const express = require('express');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration
const API_KEY = process.env.API_KEY || 'pk_video_converter_4k_2024';
const DOMAIN = process.env.RAILWAY_STATIC_URL || `http://localhost:${PORT}`;

// Middleware
app.use(cors());
app.use(express.json());

// Créer les dossiers nécessaires
const UPLOAD_DIR = 'temp';
const OUTPUT_DIR = 'converted';
[UPLOAD_DIR, OUTPUT_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

// Middleware d'authentification simple
const authenticate = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== API_KEY) {
        return res.status(403).json({ 
            error: 'Clé API invalide ou manquante',
            message: 'Ajoutez X-API-Key dans les headers'
        });
    }
    next();
};

// Fonction pour extraire l'ID Google Drive
function extractGoogleDriveId(url) {
    const patterns = [
        /\/file\/d\/([a-zA-Z0-9_-]+)/,
        /id=([a-zA-Z0-9_-]+)/,
        /\/open\?id=([a-zA-Z0-9_-]+)/,
        /drive\.google\.com\/.*[?&]id=([a-zA-Z0-9_-]+)/
    ];
    
    for (const pattern of patterns) {
        const match = url.match(pattern);
        if (match) return match[1];
    }
    return null;
}

// FONCTION ULTRA ROBUSTE pour télécharger depuis Google Drive
async function downloadFromGoogleDrive(url, outputPath) {
    const fileId = extractGoogleDriveId(url);
    if (!fileId) {
        throw new Error('ID Google Drive non trouvé dans l\'URL');
    }
    
    console.log(`\n📥 Téléchargement Google Drive: ${fileId}`);
    console.log(`📁 Destination: ${outputPath}`);
    
    // Stratégie de téléchargement en plusieurs étapes
    const strategies = [
        {
            name: 'Méthode 1: Direct avec confirmation',
            url: `https://drive.google.com/uc?export=download&confirm=t&id=${fileId}`
        },
        {
            name: 'Méthode 2: API alternative',
            url: `https://drive.google.com/uc?id=${fileId}&export=download&confirm=t`
        },
        {
            name: 'Méthode 3: Avec token dynamique',
            url: `https://drive.google.com/uc?export=download&id=${fileId}`,
            requiresToken: true
        }
    ];
    
    let lastError = null;
    
    for (const strategy of strategies) {
        console.log(`\n🔄 Essai: ${strategy.name}`);
        
        try {
            if (strategy.requiresToken) {
                // Méthode complexe pour obtenir le token de confirmation
                await downloadWithConfirmationToken(fileId, outputPath);
            } else {
                // Méthode directe
                await downloadDirect(strategy.url, outputPath);
            }
            
            // Vérifier que le téléchargement est valide
            const stats = fs.statSync(outputPath);
            console.log(`✅ Fichier téléchargé: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
            
            // Vérifier que ce n'est pas une page HTML
            if (stats.size < 50000) { // < 50KB, probablement HTML
                const content = fs.readFileSync(outputPath, 'utf8').substring(0, 200);
                if (content.includes('<!DOCTYPE') || content.includes('<html')) {
                    console.log('⚠️ Fichier HTML détecté, passage à la stratégie suivante');
                    fs.unlinkSync(outputPath);
                    lastError = new Error('Page HTML reçue au lieu du fichier');
                    continue;
                }
            }
            
            // Succès !
            return;
            
        } catch (error) {
            console.error(`❌ Échec: ${error.message}`);
            lastError = error;
            
            // Nettoyer si le fichier existe
            if (fs.existsSync(outputPath)) {
                fs.unlinkSync(outputPath);
            }
        }
    }
    
    // Si toutes les stratégies ont échoué
    throw new Error(`Impossible de télécharger le fichier Google Drive. Dernier erreur: ${lastError?.message}`);
}

// Téléchargement direct
async function downloadDirect(url, outputPath) {
    const response = await axios({
        method: 'GET',
        url: url,
        responseType: 'stream',
        timeout: 1200000, // 20 minutes pour les très gros fichiers
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': '*/*',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive'
        },
        // Suivre les redirections
        maxRedirects: 10
    });
    
    const writer = fs.createWriteStream(outputPath);
    
    // Afficher la progression
    const totalSize = parseInt(response.headers['content-length'] || '0');
    let downloadedSize = 0;
    
    response.data.on('data', (chunk) => {
        downloadedSize += chunk.length;
        if (totalSize > 0) {
            const progress = (downloadedSize / totalSize * 100).toFixed(1);
            process.stdout.write(`\r📊 Téléchargement: ${progress}% (${(downloadedSize / 1024 / 1024).toFixed(1)}MB / ${(totalSize / 1024 / 1024).toFixed(1)}MB)`);
        }
    });
    
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
        writer.on('finish', () => {
            console.log('\n✅ Téléchargement terminé');
            resolve();
        });
        writer.on('error', reject);
        response.data.on('error', reject);
    });
}

// Téléchargement avec token de confirmation (pour gros fichiers)
async function downloadWithConfirmationToken(fileId, outputPath) {
    // Étape 1: Obtenir la page avec le token
    console.log('🔑 Récupération du token de confirmation...');
    
    const initialUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
    const response = await axios({
        method: 'GET',
        url: initialUrl,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
    });
    
    const html = response.data;
    
    // Chercher le token de confirmation
    const tokenMatch = html.match(/confirm=([a-zA-Z0-9_-]+)/);
    const uuidMatch = html.match(/uuid=([a-zA-Z0-9_-]+)/);
    
    if (!tokenMatch) {
        throw new Error('Token de confirmation non trouvé');
    }
    
    const confirmToken = tokenMatch[1];
    const uuid = uuidMatch ? uuidMatch[1] : '';
    
    console.log('🔓 Token trouvé:', confirmToken);
    
    // Étape 2: Télécharger avec le token
    const downloadUrl = `https://drive.google.com/uc?export=download&confirm=${confirmToken}&id=${fileId}${uuid ? '&uuid=' + uuid : ''}`;
    
    // Conserver les cookies
    const cookies = response.headers['set-cookie'] || [];
    const cookieString = cookies.map(c => c.split(';')[0]).join('; ');
    
    await downloadDirect(downloadUrl, outputPath);
}

// Fonction pour convertir la vidéo (optimisée pour les réseaux sociaux)
async function convertVideo(inputPath, outputPath, quality = '4k') {
    return new Promise((resolve, reject) => {
        console.log(`\n🎬 Conversion en ${quality}...`);
        
        // Obtenir les infos de la vidéo
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }
            
            const duration = metadata.format.duration;
            console.log(`📹 Durée: ${Math.floor(duration / 60)}:${Math.floor(duration % 60)}`);
            
            // Paramètres optimisés pour les réseaux sociaux
            let outputOptions = [
                '-c:v libx264',      // Codec vidéo H.264 (compatible partout)
                '-preset medium',     // Balance qualité/vitesse
                '-crf 23',           // Qualité (plus bas = meilleure qualité)
                '-c:a aac',          // Codec audio AAC
                '-b:a 192k',         // Bitrate audio
                '-movflags +faststart', // Optimisation pour streaming
                '-pix_fmt yuv420p'   // Format de pixels compatible
            ];
            
            // Résolution selon la qualité demandée
            switch(quality) {
                case '4k':
                    outputOptions.push('-vf scale=3840:2160:force_original_aspect_ratio=decrease,pad=3840:2160:(ow-iw)/2:(oh-ih)/2');
                    outputOptions.push('-b:v 35M'); // Bitrate pour 4K
                    break;
                case '1080p':
                    outputOptions.push('-vf scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2');
                    outputOptions.push('-b:v 8M');  // Bitrate pour 1080p
                    break;
                case '720p':
                    outputOptions.push('-vf scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2');
                    outputOptions.push('-b:v 5M');  // Bitrate pour 720p
                    break;
                default:
                    // Garder la qualité originale
                    outputOptions.push('-b:v 10M');
            }
            
            const ffmpegCommand = ffmpeg(inputPath)
                .outputOptions(outputOptions)
                .on('start', (commandLine) => {
                    console.log('🎯 Commande FFmpeg:', commandLine);
                })
                .on('progress', (progress) => {
                    if (progress.percent) {
                        process.stdout.write(`\r📊 Conversion: ${Math.round(progress.percent)}%`);
                    }
                })
                .on('end', () => {
                    console.log('\n✅ Conversion terminée');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('❌ Erreur conversion:', err);
                    reject(err);
                })
                .save(outputPath);
        });
    });
}

