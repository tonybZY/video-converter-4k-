// Éléments DOM
const urlForm = document.getElementById('url-form');
const fileForm = document.getElementById('file-form');
const uploadArea = document.getElementById('upload-area');
const fileInput = document.getElementById('video-file');
const fileInfo = document.getElementById('file-info');
const fileName = document.getElementById('file-name');
const fileSize = document.getElementById('file-size');
const progressArea = document.getElementById('progress-area');
const progressFill = document.getElementById('progress-fill');
const progressText = document.getElementById('progress-text');
const resultArea = document.getElementById('result-area');
const downloadBtn = document.getElementById('download-btn');

let selectedFile = null;
let downloadUrl = null;

// Changer d'onglet
function switchTab(tab) {
    const tabs = document.querySelectorAll('.tab');
    const contents = document.querySelectorAll('.tab-content');
    
    tabs.forEach(t => t.classList.remove('active'));
    contents.forEach(c => c.classList.remove('active'));
    
    if (tab === 'url') {
        tabs[0].classList.add('active');
        document.getElementById('url-tab').classList.add('active');
    } else {
        tabs[1].classList.add('active');
        document.getElementById('file-tab').classList.add('active');
    }
}

// Gestion du drag & drop
uploadArea.addEventListener('click', () => fileInput.click());

uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('active');
});

uploadArea.addEventListener('dragleave', () => {
    uploadArea.classList.remove('active');
});

uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('active');
    
    const files = e.dataTransfer.files;
    if (files.length > 0) {
        handleFileSelect(files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
        handleFileSelect(e.target.files[0]);
    }
});

// Gestion de la sélection de fichier
function handleFileSelect(file) {
    if (!file.type.startsWith('video/')) {
        alert('Veuillez sélectionner un fichier vidéo');
        return;
    }
    
    selectedFile = file;
    fileName.textContent = file.name;
    fileSize.textContent = formatFileSize(file.size);
    fileInfo.style.display = 'block';
    fileForm.querySelector('.convert-btn').disabled = false;
}

// Formatage de la taille du fichier
function formatFileSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Conversion depuis URL
urlForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const url = document.getElementById('video-url').value;
    const quality = document.getElementById('quality-url').value;
    const format = document.getElementById('format-url').value;
    
    showProgress();
    
    try {
        const response = await fetch('/convert-url', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ url, quality, format })
        });
        
        if (!response.ok) {
            throw new Error('Erreur lors de la conversion');
        }
        
        // Créer un blob depuis la réponse
        const blob = await response.blob();
        downloadUrl = URL.createObjectURL(blob);
        
        showResult();
    } catch (error) {
        alert('Erreur: ' + error.message);
        hideProgress();
    }
});

// Conversion depuis fichier
fileForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    if (!selectedFile) {
        alert('Veuillez sélectionner un fichier');
        return;
    }
    
    const quality = document.getElementById('quality-file').value;
    const format = document.getElementById('format-file').value;
    
    const formData = new FormData();
    formData.append('video', selectedFile);
    formData.append('quality', quality);
    formData.append('format', format);
    
    showProgress();
    
    try {
        const response = await fetch('/convert-file', {
            method: 'POST',
            body: formData
        });
        
        if (!response.ok) {
            throw new Error('Erreur lors de la conversion');
        }
        
        // Créer un blob depuis la réponse
        const blob = await response.blob();
        downloadUrl = URL.createObjectURL(blob);
        
        showResult();
    } catch (error) {
        alert('Erreur: ' + error.message);
        hideProgress();
    }
});

// Téléchargement
downloadBtn.addEventListener('click', () => {
    if (downloadUrl) {
        const a = document.createElement('a');
        a.href = downloadUrl;
        a.download = `converted-video.mp4`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    }
});

// Gestion de l'affichage
function showProgress() {
    progressArea.style.display = 'block';
    resultArea.style.display = 'none';
    
    // Simulation de progression
    let progress = 0;
    const interval = setInterval(() => {
        progress += Math.random() * 15;
        if (progress > 90) {
            clearInterval(interval);
            progress = 90;
        }
        progressFill.style.width = progress + '%';
        progressText.textContent = `Conversion en cours... ${Math.round(progress)}%`;
    }, 500);
}

function hideProgress() {
    progressArea.style.display = 'none';
}

function showResult() {
    progressFill.style.width = '100%';
    progressText.textContent = 'Conversion terminée!';
    
    setTimeout(() => {
        progressArea.style.display = 'none';
        resultArea.style.display = 'block';
    }, 1000);
}

// Vérification de la compatibilité
window.addEventListener('load', () => {
    if (!window.File || !window.FileReader || !window.FileList || !window.Blob) {
        alert('Votre navigateur ne supporte pas toutes les fonctionnalités requises');
    }
});
