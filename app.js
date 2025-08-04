document.addEventListener('DOMContentLoaded', () => {
    const isObs = navigator.userAgent.includes('OBS');
    const container = document.querySelector('.container');
    let audioContext;
    const sounds = {}; // Store audio buffers and nodes
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

        // Listen for messages from the server (both OBS and Remote)
        ws.onmessage = (event) => {
            try {
                const command = JSON.parse(event.data);
                handleCommand(command);
            } catch (e) {
                console.error('Failed to parse command:', event.data);
            }
        };
    }

    // --- Command Sender (for Remote and OBS) ---
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
                volume: 1,
                buffer: null,
                source: null // To keep track of the current source
            };
        }
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
        if (!sound || !sound.buffer) {
            loadSound(soundId).then(() => {
                if(sound.buffer) playSound(soundId);
            });
            return;
        }

        // Stop existing sound if it's playing
        if (sound.source) {
            sound.source.onended = null; // Remove previous listener
            sound.source.stop();
        }

        const source = audioContext.createBufferSource();
        source.buffer = sound.buffer;
        source.connect(sound.gainNode);
        source.start(0);
        sound.source = source;

        // Notify remotes that sound has started
        sendCommand({ action: 'sound_started', soundId });

        source.onended = () => {
            // Notify remotes that sound has ended
            sendCommand({ action: 'sound_ended', soundId });
            sound.source = null;
        };
    }

    // --- Command Handler (for both OBS and Remote) ---
    function handleCommand(command) {
        const { action, soundId, volume, masterVolume } = command;
        const sound = sounds[soundId];

        if (isObs) {
            // OBS handles audio playback commands
            switch (action) {
                case 'play':
                    playSound(soundId);
                    break;
                case 'stopAll':
                    Object.values(sounds).forEach(s => {
                        if (s.source) {
                            s.source.onended = null; // Avoid sending ended event on manual stop
                            s.source.stop();
                            s.source = null;
                            // Manually notify of stop
                            sendCommand({ action: 'sound_ended', soundId: s.id });
                        }
                    });
                    break;
                case 'setVolume':
                    if (sound) {
                        sound.volume = volume;
                        sound.gainNode.gain.value = sound.volume * (sounds.masterVolume || 1);
                    }
                    break;
                case 'setMasterVolume':
                    sounds.masterVolume = masterVolume;
                    Object.values(sounds).forEach(s => {
                        if(s.gainNode) s.gainNode.gain.value = s.volume * sounds.masterVolume;
                    });
                    break;
            }
        } else {
            // Remote handles UI update commands
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

            // Load saved color or use default
            const savedColor = localStorage.getItem(`color_${sound.id}`);
            button.style.backgroundColor = savedColor || colorPresets[0];

            const presetsHTML = colorPresets.map(color => 
                `<div class="color-swatch" style="background-color: ${color};" data-color="${color}"></div>`
            ).join('');

            button.innerHTML = `
                <div class="btn-name">${sound.name.replace(/\.[^/.]+$/, "")}</div>
                <div class="controls-wrapper">
                    <input type="range" class="volume-slider" min="0" max="1" step="0.01" value="${sound.volume}">
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
                sendCommand({ action: 'setVolume', soundId: sound.id, volume: newVolume });
            });

            // Add event listeners for color swatches
            button.querySelectorAll('.color-swatch').forEach(swatch => {
                swatch.addEventListener('click', (e) => {
                    e.stopPropagation(); // Prevent button click event
                    const newColor = e.target.dataset.color;
                    button.style.backgroundColor = newColor;
                    localStorage.setItem(`color_${sound.id}`, newColor);
                });
            });
        };

        stopAllBtn.addEventListener('click', () => sendCommand({ action: 'stopAll' }));
        masterVolumeSlider.addEventListener('input', (e) => {
            const newMasterVolume = parseFloat(e.target.value);
            sendCommand({ action: 'setMasterVolume', masterVolume: newMasterVolume });
        });

        volumeModeBtn.addEventListener('click', () => {
            document.body.classList.toggle('volume-adjust-mode');
            const isAdjustMode = document.body.classList.contains('volume-adjust-mode');
            volumeModeBtn.textContent = isAdjustMode ? '🔊 調整中...' : '🔊 音量調整';
            volumeModeBtn.style.backgroundColor = isAdjustMode ? '#007bff' : '';
        });

        settingsBtn.addEventListener('click', () => modal.style.display = 'block');
        closeBtn.addEventListener('click', () => modal.style.display = 'none');
        window.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
        columnsInput.addEventListener('change', (e) => {
            soundBoard.style.setProperty('--columns', e.target.value);
        });

        fetch('/sounds').then(res => res.json()).then(files => {
            files.forEach((file, index) => {
                const soundId = `sound-${encodeURIComponent(file)}`;
                createButton({ id: soundId, name: file, volume: 1, defaultColor: colorPresets[index % colorPresets.length] });
            });
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