// Імпорти для Deno
import { Application, Router, send } from "oak";
import { DB } from "sqlite";
import { Server } from "socketio";
import { WebSocketAdapter } from "socketio_adapter_ws";
import { join } from "std/path";
import { getCookies, setCookie } from "std/http/cookie.ts";
import { toHashString } from "std/crypto/to_hash_string.ts";
import { decode, encode } from "std/encoding/hex.ts";

// --- КОНСТАНТИ ТА ІНІЦІАЛІЗАЦІЯ ---

// Конфігурація додатка Oak
const app = new Application();
const router = new Router();
const port = parseInt(Deno.env.get("PORT") || "3000"); // Використовуємо порт з ENV або 3000 за замовчуванням

// Ініціалізація Socket.IO сервера для Deno
const io = new Server({
    cors: {
        origin: "*", // Дозволяє підключення з будь-яких доменів (для розробки)
        methods: ["GET", "POST"]
    },
    adapter: new WebSocketAdapter() // Використовуємо WebSocketAdapter для Deno
});

// Шлях до файлу бази даних SQLite
// УВАГА: SQLite на Deno Deploy НЕ ЗБЕРІГАЄ ДАНІ постійно.
// Кожен деплой або перезапуск процесу призводить до втрати даних.
// Для постійного зберігання потрібна зовнішня база даних (наприклад, Supabase Postgres).
const DATABASE_PATH = join(Deno.cwd(), 'kpk_game.db'); // Використовуємо Deno.cwd() для поточного робочого каталогу

// Секретний ключ для підпису сесійних кукі
// Важливо: у продакшені генеруйте цей ключ надійно і зберігайте його в змінних середовища!
const SESSION_SECRET_STRING = 'e57724220b3b4f63c87895e7c80529d4791054b1f618d3600f6074127c525f0a1c6298e874558509'; // Той самий ключ, що був у Python/Node.js
const SESSION_SECRET = new TextEncoder().encode(SESSION_SECRET_STRING); // Перетворюємо в Uint8Array для криптографічних операцій

// Глобальна кімната для трансляції подій всім підключеним клієнтам
const BROADCAST_ROOM = 'global_broadcast_room';

// Константа для максимальної кількості активних гравців (перших, хто зареєструвався)
const MAX_ACTIVE_PLAYERS = 4;
const COOLDOWN_SECONDS = 10;

// --- УТИЛІТИ ДЛЯ БАЗИ ДАНИХ (SQLite) ---

// Функція для підключення до бази даних
function getDb(): DB {
    return new DB(DATABASE_PATH);
}

