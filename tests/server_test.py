"""Isolated API integration test; does not touch the real database."""
import importlib.util
import sys
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
import http.cookiejar
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).parents[1]))
spec = importlib.util.spec_from_file_location('server', Path(__file__).parents[1] / 'server.py')
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

class API(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        server.DB = Path(cls.tmp.name) / 'test.db'
        cls.teacher_key = server.initialize()
        with server.closing(server.connect()) as db, db:
            for login, role in [('teacher-test', 'teacher'), ('student-test', 'student')]:
                salt = 'test-salt-' + login
                db.execute('INSERT INTO users(login,salt,password,role) VALUES (?,?,?,?)',
                           (login, salt, server.password_hash('test-password-123',salt), role))
        cls.http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        cls.base = 'http://127.0.0.1:' + str(cls.http.server_port)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()
        cls.tmp.cleanup()

    def client(self):
        return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def setUp(self):
        server.AUTH_ATTEMPTS.clear()
        with server.closing(server.connect()) as db,db:
            row=db.execute('SELECT body,revision FROM events WHERE id=1').fetchone()
            self.original_event=(row['body'],row['revision'])
            db.execute('DELETE FROM memberships')
            db.execute('DELETE FROM invites')

    def tearDown(self):
        with server.closing(server.connect()) as db,db:
            db.execute('UPDATE events SET body=?,revision=? WHERE id=1',self.original_event)

    def teacher(self):
        client=self.client()
        self.assertEqual(self.req(client,'/api/login',{'login':'teacher-test','password':'test-password-123'})[0],200)
        return client

    def test_workspace_invitation_lifecycle(self):
        teacher=self.teacher();student=self.client()
        code,result=self.req(teacher,'/api/invites',{'className':'9А','emails':[]})
        self.assertEqual(code,200);invite=result['invites'][0]
        self.assertEqual(self.req(student,'/api/register',{'login':'invited-student','password':'student-password','name':'Иван','inviteCode':invite['code']})[0],201)
        self.req(student,'/api/login',{'login':'invited-student','password':'student-password'})
        _,state=self.req(student,'/api/state');self.assertEqual(state['accessStatus'],'pending');self.assertEqual(state['participants'],[])
        self.assertEqual(self.req(student,'/api/roster')[0],403)
        self.assertEqual(self.req(student,'/api/invites',{'className':'9А'})[0],403)
        self.assertEqual(self.req(teacher,'/api/membership',{'login':'invited-student','status':'active'})[0],200)
        _,own=self.req(student,'/api/state');ident=own['ownParticipantId'];self.assertTrue(ident)
        _,state=self.req(teacher,'/api/state')
        state['settings']={'status':'live','visibility':'codes','showLeaderboard':True}
        state['tasks']=[{'id':'a','title':'Задача 1','maxScore':40},{'id':'b','title':'Задача 2','maxScore':60}]
        person=next(p for p in state['participants'] if p['id']==ident);person['taskScores']={'a':25,'b':30}
        code,saved=self.req(teacher,'/api/state',state);self.assertEqual(code,200)
        self.assertEqual(next(p for p in saved['participants'] if p['id']==ident)['score'],55)
        _,own=self.req(student,'/api/state');self.assertEqual(own['ownParticipantId'],ident)
        self.assertEqual(next(p for p in own['participants'] if p['id']==ident)['name'],'Иван')
        self.assertTrue(all(p['name'].startswith('Участник ') for p in own['participants'] if p['id']!=ident))
        saved['settings']['showLeaderboard']=False
        self.assertEqual(self.req(teacher,'/api/state',saved)[0],200)
        _,private=self.req(student,'/api/state')
        self.assertEqual(len(private['participants']),1)
        self.assertEqual(private['ownRank'],5,'Private leaderboard must retain the actual place')
        self.assertEqual(self.req(teacher,'/api/membership',{'login':'invited-student','status':'frozen'})[0],200)
        _,blocked=self.req(student,'/api/state');self.assertEqual(blocked['participants'],[]);self.assertEqual(blocked['accessStatus'],'frozen')
        self.assertEqual(self.req(student,'/api/profile')[0],200)
        self.req(teacher,'/api/membership',{'login':'invited-student','status':'active'})
        self.req(teacher,'/api/membership',{'login':'invited-student','status':'detached'})
        self.assertEqual(self.req(student,'/api/state')[1]['accessStatus'],'detached')
        self.assertTrue(any(p['id']==ident for p in self.req(teacher,'/api/state')[1]['participants']))
        reused=self.req(self.client(),'/api/register',{'login':'reuse-student','password':'student-password','inviteCode':invite['code']})
        self.assertEqual(reused[0],409)
        self.assertEqual(self.req(self.client(),'/api/login',{'login':'reuse-student','password':'student-password'})[0],401)

    def test_workspace_invites_bound_email_and_expiry(self):
        teacher=self.teacher()
        _,created=self.req(teacher,'/api/invites',{'className':'10Б','emails':['a@example.ru','b@example.ru']})
        self.assertEqual(len(created['invites']),2)
        invitation=created['invites'][0]
        self.assertEqual(self.req(self.client(),'/api/register',{'login':'email-student','password':'student-password','email':'wrong@example.ru','inviteCode':invitation['code']})[0],403)
        self.assertEqual(self.req(self.client(),'/api/register',{'login':'email-student','password':'student-password','email':'a@example.ru','inviteCode':invitation['code']})[0],201)
        with server.closing(server.connect()) as db,db:
            db.execute('UPDATE invites SET expires_at=0 WHERE id=?',(created['invites'][1]['id'],))
        self.assertEqual(self.req(self.client(),'/api/register',{'login':'expired-student','password':'student-password','email':'b@example.ru','inviteCode':created['invites'][1]['code']})[0],409)
        _,created=self.req(teacher,'/api/invites',{'className':'10Б'})
        invitation=created['invites'][0]
        self.req(teacher,'/api/invites/revoke',{'id':invitation['id']})
        self.assertEqual(self.req(self.client(),'/api/register',{'login':'revoked-student','password':'student-password','inviteCode':invitation['code']})[0],409)

    def test_workspace_profile_password_sessions(self):
        client=self.client();second=self.client()
        self.req(client,'/api/register',{'login':'profile-student','password':'student-password'})
        for c in [client,second]:self.req(c,'/api/login',{'login':'profile-student','password':'student-password'})
        code,profile=self.req(client,'/api/profile',{'name':'Анна','school':'Школа 1','className':'9А','email':'anna@example.ru','notifications':False,'role':'admin'})
        self.assertEqual(code,200);self.assertEqual(profile['role'],'student');self.assertFalse(profile['notifications'])
        self.assertEqual(self.req(client,'/api/profile')[1]['school'],'Школа 1')
        self.assertEqual(self.req(client,'/api/password',{'currentPassword':'wrong','newPassword':'changed-password'})[0],400)
        self.assertEqual(self.req(client,'/api/password',{'currentPassword':'student-password','newPassword':'changed-password'})[0],200)
        for c in [client,second]:self.assertEqual(self.req(c,'/api/profile')[0],401)
        self.assertEqual(self.req(client,'/api/login',{'login':'profile-student','password':'changed-password'})[0],200)

    def test_workspace_admin_live_permissions(self):
        teacher=self.teacher();admin=self.client();subject=self.client()
        self.req(admin,'/api/register',{'login':'workspace-admin','password':'admin-password'})
        self.req(subject,'/api/register',{'login':'role-subject','password':'student-password'})
        with server.closing(server.connect()) as db,db:db.execute('UPDATE users SET role="admin" WHERE login="workspace-admin"')
        self.req(admin,'/api/login',{'login':'workspace-admin','password':'admin-password'})
        self.req(subject,'/api/login',{'login':'role-subject','password':'student-password'})
        self.assertEqual(self.req(teacher,'/api/admin/users')[0],403)
        self.assertEqual(self.req(subject,'/api/admin/users',{'login':'role-subject','role':'admin'})[0],403)
        self.assertEqual(self.req(admin,'/api/admin/users',{'login':'workspace-admin','role':'student'})[0],409)
        self.assertEqual(self.req(admin,'/api/admin/users',{'login':'role-subject','role':'teacher'})[0],200)
        _,state=self.req(subject,'/api/state');self.assertEqual(self.req(subject,'/api/state',state)[0],200)
        self.assertEqual(self.req(admin,'/api/admin/users',{'login':'role-subject','role':'teacher','disabled':True})[0],200)
        self.assertEqual(self.req(subject,'/api/profile')[0],401)

    def test_workspace_settings_atomic_validation(self):
        teacher=self.teacher();_,before=self.req(teacher,'/api/state')
        for settings in [{'startsAt':'2026-11-11T10:00'},{'startsAt':'2026-11-12T10:00Z','endsAt':'2026-11-11T10:00Z'},{'status':'unknown'}]:
            candidate={**before,'settings':settings}
            self.assertEqual(self.req(teacher,'/api/state',candidate)[0],400)
            self.assertEqual(self.req(teacher,'/api/state')[1],before)
        candidate={**before,'tasks':[{'id':'a','title':'А','maxScore':10}]}
        self.assertEqual(self.req(teacher,'/api/state',candidate)[0],400)

    def test_registration(self):
        client = self.client()
        code, user = self.req(client, '/api/register', {'login':'New.Student','password':'strong-password-123','role':'teacher'})
        self.assertEqual(code, 201)
        self.assertEqual(user, {'login':'new.student', 'role':'student'})
        self.assertEqual(self.req(client, '/api/state')[0], 401)
        self.assertEqual(self.req(client, '/api/login', {'login':'NEW.STUDENT','password':'strong-password-123'})[0],200)
        self.assertEqual(self.req(client, '/api/state', {})[0],403)
        self.assertEqual(self.req(client, '/api/register', {'login':'new.STUDENT','password':'other-password-123'})[0],409)
        self.assertEqual(self.req(client, '/api/register', {'login':'bad-key','password':'strong-password-123','teacherKey':'wrong'})[0],403)
        self.assertEqual(self.req(client, '/api/login', {'login':'bad-key','password':'strong-password-123'})[0],401)
        code, teacher = self.req(client, '/api/register', {'login':'new.teacher','password':'strong-password-123','teacherKey':self.teacher_key})
        self.assertEqual(code,201)
        self.assertEqual(teacher['role'],'teacher')
        self.assertEqual(self.req(client, '/api/login', {'login':'new.teacher','password':'strong-password-123'})[0],200)
        _, state = self.req(client, '/api/state')
        self.assertEqual(self.req(client, '/api/state', state)[0],200)
        with server.closing(server.connect()) as db:
            row=db.execute('SELECT * FROM users WHERE login=?',('new.teacher',)).fetchone()
            self.assertNotEqual(row['password'],'strong-password-123')
            self.assertNotEqual(db.execute('SELECT value FROM settings WHERE key=?',('teacher_key_hash',)).fetchone()[0],self.teacher_key)

    def test_registration_validation(self):
        client = self.client()
        for data in [[], None, {'login':'ab','password':'strong-password'}, {'login':'valid','password':'short'},
                     {'login':'valid','password':'x'*129}, {'login':'valid','password':'strong-password','teacherKey':{}},
                     {'login':'no spaces','password':'strong-password'}]:
            if data is None:
                continue
            self.assertEqual(self.req(client,'/api/register',data)[0],400)

    def test_rotated_key_and_restart(self):
        client=self.client()
        old_key=self.teacher_key
        fresh=server.rotate_teacher_key()
        try:
            self.assertIsNone(server.initialize(), 'Restart must not rotate the key')
            self.assertEqual(self.req(client,'/api/register',{'login':'old-invite','password':'strong-password','teacherKey':old_key})[0],403)
            self.assertEqual(self.req(client,'/api/register',{'login':'new-invite','password':'strong-password','teacherKey':fresh})[0],201)
        finally:
            with server.closing(server.connect()) as db, db:
                db.execute('UPDATE settings SET value=? WHERE key=?',(server.hashlib.sha256(old_key.encode()).hexdigest(),'teacher_key_hash'))

    def test_auth_rate_limit(self):
        client=self.client()
        for _ in range(20):
            self.assertEqual(self.req(client,'/api/login',{'login':'absent','password':'wrong'})[0],401)
        self.assertEqual(self.req(client,'/api/register',{'login':'blocked','password':'strong-password'})[0],429)

    def test_legacy_demo_accounts_are_disabled(self):
        legacy = Path(self.tmp.name) / 'legacy.db'
        with patch.object(server, 'DB', legacy):
            with server.closing(server.connect()) as db, db:
                db.execute('CREATE TABLE users(login TEXT PRIMARY KEY,salt TEXT,password TEXT,role TEXT)')
                db.execute('CREATE TABLE events(id INTEGER PRIMARY KEY,body TEXT,revision INTEGER)')
                preserved={'eventName':'Сохранённое мероприятие','maxScore':100,'participants':[]}
                db.execute('INSERT INTO events VALUES (1,?,7)',(json.dumps(preserved),))
                for login, password, role in [('teacher','teacher123','teacher'),('student','student123','student')]:
                    salt='legacy-salt'
                    db.execute('INSERT INTO users VALUES (?,?,?,?)',
                               (login,salt,server.password_hash(password,salt),role))
                db.execute('INSERT INTO users VALUES (?,?,?,?)',
                           ('organizer',salt,server.password_hash('personal-password',salt),'teacher'))
            server.initialize()
            for login,password in [('teacher','teacher123'),('student','student123')]:
                self.assertEqual(self.req(self.client(),'/api/login',{'login':login,'password':password})[0],401)
            client=self.client()
            self.assertEqual(self.req(client,'/api/login',{'login':'organizer','password':'personal-password'})[0],200)
            self.assertEqual(self.req(client,'/api/state')[1],{**preserved,'revision':7})

    def req(self, client, path, data=None):
        request = urllib.request.Request(self.base+path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type':'application/json'})
        try:
            response = client.open(request)
        except urllib.error.HTTPError as e:
            response = e
        with response:
            raw=response.read()
            return response.code, json.loads(raw)

    def test_head_boundary(self):
        client = self.client()
        for path in ['/server.py', '/schoolflow.sqlite3', '/tests/server_test.py', '/api/state', '/%73erver.py']:
            request = urllib.request.Request(self.base + path, method='HEAD')
            with self.assertRaises(urllib.error.HTTPError) as error:
                client.open(request)
            with error.exception as response:
                self.assertEqual(response.code, 404)
                self.assertEqual(response.read(), b'')
        with client.open(urllib.request.Request(self.base + '/js/core.js', method='HEAD')) as response:
            self.assertEqual(response.code, 200)
            self.assertEqual(response.read(), b'')

    def test_initialize_preserves_existing_data_without_rehashing(self):
        client = self.client()
        self.req(client, '/api/login', {'login':'teacher-test', 'password':'test-password-123'})
        before = self.req(client, '/api/state')[1]
        with patch.object(server.hashlib, 'pbkdf2_hmac', wraps=server.hashlib.pbkdf2_hmac) as digest:
            server.initialize()
            digest.assert_not_called()
        self.assertEqual(self.req(client, '/api/state')[1], before)

    def test_expired_session(self):
        client = self.client()
        self.assertEqual(self.req(client, '/api/login', {'login':'teacher-test', 'password':'test-password-123'})[0], 200)
        for handler in client.handlers:
            if isinstance(handler, urllib.request.HTTPCookieProcessor):
                token = next(iter(handler.cookiejar)).value
        server.SESSIONS[token]['expires'] = 0
        self.assertEqual(self.req(client, '/api/state')[0], 401)
        self.assertEqual(self.req(client, '/api/state', {})[0], 401)
        self.assertIsNone(self.req(client, '/api/session')[1]['user'])

    def test_invalid_batch_is_atomic(self):
        client = self.client()
        self.req(client, '/api/login', {'login':'teacher-test', 'password':'test-password-123'})
        _, before = self.req(client, '/api/state')
        candidate = json.loads(json.dumps(before))
        candidate['participants'] += [dict(id='valid', name='Valid', className='9A', score=0),
                                      dict(id='invalid', name='Invalid', className='9A', score=-1)]
        self.assertEqual(self.req(client, '/api/state', candidate)[0], 400)
        self.assertEqual(self.req(client, '/api/state')[1], before)

    def test_workflow(self):
        teacher, student = self.client(), self.client()
        self.assertEqual(self.req(teacher,'/api/state')[0],401)
        self.assertEqual(self.req(teacher,'/api/login',{'login':'teacher-test','password':'bad'})[0],401)
        self.assertEqual(self.req(teacher,'/api/login',{'login':'teacher-test','password':'test-password-123'})[0],200)
        self.assertEqual(self.req(student,'/api/login',{'login':'student-test','password':'test-password-123'})[0],200)
        _, state = self.req(teacher,'/api/state')
        self.assertEqual(self.req(student,'/api/state',state)[0],403)
        state['participants'].append(dict(id='zero',name='Ноль',className='9А',score=0))
        code, saved = self.req(teacher,'/api/state',state)
        self.assertEqual(code,200)
        self.assertEqual(saved['participants'][-1]['score'],0)
        self.assertEqual(self.req(teacher,'/api/state',state)[0],409)
        saved['participants'][-1]['score']=101
        self.assertEqual(self.req(teacher,'/api/state',saved)[0],400)
        saved['participants'][-1]['score']=None
        self.assertEqual(self.req(teacher,'/api/state',saved)[0],200)
        for path in ['/schoolflow.sqlite3','/server.py','/../server.py']:
            self.assertEqual(self.req(teacher,path)[0],404)
        self.req(teacher,'/api/logout',{})
        self.assertEqual(self.req(teacher,'/api/state')[0],401)

if __name__ == '__main__':
    unittest.main()
