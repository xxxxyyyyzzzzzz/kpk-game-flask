const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const session = require('express-session'); // Для управління сесіями
const crypto = require('crypto'); // Для генерації секретного ключа

const app = express();
const server = http.createServer(app);

// Ініціалізація Socket.IO
// cors_allowed_origins="*" дозволяє підключення з будь-яких доменів (для розробки)
const io = socketIo(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

// Шлях до файлу бази даних SQLite
// УВАГА: SQLite на Render НЕ ЗБЕРІГАЄ ДАНІ постійно.
// Кожен деплой або перезапуск динамо призводить до втрати даних.
// Для постійного зберігання потрібен Render Postgres.
const DATABASE = path.join(__dirname, 'kpk_game.db');

// Генеруємо секретний ключ для сесії
// const SESSION_SECRET = crypto.randomBytes(32).toString('hex');
// console.log("Секретний ключ сесії:", SESSION_SECRET); // Виведи один раз і захардкодь його нижче, як в Python
const SESSION_SECRET = 'e57724220b3b4f63c87895e7c80529d4791054b1f618d3600f6074127c525f0a1c6298e874558509'; // Використовуємо той самий, що був у Python

// Налаштування сесій Express
app.use(session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === 'production' } // secure: true for HTTPS in production
}));

// Middleware для обробки JSON-запитів
app.use(express.json());
// Middleware для подачі статичних файлів (CSS, JS)
app.use(express.static(path.join(__dirname, 'static')));

// Глобальна кімната для трансляції подій всім підключеним клієнтам
const BROADCAST_ROOM = 'global_broadcast_room';

// Константа для максимальної кількості активних гравців (перших, хто зареєструвався)
const MAX_ACTIVE_PLAYERS = 4;
const COOLDOWN_SECONDS = 2;

// Функція для підключення до бази даних
function getDb() {
    return new sqlite3.Database(DATABASE);
}

// Функція для ініціалізації схеми бази даних
function initDb() {
    const db = getDb();
    db.serialize(() => {
        db.run(`
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nickname TEXT UNIQUE NOT NULL,
                score INTEGER DEFAULT 0,
                mission_stats TEXT DEFAULT '{}',
                last_mission_time TEXT,
                registration_time TEXT NOT NULL
            );
        `);
        db.run(`
            CREATE TABLE IF NOT EXISTS score_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                score_change INTEGER NOT NULL,
                reason TEXT,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users (id)
            );
        `);
    });
    db.close();
}

// Викликаємо ініціалізацію бази даних при запуску програми
initDb();

// Допоміжна функція для отримання нікнеймів активних гравців
async function getActivePlayerNicknames() {
    const db = getDb();
    return new Promise((resolve, reject) => {
        db.all('SELECT nickname FROM users ORDER BY registration_time ASC LIMIT ?', [MAX_ACTIVE_PLAYERS], (err, rows) => {
            db.close();
            if (err) {
                console.error("Error fetching active player nicknames:", err);
                return reject(err);
            }
            resolve(rows.map(row => row.nickname));
        });
    });
}

// Функції для взаємодії з даними через SQLite
async function getPlayer(nickname) {
    const db = getDb();
    return new Promise((resolve, reject) => {
        db.get('SELECT * FROM users WHERE nickname = ?', [nickname], (err, row) => {
            db.close();
            if (err) {
                console.error("Error fetching player:", err);
                return reject(err);
            }
            if (row) {
                row.mission_stats = JSON.parse(row.mission_stats || '{}');
            }
            resolve(row);
        });
    });
}

async function createPlayer(nickname) {
    const db = getDb();
    return new Promise((resolve, reject) => {
        db.run(
            'INSERT INTO users (nickname, score, mission_stats, last_mission_time, registration_time) VALUES (?, ?, ?, ?, ?)',
            [nickname, 0, JSON.stringify({'I': 5, 'II': 5, 'III': 5}), null, new Date().toISOString()],
            function(err) {
                db.close();
                if (err) {
                    console.error("Error creating player:", err);
                    return reject(err);
                }
                resolve(this.lastID); // this.lastID повертає ID новоствореного запису
            }
        );
    });
}

