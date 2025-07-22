const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const cors = require('cors');
const youtubedl = require('youtube-dl-exec');

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration des clés API
const API_KEY_1 = process.env.API_KEY_1 || 'pk_live_mega_converter_primary_key_2024_abc123';
const API_KEY_2 = process.env.API_KEY_2 || 'sk_live_mega_converter_secret_key_2024_xyz789';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Middleware d'authentification API
const authenticateAPI = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  
  // Permettre l'accès sans clé API depuis le navigateur (interface web)
  if (req.path === '/' || req.path.startsWith('/public/')) {
    return next();
  }
  
  // Pour les requêtes API, vérifier la clé
  if (req.path.startsWith('/api/')) {
    if (!apiKey) {
      return res.status(401).json({ error: 'Clé API requise' });
    }
    
    if (apiKey !== API_KEY_1 && apiKey !== API_KEY_2) {
      return res.status(403).json({ error: 'Clé API invalide' });
    }
  }
  
  next();
};

app.use(authenticateAPI);

// Configuration Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 * 1024 } // 5GB max
});

// Fonction pour extraire l'ID Google Drive
function extractGoogleDriveId(url) {
  const patterns = [
    /\/file\/d\/([a-zA-Z0-9_-]+)/,
    /id=([a-zA-Z0-9_-]+)/,
    /\/open\?id=([a-zA-Z0-9_-]+)/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

// Fonction pour télécharger depuis une URL
async function downloadFromUrl(url, outputPath) {
  try {
    // Support Google Drive
    if (url.includes('drive.google.com')) {
      const fileId = extractGoogleDriveId(url);
      if (fileId) {
        url = `https://drive.google.com/uc?export=download&id=${fileId}`;
      }
    }
    
    // Support Dropbox
    if (url.includes('dropbox.com')) {
      url = url.replace('?dl=0', '?dl=1');
    }
    
    // Support YouTube et autres plateformes
    if (url.includes('youtube.com') || url.includes('youtu.be') || 
        url.includes('vimeo.com') || url.includes('dailymotion.com')) {
      await youtubedl(url, {
        output: outputPath,
        format: 'best[ext=mp4]/best'
      });
      return;
    }
    
    // Téléchargement direct pour autres URLs
    const response = await axios({
      method: 'GET',
      url: url,
      responseType: 'stream',
      timeout: 300000 // 5 minutes timeout
    });
    
    const writer = fs.createWriteStream(outputPath);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
      writer.on('finish', resolve);
      writer.on('error', reject);
    });
  } catch (error) {
    throw new Error(`Erreur lors du téléchargement: ${error.message}`);
  }
}

// Route principale (interface web)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Route API pour la conversion depuis URL (pour n8n)
app.post('/api/convert-url', async (req, res) => {
  const { url, format = 'mp4', quality = '4k' } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL requise' });
  }
  
  const tempInput = path.join('uploads', `temp-${Date.now()}.mp4`);
  const outputFilename = `converted-${Date.now()}.${format}`;
  const outputPath = path.join('uploads', outputFilename);
  
  try {
    console.log('Téléchargement en cours depuis:', url);
    await downloadFromUrl(url, tempInput);
    
    // Déterminer les paramètres de qualité
    let outputOptions = [
      '-c:v libx264',
      '-preset slow',
      '-crf 18',
      '-c:a aac',
      '-b:a 320k'
    ];
    
    if (quality === '4k') {
      outputOptions.push('-vf scale=3840:2160');
    } else if (quality === '1080p') {
      outputOptions.push('-vf scale=1920:1080');
    } else if (quality === '720p') {
      outputOptions.push('-vf scale=1280:720');
    }
    
    // Convertir avec FFmpeg
    await new Promise((resolve, reject) => {
      ffmpeg(tempInput)
        .outputOptions(outputOptions)
        .on('progress', (progress) => {
          console.log(`Progression: ${progress.percent}%`);
        })
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });
    
    // Nettoyer le fichier temporaire
    fs.unlinkSync(tempInput);
    
    // Générer une URL de téléchargement temporaire
    const downloadUrl = `${req.protocol}://${req.get('host')}/download/${path.basename(outputPath)}`;
    
    res.json({
      success: true,
      message: 'Conversion réussie',
      downloadUrl: downloadUrl,
      filename: outputFilename,
      expiresIn: '5 minutes'
    });
    
    // Supprimer le fichier après 5 minutes
    setTimeout(() => {
      if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
      }
    }, 300000);
    
  } catch (error) {
    console.error('Erreur:', error);
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    
    res.status(500).json({ 
      error: 'Erreur lors de la conversion', 
      details: error.message 
    });
  }
});

