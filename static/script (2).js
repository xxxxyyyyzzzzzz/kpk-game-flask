// Ensure this script is loaded AFTER socket.io.min.js in index.html
// <script src="https://cdnjs.cloudflare.com/ajax/libs/socket.io/4.0.0/socket.io.min.js"></script>

document.addEventListener('DOMContentLoaded', () => {
    // Елементи інтерфейсу
    const loginScreen = document.getElementById('login-screen');
    const mainMenuScreen = document.getElementById('main-menu-screen');
    const missionScreen = document.getElementById('mission-screen');
    const scoreScreen = document.getElementById('score-screen');

    const nicknameInput = document.getElementById('nickname-input');
    const loginButton = document.querySelector('.login-button');
    const loginMessage = document.getElementById('login-message');

    const mainMenuHeaderTime = document.getElementById('main-menu-header-time');
    const missionHeaderTime = document.getElementById('mission-header-time');
    const scoreHeaderTime = document.getElementById('score-header-time');

    const missionButton = document.getElementById('mission-button');
    const yebalyButton = document.getElementById('yebaly-button'); // ЄБали
    const newsButton = document.getElementById('news-button');
    const upgradesButton = document.getElementById('upgrades-button');
    const logoutButton = document.getElementById('logout-button');
    const resetGameButton = document.getElementById('reset-game-button');

    const missionBackButton = document.getElementById('mission-back-button');
    const scoreBackButton = document.getElementById('score-back-button');

    // Елементи для відображення інформації гравця
    const currentUserMainMenu = document.getElementById('current-user-main-menu');
    const currentScoreMainMenu = document.getElementById('current-score-main-menu');
    const currentUserMissionScreen = document.getElementById('current-user-mission-screen');
    const currentScoreMissionScreen = document.getElementById('current-score-mission-screen');
    const missionStatI = document.getElementById('mission-stat-i');
    const missionStatII = document.getElementById('mission-stat-ii');
    const missionStatIII = document.getElementById('mission-stat-iii');

    // Custom Modal elements
    const customModal = document.getElementById('custom-modal');
    const modalMessage = document.getElementById('modal-message');
    const modalOkButton = document.getElementById('modal-ok-button');
    const modalCancelButton = document.getElementById('modal-cancel-button');

    let gameData = {
        nickname: '',
        score: 0,
        missionStats: {
            I: 5, // These are static mock values for now, not updated by +/- buttons
            II: 5,
            III: 5
        },
        scoreHistory: []
    };

    // Socket.IO client initialization
    // ВКАЗУЄМО ЯВНО ВИКОРИСТОВУВАТИ ТІЛЬКИ "polling" ТРАНСПОРТ
    const socket = io({ transports: ['polling'] });

    // --- Utility Functions ---

    // Global debounce timer for UI updates
    let debounceTimer;

    function debounce(func, delay) {
        return function(...args) {
            const context = this;
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => func.apply(context, args), delay);
        };
    }

    // Function to display custom modal
    function showModal(message, isConfirm = false) {
        modalMessage.textContent = message;
        customModal.classList.remove('hidden');
        if (isConfirm) {
            modalCancelButton.classList.remove('hidden');
            return new Promise(resolve => {
                modalOkButton.onclick = () => {
                    customModal.classList.add('hidden');
                    resolve(true);
                };
                modalCancelButton.onclick = () => {
                    customModal.classList.add('hidden');
                    resolve(false);
                };
            });
        } else {
            modalCancelButton.classList.add('hidden');
            return new Promise(resolve => {
                modalOkButton.onclick = () => {
                    customModal.classList.add('hidden');
                    resolve(true);
                };
            });
        }
    }

    // Function to update time display
    function updateTime() {
        const now = new Date();
        const hours = String(now.getHours()).padStart(2, '0');
        const minutes = String(now.getMinutes()).padStart(2, '0');
        const timeString = `${hours}:${minutes}`;
        mainMenuHeaderTime.textContent = timeString;
        missionHeaderTime.textContent = timeString;
        scoreHeaderTime.textContent = timeString;
    }

    // Function to update UI elements with current game data
    function updateUI() {
        if (gameData.nickname) {
            currentUserMainMenu.textContent = gameData.nickname;
            currentScoreMainMenu.textContent = gameData.score;
            currentUserMissionScreen.textContent = gameData.nickname;
            currentScoreMissionScreen.textContent = gameData.score;
            missionStatI.textContent = gameData.missionStats.I;
            missionStatII.textContent = gameData.missionStats.II;
            missionStatIII.textContent = gameData.missionStats.III;
        }
    }

    // Function to switch screens
    function showScreen(screenToShow) {
        const allScreens = [loginScreen, mainMenuScreen, missionScreen, scoreScreen];
        allScreens.forEach(screen => {
            if (screen === screenToShow) {
                screen.classList.remove('hidden');
                screen.classList.add('visible');
            } else {
                screen.classList.remove('visible');
                screen.classList.add('hidden');
            }
        });
    }

    // Function to render score history (ЄБали - Історія балів)
    function renderScoreHistory() {
        const scoreHistoryList = document.getElementById('score-history-list');
        scoreHistoryList.innerHTML = ''; // Clear previous history

        if (!gameData.scoreHistory || gameData.scoreHistory.length === 0) {
            scoreHistoryList.innerHTML = '<p class="history-item">Історія балів порожня.</p>';
            return;
        }

        // Sort history by timestamp in descending order (newest first) for display
        const sortedHistory = [...gameData.scoreHistory].sort((a, b) => {
            return new Date(b.timestamp) - new Date(a.timestamp);
        }).slice(0, 20); // Ensure only up to 20 items are rendered initially

        sortedHistory.forEach(entry => {
            const historyItem = document.createElement('div');
            historyItem.classList.add('history-item');

            const scoreChangeClass = entry.type === 'added' ? 'score-change-positive' : 'score-change-negative';
            const sign = entry.type === 'added' ? '+' : '-';
            const formattedTime = new Date(entry.timestamp).toLocaleString(); // Format timestamp for display

            historyItem.innerHTML = `
                <span>${formattedTime}</span>
                <span>${entry.missionName ? `(${entry.missionName})` : ''}</span>
                <span class="${scoreChangeClass}">${sign}${entry.amount} Балів</span>
            `;
            scoreHistoryList.appendChild(historyItem);
        });
    }

    // Debounced version of renderTopPlayers
    const debouncedRenderTopPlayers = debounce(renderTopPlayers, 300);

    // Function to render top players (ЄБали - Топ гравців)
    async function renderTopPlayers() {
        const topPlayersList = document.getElementById('top-players-list');
        topPlayersList.innerHTML = ''; // Clear previous

        try {
            const response = await fetch('/api/get_players_info'); // Updated endpoint
            const players = await response.json();

            if (players.length === 0) {
                topPlayersList.innerHTML = '<p class="player-score-item">Наразі немає інших гравців.</p>';
                return;
            }

            players.forEach(player => {
                const playerItem = document.createElement('div');
                playerItem.classList.add('player-score-item');
                playerItem.innerHTML = `
                    <span>${player.nickname}</span>
                    <span>${player.score} Балів</span>
                `;
                topPlayersList.appendChild(playerItem);
            });
        } catch (error) {
            console.error('Помилка при отриманні топ гравців:', error);
            topPlayersList.innerHTML = '<p class="player-score-item">Не вдалося завантажити топ гравців.</p>';
        }
    }

    // --- Backend API Interaction Functions (Updated) ---

    async function apiLogin(nickname) {
        try {
            const response = await fetch('/api/login', { // Updated endpoint
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nickname })
            });
            const data = await response.json();
            if (response.ok) {
                return data.userData;
            } else {
                showModal(`Помилка входу: ${data.message}`);
                return null;
            }
        } catch (error) {
            console.error('Помилка при запиті до API входу:', error);
            showModal('Помилка підключення до сервера.');
            return null;
        }
    }

    async function apiCompleteMission(nickname, missionName, scoreChange, newMissionStats) {
        try {
            const response = await fetch('/api/complete_mission', { // Updated endpoint
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    nickname: nickname,
                    missionName: missionName, // Send missionName for history
                    scoreChange: scoreChange, // Send score change for backend calculation (optional, backend can generate)
                    missionStats: newMissionStats // Send updated missionStats
                })
            });
            const data = await response.json();
            if (response.ok) {
                return { success: true, message: data.message, updatedScore: data.updatedScore, updatedMissionStats: data.updatedMissionStats };
            } else {
                showModal(`Помилка виконання місії: ${data.message}`);
                return { success: false, message: data.message };
            }
        } catch (error) {
            console.error('Помилка при запиті до API виконання місії:', error);
            showModal('Помилка підключення.');
            return { success: false, message: 'Помилка підключення.' };
        }
    }

    async function apiResetGameSession(nickname) { // Renamed and updated endpoint
        try {
            const response = await fetch('/api/reset_game_session', { // Updated endpoint
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ nickname }) // Sending nickname for server-side validation
            });
            const data = await response.json();
            if (response.ok) {
                return true; // Successfully reset
            } else {
                showModal(`Помилка скидання: ${data.message}`);
                return false;
            }
        } catch (error) {
            console.error('Помилка при запиті до API скидання даних:', error);
            showModal('Помилка підключення.');
            return false;
        }
    }

    // --- Socket.IO Event Listeners ---
    socket.on('connect', () => {
        console.log('Підключено до WebSocket (або Long Polling)!');
        // On reconnect, ensure UI is up-to-date
        if (gameData.nickname) {
            updateUI(); // To ensure current user score/stats are fresh
        }
        // If on score screen, re-render everything
        if (scoreScreen && !scoreScreen.classList.contains('hidden')) {
            renderTopPlayers(); // Fetch and render top players
            // Fetch score history and render it
            fetch('/api/score_history')
                .then(res => res.json())
                .then(history => {
                    gameData.scoreHistory = history; // Update local copy
                    renderScoreHistory();
                }).catch(error => console.error("Error fetching history on connect/reconnect:", error));
        }
    });

    socket.on('disconnect', () => {
        console.log('Відключено від WebSocket (або Long Polling).');
    });

    socket.on('score_updated', (data) => {
        console.log('Оновлення балів отримано через WebSocket:', data);
        if (gameData.nickname === data.nickname) {
            gameData.score = data.score; // Update current user's score
            updateUI(); // Refresh UI for current user
        }
        // Only update top players list if score screen is visible
        if (scoreScreen && !scoreScreen.classList.contains('hidden')) {
            debouncedRenderTopPlayers(); // Use debounced version
        }
    });

    socket.on('history_updated', (entry) => {
        console.log('Оновлення історії отримано через WebSocket:', entry);
        const formattedEntry = {
            timestamp: entry.timestamp,
            type: entry.score_change > 0 ? 'added' : 'removed',
            amount: Math.abs(entry.score_change),
            missionName: entry.reason
        };
        // Update local gameData.scoreHistory
        gameData.scoreHistory.unshift(formattedEntry);
        // Keep only the latest 20 entries locally
        if (gameData.scoreHistory.length > 20) {
            gameData.scoreHistory.pop();
        }

        if (scoreScreen && !scoreScreen.classList.contains('hidden')) {
            // Directly prepend the new item to the DOM if score screen is visible
            const scoreHistoryList = document.getElementById('score-history-list');
            const historyItem = document.createElement('div');
            historyItem.classList.add('history-item');

            const scoreChangeClass = formattedEntry.type === 'added' ? 'score-change-positive' : 'score-change-negative';
            const sign = formattedEntry.type === 'added' ? '+' : '-';
            const formattedTime = new Date(formattedEntry.timestamp).toLocaleString();

            historyItem.innerHTML = `
                <span>${formattedTime}</span>
                <span>${formattedEntry.missionName ? `(${formattedEntry.missionName})` : ''}</span>
                <span class="${scoreChangeClass}">${sign}${formattedEntry.amount} Балів</span>
            `;
            scoreHistoryList.prepend(historyItem); // Prepend to show newest first

            // Ensure max 20 items are displayed in DOM if we are directly prepending
            while (scoreHistoryList.children.length > 20) {
                scoreHistoryList.removeChild(scoreHistoryList.lastChild);
            }
        }
    });

    socket.on('player_logged_in', (data) => {
        console.log('Гравець увійшов/оновлено:', data);
        // Always update top players on login/logout as active players list might change
        if (scoreScreen && !scoreScreen.classList.contains('hidden')) {
            debouncedRenderTopPlayers(); // Use debounced version
            // Re-fetch score history as its content depends on active players
            fetch('/api/score_history')
                .then(res => res.json())
                .then(history => {
                    gameData.scoreHistory = history; // Update local copy
                    renderScoreHistory();
                }).catch(error => console.error("Error fetching history on player_logged_in:", error));
        }
    });

    socket.on('player_logged_out', (data) => {
        console.log('Гравець вийшов:', data);
        if (scoreScreen && !scoreScreen.classList.contains('hidden')) {
            debouncedRenderTopPlayers(); // Use debounced version
            // Re-fetch score history as its content depends on active players
            fetch('/api/score_history')
                .then(res => res.json())
                .then(history => {
                    gameData.scoreHistory = history; // Update local copy
                    renderScoreHistory();
                }).catch(error => console.error("Error fetching history on player_logged_out:", error));
        }
    });

    socket.on('game_reset', () => {
        console.log('Сигнал скидання гри отримано через WebSocket.');
        // Reset local gameData
        gameData = {
            nickname: '',
            score: 0,
            missionStats: { I: 5, II: 5, III: 5 },
            scoreHistory: []
        };
        updateUI(); // Clear UI
        showScreen(loginScreen);
        nicknameInput.value = '';
        loginMessage.textContent = 'Гра скинута. Будь ласка, увійдіть знову.';
        showModal('Гра успішно скинута! Всі дані очищено.');
    });

    // --- Event Listeners ---

    // Login Button Click
    loginButton.addEventListener('click', async () => {
        const nickname = nicknameInput.value.trim();
        if (nickname) {
            const userData = await apiLogin(nickname);
            if (userData) {
                gameData = userData; // Update local gameData with data from server
                updateUI();
                showScreen(mainMenuScreen);
                // Save nickname to localStorage to try auto-logging in next time
                localStorage.setItem('lastNickname', nickname);
            }
        } else {
            loginMessage.textContent = 'Будь ласка, введіть ваш нікнейм.';
        }
    });

    // Main Menu Buttons
    missionButton.addEventListener('click', () => {
        updateUI(); // Ensure mission stats are updated
        showScreen(missionScreen);
    });

    yebalyButton.addEventListener('click', async () => {
        // Always fetch fresh data when entering the score screen
        await renderTopPlayers(); // Fetch and render top players
        try {
            const response = await fetch('/api/score_history');
            const history = await response.json();
            gameData.scoreHistory = history; // Update local copy
            renderScoreHistory();
        } catch (error) {
            console.error("Помилка при завантаженні історії балів:", error);
            showModal("Не вдалося завантажити історію балів.");
        }
        showScreen(scoreScreen);
    });

    // Placeholder for News Button
    newsButton.addEventListener('click', () => {
        showModal('Розділ "Новини" ще в розробці.');
    });

    // Placeholder for Upgrades Button
    upgradesButton.addEventListener('click', () => {
        showModal('Розділ "Прокачки" ще в розробці.');
    });

    logoutButton.addEventListener('click', async () => {
        const confirmed = await showModal('Ви впевнені, що хочете вийти?', true);
        if (confirmed) {
            localStorage.removeItem('lastNickname'); 
            try {
                await fetch('/api/logout', { method: 'POST' }); // Updated endpoint
            } catch (error) {
                console.error("Помилка при виході:", error);
            }
            gameData = {
                nickname: '',
                score: 0,
                missionStats: { I: 5, II: 5, III: 5 },
                scoreHistory: []
            };
            updateUI();
            showScreen(loginScreen);
        }
    });

    resetGameButton.addEventListener('click', async () => {
        const confirmed = await showModal('Ви впевнені, що хочете скинути весь прогрес гри? Цю дію не можна буде скасувати.', true);
        if (confirmed) {
            const success = await apiResetGameSession(gameData.nickname); // Call backend
            if (success) {
                localStorage.removeItem('lastNickname'); // Clear auto-login
                // Backend will emit 'game_reset' which triggers the local reset and UI update
            }
        }
    });

    // Back Buttons
    missionBackButton.addEventListener('click', () => {
        showScreen(mainMenuScreen);
    });

    scoreBackButton.addEventListener('click', () => {
        showScreen(mainMenuScreen);
    });

    // Mission interaction logic
    document.querySelectorAll('.mission-action-button-small').forEach(button => {
        button.addEventListener('click', async (event) => {
            if (!gameData.nickname) {
                showModal('Будь ласка, увійдіть, щоб виконувати місії.');
                return;
            }

            const missionItem = event.target.closest('.mission-item');
            const missionName = missionItem.querySelector('.mission-name').textContent;
            
            // Determine score change
            let scoreChange = 0;
            if (event.target.textContent === '+') {
                scoreChange = 10; // Example score gain
                // For demonstration, let's increment a mission stat on the client side
                // This is where you would link this to actual mission progression
                if (missionName.includes('першого рівня')) gameData.missionStats.I += 1;
                else if (missionName.includes('другого рівня')) gameData.missionStats.II += 1;
                else if (missionName.includes('третього рівня')) gameData.missionStats.III += 1;

            } else if (event.target.textContent === '-') {
                scoreChange = -5; // Example score loss
                // For demonstration, let's decrement a mission stat on the client side
                if (missionName.includes('першого рівня') && gameData.missionStats.I > 0) gameData.missionStats.I -= 1;
                else if (missionName.includes('другого рівня') && gameData.missionStats.II > 0) gameData.missionStats.II -= 1;
                else if (missionName.includes('третього рівня') && gameData.missionStats.III > 0) gameData.missionStats.III -= 1;
            }

            // Call backend to complete mission and update score/history
            const result = await apiCompleteMission(gameData.nickname, missionName, scoreChange, gameData.missionStats);
            
            if (result.success) {
                // Update local gameData from backend response (score and missionStats)
                gameData.score = result.updatedScore;
                if (result.updatedMissionStats) {
                    gameData.missionStats = result.updatedMissionStats; 
                }
                updateUI(); // Update UI after score change and mission stats sync
                showModal(result.message); // Show backend message
            }
            // No need to call addScoreHistory locally, backend will emit 'history_updated'
        });
    });

    // Initial setup
    updateTime(); // Initial time display
    setInterval(updateTime, 60000); // Update time every minute

    // Try to auto-login if a nickname was previously stored
    const lastNickname = localStorage.getItem('lastNickname');
    if (lastNickname) {
        nicknameInput.value = lastNickname; // Pre-fill nickname
        loginButton.click(); // Programmatically click login to trigger API call
    } else {
        showScreen(loginScreen);
    }
});
