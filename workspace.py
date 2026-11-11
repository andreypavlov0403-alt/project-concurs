"""Profiles, one-use invitations, event membership and administrator operations."""
from contextlib import closing
import hashlib
import hmac
import json
import re
import secrets
import time

from domain import text, validate_event


class APIError(Exception):
    def __init__(self,status,message):
        self.status=status
        super().__init__(message)


def initialize(db):
    db.execute('CREATE TABLE IF NOT EXISTS profiles(login TEXT PRIMARY KEY,name TEXT NOT NULL DEFAULT "",school TEXT NOT NULL DEFAULT "",class_name TEXT NOT NULL DEFAULT "",email TEXT NOT NULL DEFAULT "",notifications INTEGER NOT NULL DEFAULT 1)')
    db.execute('CREATE TABLE IF NOT EXISTS memberships(login TEXT PRIMARY KEY,participant_id TEXT UNIQUE,status TEXT NOT NULL,created_by TEXT,joined_at REAL NOT NULL)')
    db.execute('CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,email TEXT NOT NULL,class_name TEXT NOT NULL,created_by TEXT NOT NULL,created_at REAL NOT NULL,expires_at REAL NOT NULL,status TEXT NOT NULL,used_by TEXT)')
    db.execute('CREATE INDEX IF NOT EXISTS invites_status ON invites(status,expires_at)')


def profile(db,login):
    row=db.execute('SELECT * FROM profiles WHERE login=?',(login,)).fetchone()
    user=db.execute('SELECT login,role FROM users WHERE login=?',(login,)).fetchone()
    return dict(login=user['login'],role=user['role'],name=row['name'] if row else '',school=row['school'] if row else '',
                className=row['class_name'] if row else '',email=row['email'] if row else '',notifications=bool(row['notifications']) if row else True)


def event(db):
    row=db.execute('SELECT body,revision FROM events WHERE id=1').fetchone()
    return {**json.loads(row['body']),'revision':row['revision']}


def write_event(db,state):
    clean=validate_event(state)
    db.execute('UPDATE events SET body=?,revision=revision+1 WHERE id=1',(json.dumps(clean,ensure_ascii=False),))


def invite_for(db,code):
    if not isinstance(code,str) or not 10<=len(code)<=128:
        raise APIError(400,'Проверьте код приглашения')
    row=db.execute('SELECT * FROM invites WHERE token_hash=?',(hashlib.sha256(code.strip().encode()).hexdigest(),)).fetchone()
    if not row or row['status']!='pending' or row['expires_at']<=time.time():
        raise APIError(409,'Приглашение использовано, отменено или истекло')
    return row


def accept_invite(db,login,code):
    invitation=invite_for(db,code)
    user=db.execute('SELECT role FROM users WHERE login=?',(login,)).fetchone()
    if user['role']!='student':
        raise APIError(403,'Приглашение предназначено для ученика')
    info=profile(db,login)
    if invitation['email'] and info['email'].lower()!=invitation['email'].lower():
        raise APIError(403,'Email аккаунта не совпадает с приглашением')
    membership=db.execute('SELECT * FROM memberships WHERE login=?',(login,)).fetchone()
    if membership and membership['status']!='detached':
        raise APIError(409,'Аккаунт уже связан с мероприятием')
    state=event(db)
    ident=membership['participant_id'] if membership else secrets.token_hex(16)
    person=next((p for p in state['participants'] if p['id']==ident),None)
    if person is None:
        if len(state['participants'])>=10000:
            raise APIError(400,'В мероприятии уже 10000 участников')
        state['participants'].append(dict(id=ident,name=info['name'] or login,className=invitation['class_name'],score=None))
    status='pending' if state.get('settings',{}).get('approvalRequired',True) else 'active'
    db.execute('INSERT OR REPLACE INTO memberships VALUES (?,?,?,?,?)',(login,ident,status,invitation['created_by'],time.time()))
    db.execute('UPDATE invites SET status="used",used_by=? WHERE id=?',(login,invitation['id']))
    write_event(db,state)
    return {'status':status,'participantId':ident}


def project_state(db,user):
    state=event(db)
    if user['role']!='student':
        return state
    membership=db.execute('SELECT * FROM memberships WHERE login=?',(user['login'],)).fetchone()
    status=membership['status'] if membership else 'not_joined'
    own=membership['participant_id'] if membership and status=='active' else None
    blocked={r['participant_id'] for r in db.execute('SELECT participant_id FROM memberships WHERE status IN ("pending","detached")')}
    people=[p for p in state['participants'] if p['id'] not in blocked]
    own_person=next((p for p in people if p['id']==own),None)
    own_rank=1+sum(1 for p in people if p['score'] is not None and p['score']>own_person['score']) if own_person and own_person['score'] is not None else None
    if membership and status!='active':
        people=[]
    elif not state.get('settings',{}).get('showLeaderboard',True):
        people=[p for p in people if p['id']==own]
    if state.get('settings',{}).get('visibility')=='codes':
        people=[{**p,'name':p['name'] if p['id']==own else 'Участник '+p['id'][:8], 'className':p['className'] if p['id']==own else ''} for p in people]
    return {**state,'participants':people,'ownParticipantId':own,'ownRank':own_rank,'accessStatus':status}