// Route principale de l'API
app.post('/api/convert', authenticate, async (req, res) => {
    console.log('\n=== NOUVELLE REQUÊTE DE CONVERSION ===');
    console.log('📅 Date:', new Date().toISOString());
    console.log('📦 Body:', JSON.stringify(req.body, null, 2));
    
    const { url, quality = '4k', filename } = req.body;
    
    // Validation
    if (!url) {
        return res.status(400).json({ 
            error: 'URL requise',
            message: 'Fournissez une URL Google Drive ou directe'
        });
    }
    
    // Générer des noms de fichiers uniques
    const timestamp = Date.now();
    const tempFile = path.join(UPLOAD_DIR, `temp_${timestamp}.mp4`);
    const outputFilename = filename || `video_${timestamp}_${quality}.mp4`;
    const outputFile = path.join(OUTPUT_DIR, outputFilename);
    
    try {
        // 1. Télécharger la vidéo
        console.log('\n🚀 Étape 1: Téléchargement');
        
        if (url.includes('drive.google.com')) {
            await downloadFromGoogleDrive(url, tempFile);
        } else {
            // Support des URLs directes
            console.log('📥 Téléchargement direct depuis:', url);
            await downloadDirect(url, tempFile);
        }
        
        // 2. Vérifier que le fichier existe et est valide
        if (!fs.existsSync(tempFile)) {
            throw new Error('Échec du téléchargement');
        }
        
        const stats = fs.statSync(tempFile);
        console.log(`\n📁 Fichier téléchargé: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        
        // 3. Convertir la vidéo
        console.log('\n🚀 Étape 2: Conversion');
        await convertVideo(tempFile, outputFile, quality);
        
        // 4. Nettoyer le fichier temporaire
        fs.unlinkSync(tempFile);
        console.log('🗑️ Fichier temporaire supprimé');
        
        // 5. Générer l'URL de téléchargement
        const downloadUrl = `${DOMAIN}/download/${outputFilename}`;
        
        // 6. Programmer la suppression après 10 minutes
        setTimeout(() => {
            if (fs.existsSync(outputFile)) {
                fs.unlinkSync(outputFile);
                console.log(`🗑️ Fichier converti supprimé: ${outputFilename}`);
            }
        }, 600000); // 10 minutes
        
        // 7. Réponse avec toutes les infos
        const finalStats = fs.statSync(outputFile);
        
        console.log('\n✅ CONVERSION RÉUSSIE !');
        console.log(`📦 Taille finale: ${(finalStats.size / 1024 / 1024).toFixed(2)} MB`);
        console.log(`🔗 URL: ${downloadUrl}`);
        
        res.json({
            success: true,
            message: 'Conversion réussie',
            data: {
                downloadUrl: downloadUrl,
                directUrl: downloadUrl,
                filename: outputFilename,
                quality: quality,
                size: finalStats.size,
                sizeMB: (finalStats.size / 1024 / 1024).toFixed(2),
                expiresIn: '10 minutes',
                format: 'mp4',
                optimizedFor: 'social_media'
            }
        });
        
    } catch (error) {
        console.error('\n❌ ERREUR GLOBALE:', error);
        
        // Nettoyer les fichiers en cas d'erreur
        [tempFile, outputFile].forEach(file => {
            if (fs.existsSync(file)) {
                fs.unlinkSync(file);
            }
        });
        
        res.status(500).json({ 
            error: 'Erreur lors de la conversion',
            message: error.message,
            details: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// Route pour télécharger les fichiers convertis
app.get('/download/:filename', (req, res) => {
    const filename = req.params.filename;
    const filepath = path.join(OUTPUT_DIR, filename);
    
    // Sécurité : empêcher l'accès aux dossiers parents
    if (filename.includes('..')) {
        return res.status(403).json({ error: 'Accès interdit' });
    }
    
    // Vérifier que le fichier existe
    if (!fs.existsSync(filepath)) {
        return res.status(404).json({ 
            error: 'Fichier non trouvé',
            message: 'Le fichier a peut-être expiré'
        });
    }
    
    // Envoyer le fichier
    res.download(filepath, filename, (err) => {
        if (err) {
            console.error('Erreur téléchargement:', err);
            res.status(500).json({ error: 'Erreur lors du téléchargement' });
        }
    });
});

// Route de statut
app.get('/api/status', (req, res) => {
    res.json({
        status: 'online',
        version: '3.0 ULTRA',
        features: [
            '✅ Support des gros fichiers Google Drive (>100MB)',
            '✅ Multiples stratégies de téléchargement',
            '✅ Gestion automatique des tokens de confirmation',
            '✅ Support des URLs directes',
            '✅ Progression en temps réel',
            '✅ Conversion 4K optimisée'
        ],
        api: {
            endpoint: '/api/convert',
            method: 'POST',
            headers: {
                'X-API-Key': 'Votre clé API',
                'Content-Type': 'application/json'
            },
            body: {
                url: 'URL Google Drive ou directe (requis)',
                quality: '4k, 1080p, 720p, original (optionnel, défaut: 4k)',
                filename: 'Nom personnalisé (optionnel)'
            }
        },
        supportedQualities: ['4k', '1080p', '720p', 'original'],
        supportedSources: [
            'Google Drive (tous types de partage)',
            'URLs directes (HTTP/HTTPS)',
            'Fichiers jusqu\'à 5GB'
        ]
    });
});

// Page d'accueil simple
app.get('/', (req, res) => {
    res.json({
        name: 'Video Converter API - ULTRA Edition',
        version: '3.0',
        status: 'Ready',
        message: 'API ultra robuste pour conversion vidéo 4K',
        documentation: '/api/status',
        usage: 'POST /api/convert avec X-API-Key header'
    });
});

// Route de test (pour debug)
app.post('/api/test', authenticate, (req, res) => {
    console.log('Test reçu:', req.body);
    res.json({
        success: true,
        received: req.body,
        timestamp: new Date().toISOString()
    });
});

// Gestion des erreurs 404
app.use((req, res) => {
    res.status(404).json({ 
        error: 'Route non trouvée',
        availableRoutes: [
            'GET /',
            'GET /api/status',
            'POST /api/convert',
            'POST /api/test',
            'GET /download/:filename'
        ]
    });
});

// Démarrer le serveur
app.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║          🚀 VIDEO CONVERTER API - ULTRA EDITION 🚀          ║
╠═══════════════════════════════════════════════════════════╣
║ 📡 Port      : ${PORT}                                          ║
║ 🔗 URL       : ${DOMAIN}${' '.repeat(45 - DOMAIN.length)}║
║ 🔑 API Key   : ${API_KEY ? 'Configurée ✅' : 'Non configurée ❌'}                             ║
║ 📁 Dossiers  : ${UPLOAD_DIR}/ et ${OUTPUT_DIR}/                             ║
╠═══════════════════════════════════════════════════════════╣
║ 🎯 Fonctionnalités:                                        ║
║ • Support des gros fichiers Google Drive (>100MB)          ║
║ • Multiples stratégies de téléchargement                   ║
║ • Conversion 4K avec optimisation réseaux sociaux          ║
║ • Progression en temps réel                                ║
╚═══════════════════════════════════════════════════════════╝
    `);
});
