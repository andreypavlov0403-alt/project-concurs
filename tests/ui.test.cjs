// DOM integration tests; native browser layout/printing needs a separate visual check.
const vm = require('node:vm'), fs = require('node:fs'), assert = require('node:assert/strict');
const path = require('node:path'), root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length, 'Duplicate element IDs');
const sample = JSON.parse(fs.readFileSync(path.join(root, 'data/sample.json'), 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const file = text => ({size:text.length, text:async () => text});
const csv = 'name,class,score\nИмпорт,9А,5';
function classes() {
  const values = new Set();
  return {toggle(n, force) { if (force ?? !values.has(n)) values.add(n); else values.delete(n); },
    add(n) { values.add(n); }, remove(n) { values.delete(n); }, contains(n) { return values.has(n); }};
}
function harness(initialHash='#dashboard') {
  const els = Object.fromEntries(ids.map(id => [id, {id, value:'', textContent:'', innerHTML:'', hidden:false,
    disabled:false, checked:false, dataset:{}, listeners:{}, classList:classes(), addEventListener(n, fn) { this.listeners[n] = fn; },
    reset() {}, setAttribute(n,v) {this[n]=v;}, showModal() { this.open = true; }, close() { this.open = false; }, focus() {}, click() {}}]));
  const controls = [...html.matchAll(/<(?:button|input)\b[^>]*\bid="([^"]+)"[^>]*>/g)]
    .filter(m => m[0].startsWith('<button') || /type="file"/.test(m[0])).map(m => els[m[1]]);
  const body = {classList:classes()}, calls = [], downloads = [];
  let serverState = {...clone(sample), revision:1}, user = {login:'teacher', role:'teacher'}, intercept;
  const response = (status, value) => ({ok:status < 400, status, json:async () => clone(value)});
  const context = {console, Intl, Date, Blob, URL, crypto:require('node:crypto').webcrypto,
    setTimeout:() => 0, clearTimeout() {}, setInterval:()=>0,clearInterval(){},addEventListener(){},confirm:()=>true,
    URLSearchParams,location:{hash:initialHash,origin:'http://localhost',pathname:'/'},history:{replaceState(a,b,url){context.location.hash=url;},pushState(a,b,url){context.location.hash=url;}},
    document:{body, querySelector:s => {assert(els[s.slice(1)], `Missing ${s}`);return els[s.slice(1)];},
      querySelectorAll:s => s === 'button, input[type=file]' ? controls : [],
      createElement:() => ({click() { downloads.push(this.download); }})},
    fetch:async (url, options) => {
      calls.push({url, options});
      if (intercept) { const result = await intercept(url, options, response); if (result) return result; }
      if (url === '/api/login') {user = {login:'teacher', role:'teacher'};return response(200, user);}
      if (url === '/api/register') {
        const data=JSON.parse(options.body);
        if(data.teacherKey && data.teacherKey!=='test-teacher-key')return response(403,{error:'Неверный ключ учителя'});
        return response(201,{login:data.login,role:data.teacherKey?'teacher':'student'});
      }
      if (url === '/api/profile')return response(200,{login:user?.login,role:user?.role,name:'',school:'',className:'',email:'',notifications:true});
      if (url === '/api/session') return response(200, {user});
      if (!user) return response(401, {error:'Войдите в систему'});
      if (url === '/api/logout') {user = null;return response(200, {});}
      if (url === '/api/state') {
        if (options?.body) {
          if (user.role !== 'teacher') return response(403, {error:'Нет прав'});
          const candidate = JSON.parse(options.body);
          if (candidate.revision !== serverState.revision) return response(409, {error:'Конфликт версий'});
          serverState = {...candidate, revision:serverState.revision + 1};
        }
        return response(200, serverState);
      }
      throw Error(url);
    }};
  context.window = context; vm.createContext(context);
  for (const f of ['js/core.js','js/icons.js','js/workspace.js','js/main.js']) vm.runInContext(fs.readFileSync(path.join(root,f),'utf8'),context);
  return {els, body, calls, downloads, evaluate:code => vm.runInContext(code,context),
    get state() {return serverState;}, set state(v) {serverState=v;}, set user(v) {user=v;}, set intercept(v) {intercept=v;},
    add(name='Новый', score='0') {
      els['participant-id'].value='';els['participant-name'].value=name;
      els['participant-class'].value='9А';els['participant-score'].value=score;
      return els['participant-form'].listeners.submit({preventDefault(){}});
    }, refresh:() => els['refresh-ranking'].listeners.click(),
    restore:f => els['restore-json'].listeners.change({target:{files:[f],value:'x'}})};
}
async function ready(hash) { const h=harness(hash); await tick(); return h; }
async function main() {
  {
    const h=await ready();const first=h.state.participants[0];
    h.state={...h.state,revision:2,tasks:[{id:'a',title:'Задача',maxScore:100}]};await h.refresh();
    h.els['participant-id'].value=first.id;h.els['participant-name'].value='Новое имя';
    h.els['participant-class'].value=first.className;h.els['participant-score'].value=String(first.score);
    await h.els['participant-form'].listeners.submit({preventDefault(){}});
    assert.equal(h.state.participants[0].score,first.score,'Editing a legacy name must not discard the aggregate score');
    assert.equal(h.state.participants[0].taskScores,undefined);
  }
  {
    const h=await ready('#results');assert.equal(h.evaluate('currentView'),'results');
    h.evaluate('navigate("account")');assert.equal(h.evaluate('location.hash'),'#account');
    const reloaded=await ready(h.evaluate('location.hash'));assert.equal(reloaded.evaluate('currentView'),'account');
    h.user={login:'student',role:'student'};await h.evaluate('boot()');h.evaluate('navigate("event")');
    assert.equal(h.evaluate('currentView'),'dashboard');
    assert.deepEqual(Array.from(h.evaluate('Workspace.parseEmails("email\\nA@example.ru\\nb@example.ru")')),['a@example.ru','b@example.ru']);
    assert.equal(h.evaluate('Workspace.codeFrom("http://localhost/#register?invite=abc123")'),'abc123');
  }
  for(const key of ['', 'test-teacher-key', 'wrong-key']) {
    const h=await ready();await h.els.logout.listeners.click();h.els['auth-register-tab'].listeners.click();
    assert.equal(h.els['register-form'].hidden,false);
    h.els['register-name'].value='New.User';h.els['register-password'].value='password-12345';
    h.els['register-confirm'].value='different';h.els['register-key'].value=key;
    let before=h.calls.length;
    await h.els['register-form'].listeners.submit({preventDefault(){}});
    assert.equal(h.calls.length,before);assert.equal(h.els['register-error'].textContent,'Пароли не совпадают');
    h.els['register-confirm'].value='password-12345';
    await h.els['register-form'].listeners.submit({preventDefault(){}});
    const request=h.calls.at(-1);assert.equal(request.url,'/api/register');
    const sent=JSON.parse(request.options.body);assert.equal(sent.login,'new.user');assert.equal(sent.role,undefined);
    assert.equal(h.els['register-key'].value,'');
    if(key==='wrong-key'){assert(h.els['register-error'].textContent.includes('Неверный'));assert.equal(h.els['register-form'].hidden,false);}
    else {assert.equal(h.els['login-form'].hidden,false);assert.equal(h.els['auth-success'].hidden,false);
      assert(h.els['auth-success'].textContent.includes(key?'учителя':'ученика'));}
  }
  {
    const h=await ready();assert.equal(h.els['stat-total'].textContent,4);
    await h.add();assert.equal(h.state.participants.at(-1).score,0);
    await h.add('Ожидающий','');assert.equal(h.state.participants.at(-1).score,null);
    assert.equal(h.els['stat-checked'].textContent,5);
    assert(!h.els['ranking-table'].innerHTML.includes('Ожидающий'));
    h.els.search.value='Ожидающий';h.els.search.listeners.input();
    assert(h.els['participants-table'].innerHTML.includes('Ожидающий'));
    h.state={...h.state,eventName:'Новое название',revision:h.state.revision+1};
    const before=h.calls.length;await h.refresh();
    assert(h.calls.slice(before).some(c=>c.url==='/api/state'&&!c.options?.body));
    assert.equal(h.els['event-heading'].textContent,'Новое название');
  }
  {
    const h=await ready();h.intercept=async()=>{throw Error('offline');};
    await h.add('НЕ СОХРАНЕНО');assert.equal(h.state.participants.length,4);
    assert.equal(h.els['stat-total'].textContent,4);
    assert(!h.els['participants-table'].innerHTML.includes('НЕ СОХРАНЕНО'));
    assert.equal(h.els['sync-notice'].hidden,false);
    h.els['export-json'].listeners.click();assert.equal(h.downloads.length,0);
    const before=h.calls.length;await h.add('Заблокировано');assert.equal(h.calls.length,before);
    h.intercept=null;await h.els['sync-retry'].listeners.click();
    assert.equal(h.els['sync-notice'].hidden,true);await h.add('Сохранено');
    assert.equal(h.state.participants.length,5);
    assert(!h.state.participants.some(p=>p.name==='НЕ СОХРАНЕНО'));
  }
  {
    const h=await ready();let lost=false;
    h.intercept=async(url,options)=>{
      if(options?.body&&!lost){h.state={...JSON.parse(options.body),revision:h.state.revision+1};lost=true;throw Error('response lost');}
    };
    await h.add('Сохранено без ответа');assert.equal(h.state.participants.length,5);
    assert.equal(h.els['stat-total'].textContent,5);assert.equal(h.els['sync-notice'].hidden,true);
    assert.equal(h.calls.filter(c=>c.options?.body).length,1);
  }
  {
    const h=await ready();h.state={...h.state,eventName:'Из другого окна',revision:2};
    await h.add('Конфликт');assert.equal(h.state.participants.length,4);
    assert.equal(h.els['event-heading'].textContent,'Из другого окна');assert.equal(h.els['stat-total'].textContent,4);
  }
  {
    const h=await ready();h.intercept=async(url,options,response)=>options?.body?response(400,{error:'Ошибка валидации'}):null;
    await h.add('Отклонено');assert.equal(h.els['stat-total'].textContent,4);assert.equal(h.els['sync-notice'].hidden,true);
  }
  {
    const h=await ready();let release;const gate=new Promise(r=>{release=r;});
    const first=h.evaluate('importCSV')({size:100,text:()=>gate});
    assert.equal(h.els['import-file'].disabled,true);
    await h.add('Параллельно');await h.evaluate('importCSV')(file(csv));await h.restore(file(JSON.stringify(sample)));
    assert.equal(h.calls.filter(c=>c.options?.body).length,0);
    release(csv);await first;assert.equal(h.state.participants.length,5);
    assert.equal(h.calls.filter(c=>c.options?.body).length,1);assert.equal(h.els['import-file'].disabled,false);
  }
  {
    const h=await ready();await h.evaluate('importCSV')(file('name,class,score\nValid,9A,1\nBroken,9A,1,5'));
    assert.equal(h.state.participants.length,4);assert.equal(h.calls.filter(c=>c.options?.body).length,0);
    await h.evaluate('importCSV')(file(csv));const revision=h.state.revision;
    await h.evaluate('importCSV')(file(csv));assert.equal(h.state.revision,revision);
    await h.restore(file(JSON.stringify({...sample,eventName:'Восстановлено'})));
    assert.equal(h.state.eventName,'Восстановлено');assert.equal(h.state.participants.length,4);
  }
  for(const trigger of ['save','refresh','logout']) {
    const h=await ready();h.user=null;
    if(trigger==='save')await h.add();if(trigger==='refresh')await h.refresh();if(trigger==='logout')await h.els.logout.listeners.click();
    assert(h.body.classList.contains('signed-out'),trigger);assert.equal(h.evaluate('currentUser'),null);
    assert.equal(h.evaluate('state.participants.length'),0);assert.equal(h.els['sync-notice'].hidden,true);
    h.els['login-name'].value='teacher';h.els['login-password'].value='teacher123';
    await h.els['login-form'].listeners.submit({preventDefault(){}});assert(!h.body.classList.contains('signed-out'));
  }
  {
    const h=await ready();await h.els['logout-mobile'].listeners.click();assert(h.body.classList.contains('signed-out'));
  }
  {
    const h=await ready();h.user={login:'student',role:'student'};await h.evaluate('boot()');const before=h.calls.length;
    await h.add();await h.evaluate('importCSV')(file(csv));await h.restore(file(JSON.stringify(sample)));
    assert.equal(h.calls.length,before);
  }
  {
    const h=await ready();
    h.state={...h.state,revision:2,participants:Array.from({length:205},(_,i)=>({id:String(i),name:`Person ${i}`,className:'9A',score:i%101}))};
    await h.refresh();
    const rows=()=>h.els['participants-table'].innerHTML.match(/<tr>/g)?.length||0;
    assert.equal(rows(),100);assert.equal(h.els['participants-prev'].disabled,true);
    h.els['participants-next'].listeners.click();assert.equal(rows(),100);
    assert.equal(h.els['participants-page'].textContent,'2 / 3');
    h.els['participants-next'].listeners.click();assert.equal(rows(),5);
    assert.equal(h.els['participants-next'].disabled,true);
    h.els.search.value='Person 204';h.els.search.listeners.input();assert.equal(rows(),1);
    assert.equal(h.els['participants-page'].textContent,'1 / 1');
    h.evaluate('var sortCalls=0;var originalRanking=SchoolFlow.ranking;SchoolFlow.ranking=(...args)=>{sortCalls++;return originalRanking(...args)}');
    await h.refresh();
    assert.equal(h.evaluate('sortCalls'),1);
    h.evaluate('renderAll();renderResults();sortedParticipants();');
    assert.equal(h.evaluate('sortCalls'),1,'Unchanged state must reuse ranking');
    await h.add('Invalidates cache','100');
    assert.equal(h.evaluate('sortCalls'),2);
    assert.equal(h.els['stat-total'].textContent,206);
  }
  console.log('UI: offline recovery, lost response, conflicts, refresh, operation lock, CSV, restore, sessions, roles passed');
}
module.exports=main();
module.exports.catch(error=>{console.error(error);process.exitCode=1;});