class Service:
    def __init__(self,connect,password_hash):
        self.connect=connect;self.password_hash=password_hash

    def get(self,path,user):
        with closing(self.connect()) as db:
            if path=='profile':return profile(db,user['login'])
            if path=='roster':
                self.teacher(user)
                state=event(db);people={p['id']:p for p in state['participants']}
                rows=[]
                for row in db.execute('SELECT m.*,p.name,p.email,p.school FROM memberships m LEFT JOIN profiles p ON p.login=m.login ORDER BY m.joined_at DESC'):
                    person=people.get(row['participant_id'])
                    rows.append({**dict(row),'name':row['name'] or row['login'],'participant':person})
                invitations=[dict(row) for row in db.execute('SELECT id,email,class_name,created_by,created_at,expires_at,status,used_by FROM invites ORDER BY created_at DESC LIMIT 500')]
                return {'members':rows,'invites':invitations}
            if path=='admin/users':
                self.admin(user)
                return {'users':[dict(row) for row in db.execute('SELECT login,role,disabled FROM users ORDER BY login')]}
        raise APIError(404,'Не найдено')

    @staticmethod
    def teacher(user):
        if user['role'] not in {'teacher','admin'}:raise APIError(403,'Доступно учителю')

    @staticmethod
    def admin(user):
        if user['role']!='admin':raise APIError(403,'Доступно администратору')

    def post(self,path,data,user):
        with closing(self.connect()) as db,db:
            db.execute('BEGIN IMMEDIATE')
            if path=='profile':
                name=text(data.get('name',''),'Имя',100)
                school=text(data.get('school',''),'Школа',150)
                group=text(data.get('className',''),'Класс',30)
                email=text(data.get('email',''),'Email',200).lower()
                if email and not re.fullmatch(r'[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+',email):raise APIError(400,'Проверьте email')
                notifications=data.get('notifications',True)
                if type(notifications) is not bool:raise APIError(400,'Проверьте настройки уведомлений')
                db.execute('INSERT OR REPLACE INTO profiles VALUES (?,?,?,?,?,?)',(user['login'],name,school,group,email,int(notifications)))
                return profile(db,user['login'])
            if path=='password':
                old,new=data.get('currentPassword'),data.get('newPassword')
                if not isinstance(old,str) or len(old)>128 or not isinstance(new,str) or not 10<=len(new)<=128:
                    raise APIError(400,'Новый пароль: 10–128 символов')
                row=db.execute('SELECT salt,password FROM users WHERE login=?',(user['login'],)).fetchone()
                if not hmac.compare_digest(row['password'],self.password_hash(old,row['salt'])):raise APIError(400,'Текущий пароль неверен')
                if old==new:raise APIError(400,'Новый пароль должен отличаться')
                salt=secrets.token_hex(16)
                db.execute('UPDATE users SET salt=?,password=? WHERE login=?',(salt,self.password_hash(new,salt),user['login']))
                return {'changed':True}
            if path=='invites/accept':return accept_invite(db,user['login'],data.get('code'))
            if path=='invites':
                self.teacher(user)
                group=text(data.get('className',''),'Класс',30,True)
                emails=data.get('emails',[])
                if not isinstance(emails,list) or len(emails)>100:raise APIError(400,'До 100 адресов за один раз')
                emails=list(dict.fromkeys(text(e,'Email',200).lower() for e in emails)) or ['']
                if any(e and not re.fullmatch(r'[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+',e) for e in emails):raise APIError(400,'Проверьте email в списке')
                now=time.time();results=[]
                for email in emails:
                    code=secrets.token_urlsafe(24);ident=secrets.token_hex(12)
                    db.execute('INSERT INTO invites VALUES (?,?,?,?,?,?,?,?,?)',(ident,hashlib.sha256(code.encode()).hexdigest(),email,group,user['login'],now,now+7*86400,'pending',None))
                    results.append({'id':ident,'code':code,'email':email,'className':group,'expiresAt':now+7*86400})
                return {'invites':results}
            if path=='invites/revoke':
                self.teacher(user)
                result=db.execute('UPDATE invites SET status="revoked" WHERE id=? AND status="pending"',(data.get('id'),))
                if result.rowcount!=1:raise APIError(409,'Приглашение уже использовано или отменено')
                return {'revoked':True}
            if path=='membership':
                self.teacher(user)
                login=text(data.get('login'),'Логин',32,True);status=data.get('status')
                if status not in {'active','pending','frozen','detached'}:raise APIError(400,'Проверьте статус')
                row=db.execute('SELECT * FROM memberships WHERE login=?',(login,)).fetchone()
                if not row:raise APIError(404,'Участник не найден')
                state=event(db)
                ident=text(data.get('participantId',row['participant_id']),'Идентификатор',100,True)
                if not any(p['id']==ident for p in state['participants']):raise APIError(400,'Выбранная запись отсутствует в мероприятии')
                if db.execute('SELECT 1 FROM memberships WHERE participant_id=? AND login!=?',(ident,login)).fetchone():raise APIError(409,'Запись уже связана с другим аккаунтом')
                db.execute('UPDATE memberships SET status=?,participant_id=? WHERE login=?',(status,ident,login))
                # Bump the version: an open teacher window must reconcile membership changes.
                db.execute('UPDATE events SET revision=revision+1 WHERE id=1')
                return {'login':login,'status':status}
            if path=='admin/users':
                self.admin(user)
                login=text(data.get('login'),'Логин',32,True);role=data.get('role');disabled=data.get('disabled',False)
                if role not in {'student','teacher','admin'} or type(disabled) is not bool:raise APIError(400,'Проверьте роль и доступ')
                row=db.execute('SELECT * FROM users WHERE login=?',(login,)).fetchone()
                if not row:raise APIError(404,'Аккаунт не найден')
                if row['role']=='admin' and (role!='admin' or disabled):
                    if db.execute('SELECT count(*) FROM users WHERE role="admin" AND disabled=0').fetchone()[0]<=1:raise APIError(409,'Нельзя отключить последнего администратора')
                db.execute('UPDATE users SET role=?,disabled=? WHERE login=?',(role,int(disabled),login))
                return {'login':login,'role':role,'disabled':disabled}
        raise APIError(404,'Не найдено')