// Route API pour obtenir le statut
app.get('/api/status', (req, res) => {
  res.json({
    status: 'online',
    version: '1.0.0',
    supportedFormats: ['mp4', 'avi', 'mov', 'mkv', 'webm'],
    supportedQualities: ['4k', '1080p', '720p', 'original']
  });
});

// Route de téléchargement
app.get('/download/:filename', (req, res) => {
  const filePath = path.join('uploads', req.params.filename);
  
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Fichier non trouvé' });
  }
  
  res.download(filePath);
});

// Routes pour l'interface web (sans authentification API)
app.post('/convert-url', async (req, res) => {
  const { url, format = 'mp4', quality = '4k' } = req.body;
  
  if (!url) {
    return res.status(400).json({ error: 'URL requise' });
  }
  
  const tempInput = path.join('uploads', `temp-${Date.now()}.mp4`);
  const outputFilename = `converted-${Date.now()}.${format}`;
  const outputPath = path.join('uploads', outputFilename);
  
  try {
    await downloadFromUrl(url, tempInput);
    
    let outputOptions = [
      '-c:v libx264',
      '-preset slow',
      '-crf 18',
      '-c:a aac',
      '-b:a 320k'
    ];
    
    if (quality === '4k') {
      outputOptions.push('-vf scale=3840:2160');
    } else if (quality === '1080p') {
      outputOptions.push('-vf scale=1920:1080');
    } else if (quality === '720p') {
      outputOptions.push('-vf scale=1280:720');
    }
    
    await new Promise((resolve, reject) => {
      ffmpeg(tempInput)
        .outputOptions(outputOptions)
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });
    
    fs.unlinkSync(tempInput);
    
    res.download(outputPath, outputFilename, (err) => {
      if (err) console.error(err);
      setTimeout(() => {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      }, 60000);
    });
    
  } catch (error) {
    console.error('Erreur:', error);
    if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    
    res.status(500).json({ 
      error: 'Erreur lors de la conversion', 
      details: error.message 
    });
  }
});

// Route pour la conversion depuis upload
app.post('/convert-file', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier fourni' });
  }
  
  const { format = 'mp4', quality = '4k' } = req.body;
  const inputPath = req.file.path;
  const outputFilename = `converted-${Date.now()}.${format}`;
  const outputPath = path.join('uploads', outputFilename);
  
  try {
    let outputOptions = [
      '-c:v libx264',
      '-preset slow',
      '-crf 18',
      '-c:a aac',
      '-b:a 320k'
    ];
    
    if (quality === '4k') {
      outputOptions.push('-vf scale=3840:2160');
    } else if (quality === '1080p') {
      outputOptions.push('-vf scale=1920:1080');
    } else if (quality === '720p') {
      outputOptions.push('-vf scale=1280:720');
    }
    
    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .outputOptions(outputOptions)
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });
    
    fs.unlinkSync(inputPath);
    
    res.download(outputPath, outputFilename, (err) => {
      if (err) console.error(err);
      setTimeout(() => {
        if (fs.existsSync(outputPath)) {
          fs.unlinkSync(outputPath);
        }
      }, 60000);
    });
    
  } catch (error) {
    console.error('Erreur:', error);
    if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    
    res.status(500).json({ 
      error: 'Erreur lors de la conversion', 
      details: error.message 
    });
  }
});

// Démarrer le serveur
app.listen(PORT, () => {
  console.log(`🚀 Serveur démarré sur le port ${PORT}`);
  console.log(`📡 Accès local: http://localhost:${PORT}`);
  console.log(`🔑 API Keys configurées:`, API_KEY_1 ? 'Oui' : 'Non');
});
