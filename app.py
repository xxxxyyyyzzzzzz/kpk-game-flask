import sqlite3
import json
import os
from flask import Flask, request, jsonify, render_template, session
from datetime import datetime
import random
from flask_socketio import SocketIO, emit, join_room, leave_room # Імпортуємо join_room та leave_room

app = Flask(__name__)
app.secret_key = 'e57724220b3b4f63c87895e7c80529d4791054b1f618d3600f6074127c525f0a1c6298e874558509' # Згенерований унікальний секретний ключ!

# Шлях до файлу бази даних SQLite
DATABASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'kpk_game.db')

# Ініціалізація SocketIO
# Явно вказуємо використовувати тільки 'polling' транспорт
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='threading', transports=['polling'])

# Глобальна кімната для трансляції подій всім підключеним клієнтам
BROADCAST_ROOM = 'global_broadcast_room'

# Константа для максимальної кількості активних гравців (перших, хто зареєструвався)
MAX_ACTIVE_PLAYERS = 4

# Функція для підключення до бази даних
def get_db_connection():
    conn = sqlite3.connect(DATABASE)
    conn.row_factory = sqlite3.Row
    return conn

# Функція для ініціалізації схеми бази даних
def init_db():
    with app.app_context(): # Обгортаємо в app_context
        conn = get_db_connection()
        conn.execute('''
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nickname TEXT UNIQUE NOT NULL,
                score INTEGER DEFAULT 0,
                mission_stats TEXT DEFAULT '{}',
                last_mission_time TEXT,
                registration_time TEXT NOT NULL
            );
        ''')
        conn.execute('''
            CREATE TABLE IF NOT EXISTS score_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                score_change INTEGER NOT NULL,
                reason TEXT,
                timestamp TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users (id)
            );
        ''')
        conn.commit()
        conn.close()

# Викликаємо ініціалізацію бази даних при запуску програми
init_db()


# Допоміжна функція для отримання нікнеймів активних гравців
def get_active_player_nicknames():
    conn = get_db_connection()
    cursor = conn.execute(
        'SELECT nickname FROM users ORDER BY registration_time ASC LIMIT ?',
        (MAX_ACTIVE_PLAYERS,)
    )
    active_players = [row['nickname'] for row in cursor.fetchall()]
    conn.close()
    return active_players

# Функції для взаємодії з даними через SQLite
def get_player(nickname):
    conn = get_db_connection()
    player = conn.execute('SELECT * FROM users WHERE nickname = ?', (nickname,)).fetchone()
    conn.close()
    if player:
        player_dict = dict(player)
        player_dict['mission_stats'] = json.loads(player_dict['mission_stats'])
        return player_dict
    return None

def create_player(nickname):
    player = get_player(nickname)
    if not player:
        conn = get_db_connection()
        try:
            conn.execute(
                'INSERT INTO users (nickname, score, mission_stats, last_mission_time, registration_time) VALUES (?, ?, ?, ?, ?)',
                (nickname, 0, json.dumps({'I': 5, 'II': 5, 'III': 5}), None, datetime.now().isoformat())
            )
            conn.commit()
            return True
        except sqlite3.IntegrityError: # Якщо нікнейм вже існує (хоча має бути перевірено get_player)
            print(f"Attempted to create duplicate nickname: {nickname}")
            return False
        finally:
            conn.close()
    return False

# Змінена функція: тепер приймає conn і не комітить зміни сама
def update_player_score_internal(conn, player_id, nickname, amount, reason="Місія виконана"):
    """
    Оновлює бали гравця та додає запис до історії балів.
    НЕ КОМІТИТЬ ЗМІНИ, очікується коміт зовнішнім викликом.
    """
    player_data_for_score_update = get_player(nickname) # Отримуємо актуальний рахунок
    if not player_data_for_score_update:
        return False # Гравець не знайдений

    new_score = player_data_for_score_update['score'] + amount
    conn.execute('UPDATE users SET score = ? WHERE nickname = ?', (new_score, nickname))
    conn.execute(
        'INSERT INTO score_history (user_id, score_change, reason, timestamp) VALUES (?, ?, ?, ?)',
        (player_id, amount, reason, datetime.now().isoformat())
    )
    return new_score # Повертаємо новий рахунок для еміту WebSockets

def reset_all_game_data():
    conn = get_db_connection()
    try:
        conn.execute('DELETE FROM users')
        conn.execute('DELETE FROM score_history')
        conn.commit()
        # Емітуємо в BROADCAST_ROOM
        socketio.emit('game_reset', room=BROADCAST_ROOM)
    except sqlite3.Error as e:
        print(f"Error resetting game data: {e}")
        conn.rollback()
    finally:
        conn.close()


# Маршрути Flask
@app.route('/')
def index():
    return render_template('index.html')

