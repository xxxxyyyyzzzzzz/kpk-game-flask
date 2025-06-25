// Helper function to show a custom alert modal
function showCustomAlert(message) {
    return new Promise(resolve => {
        const modalOverlay = document.createElement('div');
        modalOverlay.classList.add('modal-overlay');

        const modalContent = document.createElement('div');
        modalContent.classList.add('modal-content');

        const messageParagraph = document.createElement('p');
        messageParagraph.textContent = message;

        const buttonContainer = document.createElement('div');
        buttonContainer.classList.add('modal-buttons');

        const okButton = document.createElement('button');
        okButton.classList.add('modal-button');
        okButton.textContent = 'ОК';
        okButton.onclick = () => {
            document.body.removeChild(modalOverlay);
            resolve(true); // Resolve with true for OK
        };

        buttonContainer.appendChild(okButton);
        modalContent.appendChild(messageParagraph);
        modalContent.appendChild(buttonContainer);
        modalOverlay.appendChild(modalContent);
        document.body.appendChild(modalOverlay);
    });
}

// Helper function to show a custom confirm modal
function showCustomConfirm(message) {
    return new Promise(resolve => {
        const modalOverlay = document.createElement('div');
        modalOverlay.classList.add('modal-overlay');

        const modalContent = document.createElement('div');
        modalContent.classList.add('modal-content');

        const messageParagraph = document.createElement('p');
        messageParagraph.textContent = message;

        const buttonContainer = document.createElement('div');
        buttonContainer.classList.add('modal-buttons');

        const confirmButton = document.createElement('button');
        confirmButton.classList.add('modal-button');
        confirmButton.textContent = 'Так';
        confirmButton.onclick = () => {
            document.body.removeChild(modalOverlay);
            resolve(true); // Resolve with true if confirmed
        };

        const cancelButton = document.createElement('button');
        cancelButton.classList.add('modal-button');
        cancelButton.textContent = 'Ні';
        cancelButton.onclick = () => {
            document.body.removeChild(modalOverlay);
            resolve(false); // Resolve with false if cancelled
        };

        buttonContainer.appendChild(confirmButton);
        buttonContainer.appendChild(cancelButton);
        modalContent.appendChild(messageParagraph);
        modalContent.appendChild(buttonContainer);
        modalOverlay.appendChild(modalContent);
        document.body.appendChild(modalOverlay);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    const loginScreen = document.getElementById('login-screen');
    const mainMenuScreen = document.getElementById('main-menu-screen');
    const scoreScreen = document.getElementById('score-screen');
    const missionScreen = document.getElementById('mission-screen'); 
    const nicknameInput = document.getElementById('nickname-input');
    const loginButton = document.querySelector('.login-button');
    const loginMessage = document.getElementById('login-message');

    // Елементи для відображення нікнейму та балів на головному меню
    const currentUserMainMenuSpan = document.getElementById('current-user-main-menu');
    const currentScoreMainMenuSpan = document.getElementById('current-score-main-menu');

    const missionButton = document.getElementById('mission-button');
    const yebalyButton = document.getElementById('yebaly-button');
    const scoreBackButton = document.getElementById('score-back-button');
    const missionBackButton = document.getElementById('mission-back-button');
    const topPlayersList = document.getElementById('top-players-list');
    const scoreHistoryList = document.getElementById('score-history-list');
    const logoutButton = document.getElementById('logout-button');
    const resetGameButton = document.getElementById('reset-game-button');
    const newsButton = document.getElementById('news-button');
    const upgradesButton = document.getElementById('upgrades-button');
    const mainMenuHomeButton = document.getElementById('main-menu-home-button');

    // Елементи для відображення інформації на екрані "Місії"
    const currentUserMissionScreenSpan = document.getElementById('current-user-mission-screen');
    const currentScoreMissionScreenSpan = document.getElementById('current-score-mission-screen');
    const missionStatISpan = document.getElementById('mission-stat-i');
    const missionStatIISpan = document.getElementById('mission-stat-ii');
    const missionStatIIISpan = document.getElementById('mission-stat-iii');
    const missionHeaderTime = document.getElementById('mission-header-time'); // Час на екрані місій

    let currentNickname = null;
    let isCurrentUserActivePlayer = false; // Змінна для зберігання статусу гравця
    let updateTimeInterval; // Для оновлення часу (окремо від SocketIO)

    // Ініціалізація Socket.IO клієнта
    // Socket.IO для Deno сервера використовується без додаткових параметрів
    const socket = io(); 

    // Слухаємо події від сервера Socket.IO
    socket.on('connect', () => {
        console.log('Підключено до WebSocket!');
    });

    socket.on('disconnect', () => {
        console.log('Відключено від WebSocket.');
    });

    socket.on('score_updated', (data) => {
        console.log('Оновлення балів отримано через WebSocket:', data);
        // Оновлюємо бали поточного користувача, якщо це він
        if (currentNickname && data.nickname === currentNickname) {
            currentScoreMainMenuSpan.textContent = data.score;
            if (currentScoreMissionScreenSpan) {
                currentScoreMissionScreenSpan.textContent = data.score;
            }
        }
        // Якщо користувач на екрані балів, оновлюємо весь список
        if (scoreScreen && scoreScreen.classList.contains('visible')) {
            fetchScores(); // Повторно завантажуємо всі бали та історію
        }
    });

    socket.on('history_updated', (entry) => {
        console.log('Оновлення історії отримано через WebSocket:', entry);
        // Якщо користувач на екрані балів, оновлюємо історію
        if (scoreScreen && scoreScreen.classList.contains('visible')) {
            fetchScores(); // Поки що повністю оновлюємо список для простоти
        }
    });
    
    socket.on('player_logged_in', (data) => {
        console.log('Гравець увійшов через WebSocket:', data);
        // Оновлюємо UI, якщо це потрібно для інших глядачів
        if (scoreScreen.classList.contains('visible')) {
            fetchScores();
        }
    });

    socket.on('player_logged_out', (data) => {
        console.log('Гравець вийшов через WebSocket:', data);
        if (scoreScreen.classList.contains('visible')) {
            fetchScores();
        }
    });

    socket.on('game_reset', async () => {
        console.log('Сигнал скидання гри отримано через WebSocket.');
        // Переводимо на екран входу після скидання
        currentNickname = null;
        isCurrentUserActivePlayer = false;
        if (updateTimeInterval) {
            clearInterval(updateTimeInterval); // Зупиняємо оновлення часу
        }
        showScreen('login');
        loginMessage.textContent = 'Гра скинута. Будь ласка, увійдіть знову.';
        await showCustomAlert('Гра успішно скинута!');
        nicknameInput.value = ''; // Очищаємо поле введення
    });


    // Function to show a specific screen
    function showScreen(screenId) {
        // Hide all screens
        loginScreen.classList.remove('visible');
        mainMenuScreen.classList.remove('visible');
        scoreScreen.classList.remove('visible');
        missionScreen.classList.remove('visible'); 

        loginScreen.classList.add('hidden');
        mainMenuScreen.classList.add('hidden');
        scoreScreen.classList.add('hidden');
        missionScreen.classList.add('hidden'); 

        // Show the desired screen
        if (screenId === 'login') {
            loginScreen.classList.remove('hidden');
            loginScreen.classList.add('visible');
            nicknameInput.value = ''; // Clear nickname input on logout
            loginMessage.textContent = ''; // Clear any previous login messages
        } else if (screenId === 'main-menu') {
            mainMenuScreen.classList.remove('hidden');
            mainMenuScreen.classList.add('visible');
            fetchCurrentUserScore(); // Update score when entering main menu
            updateMainMenuUI(); // Оновлюємо UI головного меню, включаючи статус глядача та кнопки
        } else if (screenId === 'score') {
            scoreScreen.classList.remove('hidden');
            scoreScreen.classList.add('visible');
            fetchScores(); // Fetch scores when entering score screen
        } else if (screenId === 'mission') { 
            missionScreen.classList.remove('hidden');
            missionScreen.classList.add('visible');
            updateMissionScreenUI(); // Оновлюємо дані для екрану місій
        }
    }

    // Function to update the time
    async function updateTime() {
        try {
            const response = await fetch('/api/get_time'); 
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`HTTP error! status: ${response.status}, response: ${errorText}`);
                throw new Error(`Failed to fetch time: ${response.status}`);
            }
            const data = await response.json();
            const timeString = data.time;
            const timeElements = document.querySelectorAll('[id*="-header-time"]'); 
            timeElements.forEach(element => {
                element.textContent = timeString;
            });
        } catch (error) {
            console.error('Помилка отримання часу:', error);
        }
    }

    // Оновлення UI головного меню (статус гравця, кнопки)
    function updateMainMenuUI() {
        if (currentNickname) {
            // Оновлюємо текст нікнейму зі статусом глядача
            currentUserMainMenuSpan.textContent = `${currentNickname}${isCurrentUserActivePlayer ? '' : ' (Глядач)'}`;
            
            // Кнопка "Місії" вимикається для глядачів
            if (missionButton) missionButton.disabled = !isCurrentUserActivePlayer;

            // Кнопка "Скинути гру" вимикається для глядачів
            if (resetGameButton) resetGameButton.disabled = !isCurrentUserActivePlayer;

            // Кнопки "ЄБали", "Новини", "Прокачки" завжди доступні, якщо користувач увійшов
            if (yebalyButton) yebalyButton.disabled = false;
            if (newsButton) newsButton.disabled = false;
            if (upgradesButton) upgradesButton.disabled = false;

        } else {
            // Користувач не увійшов - вимикаємо всі кнопки дії/навігації
            currentUserMainMenuSpan.textContent = '';
            currentScoreMainMenuSpan.textContent = '';
            if (missionButton) missionButton.disabled = true;
            if (resetGameButton) resetGameButton.disabled = true;
            if (yebalyButton) yebalyButton.disabled = true;
            if (newsButton) newsButton.disabled = true;
            if (upgradesButton) upgradesButton.disabled = true;
        }
    }

    // Оновлення UI екрану місій
    async function updateMissionScreenUI() {
        if (currentNickname) {
            if (currentUserMissionScreenSpan) {
                currentUserMissionScreenSpan.textContent = `${currentNickname}`;
            }
            // Отримуємо актуальні дані гравця, щоб оновити missionStats
            try {
                const playerResponse = await fetch(`/api/get_player_score?nickname=${currentNickname}`); 
                if (playerResponse.ok) {
                    const playerData = await playerResponse.json();
                    if (currentScoreMissionScreenSpan) currentScoreMissionScreenSpan.textContent = playerData.score;
                    // TODO: Оновити mission stats з бекенду, коли вони будуть повертатися
                    // Для прикладу, поки що просто відображаємо статичні значення
                    if (missionStatISpan) missionStatISpan.textContent = '5';
                    if (missionStatIISpan) missionStatIISpan.textContent = '5';
                    if (missionStatIIISpan) missionStatIIISpan.textContent = '5';
                }
            } catch (error) {
                console.error('Помилка оновлення даних місій:', error);
            }
        } else {
            // Якщо не увійшов, очистити інформацію
            if (currentUserMissionScreenSpan) currentUserMissionScreenSpan.textContent = '';
            if (currentScoreMissionScreenSpan) currentScoreMissionScreenSpan.textContent = '';
            if (missionStatISpan) missionStatISpan.textContent = 'N/A';
            if (missionStatIISpan) missionStatIISpan.textContent = 'N/A';
            if (missionStatIIISpan) missionStatIIISpan.textContent = 'N/A';
        }
    }


    // Fetch current user score for main menu
    async function fetchCurrentUserScore() {
        if (!currentNickname) return;
        try {
            const response = await fetch(`/api/get_player_score?nickname=${currentNickname}`); 
            if (!response.ok) {
                const errorText = await response.text();
                console.error(`HTTP error! status: ${response.status}, response: ${errorText}`);
                throw new Error(`Failed to fetch current player score: ${response.status}`);
            }
            const data = await response.json();
            if (currentScoreMainMenuSpan) {
                currentScoreMainMenuSpan.textContent = data.score;
            }
        } catch (error) {
            console.error('Помилка отримання балів поточного користувача:', error);
            if (currentScoreMainMenuSpan) {
                currentScoreMainMenuSpan.textContent = 'N/A';
            }
        } finally {
            updateMainMenuUI(); 
        }
    }

    // Mission completion functionality
    async function fetchMissionCompletion() { 
        if (!currentNickname) {
            await showCustomAlert('Будь ласка, увійдіть, щоб виконати місію.');
            showScreen('login');
            return;
        }
        if (!isCurrentUserActivePlayer) {
            await showCustomAlert('Ви є глядачем і не можете виконувати місії.');
            return;
        }

        try {
            const response = await fetch('/api/complete_mission', { 
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ nickname: currentNickname })
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.message || `HTTP error! status: ${response.status}`);
            }
            
            await showCustomAlert(data.message); // Show success or info message
            // fetchCurrentUserScore(); // Видалено, оновлення прийде через WebSocket
            // updateMissionScreenUI(); // Видалено, оновлення прийде через WebSocket
        } catch (error) {
            console.error('Помилка виконання місії:', error);
            await showCustomAlert(`Помилка: ${error.message}`);
        }
    }

    // Fetch scores for the "ЄБали" screen
    async function fetchScores() {
        try {
            const playersResponse = await fetch('/api/get_players_info'); 
            if (!playersResponse.ok) {
                const errorText = await playersResponse.text();
                console.error(`HTTP error! status: ${playersResponse.status}, response: ${errorText}`);
                throw new Error(`Failed to fetch players: ${playersResponse.status}`);
            }
            const playersData = await playersResponse.json();

            // Оновлюємо Top Players
            topPlayersList.innerHTML = '';
            if (playersData && playersData.length > 0) {
                playersData.forEach(player => {
                    const div = document.createElement('div');
                    div.classList.add('player-score-item');
                    div.innerHTML = `<span>${player.nickname}</span> <span>${player.score} Балів</span>`;
                    topPlayersList.appendChild(div);
                });
            } else {
                topPlayersList.innerHTML = '<div class="player-score-item"><span>Немає активних гравців</span></div>';
            }

            // Fetch Score History
            const historyResponse = await fetch('/api/score_history');
            if (!historyResponse.ok) {
                const errorText = await historyResponse.text();
                console.error(`HTTP error! status: ${historyResponse.status}, response: ${errorText}`);
                throw new Error(`Failed to fetch score history: ${historyResponse.status}`);
            }
            const historyData = await historyResponse.json();

            // Update Score History
            scoreHistoryList.innerHTML = '';
            if (historyData && historyData.length > 0) {
                historyData.forEach(entry => {
                    const div = document.createElement('div');
                    div.classList.add('history-item');
                    const changeSign = entry.score_change > 0 ? '+' : '';
                    const scoreChangeClass = entry.score_change > 0 ? 'score-change-positive' : 'score-change-negative';
                    div.innerHTML = `
                        <span>${entry.player_id}</span>
                        <span class="${scoreChangeClass}">${changeSign}${entry.score_change}</span>
                        <span>${entry.reason || 'Невідомо'}</span>
                        <span>${new Date(entry.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    `;
                    scoreHistoryList.appendChild(div);
                });
            } else {
                scoreHistoryList.innerHTML = '<div class="history-item"><span>Немає історії балів для активних гравців</span></div>';
            }
        } catch (error) {
            console.error('Помилка отримання балів або історії:', error);
            topPlayersList.innerHTML = '<div class="player-score-item"><span>Помилка завантаження гравців</span></div>';
            scoreHistoryList.innerHTML = '<div class="history-item"><span>Помилка завантаження історії</span></div>';
        }
    }

    // Logout functionality
    logoutButton.addEventListener('click', async () => {
        try {
            const response = await fetch('/api/logout', { 
                method: 'POST'
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.message || `HTTP error! status: ${response.status}`);
            }

            currentNickname = null;
            isCurrentUserActivePlayer = false; 
            if (updateTimeInterval) {
                clearInterval(updateTimeInterval); // Stop time updates
            }
            showScreen('login');
            loginMessage.textContent = 'Ви вийшли з системи.';
            await showCustomAlert('Ви успішно вийшли.');
        } catch (error) {
            console.error('Помилка виходу:', error);
            await showCustomAlert(`Помилка виходу: ${error.message}`);
        }
    });

    // Reset Game functionality
    resetGameButton.addEventListener('click', async () => {
        if (!currentNickname) {
            await showCustomAlert('Будь ласка, увійдіть, щоб скинути гру.');
            showScreen('login');
            return;
        }
        if (!isCurrentUserActivePlayer) {
            await showCustomAlert('Ви не є активним гравцем і не можете скидати ігрову сесію.');
            return;
        }

        const confirmed = await showCustomConfirm('Ви впевнені, що хочете скинути гру? Всі дані (гравці, бали, історія) будуть видалені.');
        if (confirmed) {
            try {
                const response = await fetch('/api/reset_game_session', { 
                    method: 'POST'
                });

                const data = await response.json();
                if (!response.ok) {
                    throw new Error(data.message || `HTTP error! status: ${response.status}`);
                }

                // Логіка для UI-оновлень після скидання гри буде оброблятися слухачем game_reset Socket.IO
            } catch (error) {
                console.error('Помилка скидання гри:', error);
                await showCustomAlert(`Помилка скидання гри: ${error.message}`);
            }
        }
    });


    // Initial time update and set interval
    updateTime();
    updateTimeInterval = setInterval(updateTime, 1000); // Оновлюємо час кожну секунду


    // Event Listeners for navigation
    if (missionButton) {
        missionButton.addEventListener('click', () => {
            if (missionButton.disabled) {
                showCustomAlert('Ви є глядачем і не можете виконувати місії.');
                return;
            }
            showScreen('mission'); 
        });
    }
    if (yebalyButton) yebalyButton.addEventListener('click', () => showScreen('score'));
    if (scoreBackButton) scoreBackButton.addEventListener('click', () => showScreen('main-menu'));
    if (missionBackButton) missionBackButton.addEventListener('click', () => showScreen('main-menu'));
    if (mainMenuHomeButton) mainMenuHomeButton.addEventListener('click', () => showScreen('main-menu'));

    // Placeholder for other buttons (will just alert for now)
    if (newsButton) newsButton.addEventListener('click', async () => {
        if (newsButton.disabled) return;
        await showCustomAlert('Новини поки що недоступні.');
    });
    if (upgradesButton) upgradesButton.addEventListener('click', async () => {
        if (upgradesButton.disabled) return;
        await showCustomAlert('Прокачки поки що недоступні.');
    });


    // Check if user is already logged in on page load (e.g., from session)
    async function checkLoginStatus() {
        try {
            const response = await fetch('/api/get_current_user'); 
            if (!response.ok) {
                console.warn(`Failed to get current user status: ${response.status}`);
                showScreen('login');
                return;
            }
            const data = await response.json();
            if (data.nickname) {
                currentNickname = data.nickname;
                isCurrentUserActivePlayer = data.is_active; 
                if (currentUserMainMenuSpan) {
                    currentUserMainMenuSpan.textContent = currentNickname;
                }
                showScreen('main-menu');
            } else {
                showScreen('login');
            }
        } catch (error) {
            console.error('Помилка перевірки статусу входу:', error);
            showScreen('login'); // Fallback to login if check fails
        } finally {
            updateMainMenuUI(); 
        }
    }

    checkLoginStatus(); // Call on page load
});
