const express = require('express');
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

// Serve webcam.html for root if accessed via webcam server
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'webcam.html'));
});

app.use(express.static('public'));

// පින්තූර සේව් කරන ඩිරෙක්ටරිය ස්වයංක්‍රීයව සෑදීම
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// පින්තූර සේව් කරන තැන
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        cb(null, 'webcam-' + Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// SSE (Server-Sent Events) සඳහා
let clients = [];
app.get('/api/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    clients.push(res);
    req.on('close', () => { 
        clients = clients.filter(client => client !== res); 
    });
});

// ඒජන්ට් එකට යවන්න තියෙන කමාන්ඩ් එක (Queue එකක් විදියට)
let agentCommandQueue = [];

// වෙබ් පේජ් එකෙන් කමාන්ඩ් එක එන තැන
app.post('/api/command', (req, res) => {
    const { command } = req.body;
    if (command) {
        agentCommandQueue.push(command);
        res.json({ success: true, message: "Command queued for agent" });
    } else {
        res.status(400).json({ error: "No command provided" });
    }
});

// ඒජන්ට් එක කමාන්ඩ් එක අරගන්න එන තැන
app.get('/api/poll', (req, res) => {
    if (agentCommandQueue.length > 0) {
        const cmd = agentCommandQueue.shift(); // ඉස්සෙල්ලා ආපු එක ගන්නවා
        res.json({ command: cmd });
    } else {
        res.json({ command: null });
    }
});

// ඒජන්ට් එකෙන් පින්තූරය අප්ලෝඩ් කරන තැන
app.post('/api/upload-webcam', upload.single('webcamPhoto'), (req, res) => {
    if (!req.file) {
        return res.status(400).send('No file uploaded.');
    }
    
    const imageUrl = `/uploads/${req.file.filename}`;
    
    // වෙබ් පේජ් එකට අලුත් පින්තූරය ගැන දැනුම් දෙනවා (Live)
    clients.forEach(client => {
        client.write(`data: ${JSON.stringify({ type: 'webcam_update', url: imageUrl })}\n\n`);
    });

    res.json({ success: true, imageUrl: imageUrl });
});

const PORT = process.env.PORT || 3880;
app.listen(PORT, () => {
    console.log(`[Webcam Agent Server] running on port ${PORT}`);
});