async function updatePlayerScoreInternal(dbInstance, userId, nickname, amount, reason = "Місія виконана") {
    return new Promise((resolve, reject) => {
        dbInstance.get('SELECT score FROM users WHERE id = ?', [userId], (err, row) => {
            if (err) {
                console.error("Error getting score for internal update:", err);
                return reject(err);
            }
            if (!row) {
                return resolve(false); // Гравець не знайдений
            }

            const newScore = row.score + amount;
            dbInstance.run('UPDATE users SET score = ? WHERE id = ?', [newScore, userId], (err) => {
                if (err) {
                    console.error("Error updating score internally:", err);
                    return reject(err);
                }
                dbInstance.run(
                    'INSERT INTO score_history (user_id, score_change, reason, timestamp) VALUES (?, ?, ?, ?)',
                    [userId, amount, reason, new Date().toISOString()],
                    (err) => {
                        if (err) {
                            console.error("Error inserting score history internally:", err);
                            return reject(err);
                        }
                        resolve(newScore); // Повертаємо новий рахунок
                    }
                );
            });
        });
    });
}


async function resetAllGameData() {
    const db = getDb();
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('DELETE FROM users', (err) => {
                if (err) return reject(err);
            });
            db.run('DELETE FROM score_history', (err) => {
                if (err) return reject(err);
            });
            db.close((err) => {
                if (err) return reject(err);
                io.to(BROADCAST_ROOM).emit('game_reset'); // Емітуємо в BROADCAST_ROOM
                resolve(true);
            });
        });
    });
}


// Маршрути Express
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'templates', 'index.html'));
});

app.post('/api/login', async (req, res) => {
    const { nickname } = req.body;

    if (!nickname) {
        return res.status(400).json({ message: 'Нікнейм не може бути порожнім' });
    }

    try {
        let player = await getPlayer(nickname);
        let message;
        let isNewPlayer = false;

        if (!player) {
            await createPlayer(nickname);
            message = `Привіт, ${nickname}! Ти новий гравець!`;
            player = await getPlayer(nickname); // Отримуємо дані щойно створеного гравця
            if (!player) {
                return res.status(500).json({ message: 'Не вдалося створити або отримати дані нового гравця.' });
            }
            isNewPlayer = true;
        } else {
            message = `З поверненням, ${nickname}!`;
        }

        req.session.nickname = nickname; // Зберігаємо нікнейм у сесії

        const activePlayers = await getActivePlayerNicknames();
        const isActive = activePlayers.includes(nickname);

        const db = getDb();
        const scoreHistoryRows = await new Promise((resolve, reject) => {
            db.all("SELECT score_change, reason, timestamp FROM score_history WHERE user_id = ? ORDER BY id DESC LIMIT 20", [player.id], (err, rows) => {
                db.close();
                if (err) return reject(err);
                resolve(rows);
            });
        });
        
        const scoreHistoryForFrontend = scoreHistoryRows.map(entry => ({
            type: entry.score_change > 0 ? 'added' : 'removed',
            amount: Math.abs(entry.score_change),
            missionName: entry.reason,
            timestamp: entry.timestamp
        }));

        const userData = {
            nickname: player.nickname,
            score: player.score,
            missionStats: player.mission_stats,
            scoreHistory: scoreHistoryForFrontend
        };

        // Емітуємо в BROADCAST_ROOM
        io.to(BROADCAST_ROOM).emit('player_logged_in', {
            nickname: nickname,
            score: player.score,
            is_active: isActive
        });

        res.json({ message, userData, is_active: isActive });

    } catch (e) {
        console.error(`Помилка в маршруті /api/login: ${e.message}`, e.stack);
        res.status(500).json({ message: `Серверна помилка при вході: ${e.message}. Перевірте логи сервера.` });
    }
});

app.post('/api/logout', (req, res) => {
    const nickname = req.session.nickname;
    if (nickname) {
        req.session.destroy(err => {
            if (err) {
                console.error("Error destroying session:", err);
                return res.status(500).json({ message: "Помилка при виході." });
            }
            io.to(BROADCAST_ROOM).emit('player_logged_out', { nickname });
            res.json({ message: 'Ви успішно вийшли.' });
        });
    } else {
        res.json({ message: 'Ви не були увійдені.' });
    }
});

app.get('/api/get_time', (req, res) => {
    const currentTime = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    res.json({ time: currentTime });
});

app.get('/api/get_current_user', async (req, res) => {
    const nickname = req.session.nickname;
    if (nickname) {
        try {
            const player = await getPlayer(nickname);
            if (player) {
                const activePlayers = await getActivePlayerNicknames();
                const isActive = activePlayers.includes(nickname);
                return res.json({ nickname: player.nickname, score: player.score, status: 'logged_in', is_active: isActive });
            } else {
                req.session.destroy(err => { // Якщо гравця немає в DB, видаляємо сесію
                    if (err) console.error("Error destroying session after missing player:", err);
                });
                return res.json({ nickname: null, status: 'logged_out', is_active: false });
            }
        } catch (e) {
            console.error("Error in /api/get_current_user:", e);
            return res.status(500).json({ message: "Серверна помилка при отриманні поточного користувача." });
        }
    } else {
        res.json({ nickname: null, status: 'logged_out', is_active: false });
    }
});

