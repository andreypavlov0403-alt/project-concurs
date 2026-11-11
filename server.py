"""SchoolFlow: local prototype, Python 3.10+, no third-party dependencies."""
import argparse
import hashlib
import hmac
import json
import re
import secrets
import sqlite3
import time
from contextlib import closing
from collections import deque
from threading import Lock
from http.cookies import SimpleCookie
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from domain import validate_event
import workspace

ROOT = Path(__file__).resolve().parent
DB = ROOT / 'schoolflow.sqlite3'
SESSIONS = {}
AUTH_ATTEMPTS = {}
AUTH_LOCK = Lock()

def password_hash(password, salt):
    return hashlib.pbkdf2_hmac('sha256', password.encode(), salt.encode(), 200000).hex()

def create_teacher_key(db):
    key = 'SF-T-' + secrets.token_urlsafe(32)
    db.execute('INSERT OR REPLACE INTO settings VALUES (?,?)',
               ('teacher_key_hash', hashlib.sha256(key.encode()).hexdigest()))
    return key

def rotate_teacher_key():
    with closing(connect()) as db, db:
        return create_teacher_key(db)

def allow_auth(address):
    now = time.monotonic()
    with AUTH_LOCK:
        for ip in list(AUTH_ATTEMPTS):
            attempts = AUTH_ATTEMPTS[ip]
            while attempts and attempts[0] <= now - 60:
                attempts.popleft()
            if not attempts:
                del AUTH_ATTEMPTS[ip]
        attempts = AUTH_ATTEMPTS.setdefault(address, deque())
        if len(attempts) >= 20:
            return False
        attempts.append(now)
        return True

def connect():
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    return db