@app.route('/api/login', methods=['POST'])
def login():
    data = request.json
    nickname = data.get('nickname')
    
    if not nickname:
        return jsonify({'message': 'Нікнейм не може бути порожнім'}), 400

    try:
        player = get_player(nickname)
        if not player:
            create_player(nickname)
            message = f"Привіт, {nickname}! Ти новий гравець!"
            player = get_player(nickname) # Отримуємо дані щойно створеного гравця
            if not player: # Якщо навіть після створення не змогли отримати, щось пішло не так
                return jsonify({'message': 'Не вдалося створити або отримати дані нового гравця.'}), 500
        else:
            message = f"З поверненням, {nickname}!"
        
        session['nickname'] = nickname
        
        is_active = nickname in get_active_player_nicknames()
        
        conn = get_db_connection()
        score_history_rows = conn.execute(
            "SELECT score_change, reason, timestamp FROM score_history WHERE user_id = ? ORDER BY id DESC LIMIT 20",
            (player['id'],)
        ).fetchall()
        conn.close()
        
        score_history_for_frontend = [
            {'type': 'added' if entry['score_change'] > 0 else 'removed',
             'amount': abs(entry['score_change']),
             'missionName': entry['reason'],
             'timestamp': entry['timestamp']} for entry in score_history_rows
        ]

        user_data = {
            "nickname": player['nickname'],
            "score": player['score'],
            "missionStats": player['mission_stats'],
            "scoreHistory": score_history_for_frontend
        }

        # Емітуємо в BROADCAST_ROOM
        socketio.emit('player_logged_in', {
            'nickname': nickname,
            'score': player['score'],
            'is_active': is_active
        }, room=BROADCAST_ROOM) # Виправлено: використано room=BROADCAST_ROOM

        return jsonify({'message': message, 'userData': user_data, 'is_active': is_active})
    except Exception as e:
        print(f"Помилка в маршруті /api/login: {e}")
        return jsonify({"message": f"Серверна помилка при вході: {str(e)}. Перевірте логи сервера."}), 500


@app.route('/api/logout', methods=['POST'])
def logout():
    nickname = session.pop('nickname', None)
    if nickname:
        # Емітуємо в BROADCAST_ROOM
        socketio.emit('player_logged_out', {'nickname': nickname}, room=BROADCAST_ROOM) # Виправлено: використано room=BROADCAST_ROOM
    return jsonify({'message': 'Ви успішно вийшли.'})

@app.route('/api/get_time')
def get_time():
    current_time = datetime.now().strftime("%H:%M")
    return jsonify({'time': current_time})

@app.route('/api/get_current_user')
def get_current_user():
    nickname = session.get('nickname')
    if nickname:
        player = get_player(nickname)
        if player:
            is_active = nickname in get_active_player_nicknames()
            return jsonify({'nickname': player['nickname'], 'score': player['score'], 'status': 'logged_in', 'is_active': is_active})
        else:
            session.pop('nickname', None)
            return jsonify({'nickname': None, 'status': 'logged_out', 'is_active': False})
    else:
        return jsonify({'nickname': None, 'status': 'logged_out', 'is_active': False})

@app.route('/api/get_player_score')
def get_player_score():
    nickname = request.args.get('nickname')
    if not nickname:
        nickname = session.get('nickname')
        if not nickname:
            return jsonify({'message': 'Нікнейм не вказано або ви не увійшли'}), 400

    player = get_player(nickname)
    if player:
        return jsonify({'nickname': player['nickname'], 'score': player['score']})
    return jsonify({'message': 'Гравець не знайдений'}), 404

@app.route('/api/complete_mission', methods=['POST'])
def complete_mission():
    data = request.json
    nickname = data.get('nickname') or session.get('nickname')
    client_mission_stats = data.get('missionStats', {'I': 0, 'II': 0, 'III': 0})
    
    if not nickname:
        return jsonify({'message': 'Ви не увійшли. Будь ласка, увійдіть, щоб виконати місію.'}), 401

    if nickname not in get_active_player_nicknames():
        return jsonify({'message': 'Ви є глядачем і не можете виконувати місії.'}), 403

    player = get_player(nickname) # Отримуємо дані гравця один раз на початку запиту
    if not player:
        return jsonify({'message': 'Гравець не знайдений.'}), 404

    COOLDOWN_SECONDS = 10 
    last_mission_time_str = player.get('last_mission_time')
    if last_mission_time_str and last_mission_time_str != 'None':
        last_mission_time = datetime.fromisoformat(last_mission_time_str)
        time_diff = datetime.now() - last_mission_time
        if time_diff.total_seconds() < COOLDOWN_SECONDS:
            remaining_time = round(COOLDOWN_SECONDS - time_diff.total_seconds())
            return jsonify({'message': f'Зачекайте {remaining_time} секунд перед наступною місією.'}), 429

    points_to_add = random.randint(5, 40)
    
    conn = get_db_connection()
    try:
        # Виконуємо всі оновлення та вставки в рамках однієї транзакції
        new_score_after_mission = update_player_score_internal(conn, player['id'], nickname, points_to_add, "Виконано місію")
        
        if new_score_after_mission is False: # Якщо update_player_score_internal повернула False
            conn.rollback()
            return jsonify({"message": "Не вдалося оновити бали гравця."}), 500

        conn.execute('UPDATE users SET last_mission_time = ?, mission_stats = ? WHERE nickname = ?',
                     (datetime.now().isoformat(), json.dumps(client_mission_stats), nickname))
        
        conn.commit() # Комітуємо всі зміни одночасно
        
        # Емітуємо події Socket.IO ТІЛЬКИ після успішного коміту
        socketio.emit('score_updated', {'nickname': nickname, 'score': new_score_after_mission}, room=BROADCAST_ROOM) # Виправлено: використано room=BROADCAST_ROOM
        socketio.emit('history_updated', {
            'player_id': nickname,
            'score_change': points_to_add, # Повторно використовуємо points_to_add
            'reason': "Виконано місію",
            'timestamp': datetime.now().isoformat()
        }, room=BROADCAST_ROOM) # Виправлено: використано room=BROADCAST_ROOM

        return jsonify({
            'message': f'Місія виконана! Ви отримали {points_to_add} балів. Всього балів: {new_score_after_mission}',
            'updatedScore': new_score_after_mission,
            'updatedMissionStats': client_mission_stats # Повертаємо оновлені mission_stats від клієнта
        })
    except sqlite3.Error as e:
        print(f"Error in complete_mission transaction: {e}")
        conn.rollback()
        return jsonify({"message": f"Помилка виконання місії: {str(e)}"}), 500
    finally:
        conn.close()