app.get('/api/get_player_score', async (req, res) => {
    let nickname = req.query.nickname || req.session.nickname;
    if (!nickname) {
        return res.status(400).json({ message: 'Нікнейм не вказано або ви не увійшли' });
    }

    try {
        const player = await getPlayer(nickname);
        if (player) {
            res.json({ nickname: player.nickname, score: player.score });
        } else {
            res.status(404).json({ message: 'Гравець не знайдений' });
        }
    } catch (e) {
        console.error("Error in /api/get_player_score:", e);
        res.status(500).json({ message: "Серверна помилка при отриманні балів гравця." });
    }
});

app.post('/api/complete_mission', async (req, res) => {
    const { nickname: clientNickname, missionStats } = req.body;
    const currentSessionNickname = req.session.nickname;

    if (!currentSessionNickname) {
        return res.status(401).json({ message: 'Ви не увійшли. Будь ласка, увійдіть, щоб виконати місію.' });
    }

    // Перевіряємо, чи нікнейм у сесії відповідає нікнейму у запиті, або просто використовуємо нікнейм сесії
    const actualNickname = clientNickname && clientNickname === currentSessionNickname ? clientNickname : currentSessionNickname;

    try {
        const activePlayers = await getActivePlayerNicknames();
        if (!activePlayers.includes(actualNickname)) {
            return res.status(403).json({ message: 'Ви є глядачем і не можете виконувати місії.' });
        }

        const player = await getPlayer(actualNickname);
        if (!player) {
            return res.status(404).json({ message: 'Гравець не знайдений.' });
        }

        const lastMissionTimeStr = player.last_mission_time;
        if (lastMissionTimeStr) {
            const lastMissionTime = new Date(lastMissionTimeStr);
            const timeDiffSeconds = (new Date() - lastMissionTime) / 1000;
            if (timeDiffSeconds < COOLDOWN_SECONDS) {
                const remainingTime = Math.round(COOLDOWN_SECONDS - timeDiffSeconds);
                return res.status(429).json({ message: `Зачекайте ${remainingTime} секунд перед наступною місією.` });
            }
        }

        const pointsToAdd = Math.floor(Math.random() * (40 - 5 + 1)) + 5; // Random int between 5 and 40

        const db = getDb();
        try {
            await new Promise((resolve, reject) => {
                db.serialize(() => {
                    db.run('BEGIN TRANSACTION;', (err) => { // Починаємо транзакцію
                        if (err) return reject(err);
                    });

                    updatePlayerScoreInternal(db, player.id, actualNickname, pointsToAdd, "Виконано місію")
                        .then(newScore => {
                            if (newScore === false) { // Якщо гравець не знайдений
                                return Promise.reject(new Error("Не вдалося оновити бали гравця."));
                            }
                            db.run(
                                'UPDATE users SET last_mission_time = ?, mission_stats = ? WHERE id = ?',
                                [new Date().toISOString(), JSON.stringify(missionStats || player.mission_stats), player.id],
                                (err) => {
                                    if (err) return reject(err);
                                    db.run('COMMIT;', (err) => { // Комітуємо транзакцію
                                        if (err) return reject(err);
                                        resolve(newScore); // Повертаємо новий рахунок
                                    });
                                }
                            );
                        })
                        .catch(err => {
                            db.run('ROLLBACK;', () => { // Відкочуємо транзакцію у випадку помилки
                                console.error("Transaction rolled back due to error:", err);
                                reject(err);
                            });
                        });
                });
            });

            // Отримуємо новий актуальний рахунок для еміту
            const updatedPlayer = await getPlayer(actualNickname);
            const newScoreForEmit = updatedPlayer ? updatedPlayer.score : player.score + pointsToAdd; // Fallback

            io.to(BROADCAST_ROOM).emit('score_updated', { nickname: actualNickname, score: newScoreForEmit });
            io.to(BROADCAST_ROOM).emit('history_updated', {
                player_id: actualNickname,
                score_change: pointsToAdd,
                reason: "Виконано місію",
                timestamp: new Date().toISOString()
            });

            res.json({
                message: `Місія виконана! Ви отримали ${pointsToAdd} балів. Всього балів: ${newScoreForEmit}`,
                updatedScore: newScoreForEmit,
                updatedMissionStats: missionStats || player.mission_stats
            });
        } catch (e) {
            console.error(`Помилка виконання місії: ${e.message}`, e.stack);
            res.status(500).json({ message: `Помилка виконання місії: ${e.message}` });
        } finally {
            db.close();
        }
    } catch (e) {
        console.error("General error in complete_mission route:", e);
        res.status(500).json({ message: `Серверна помилка: ${e.message}` });
    }
});