def initialize():
    created_key = None
    with closing(connect()) as db, db:
        db.execute('CREATE TABLE IF NOT EXISTS users (login TEXT PRIMARY KEY, salt TEXT, password TEXT, role TEXT)')
        legacy_users = 'disabled' not in {row['name'] for row in db.execute('PRAGMA table_info(users)')}
        if legacy_users:
            db.execute('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0')
        db.execute('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        if not db.execute('SELECT 1 FROM settings WHERE key=?', ('teacher_key_hash',)).fetchone():
            created_key = create_teacher_key(db)
        workspace.initialize(db)
        db.execute('CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT, revision INTEGER)')
        # Retire public demo credentials; otherwise the teacher invitation is bypassed.
        for login, password in ([('teacher', 'teacher123'), ('student', 'student123')] if legacy_users else []):
            row = db.execute('SELECT * FROM users WHERE login=? AND disabled=0', (login,)).fetchone()
            if row and hmac.compare_digest(row['password'], password_hash(password, row['salt'])):
                db.execute('UPDATE users SET disabled=1 WHERE login=?', (login,))
        sample = json.loads((ROOT / 'data/sample.json').read_text(encoding='utf-8-sig'))
        for p in sample['participants']:
            p['id'] = secrets.token_hex(16)
        db.execute('INSERT OR IGNORE INTO events VALUES (1,?,1)', (json.dumps(sample, ensure_ascii=False),))
    return created_key

def validate(data):
    return validate_event(data)

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def reply(self, code, data, cookie=None):
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        if cookie:
            self.send_header('Set-Cookie', cookie)
        self.end_headers()
        if self.command != 'HEAD':
            self.wfile.write(raw)

    def send_head(self):
        # Both GET and inherited HEAD must use the same static-file boundary.
        path = self.path.split('?')[0]
        if path not in {'/', '/index.html', '/css/style.css', '/js/main.js',
                        '/js/core.js', '/js/theme.js', '/js/icons.js', '/js/workspace.js', '/data/sample.csv', '/data/sample.json'}:
            self.reply(404, {'error': 'Не найдено'})
            return None
        return super().send_head()

    def user(self):
        try:
            cookie = SimpleCookie(self.headers.get('Cookie', ''))
            token = cookie['schoolflow'].value if 'schoolflow' in cookie else ''
            session = SESSIONS.get(token)
            if session and session['expires'] > time.time():
                with closing(connect()) as db:
                    row = db.execute('SELECT role,disabled FROM users WHERE login=?',(session['login'],)).fetchone()
                if row and not row['disabled']:
                    return {**session,'role':row['role']}
                SESSIONS.pop(token,None)
        except Exception:
            pass
        return None

    def body(self):
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 5_000_000:
            raise ValueError('Размер запроса должен быть от 1 байта до 5 МБ')
        return json.loads(self.rfile.read(size))

    def do_GET(self):
        if self.path in {'/api/profile','/api/roster','/api/admin/users'}:
            user=self.user()
            if not user:return self.reply(401,{'error':'Войдите в систему'})
            try:return self.reply(200,workspace.Service(connect,password_hash).get(self.path[5:],user))
            except workspace.APIError as exc:return self.reply(exc.status,{'error':str(exc)})
        if self.path == '/api/session':
            user = self.user()
            return self.reply(200, {'user': {'login': user['login'], 'role': user['role']} if user else None})
        if self.path == '/api/state':
            if not self.user():
                return self.reply(401, {'error': 'Войдите в систему'})
            with closing(connect()) as db:
                projected = workspace.project_state(db,self.user())
            return self.reply(200, projected)
        # Explicit allowlist prevents exposure of database, source, and backups.
        path = self.path.split('?')[0]
        if path not in ['/', '/index.html', '/css/style.css', '/js/main.js', '/js/core.js', '/js/theme.js', '/js/icons.js', '/js/workspace.js', '/data/sample.csv', '/data/sample.json']:
            return self.reply(404, {'error': 'Не найдено'})
        super().do_GET()

    def do_POST(self):
        # Browser mutations must originate from this host; JSON blocks simple cross-origin forms.
        if self.headers.get('Origin') and self.headers['Origin'] != 'http://' + self.headers.get('Host', ''):
            return self.reply(403, {'error': 'Недопустимый источник запроса'})
        if not self.headers.get('Content-Type', '').startswith('application/json'):
            return self.reply(415, {'error': 'Требуется application/json'})
        try:
            data = self.body()
            if not isinstance(data, dict):
                raise ValueError('Ожидается объект запроса')
            if self.path in {'/api/login', '/api/register', '/api/password'} and not allow_auth(self.client_address[0]):
                return self.reply(429, {'error': 'Слишком много попыток. Подождите одну минуту.'})
            if self.path == '/api/register':
                login, password, teacher_key = data.get('login'), data.get('password'), data.get('teacherKey', '')
                if not isinstance(login, str) or not re.fullmatch(r'[A-Za-z0-9_.-]{3,32}', login.strip()):
                    raise ValueError('Логин: 3–32 символа, латинские буквы, цифры, точка, дефис или подчёркивание')
                login = login.strip().lower()
                if not isinstance(password, str) or not 10 <= len(password) <= 128:
                    raise ValueError('Пароль: от 10 до 128 символов')
                if not isinstance(teacher_key, str) or len(teacher_key) > 128:
                    raise ValueError('Некорректный ключ учителя')
                teacher_key = teacher_key.strip()
                role = 'student'
                if teacher_key:
                    with closing(connect()) as db:
                        row = db.execute('SELECT value FROM settings WHERE key=?', ('teacher_key_hash',)).fetchone()
                    if not row or not hmac.compare_digest(row['value'], hashlib.sha256(teacher_key.encode()).hexdigest()):
                        return self.reply(403, {'error': 'Неверный ключ учителя. Аккаунт не создан.'})
                    role = 'teacher'
                salt = secrets.token_hex(16)
                digest = password_hash(password, salt)
                email=workspace.text(data.get('email',''),'Email',200).lower()
                if email and not re.fullmatch(r'[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+',email):
                    raise ValueError('Проверьте email')
                try:
                    with closing(connect()) as db, db:
                        db.execute('BEGIN IMMEDIATE')
                        # Recheck inside the transaction so a concurrent key rotation wins.
                        if role == 'teacher':
                            row = db.execute('SELECT value FROM settings WHERE key=?', ('teacher_key_hash',)).fetchone()
                            if not row or not hmac.compare_digest(row['value'], hashlib.sha256(teacher_key.encode()).hexdigest()):
                                return self.reply(403, {'error': 'Ключ изменился. Запросите новый ключ у организатора.'})
                        db.execute('INSERT INTO users(login,salt,password,role) VALUES (?,?,?,?)', (login,salt,digest,role))
                        db.execute('INSERT INTO profiles(login,name,email) VALUES (?,?,?)',
                                   (login,workspace.text(data.get('name',''),'Имя',100),email))
                        if data.get('inviteCode'):
                            workspace.accept_invite(db,login,data['inviteCode'])
                except sqlite3.IntegrityError:
                    return self.reply(409, {'error': 'Этот логин уже занят'})
                return self.reply(201, {'login': login, 'role': role})
            if self.path == '/api/login':
                login, password = data.get('login'), data.get('password')
                if not isinstance(login, str) or not isinstance(password, str) or len(login) > 32 or len(password) > 128:
                    raise ValueError('Проверьте логин и пароль')
                with closing(connect()) as db:
                    row = db.execute('SELECT * FROM users WHERE lower(login)=?', (login.strip().lower(),)).fetchone()
                if not row or row['disabled'] or not hmac.compare_digest(row['password'], password_hash(password, row['salt'])):
                    return self.reply(401, {'error': 'Неверный логин или пароль'})
                token = secrets.token_urlsafe(32)
                SESSIONS[token] = dict(login=row['login'], role=row['role'], expires=time.time()+28800)
                return self.reply(200, {'login': row['login'], 'role': row['role']}, f'schoolflow={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800')
            user = self.user()
            if not user:
                return self.reply(401, {'error': 'Войдите в систему'})
            if self.path == '/api/logout':
                cookie = SimpleCookie(self.headers.get('Cookie', ''))
                if 'schoolflow' in cookie:
                    SESSIONS.pop(cookie['schoolflow'].value, None)
                return self.reply(200, {}, 'schoolflow=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0')
            if self.path in {'/api/profile','/api/password','/api/invites','/api/invites/accept','/api/invites/revoke','/api/membership','/api/admin/users'}:
                result=workspace.Service(connect,password_hash).post(self.path[5:],data,user)
                if self.path=='/api/password':
                    for token in list(SESSIONS):
                        if SESSIONS.get(token,{}).get('login')==user['login']:SESSIONS.pop(token,None)
                return self.reply(200,result)
            if self.path == '/api/state':
                if user['role'] not in {'teacher','admin'}:
                    return self.reply(403, {'error': 'Изменять данные может только учитель'})
                clean = validate(data)
                with closing(connect()) as db, db:
                    result = db.execute('UPDATE events SET body=?, revision=revision+1 WHERE id=1 AND revision=?', (json.dumps(clean, ensure_ascii=False, allow_nan=False), data.get('revision')))
                    if result.rowcount != 1:
                        return self.reply(409, {'error': 'Данные изменены в другом окне. Обновите страницу и повторите действие.'})
                    valid_ids={p['id'] for p in clean['participants']}
                    for membership in db.execute('SELECT login,participant_id FROM memberships').fetchall():
                        if membership['participant_id'] not in valid_ids:
                            db.execute('UPDATE memberships SET status="detached" WHERE login=?',(membership['login'],))
                    revision = db.execute('SELECT revision FROM events WHERE id=1').fetchone()[0]
                return self.reply(200, {**clean, 'revision': revision})
            self.reply(404, {'error': 'Не найдено'})
        except workspace.APIError as exc:
            self.reply(exc.status, {'error': str(exc)})
        except (ValueError, TypeError, AttributeError) as exc:
            self.reply(400, {'error': str(exc)})
        except Exception:
            self.reply(500, {'error': 'Не удалось сохранить данные'})

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--make-admin', metavar='LOGIN', help='Назначить существующий аккаунт администратором и выйти')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--rotate-teacher-key', action='store_true', help='Создать новый ключ учителя и завершить работу')
    args = parser.parse_args()
    created_key = initialize()
    if args.rotate_teacher_key:
        created_key = created_key or rotate_teacher_key()
    if created_key:
        print('Teacher registration key (save it; shown only once): ' + created_key, flush=True)
    if args.make_admin:
        with closing(connect()) as db, db:
            result=db.execute('UPDATE users SET role="admin",disabled=0 WHERE login=?',(args.make_admin.strip().lower(),))
            if result.rowcount!=1:raise SystemExit('Account not found')
        print('Administrator role assigned',flush=True)
        raise SystemExit(0)
    if args.rotate_teacher_key:
        raise SystemExit(0)
    print(f'SchoolFlow: http://localhost:{args.port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