// Функція для ініціалізації схеми бази даних
function initDb() {
    const db = getDb();
    db.execute(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nickname TEXT UNIQUE NOT NULL,
            score INTEGER DEFAULT 0,
            mission_stats TEXT DEFAULT '{}',
            last_mission_time TEXT,
            registration_time TEXT NOT NULL
        );
    `);
    db.execute(`
        CREATE TABLE IF NOT EXISTS score_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            score_change INTEGER NOT NULL,
            reason TEXT,
            timestamp TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users (id)
        );
    `);
    db.close();
    console.log("База даних ініціалізована.");
}

// Викликаємо ініціалізацію бази даних при запуску програми
initDb();

// Допоміжна функція для отримання нікнеймів активних гравців
async function getActivePlayerNicknames(): Promise<string[]> {
    const db = getDb();
    try {
        const rows = db.query<[string]>('SELECT nickname FROM users ORDER BY registration_time ASC LIMIT ?', [MAX_ACTIVE_PLAYERS]);
        return rows.map(row => row[0]);
    } finally {
        db.close();
    }
}

// Функції для взаємодії з даними через SQLite
async function getPlayer(nickname: string): Promise<any | null> {
    const db = getDb();
    try {
        const row = db.query<[number, string, number, string, string | null, string]>('SELECT id, nickname, score, mission_stats, last_mission_time, registration_time FROM users WHERE nickname = ?', [nickname])
            .map(r => ({
                id: r[0],
                nickname: r[1],
                score: r[2],
                mission_stats: JSON.parse(r[3] || '{}'),
                last_mission_time: r[4],
                registration_time: r[5]
            }))[0];
        return row || null;
    } finally {
        db.close();
    }
}

async function createPlayer(nickname: string): Promise<number | null> {
    const db = getDb();
    try {
        const result = db.query('INSERT INTO users (nickname, score, mission_stats, last_mission_time, registration_time) VALUES (?, ?, ?, ?, ?)',
            [nickname, 0, JSON.stringify({'I': 5, 'II': 5, 'III': 5}), null, new Date().toISOString()]);
        
        // Deno SQLite не повертає lastID напряму, потрібно робити окремий запит
        const lastIdQuery = db.query<[number]>('SELECT last_insert_rowid()');
        const lastId = lastIdQuery.flat()[0]; // Отримуємо перше значення з першого рядка
        return lastId;

    } catch (e) {
        console.error("Error creating player:", e);
        return null;
    } finally {
        db.close();
    }
}

async function updatePlayerScoreInternal(dbInstance: DB, userId: number, nickname: string, amount: number, reason = "Місія виконана"): Promise<number | false> {
    try {
        const currentScoreRow = dbInstance.query<[number]>('SELECT score FROM users WHERE id = ?', [userId]).flat()[0];
        if (currentScoreRow === undefined) {
            return false; // Гравець не знайдений
        }

        const newScore = currentScoreRow + amount;
        dbInstance.query('UPDATE users SET score = ? WHERE id = ?', [newScore, userId]);
        dbInstance.query('INSERT INTO score_history (user_id, score_change, reason, timestamp) VALUES (?, ?, ?, ?)',
            [userId, amount, reason, new Date().toISOString()]);
        
        return newScore;
    } catch (e) {
        console.error("Error in updatePlayerScoreInternal:", e);
        return false;
    }
}

async function resetAllGameData(): Promise<boolean> {
    const db = getDb();
    try {
        db.query('DELETE FROM users');
        db.query('DELETE FROM score_history');
        io.to(BROADCAST_ROOM).emit('game_reset'); // Емітуємо в BROADCAST_ROOM
        return true;
    } catch (e) {
        console.error("Error resetting game data:", e);
        return false;
    } finally {
        db.close();
    }
}

// --- СЕСІЇ ---
interface SessionData {
    nickname?: string;
}

// Створення підпису для куки сесії
async function signSession(data: SessionData): Promise<string> {
    const payload = JSON.stringify(data);
    const signature = await crypto.subtle.sign(
        { name: "HMAC", hash: "SHA-256" }, // Повністю вказуємо алгоритм
        await crypto.subtle.importKey("raw", SESSION_SECRET, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
        new TextEncoder().encode(payload)
    );
    return `${encodeURIComponent(payload)}.${encode(new Uint8Array(signature))}`;
}

// Перевірка та розшифровка куки сесії
async function verifySession(signedCookie: string): Promise<SessionData | null> {
    const parts = signedCookie.split('.');
    if (parts.length !== 2) return null;

    const payload = decodeURIComponent(parts[0]);
    const signature = decode(parts[1]);

    try {
        const isValid = await crypto.subtle.verify(
            { name: "HMAC", hash: "SHA-256" }, // Повністю вказуємо алгоритм
            await crypto.subtle.importKey("raw", SESSION_SECRET, { name: "HMAC", hash: "SHA-256" }, false, ["verify"]),
            signature,
            new TextEncoder().encode(payload)
        );
        if (isValid) {
            return JSON.parse(payload);
        }
    } catch (e) {
        console.error("Session verification failed:", e);
    }
    return null;
}

// Middleware для сесій
app.use(async (context, next) => {
    const cookies = getCookies(context.request.headers);
    const signedSessionCookie = cookies["session"];
    
    let sessionData: SessionData = {};
    if (signedSessionCookie) {
        const verified = await verifySession(signedSessionCookie);
        if (verified) {
            sessionData = verified;
        }
    }
    
    // Додаємо сесію до об'єкта стану контексту
    (context.state as any).session = sessionData;

    await next();

    // Зберігаємо сесію назад у куки після обробки запиту
    if ((context.state as any).session && Object.keys((context.state as any).session).length > 0) {
        const newSignedCookie = await signSession((context.state as any).session);
        setCookie(context.response.headers, {
            name: "session",
            value: newSignedCookie,
            httpOnly: true,
            secure: Deno.env.get("NODE_ENV") === "production", // Secure for HTTPS in production
            maxAge: 7 * 24 * 60 * 60, // 7 днів
            path: "/"
        });
    } else {
        // Якщо сесія пуста, видаляємо куку
        setCookie(context.response.headers, {
            name: "session",
            value: "",
            expires: new Date(0), // Встановлюємо дату в минулому, щоб кука видалилася
            httpOnly: true,
            secure: Deno.env.get("NODE_ENV") === "production",
            path: "/"
        });
    }
});


// --- МАРШРУТИ HTTP (Router) ---

// Обслуговування index.html
router.get('/', async (context) => {
    await send(context, context.request.url.pathname, {
        root: join(Deno.cwd(), 'templates'),
        index: "index.html",
    });
});

// Обслуговування статичних файлів (CSS, JS)
app.use(async (context, next) => {
    try {
        await send(context, context.request.url.pathname, {
            root: join(Deno.cwd(), 'static'),
        });
    } catch {
        await next(); // Якщо файл не знайдено в static, передаємо далі
    }
});

router.post('/api/login', async (context) => {
    const { nickname } = await context.request.body({ type: "json" }).value;

    if (!nickname) {
        context.response.status = 400;
        context.response.body = { message: 'Нікнейм не може бути порожнім' };
        return;
    }

    try {
        let player = await getPlayer(nickname);
        let message: string;

        if (!player) {
            const playerId = await createPlayer(nickname);
            message = `Привіт, ${nickname}! Ти новий гравець!`;
            player = await getPlayer(nickname); // Отримуємо дані щойно створеного гравця
            if (!player) {
                context.response.status = 500;
                context.response.body = { message: 'Не вдалося створити або отримати дані нового гравця.' };
                return;
            }
        } else {
            message = `З поверненням, ${nickname}!`;
        }

        (context.state as any).session.nickname = nickname; // Зберігаємо нікнейм у сесії

        const activePlayers = await getActivePlayerNicknames();
        const isActive = activePlayers.includes(nickname);

        const db = getDb();
        const scoreHistoryRows = db.query<[number, string, string]>("SELECT score_change, reason, timestamp FROM score_history WHERE user_id = ? ORDER BY id DESC LIMIT 20", [player.id])
            .map(r => ({
                score_change: r[0],
                reason: r[1],
                timestamp: r[2]
            }));
        db.close(); // Закриваємо з'єднання після використання

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

        context.response.body = { message, userData, is_active: isActive };

    } catch (e) {
        console.error(`Помилка в маршруті /api/login: ${e.message}`, e);
        context.response.status = 500;
        context.response.body = { message: `Серверна помилка при вході: ${e.message}. Перевірте логи сервера.` };
    }
});

router.post('/api/logout', async (context) => {
    const nickname = (context.state as any).session.nickname;
    if (nickname) {
        (context.state as any).session = {}; // Очищаємо сесію
        io.to(BROADCAST_ROOM).emit('player_logged_out', { nickname });
        context.response.body = { message: 'Ви успішно вийшли.' };
    } else {
        context.response.body = { message: 'Ви не були увійдені.' };
    }
});

router.get('/api/get_time', (context) => {
    const currentTime = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    context.response.body = { time: currentTime };
});

router.get('/api/get_current_user', async (context) => {
    const nickname = (context.state as any).session.nickname;
    if (nickname) {
        try {
            const player = await getPlayer(nickname);
            if (player) {
                const activePlayers = await getActivePlayerNicknames();
                const isActive = activePlayers.includes(nickname);
                context.response.body = { nickname: player.nickname, score: player.score, status: 'logged_in', is_active: isActive };
            } else {
                (context.state as any).session = {}; // Якщо гравця немає в DB, видаляємо сесію
                context.response.body = { nickname: null, status: 'logged_out', is_active: false };
            }
        } catch (e) {
            console.error("Error in /api/get_current_user:", e);
            context.response.status = 500;
            context.response.body = { message: "Серверна помилка при отриманні поточного користувача." };
        }
    } else {
        context.response.body = { nickname: null, status: 'logged_out', is_active: false };
    }
});

router.get('/api/get_player_score', async (context) => {
    let nickname = context.request.url.searchParams.get('nickname') || (context.state as any).session.nickname;
    if (!nickname) {
        context.response.status = 400;
        context.response.body = { message: 'Нікнейм не вказано або ви не увійшли' };
        return;
    }

    try {
        const player = await getPlayer(nickname);
        if (player) {
            context.response.body = { nickname: player.nickname, score: player.score };
        } else {
            context.response.status = 404;
            context.response.body = { message: 'Гравець не знайдений' };
        }
    } catch (e) {
        console.error("Error in /api/get_player_score:", e);
        context.response.status = 500;
        context.response.body = { message: "Серверна помилка при отриманні балів гравця." };
    }
});

router.post('/api/complete_mission', async (context) => {
    const { nickname: clientNickname, missionStats } = await context.request.body({ type: "json" }).value;
    const currentSessionNickname = (context.state as any).session.nickname;

    if (!currentSessionNickname) {
        context.response.status = 401;
        context.response.body = { message: 'Ви не увійшли. Будь ласка, увійдіть, щоб виконати місію.' };
        return;
    }

    const actualNickname = clientNickname && clientNickname === currentSessionNickname ? clientNickname : currentSessionNickname;

    try {
        const activePlayers = await getActivePlayerNicknames();
        if (!activePlayers.includes(actualNickname)) {
            context.response.status = 403;
            context.response.body = { message: 'Ви є глядачем і не можете виконувати місії.' };
            return;
        }

        const player = await getPlayer(actualNickname);
        if (!player) {
            context.response.status = 404;
            context.response.body = { message: 'Гравець не знайдений.' };
            return;
        }

        const lastMissionTimeStr = player.last_mission_time;
        if (lastMissionTimeStr && lastMissionTimeStr !== 'None') { // Deno SQLite returns null for NULL, not "None" string
            const lastMissionTime = new Date(lastMissionTimeStr);
            const timeDiffSeconds = (new Date().getTime() - lastMissionTime.getTime()) / 1000;
            if (timeDiffSeconds < COOLDOWN_SECONDS) {
                const remainingTime = Math.round(COOLDOWN_SECONDS - timeDiffSeconds);
                context.response.status = 429;
                context.response.body = { message: `Зачекайте ${remainingTime} секунд перед наступною місією.` };
                return;
            }
        }

        const pointsToAdd = Math.floor(Math.random() * (40 - 5 + 1)) + 5; // Random int between 5 and 40

        const db = getDb();
        try {
            db.query('BEGIN TRANSACTION;');

            const newScore = await updatePlayerScoreInternal(db, player.id, actualNickname, pointsToAdd, "Виконано місію");
            
            if (newScore === false) {
                db.query('ROLLBACK;');
                context.response.status = 500;
                context.response.body = { message: "Не вдалося оновити бали гравця." };
                return;
            }

            db.query('UPDATE users SET last_mission_time = ?, mission_stats = ? WHERE id = ?',
                [new Date().toISOString(), JSON.stringify(missionStats || player.mission_stats), player.id]);
            
            db.query('COMMIT;');
            
            const updatedPlayer = await getPlayer(actualNickname); // Отримуємо оновлені дані гравця
            const newScoreForEmit = updatedPlayer ? updatedPlayer.score : (newScore as number); // Fallback

            io.to(BROADCAST_ROOM).emit('score_updated', { nickname: actualNickname, score: newScoreForEmit });
            io.to(BROADCAST_ROOM).emit('history_updated', {
                player_id: actualNickname,
                score_change: pointsToAdd,
                reason: "Виконано місію",
                timestamp: new Date().toISOString()
            });

            context.response.body = {
                message: `Місія виконана! Ви отримали ${pointsToAdd} балів. Всього балів: ${newScoreForEmit}`,
                updatedScore: newScoreForEmit,
                updatedMissionStats: missionStats || player.mission_stats
            };
        } catch (e) {
            console.error(`Помилка виконання місії у транзакції: ${e.message}`, e);
            db.query('ROLLBACK;');
            context.response.status = 500;
            context.response.body = { message: `Помилка виконання місії: ${e.message}` };
        } finally {
            db.close();
        }
    } catch (e) {
        console.error("Загальна помилка в маршруті /api/complete_mission:", e);
        context.response.status = 500;
        context.response.body = { message: `Серверна помилка: ${e.message}` };
    }
});

router.get('/api/get_players_info', async (context) => {
    try {
        const activeNicknames = await getActivePlayerNicknames();
        if (activeNicknames.length === 0) {
            context.response.body = [];
            return;
        }

        const db = getDb();
        const placeholders = activeNicknames.map(() => '?').join(',');
        const playersList = db.query<[string, number]>(`SELECT nickname, score FROM users WHERE nickname IN (${placeholders})`, activeNicknames)
            .map(r => ({ nickname: r[0], score: r[1] }));
        db.close();

        playersList.sort((a, b) => b.score - a.score); // Sort by score descending
        context.response.body = playersList;

    } catch (e) {
        console.error("Error in /api/get_players_info:", e);
        context.response.status = 500;
        context.response.body = { message: "Серверна помилка при отриманні інформації про гравців." };
    }
});

router.get('/api/score_history', async (context) => {
    try {
        const activeNicknames = await getActivePlayerNicknames();
        if (activeNicknames.length === 0) {
            context.response.body = [];
            return;
        }

        const db = getDb();
        const userIds = db.query<[number]>(`SELECT id FROM users WHERE nickname IN (${activeNicknames.map(() => '?').join(',')})`, activeNicknames)
            .map(row => row[0]);

        if (userIds.length === 0) {
            db.close();
            context.response.body = [];
            return;
        }

        const placeholders = userIds.map(() => '?').join(',');
        const query = `
            SELECT T1.nickname AS player_id, T2.score_change, T2.reason, T2.timestamp 
            FROM users T1 
            JOIN score_history T2 ON T1.id = T2.user_id 
            WHERE T2.user_id IN (${placeholders}) 
            ORDER BY T2.timestamp DESC
        `;
        const history = db.query<[string, number, string, string]>(query, userIds)
            .map(r => ({
                player_id: r[0],
                score_change: r[1],
                reason: r[2],
                timestamp: r[3]
            }));
        db.close();

        const filteredHistory = history.map(entry => ({
            player_id: entry.player_id,
            score_change: entry.score_change,
            reason: entry.reason,
            timestamp: entry.timestamp,
            type: entry.score_change > 0 ? 'added' : 'removed',
            amount: Math.abs(entry.score_change),
            missionName: entry.reason // For consistency with frontend
        }));
        context.response.body = filteredHistory;

    } catch (e) {
        console.error("Error in /api/score_history:", e);
        context.response.status = 500;
        context.response.body = { message: "Серверна помилка при отриманні історії балів." };
    }
});

router.post('/api/reset_game_session', async (context) => {
    const nickname = (context.state as any).session.nickname;
    if (!nickname) {
        context.response.status = 401;
        context.response.body = { message: 'Ви не увійшли.' };
        return;
    }

    try {
        const activeNicknames = await getActivePlayerNicknames();
        if (!activeNicknames || activeNicknames.length === 0 || nickname !== activeNicknames[0]) {
            context.response.status = 403;
            context.response.body = { message: `Лише перший активний гравець (${activeNicknames[0] || "Немає активних гравців"}) може скидати ігрову сесію.` };
            return;
        }

        await resetAllGameData();
        (context.state as any).session = {}; // Очищаємо сесію
        context.response.body = { message: 'Всі дані гри успішно скинуто. Ви вийшли з системи.' };

    } catch (e) {
        console.error("Error in /api/reset_game_session:", e);
        context.response.status = 500;
        context.response.body = { message: `Помилка скидання гри: ${e.message}` };
    }
});


// --- SOCKET.IO HANDLERS ---
io.on('connection', (socket) => {
    console.log(`Клієнт підключився до Socket.IO! SID: ${socket.id}`);
    socket.join(BROADCAST_ROOM); // Приєднуємо клієнта до глобальної кімнати
    console.log(`Клієнт ${socket.id} приєднався до кімнати '${BROADCAST_ROOM}'`);

    socket.on('disconnect', () => {
        console.log(`Клієнт відключився від Socket.IO. SID: ${socket.id}`);
    });
});

// --- ЗАПУСК СЕРВЕРА ---

// Додаємо роутер до додатку Oak
app.use(router.routes());
app.use(router.allowedMethods());

// Інтегруємо Socket.IO з HTTP-сервером Oak
// Очікуємо, поки HTTP-сервер почне слухати, потім запускаємо Socket.IO
app.addEventListener("listen", ({ hostname, port, secure }) => {
    console.log(`Сервер запущено на ${secure ? "https://" : "http://"}${hostname ?? "localhost"}:${port}`);
    // Socket.IO "прикріплюється" до вже існуючого HTTP-сервера, який Oak створює
    io.attach(app.server); 
});

// Запускаємо Oak додаток
await app.listen({ port });

