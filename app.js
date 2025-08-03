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

        // Only OBS client needs to listen for messages
        if (isObs) {
            ws.onmessage = (event) => {
                try {
                    const command = JSON.parse(event.data);
                    handleCommand(command);
                } catch (e) {
                    console.error('Failed to parse command:', event.data);
                }
            };
        }
    }

    // --- Command Sender (for Remote) ---
    function sendCommand(command) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(command));
        }
    }

    // --- Audio Engine (for OBS) ---
    async function initializeAudioEngine() {
        if (audioContext) return;
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        // Resume context on user interaction, although OBS might not need this
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        // Pre-load sound info
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
                buffer: null // Buffer will be loaded on demand
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
            console.warn(`Sound not loaded, attempting to load and play: ${soundId}`);
            loadSound(soundId).then(() => {
                if(sound.buffer) playSound(soundId); // Retry playing after loading
            });
            return;
        }
        const source = audioContext.createBufferSource();
        source.buffer = sound.buffer;
        source.connect(sound.gainNode);
        source.start(0);
    }

    // --- Command Handler (for OBS) ---
    function handleCommand(command) {
        const { action, soundId, volume, masterVolume } = command;
        const sound = sounds[soundId];

        switch (action) {
            case 'play':
                playSound(soundId);
                break;
            case 'stopAll':
                // This is a simple stop, doesn't handle fading etc.
                Object.values(sounds).forEach(s => {
                    if (s.source) s.source.stop();
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
                    s.gainNode.gain.value = s.volume * sounds.masterVolume;
                });
                break;
        }
    }

    // --- UI Initialization (for Remote) ---
    function initializeRemoteUI() {
        const soundBoard = document.getElementById('sound-board');
        const masterVolumeSlider = document.getElementById('master-volume');
        const stopAllBtn = document.getElementById('stop-all-btn');
        const settingsBtn = document.getElementById('settings-btn');
        const modal = document.getElementById('settings-modal');
        const closeBtn = document.querySelector('.close-btn');
        const columnsInput = document.getElementById('columns-input');

        const createButton = (sound) => {
            const button = document.createElement('div');
            button.className = 'sound-btn';
            button.dataset.id = sound.id;
            button.innerHTML = `
                <div class="btn-name">${sound.name.replace(/\.[^/.]+$/, "")}</div>
                <div class="controls-wrapper">
                    <input type="range" class="volume-slider" min="0" max="1" step="0.01" value="${sound.volume}">
                </div>
            `;
            soundBoard.appendChild(button);

            let longPressTimer;
            const longPressDuration = 500;
            let isLongPress = false;

            const onStart = (e) => {
                e.preventDefault();
                isLongPress = false;
                longPressTimer = setTimeout(() => {
                    isLongPress = true;
                    document.querySelectorAll('.sound-btn.show-controls').forEach(b => {
                        if (b !== button) b.classList.remove('show-controls');
                    });
                    button.classList.toggle('show-controls');
                }, longPressDuration);
            };

            const onEnd = () => {
                clearTimeout(longPressTimer);
                if (!isLongPress) {
                    sendCommand({ action: 'play', soundId: sound.id });
                }
            };

            button.addEventListener('mousedown', onStart);
            button.addEventListener('mouseup', onEnd);
            button.addEventListener('mouseleave', () => clearTimeout(longPressTimer));
            button.addEventListener('touchstart', onStart, { passive: false });
            button.addEventListener('touchend', onEnd);

            const volumeSlider = button.querySelector('.volume-slider');
            volumeSlider.addEventListener('input', (e) => {
                const newVolume = parseFloat(e.target.value);
                sendCommand({ action: 'setVolume', soundId: sound.id, volume: newVolume });
            });
        };

        stopAllBtn.addEventListener('click', () => sendCommand({ action: 'stopAll' }));
        masterVolumeSlider.addEventListener('input', (e) => {
            const newMasterVolume = parseFloat(e.target.value);
            sendCommand({ action: 'setMasterVolume', masterVolume: newMasterVolume });
        });
        settingsBtn.addEventListener('click', () => modal.style.display = 'block');
        closeBtn.addEventListener('click', () => modal.style.display = 'none');
        window.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });
        columnsInput.addEventListener('change', (e) => {
            soundBoard.style.setProperty('--columns', e.target.value);
        });

        // Fetch sounds and create buttons
        fetch('/sounds').then(res => res.json()).then(files => {
            files.forEach(file => {
                const soundId = `sound-${encodeURIComponent(file)}`;
                createButton({ id: soundId, name: file, volume: 1 });
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