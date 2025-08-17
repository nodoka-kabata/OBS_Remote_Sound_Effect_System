document.addEventListener('DOMContentLoaded', () => {
    const isObs = navigator.userAgent.includes('OBS');
    const container = document.querySelector('.container');
    let audioContext;
    const sounds = {}; // Store audio buffers and nodes
    let globalSettings = {}; // Store settings from server
    let ws;

    // --- WebSocket Connection ---
    function connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        const wsUrl = `${protocol}://${window.location.host}`;
        ws = new WebSocket(wsUrl);

        ws.onopen = () => console.log(`WebSocket connected to ${wsUrl}`);
        ws.onclose = () => {
            console.log('WebSocket disconnected. Retrying in 2s...');
            setTimeout(connectWebSocket, 2000);
        };
        ws.onerror = (err) => console.error('WebSocket Error:', err);

        ws.onmessage = (event) => {
            try {
                const command = JSON.parse(event.data);
                handleCommand(command);
            } catch (e) {
                console.error('Failed to parse command:', event.data);
            }
        };
    }

    // --- Command Sender ---
    function sendCommand(command) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(command));
        }
    }

    // --- Audio Engine (for OBS) ---
    async function initializeAudioEngine() {
        if (audioContext) return;
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        const response = await fetch('/sounds');
        const files = await response.json();
        for (const file of files) {
            const soundId = `sound-${encodeURIComponent(file)}`;
            const gainNode = audioContext.createGain();
            gainNode.connect(audioContext.destination);
            sounds[soundId] = {
                id: soundId,
                name: file,
                src: `sounds/${file}`,
                gainNode: gainNode,
                volume: 1, // Default volume
                buffer: null,
                source: null
            };
        }
        // Apply initial settings once sounds are loaded
        applyAllSettings(globalSettings);
    }

    async function loadSound(soundId) {
        const sound = sounds[soundId];
        if (!sound || sound.buffer) return;
        try {
            const response = await fetch(sound.src);
            const arrayBuffer = await response.arrayBuffer();
            sound.buffer = await audioContext.decodeAudioData(arrayBuffer);
        } catch (error) {
            console.error(`Error loading sound ${sound.name}:`, error);
        }
    }

    function playSound(soundId) {
        const sound = sounds[soundId];
        if (!sound) return;

        // Load the sound if it's not already loaded
        if (!sound.buffer) {
            loadSound(soundId).then(() => {
                if (sound.buffer) playSound(soundId); // Retry playing after loading
            });
            return;
        }

        // Stop the currently playing instance of the same sound to allow for re-triggering
        if (sound.source) {
            sound.source.onended = null; // Remove the event listener to prevent unwanted side-effects
            sound.source.stop();
        }

        // Create a new buffer source for each playback
        const source = audioContext.createBufferSource();
        source.buffer = sound.buffer;
        source.connect(sound.gainNode);
        source.start(0);

        // Keep track of the new source
        sound.source = source;

        // Notify remotes that the sound has started
        sendCommand({ action: 'sound_started', soundId });

        // Set up the onended event for the new source
        source.onended = () => {
            // Check if this is the currently active source before clearing
            if (sound.source === source) {
                sendCommand({ action: 'sound_ended', soundId });
                sound.source = null;
            }
        };
    }


    // --- Settings Application ---
    function applyAllSettings(settings) {
        globalSettings = settings;
        if (isObs) {
            // Apply master volume
            const masterVolume = settings.masterVolume || 1;
            sounds.masterVolume = masterVolume;
            // Apply individual sound volumes
            Object.keys(settings.sounds || {}).forEach(soundId => {
                const soundSettings = settings.sounds[soundId];
                const sound = sounds[soundId];
                if (sound && soundSettings) {
                    sound.volume = soundSettings.volume || 1;
                    if(sound.gainNode) sound.gainNode.gain.value = sound.volume * masterVolume;
                }
            });
        } else {
            // Apply UI settings for remote
            const soundBoard = document.getElementById('sound-board');
            const masterVolumeSlider = document.getElementById('master-volume');
            const columnsInput = document.getElementById('columns-input');

            if (masterVolumeSlider) masterVolumeSlider.value = settings.masterVolume || 1;
            if (columnsInput) columnsInput.value = settings.columns || 3;
            if (soundBoard) soundBoard.style.setProperty('--columns', settings.columns || 3);

            Object.keys(settings.sounds || {}).forEach(soundId => {
                const soundSettings = settings.sounds[soundId];
                const button = document.querySelector(`.sound-btn[data-id="${soundId}"]`);
                if (button) {
                    if (soundSettings.color) button.style.backgroundColor = soundSettings.color;
                    const volumeSlider = button.querySelector('.volume-slider');
                    if (volumeSlider) volumeSlider.value = soundSettings.volume || 1;
                }
            });
        }
    }

    function applySettingChange({ soundId, setting, value }) {
         if (soundId) { // Sound-specific setting
            const sound = sounds[soundId];
            const button = document.querySelector(`.sound-btn[data-id="${soundId}"]`);
            if (setting === 'volume') {
                if (isObs && sound) {
                    sound.volume = value;
                    sound.gainNode.gain.value = sound.volume * (sounds.masterVolume || 1);
                } else if(button) {
                    const volumeSlider = button.querySelector('.volume-slider');
                    if (volumeSlider) volumeSlider.value = value;
                }
            }
            if (setting === 'color' && button) {
                button.style.backgroundColor = value;
            }
        } else { // Global setting
            if (setting === 'masterVolume') {
                if (isObs) {
                    sounds.masterVolume = value;
                    Object.values(sounds).forEach(s => {
                        if(s.gainNode) s.gainNode.gain.value = s.volume * value;
                    });
                } else {
                    const masterVolumeSlider = document.getElementById('master-volume');
                    if (masterVolumeSlider) masterVolumeSlider.value = value;
                }
            }
             if (setting === 'columns') {
                const soundBoard = document.getElementById('sound-board');
                if (soundBoard) soundBoard.style.setProperty('--columns', value);
            }
        }
    }


    // --- Command Handler ---
    function handleCommand(command) {
        const { action, soundId, settings, setting, value } = command;

        if (action === 'settings_initialized' || action === 'settings_updated') {
            applyAllSettings(settings);
            return;
        }
        if (action === 'setting_changed') {
            applySettingChange({ soundId, setting, value });
            return;
        }

        if (isObs) {
            switch (action) {
                case 'play':
                    playSound(soundId);
                    break;
                case 'stopAll':
                    Object.values(sounds).forEach(s => {
                        if (s.source) {
                            s.source.onended = null;
                            s.source.stop();
                            s.source = null;
                            sendCommand({ action: 'sound_ended', soundId: s.id });
                        }
                    });
                    break;
                // Volume setting is now handled by 'setting_changed'
            }
        } else {
            const button = document.querySelector(`.sound-btn[data-id="${soundId}"]`);
            if (!button) return;

            switch (action) {
                case 'sound_started':
                    button.classList.add('playing');
                    break;
                case 'sound_ended':
                    button.classList.remove('playing');
                    break;
            }
        }
    }

    // --- UI Initialization (for Remote) ---
    function initializeRemoteUI() {
        const soundBoard = document.getElementById('sound-board');
        const masterVolumeSlider = document.getElementById('master-volume');
        const stopAllBtn = document.getElementById('stop-all-btn');
        const settingsBtn = document.getElementById('settings-btn');
        const volumeModeBtn = document.getElementById('volume-mode-btn');
        const modal = document.getElementById('settings-modal');
        const closeBtn = document.querySelector('.close-btn');
        const columnsInput = document.getElementById('columns-input');

        const colorPresets = ['#007bff', '#28a745', '#dc3545', '#ffc107', '#17a2b8', '#6f42c1'];

        const createButton = (sound) => {
            const button = document.createElement('div');
            button.className = 'sound-btn';
            button.dataset.id = sound.id;

            const presetsHTML = colorPresets.map(color =>
                `<div class="color-swatch" style="background-color: ${color};" data-color="${color}"></div>`
            ).join('');

            button.innerHTML = `
                <div class="btn-name">${sound.name.replace(/\.[^/.]+$/, "")}</div>
                <div class="controls-wrapper">
                    <input type="range" class="volume-slider" min="0" max="1" step="0.01" value="1">
                    <div class="color-presets">${presetsHTML}</div>
                </div>
            `;
            soundBoard.appendChild(button);

            button.addEventListener('click', () => {
                if (!document.body.classList.contains('volume-adjust-mode')) {
                    sendCommand({ action: 'play', soundId: sound.id });
                }
            });

            const volumeSlider = button.querySelector('.volume-slider');
            volumeSlider.addEventListener('input', (e) => {
                const newVolume = parseFloat(e.target.value);
                sendCommand({ action: 'update_setting', soundId: sound.id, setting: 'volume', value: newVolume });
            });

            button.querySelectorAll('.color-swatch').forEach(swatch => {
                swatch.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const newColor = e.target.dataset.color;
                    sendCommand({ action: 'update_setting', soundId: sound.id, setting: 'color', value: newColor });
                });
            });
        };

        stopAllBtn.addEventListener('click', () => sendCommand({ action: 'stopAll' }));

        masterVolumeSlider.addEventListener('input', (e) => {
            const newMasterVolume = parseFloat(e.target.value);
            sendCommand({ action: 'update_setting', setting: 'masterVolume', value: newMasterVolume });
        });

        columnsInput.addEventListener('change', (e) => {
            const newColumns = parseInt(e.target.value, 10);
            sendCommand({ action: 'update_setting', setting: 'columns', value: newColumns });
        });

        volumeModeBtn.addEventListener('click', () => {
            document.body.classList.toggle('volume-adjust-mode');
            const isAdjustMode = document.body.classList.contains('volume-adjust-mode');
            volumeModeBtn.textContent = isAdjustMode ? '🔊 調整中...' : '🔊 音量調整';
            volumeModeBtn.style.backgroundColor = isAdjustMode ? '#007bff' : '';
        });

        settingsBtn.addEventListener('click', () => {
            modal.style.display = 'block';
            // QRコード生成処理を追加
            const qrCanvas = document.getElementById('qr-code');
            const remoteUrlText = document.getElementById('remote-url-text');

            fetch('/api/remote-info')
                .then(res => res.json())
                .then(data => {
                    const url = data.remoteUrl;
                    remoteUrlText.textContent = url;
                    remoteUrlText.href = url; // Make it a clickable link
                    QRCode.toCanvas(qrCanvas, url, (error) => {
                        if (error) console.error(error);
                        console.log('QR code generated successfully!');
                    });
                })
                .catch(err => {
                    console.error('Error fetching remote URL:', err);
                    remoteUrlText.textContent = 'リモートURLの取得に失敗しました。';
                });
        });
        closeBtn.addEventListener('click', () => modal.style.display = 'none');
        window.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

        fetch('/sounds').then(res => res.json()).then(files => {
            soundBoard.innerHTML = ''; // Clear existing buttons
            files.forEach((file) => {
                const soundId = `sound-${encodeURIComponent(file)}`;
                createButton({ id: soundId, name: file });
            });
            // Apply initial settings once buttons are created
            applyAllSettings(globalSettings);
        });
    }

    // --- Main Execution ---
    if (isObs) {
        console.log('Running in OBS mode. UI is hidden.');
        if (container) container.style.display = 'none';
        initializeAudioEngine();
    } else {
        console.log('Running in Remote Control mode.');
        initializeRemoteUI();
    }
    connectWebSocket();
});
