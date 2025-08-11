const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const { WebSocketServer } = require('ws');

const app = express();
const port = 3000; /*起動ポートは必要に応じて変更*/

const soundsDirectory = path.join(__dirname, 'sounds');
const settingsFilePath = path.join(__dirname, 'settings.json');

// --- Settings Management ---
let settings = {};

function loadSettings() {
    try {
        if (fs.existsSync(settingsFilePath)) {
            const data = fs.readFileSync(settingsFilePath, 'utf8');
            settings = JSON.parse(data);
            console.log('Settings loaded from settings.json');
        } else {
            settings = {
                masterVolume: 1,
                columns: 3,
                playOnRemote: false, // Add this line
                sounds: {}
            };
            saveSettings();
            console.log('Default settings created.');
        }
    } catch (err) {
        console.error('Error loading settings.json:', err);
        settings = { masterVolume: 1, columns: 3, sounds: {} }; // Fallback to default
    }
}

function saveSettings() {
    try {
        fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2), 'utf8');
    } catch (err) {
        console.error('Error saving settings.json:', err);
    }
}

// --- HTTP Server Setup ---
app.use(express.static(__dirname));
app.use('/sounds', express.static(soundsDirectory));
app.use(express.json()); // Middleware to parse JSON bodies

// API to get current settings
app.get('/api/settings', (req, res) => {
    res.json(settings);
});

// API to update settings
app.post('/api/settings', (req, res) => {
    const newSettings = req.body;
    // Basic validation
    if (newSettings && typeof newSettings === 'object') {
        settings = { ...settings, ...newSettings };
        saveSettings();
        // Notify all clients of the settings change
        broadcast(JSON.stringify({ action: 'settings_updated', settings }));
        res.status(200).json({ message: 'Settings updated successfully' });
    } else {
        res.status(400).json({ message: 'Invalid settings format' });
    }
});


app.get('/sounds', (req, res) => {
    fs.readdir(soundsDirectory, (err, files) => {
        if (err) {
            if (err.code === 'ENOENT') {
                // If the directory doesn't exist, create it
                fs.mkdirSync(soundsDirectory, { recursive: true });
                return res.json([]); // Return an empty array as there are no files yet
            }
            console.error("Could not list the directory.", err);
            return res.status(500).send('Server error');
        }
        const audioFiles = files.filter(file =>
            ['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(path.extname(file).toLowerCase())
        );
        res.json(audioFiles);
    });
});

const server = http.createServer(app);

// --- WebSocket Server Setup ---
const wss = new WebSocketServer({ server });

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === client.OPEN) {
            client.send(data);
        }
    });
}

function broadcastExcept(sender, data) {
     wss.clients.forEach(client => {
        if (client !== sender && client.readyState === client.OPEN) {
            client.send(data);
        }
    });
}


wss.on('connection', (ws, req) => {
    const userAgent = req.headers['user-agent'] || '';
    ws.isObs = userAgent.includes('OBS');
    console.log(`Client connected: ${ws.isObs ? 'OBS Player' : 'Remote Control'}`);

    // Send initial settings to the newly connected client
    ws.send(JSON.stringify({ action: 'settings_initialized', settings }));

    ws.on('message', (message) => {
        try {
            const command = JSON.parse(message.toString());

            // Check if the command is a settings update
            if (command.action === 'update_setting') {
                const { soundId, setting, value } = command;
                if (soundId && setting) {
                    if (!settings.sounds[soundId]) {
                        settings.sounds[soundId] = {};
                    }
                    settings.sounds[soundId][setting] = value;
                } else if (setting) { // Global setting like masterVolume
                     settings[setting] = value;
                }
                saveSettings();
                // Broadcast the setting change to all clients (including the sender)
                broadcast(JSON.stringify({
                    action: 'setting_changed',
                    soundId,
                    setting,
                    value
                }));
            } else {
                 // Original functionality: Broadcast playback commands etc. to other clients
                 broadcastExcept(ws, message.toString());
            }
        } catch (e) {
            console.error("Failed to process message:", e);
             // If it's not JSON, just broadcast it for compatibility
            broadcastExcept(ws, message.toString());
        }
    });

    ws.on('close', () => {
        console.log(`Client disconnected: ${ws.isObs ? 'OBS Player' : 'Remote Control'}`);
    });

    ws.on('error', (error) => {
        console.error('WebSocket error on client:', error);
    });
});


// --- Server Startup ---
server.listen(port, '0.0.0.0', () => {
    loadSettings(); // Load settings on startup
    const networkInterfaces = os.networkInterfaces();
    let ipAddress = 'localhost';

    Object.keys(networkInterfaces).forEach(ifaceName => {
        networkInterfaces[ifaceName].forEach(iface => {
            if (iface.family === 'IPv4' && !iface.internal) {
                ipAddress = iface.address;
            }
        });
    });

    console.log(`----------------------------------------`);
    console.log(`  OBSポン出しツール サーバー起動完了`);
    console.log(`  `);
    console.log(`  OBSブラウザソースURL (PC上で設定):`);
    console.log(`  http://localhost:${port}`);
    console.log(`  `);
    console.log(`  リモコンURL (スマホ等でアクセス):`);
    console.log(`  http://${ipAddress}:${port}`);
    console.log(`----------------------------------------`);
});