@app.route('/api/get_players_info')
def get_players_info():
    """
    Повертає список лише активних гравців, відсортованих за балами у спадаючому порядку.
    """
    active_nicknames = get_active_player_nicknames()
    players_list = []
    conn = get_db_connection()
    for nickname in active_nicknames:
        player = conn.execute('SELECT nickname, score FROM users WHERE nickname = ?', (nickname,)).fetchone()
        if player:
            players_list.append(dict(player))
    conn.close()
    players_list.sort(key=lambda x: x['score'], reverse=True)
    return jsonify(players_list)

@app.route('/api/score_history')
def get_score_history_api():
    """
    Повертає історію змін балів лише для активних гравців, відсортовану за часом (новіші зверху).
    """
    active_nicknames = get_active_player_nicknames()
    conn = get_db_connection()
    
    if not active_nicknames:
        conn.close()
        return jsonify([])

    # Виправлено формування рядка з плейсхолдерами для IN-запиту
    placeholders_for_user_ids_query = ','.join('?' for _ in active_nicknames)
    user_ids = conn.execute(f"SELECT id FROM users WHERE nickname IN ({placeholders_for_user_ids_query})", active_nicknames).fetchall()
    active_user_ids = [row['id'] for row in user_ids]

    if not active_user_ids:
        conn.close()
        return jsonify([])

    placeholders = ','.join('?' for _ in active_user_ids)
    query = f"SELECT T1.nickname AS player_id, T2.score_change, T2.reason, T2.timestamp FROM users T1 JOIN score_history T2 ON T1.id = T2.user_id WHERE T2.user_id IN ({placeholders}) ORDER BY T2.timestamp DESC"
    cursor = conn.execute(query, active_user_ids)
    filtered_history = []
    for row in cursor.fetchall():
        entry = dict(row)
        entry['type'] = 'added' if entry['score_change'] > 0 else 'removed'
        entry['amount'] = abs(entry['score_change'])
        entry['missionName'] = entry['reason']
        filtered_history.append(entry)
    conn.close()
    return jsonify(filtered_history)

@app.route('/api/reset_game_session', methods=['POST'])
def reset_game_session():
    """
    Скидає всі дані гри: гравців та історію. Дозволено лише першому зареєстрованому гравцю.
    """
    nickname = session.get('nickname')
    if not nickname:
        return jsonify({'message': 'Ви не увійшли.'}), 401
    
    active_nicknames = get_active_player_nicknames()
    if not active_nicknames or nickname != active_nicknames[0]: 
        return jsonify({'message': f'Лише перший активний гравець ({active_nicknames[0] if active_nicknames else "Немає активних гравців"}) може скидати ігрову сесію.'}), 403

    reset_all_game_data()
    session.pop('nickname', None)
    return jsonify({'message': 'Всі дані гри успішно скинуто. Ви вийшли з системи.'})

# SocketIO Event Handlers
@socketio.on('connect')
def test_connect():
    print(f'Клієнт підключився до Socket.IO (через Long Polling)! SID: {request.sid}')
    join_room(BROADCAST_ROOM) # Приєднуємо клієнта до глобальної кімнати
    print(f"Клієнт {request.sid} приєднався до кімнати '{BROADCAST_ROOM}'")

@socketio.on('disconnect')
def test_disconnect():
    print(f'Клієнт відключився від Socket.IO. SID: {request.sid}')
    # leave_room(BROADCAST_ROOM) - можна не викликати явно, якщо SID автоматично видаляється з кімнат при відключенні

# Для продакшену на WSGI-сервері, не використовуйте socketio.run()
# Цей блок виконується лише при прямому запуску файлу (python app.py)
if __name__ == '__main__':
    socketio.run(app, debug=True)