app.get('/api/get_players_info', async (req, res) => {
    try {
        const activeNicknames = await getActivePlayerNicknames();
        if (activeNicknames.length === 0) {
            return res.json([]);
        }

        const db = getDb();
        const playersList = await new Promise((resolve, reject) => {
            const placeholders = activeNicknames.map(() => '?').join(',');
            db.all(`SELECT nickname, score FROM users WHERE nickname IN (${placeholders})`, activeNicknames, (err, rows) => {
                db.close();
                if (err) return reject(err);
                resolve(rows);
            });
        });
        
        playersList.sort((a, b) => b.score - a.score); // Sort by score descending
        res.json(playersList);

    } catch (e) {
        console.error("Error in /api/get_players_info:", e);
        res.status(500).json({ message: "Серверна помилка при отриманні інформації про гравців." });
    }
});

app.get('/api/score_history', async (req, res) => {
    try {
        const activeNicknames = await getActivePlayerNicknames();
        if (activeNicknames.length === 0) {
            return res.json([]);
        }

        const db = getDb();
        const userIds = await new Promise((resolve, reject) => {
            const placeholders = activeNicknames.map(() => '?').join(',');
            db.all(`SELECT id FROM users WHERE nickname IN (${placeholders})`, activeNicknames, (err, rows) => {
                if (err) return reject(err);
                resolve(rows.map(row => row.id));
            });
        });

        if (userIds.length === 0) {
            db.close();
            return res.json([]);
        }

        const history = await new Promise((resolve, reject) => {
            const placeholders = userIds.map(() => '?').join(',');
            const query = `
                SELECT T1.nickname AS player_id, T2.score_change, T2.reason, T2.timestamp 
                FROM users T1 
                JOIN score_history T2 ON T1.id = T2.user_id 
                WHERE T2.user_id IN (${placeholders}) 
                ORDER BY T2.timestamp DESC
            `;
            db.all(query, userIds, (err, rows) => {
                db.close();
                if (err) return reject(err);
                resolve(rows);
            });
        });

        const filteredHistory = history.map(entry => ({
            player_id: entry.player_id,
            score_change: entry.score_change,
            reason: entry.reason,
            timestamp: entry.timestamp,
            type: entry.score_change > 0 ? 'added' : 'removed',
            amount: Math.abs(entry.score_change),
            missionName: entry.reason // For consistency with frontend
        }));
        res.json(filteredHistory);

    } catch (e) {
        console.error("Error in /api/score_history:", e);
        res.status(500).json({ message: "Серверна помилка при отриманні історії балів." });
    }
});

app.post('/api/reset_game_session', async (req, res) => {
    const nickname = req.session.nickname;
    if (!nickname) {
        return res.status(401).json({ message: 'Ви не увійшли.' });
    }

    try {
        const activeNicknames = await getActivePlayerNicknames();
        if (!activeNicknames || activeNicknames.length === 0 || nickname !== activeNicknames[0]) {
            return res.status(403).json({ message: `Лише перший активний гравець (${activeNicknames[0] || "Немає активних гравців"}) може скидати ігрову сесію.` });
        }

        await resetAllGameData();
        req.session.destroy(err => {
            if (err) {
                console.error("Error destroying session after reset:", err);
            }
        });
        res.json({ message: 'Всі дані гри успішно скинуто. Ви вийшли з системи.' });

    } catch (e) {
        console.error("Error in /api/reset_game_session:", e);
        res.status(500).json({ message: `Помилка скидання гри: ${e.message}` });
    }
});


// Socket.IO Event Handlers
io.on('connection', (socket) => {
    console.log(`Клієнт підключився до Socket.IO! SID: ${socket.id}`);
    socket.join(BROADCAST_ROOM); // Приєднуємо клієнта до глобальної кімнати
    console.log(`Клієнт ${socket.id} приєднався до кімнати '${BROADCAST_ROOM}'`);

    socket.on('disconnect', () => {
        console.log(`Клієнт відключився від Socket.IO. SID: ${socket.id}`);
    });
});

// Запуск сервера
const PORT = process.env.PORT || 3000; // Використовуй порт, який надає Render, або 3000 локально
server.listen(PORT, () => {
    console.log(`Сервер запущено на порту ${PORT}`);
});
