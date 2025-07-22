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

// Fonction pour télécharger depuis Google Drive (VERSION CORRIGÉE)
async function downloadFromGoogleDrive(url, outputPath) {
    try {
        // Extraire l'ID du fichier
        const fileId = extractGoogleDriveId(url);
        if (!fileId) {
            throw new Error('ID Google Drive non trouvé dans l\'URL');
        }
        
        console.log(`📥 Téléchargement depuis Google Drive: ${fileId}`);
        
        // IMPORTANT : Utiliser l'API Google Drive v3 pour les gros fichiers
        // D'abord essayer le téléchargement direct
        let downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;
        
        try {
            // Premier essai : téléchargement direct
            const response = await axios({
                method: 'GET',
                url: downloadUrl,
                responseType: 'stream',
                timeout: 600000,
                maxContentLength: Infinity,
                maxBodyLength: Infinity,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            // Vérifier si c'est vraiment une vidéo
            const contentType = response.headers['content-type'];
            console.log('📋 Content-Type reçu:', contentType);
            
            if (contentType && contentType.includes('text/html')) {
                // C'est une page HTML, pas une vidéo !
                console.error('❌ Google Drive a renvoyé une page HTML au lieu de la vidéo');
                console.log('💡 Solutions :');
                console.log('   1. Rendez le fichier public (Partager → Tout le monde ayant le lien)');
                console.log('   2. Utilisez un fichier plus petit (<100MB)');
                console.log('   3. Utilisez l\'API Google Drive avec authentification');
                
                throw new Error('Le fichier Google Drive n\'est pas accessible directement. Rendez-le public ou utilisez un fichier plus petit.');
            }
            
            // Sauvegarder le fichier
            const writer = fs.createWriteStream(outputPath);
            response.data.pipe(writer);
            
            return new Promise((resolve, reject) => {
                writer.on('finish', () => {
                    // Vérifier la taille du fichier
                    const stats = fs.statSync(outputPath);
                    console.log(`✅ Téléchargement terminé: ${outputPath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
                    
                    // Si le fichier est trop petit, c'est probablement une page HTML
                    if (stats.size < 1000) {
                        const content = fs.readFileSync(outputPath, 'utf8');
                        if (content.includes('<!DOCTYPE') || content.includes('<html')) {
                            fs.unlinkSync(outputPath);
                            reject(new Error('Google Drive a renvoyé une page HTML. Le fichier doit être rendu public.'));
                            return;
                        }
                    }
                    
                    resolve();
                });
                writer.on('error', reject);
            });
            
        } catch (error) {
            if (error.response && error.response.status === 404) {
                throw new Error('Fichier Google Drive introuvable. Vérifiez l\'URL.');
            }
            throw error;
        }
        
    } catch (error) {
        console.error('❌ Erreur téléchargement:', error.message);
        throw error;
    }
}

// Fonction pour convertir la vidéo (optimisée pour les réseaux sociaux)
async function convertVideo(inputPath, outputPath, quality = '4k') {
    return new Promise((resolve, reject) => {
        console.log(`🎬 Conversion en cours: ${quality}`);
        
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
        
        ffmpeg(inputPath)
            .outputOptions(outputOptions)
            .on('start', (commandLine) => {
                console.log('🎯 Commande FFmpeg:', commandLine);
            })
            .on('progress', (progress) => {
                if (progress.percent) {
                    console.log(`📊 Progression: ${Math.round(progress.percent)}%`);
                }
            })
            .on('end', () => {
                console.log('✅ Conversion terminée');
                resolve();
            })
            .on('error', (err) => {
                console.error('❌ Erreur conversion:', err);
                reject(err);
            })
            .save(outputPath);
    });
}

// Route principale de l'API
app.post('/api/convert', authenticate, async (req, res) => {
    console.log('\n=== NOUVELLE REQUÊTE REÇUE ===');
    console.log('Body reçu:', JSON.stringify(req.body, null, 2));
    
    const { url, quality = '4k', filename } = req.body;
    
    // Validation
    if (!url || !url.includes('drive.google.com')) {
        return res.status(400).json({ 
            error: 'URL Google Drive requise',
            example: 'https://drive.google.com/file/d/FILE_ID/view'
        });
    }
    
    // Générer des noms de fichiers uniques
    const timestamp = Date.now();
    const tempFile = path.join(UPLOAD_DIR, `temp_${timestamp}.mp4`);
    const outputFilename = filename || `video_${timestamp}_${quality}.mp4`;
    const outputFile = path.join(OUTPUT_DIR, outputFilename);
    
    try {
        // 1. Télécharger depuis Google Drive
        console.log('\n🚀 Nouvelle conversion:', { url, quality });
        await downloadFromGoogleDrive(url, tempFile);
        
        // 2. Vérifier que le fichier existe
        if (!fs.existsSync(tempFile)) {
            throw new Error('Échec du téléchargement');
        }
        
        // 3. Obtenir la taille du fichier
        const stats = fs.statSync(tempFile);
        console.log(`📁 Taille du fichier: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        
        // 4. Convertir la vidéo
        await convertVideo(tempFile, outputFile, quality);
        
        // 5. Nettoyer le fichier temporaire
        fs.unlinkSync(tempFile);
        
        // 6. Générer l'URL de téléchargement
        const downloadUrl = `${DOMAIN}/download/${outputFilename}`;
        
        // 7. Programmer la suppression après 10 minutes
        setTimeout(() => {
            if (fs.existsSync(outputFile)) {
                fs.unlinkSync(outputFile);
                console.log(`🗑️ Fichier supprimé: ${outputFilename}`);
            }
        }, 600000); // 10 minutes
        
        // 8. Réponse avec toutes les infos
        res.json({
            success: true,
            message: 'Conversion réussie',
            data: {
                downloadUrl: downloadUrl,
                directUrl: downloadUrl,
                filename: outputFilename,
                quality: quality,
                size: fs.statSync(outputFile).size,
                expiresIn: '10 minutes',
                format: 'mp4',
                optimizedFor: 'social_media'
            }
        });
        
    } catch (error) {
        console.error('❌ Erreur globale:', error);
        
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
        version: '2.0',
        api: {
            endpoint: '/api/convert',
            method: 'POST',
            headers: {
                'X-API-Key': 'Votre clé API',
                'Content-Type': 'application/json'
            },
            body: {
                url: 'URL Google Drive (requis)',
                quality: '4k, 1080p, 720p, original (optionnel, défaut: 4k)',
                filename: 'Nom personnalisé (optionnel)'
            }
        },
        supportedQualities: ['4k', '1080p', '720p', 'original'],
        optimizations: [
            'H.264/AAC pour compatibilité maximale',
            'Optimisé pour streaming (faststart)',
            'Bitrate adapté par résolution',
            'Aspect ratio préservé avec padding noir'
        ]
    });
});

// Page d'accueil simple
app.get('/', (req, res) => {
    res.json({
        name: 'Video Converter API',
        version: '2.0',
        status: 'Ready',
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
🚀 Video Converter API démarré!
📡 Port: ${PORT}
🔗 URL: ${DOMAIN}
🔑 API Key: ${API_KEY ? 'Configurée' : 'Non configurée'}
📁 Dossiers: ${UPLOAD_DIR}/ et ${OUTPUT_DIR}/

📝 Utilisation:
   POST ${DOMAIN}/api/convert
   Headers: X-API-Key: ${API_KEY}
   Body: { "url": "https://drive.google.com/..." }
    `);
});
