'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const emptyState = () => ({eventName:'', maxScore:100, participants:[]});
let state = emptyState(); // Only data acknowledged by the server belongs here.
let currentUser = null, toastTimer, saving = false, needsSync = false;
let currentView = 'dashboard';
const isTeacher = () => ['teacher','admin'].includes(currentUser?.role);
const PARTICIPANTS_PAGE_SIZE = 100;
let participantPage = 0, participantPages = 1, derivedSource, derivedCache;

function derived() {
  if (derivedSource !== state) {
    derivedSource = state;
    derivedCache = {
      stats:SchoolFlow.statistics(state.participants, state.maxScore),
      search:state.participants.map(person => ({person, text:`${person.name} ${person.className}`.toLocaleLowerCase('ru')})),
      ranking:null
    };
  }
  return derivedCache;
}
function updatePaginationControls() {
  $('#participants-prev').disabled = saving || participantPage === 0;
  $('#participants-next').disabled = saving || participantPage >= participantPages - 1;
}

function updateControls() {
  $$('button, input[type=file]').forEach(el => {
    if (['theme-toggle','theme-toggle-auth'].includes(el.id)) { el.disabled = false; return; }
    const recovery = ['refresh-ranking', 'sync-retry', 'logout', 'logout-mobile'].includes(el.id);
    el.disabled = saving || (needsSync && Boolean(currentUser) && !recovery);
  });
  $('#sync-notice').hidden = !needsSync;
  updatePaginationControls();
}
function clearSession() {
  currentUser = null;
  Workspace.reset();
  state = emptyState();
  needsSync = false;
  document.body.classList.toggle('signed-out', true);
  document.body.classList.toggle('student', false);
  document.body.classList.toggle('manager', false);
  document.body.classList.toggle('admin', false);
  $('#participant-dialog').close();
  $('#search').value = '';
  $('#profile-login').textContent = '';
  renderAll();
  updateControls();
}
async function api(path, body) {
  const response = await fetch('/api/' + path, body === undefined ? {} : {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body)
  });
  if (response.status === 401 && path !== 'login') clearSession();
  let result;
  try { result = await response.json(); }
  catch { result = {error:'Сервер вернул некорректный ответ'}; }
  if (!response.ok) {
    const error = Error(result.error || 'Ошибка сервера');
    error.status = response.status;
    throw error;
  }
  if (result.error) throw Error(result.error);
  return result;
}
async function runOperation(action, mutation = false) {
  if (saving || (mutation && (!isTeacher() || needsSync))) return false;
  saving = true;
  updateControls();
  try { return await action(); }
  catch (error) { showToast(error.message); return false; }
  finally { saving = false; updateControls(); }
}
async function loadState() {
  const loaded = await api('state');
  state = loaded;
  needsSync = false;
  renderAll();
  updateControls();
}
async function saveState(candidate) {
  try {
    const saved = await api('state', candidate);
    state = saved;
    needsSync = false;
    renderAll();
    return true;
  } catch (error) {
    // A lost response may mean the write committed. Reconcile before another write/export.
    if (currentUser && (error.status === undefined || error.status === 409 || error.status >= 500)) {
      needsSync = true;
      try { await loadState(); } catch { /* Keep the last confirmed state and recovery notice. */ }
    }
    updateControls();
    showToast(error.message);
    return false;
  }
}
async function refreshState() {
  return runOperation(async () => {
    try { await loadState(); showToast('Данные обновлены с сервера'); return true; }
    catch (error) {
      if (currentUser) needsSync = true;
      throw error;
    }
  });
}
function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function sortedParticipants() {
  const cache = derived();
  if (cache.ranking === null) cache.ranking = SchoolFlow.ranking(state.participants);
  if(state.ownRank && state.ownParticipantId){
    const own=cache.ranking.find(p=>p.id===state.ownParticipantId);
    if(own)own.rank=state.ownRank;
  }
  return cache.ranking;
}
function statusFor(person) { return person.score !== null ? '<span class="status">Проверено</span>' : '<span class="status pending">Ожидает</span>'; }
function personCell(person) {
  return `<span class="person-cell">${escapeHTML(person.name)}</span>`;
}
function showToast(message) {
  const toast = $('#toast'); toast.textContent = message; toast.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}
function renderDashboard() {
  const people = state.participants;
  const stats = derived().stats;
  $('#stat-total').textContent = people.length;
  $('#stat-checked').textContent = stats.checked;
  $('#stat-average').textContent = stats.checked ? stats.average.toFixed(1) : '0';
  $('#stat-max').textContent = stats.best;
  $('#event-heading').textContent = state.eventName;
  $('#print-heading').textContent = `${state.eventName} — итоговый протокол (максимум ${state.maxScore})`;
  $('#event-name').value = state.eventName;
  $('#max-score').value = state.maxScore;
  $('#recent-table').innerHTML = people.slice(-5).reverse().map((p) => `<tr><td>${personCell(p)}</td><td>${escapeHTML(p.className)}</td><td class="score">${p.score ?? "—"}</td><td>${statusFor(p)}</td></tr>`).join('') || '<tr><td colspan="4">Нет участников</td></tr>';
}
function renderParticipants() {
  const query = ($('#search')?.value || '').trim().toLocaleLowerCase('ru');
  const filtered = derived().search.filter(row => row.text.includes(query)).map(row => row.person);
  participantPages = Math.max(1, Math.ceil(filtered.length / PARTICIPANTS_PAGE_SIZE));
  participantPage = Math.min(participantPage, participantPages - 1);
  const offset = participantPage * PARTICIPANTS_PAGE_SIZE;
  $('#participants-count').textContent = `${filtered.length} записей`;
  $('#participants-empty').hidden = filtered.length !== 0;
  $('#participants-table').innerHTML = filtered.slice(offset, offset + PARTICIPANTS_PAGE_SIZE).map((p, index) => `<tr><td>${offset + index + 1}</td><td>${personCell(p)}</td><td>${escapeHTML(p.className)}</td><td class="score">${p.score ?? "—"}</td><td>${statusFor(p)}</td><td><button class="action-btn" data-edit="${escapeHTML(p.id)}">Изменить</button><button class="action-btn delete" data-delete="${escapeHTML(p.id)}">Удалить</button></td></tr>`).join('');
  $('#participants-page').textContent = `${participantPage + 1} / ${participantPages}`;
  updatePaginationControls();
  $('#participants-caption').textContent = query ? 'Результаты поиска' : 'Все зарегистрированные участники';
  $$('#participants-table .action-btn').forEach(b=>b.hidden=!isTeacher());
}
function renderResults() {
  const list = sortedParticipants(), tasks=state.tasks||[];
  $('#ranking-head').innerHTML=`<tr><th>Место</th><th>Участник</th>${tasks.map(t=>`<th title="Максимум ${t.maxScore}">${escapeHTML(t.title)}</th>`).join('')}<th>Итог</th></tr>`;
  $('#ranking-table').innerHTML=list.map(p=>`<tr class="${p.id===state.ownParticipantId?'own-row':''}"><td class="mono">${p.rank}</td><td>${personCell(p)}${p.id===state.ownParticipantId?' <small class="muted">Вы</small>':''}</td>${tasks.map(t=>`<td class="mono">${p.taskScores?.[t.id]??'—'}</td>`).join('')}<td class="score mono">${p.score}</td></tr>`).join('');
  $('#ranking-empty').hidden=list.length!==0;
}
function renderAll() {
  renderDashboard(); renderParticipants(); renderResults();
  const {checked, bins}=derived().stats;
  Workspace.render(state,currentUser);
  $('#distribution').innerHTML=bins.map((count,i)=>`<div class="bar-row"><span>${i*25}–${i===3?100:(i+1)*25}%</span><div><i style="width:${checked?count/checked*100:0}%"></i></div><b>${count}</b></div>`).join('');
}
function openParticipant(person = null) {
  $('#participant-form').reset();
  $('#participant-id').value = person?.id || '';
  $('#modal-title').textContent = person ? 'Изменить участника' : 'Новая запись';
  $('#participant-name').value = person?.name || '';
  $('#participant-class').value = person?.className || '';
  $('#participant-score').value = person?.score ?? '';
  $('#participant-score').max = state.maxScore;
  $('#participant-score').disabled = Boolean(state.tasks?.length);
  $('#participant-tasks').innerHTML=(person && person.score!==null && !person.taskScores && state.tasks?.length?'<p class="hint">Общий результат сохранится, пока вы не введёте баллы по задачам.</p>':'')+(state.tasks||[]).map(task=>`<label class="field-label" for="task-${escapeHTML(task.id)}">${escapeHTML(task.title)} / ${task.maxScore}</label><input class="field" type="number" min="0" max="${task.maxScore}" step="any" id="task-${escapeHTML(task.id)}" data-task-score="${escapeHTML(task.id)}" value="${person?.taskScores?.[task.id]??''}">`).join('');
  $('#participant-dialog').showModal();
  $('#participant-name').focus();
}
function closeModal() { $('#participant-dialog').close(); }
async function importCSV(file) {
  if (!file) return false;
  return runOperation(async () => {
    if (file.size > 5000000) throw Error('Файл больше 5 МБ');
    const records = SchoolFlow.parseCSV(await file.text());
    if (!records.length) throw Error('Нет записей для импорта');
    if (records.some(p => p.name.length > 100 || p.className.length > 30)) {
      throw Error('Имя: до 100 символов; класс: до 30 символов. Импорт отменён.');
    }
    if (records.some(p => p.score !== null && p.score > state.maxScore)) {
      throw Error('Баллы превышают максимум мероприятия. Импорт отменён.');
    }
    const keyFor = p => JSON.stringify([p.name.toLocaleLowerCase('ru'), p.className.toLocaleLowerCase('ru')]);
    const keys = new Set(state.participants.map(keyFor));
    let skipped = 0;
    const additions = records.filter(p => {
      const key = keyFor(p);
      if (keys.has(key)) { skipped++; return false; }
      keys.add(key); return true;
    }).map(p => ({...p, id:crypto.randomUUID()}));
    if (state.participants.length + additions.length > 10000) throw Error('Допускается до 10000 участников');
    if (!additions.length) { showToast(`Новых записей нет; пропущено: ${skipped}`); return true; }
    if (!confirm(`Добавить: ${additions.length}. Пропустить совпадения имени и класса: ${skipped}?`)) return false;
    if (!await saveState({...state, participants:[...state.participants, ...additions]})) return false;
    showToast(`Добавлено: ${additions.length}; пропущено: ${skipped}`);
    return true;
  }, true);
}
function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type }); const url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = filename; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportCSV() {
  if (!currentUser || saving || needsSync) return;
  const tasks=state.tasks||[];
  const rows = [['Место', 'ФИО', 'Класс', ...tasks.map(t=>'Задача: '+t.title), 'Баллы', 'Статус'], ...[...sortedParticipants(), ...state.participants.filter(p=>p.score===null)].map(p => [p.rank ?? '', p.name, p.className, ...tasks.map(t=>p.taskScores?.[t.id]??''), p.score, p.score !== null ? 'Проверено' : 'Ожидает'])];
  const csv = '\uFEFF' + rows.map((row) => row.map(SchoolFlow.csvCell).join(';')).join('\r\n');
  downloadFile('schoolflow-report.csv', csv, 'text/csv;charset=utf-8'); showToast('Отчёт CSV сформирован');
}
function exportJSON() {
  if (!currentUser || saving || needsSync) return;
  const backup = { application: 'SchoolFlow', version: 3, exportedAt: new Date().toISOString(), eventName: state.eventName, maxScore: state.maxScore, participants: state.participants, tasks:state.tasks||[], settings:state.settings||{} };
  downloadFile('schoolflow-backup.json', JSON.stringify(backup, null, 2), 'application/json;charset=utf-8'); showToast('Резервная копия JSON готова');
}
function requestedView() { return location.hash.slice(1).split('?')[0] || 'dashboard'; }
function navigate(view, replace=false) {
  const titles={dashboard:currentUser?.role==='student'?'Мониторинг':'Обзор',participants:'Работы и баллы',students:'Состав и доступы',results:'Рейтинг',event:'Мероприятие',reports:'Отчёты',account:'Мой аккаунт',admin:'Администрирование'};
  if (!titles[view] || (!isTeacher() && !['dashboard','results','account'].includes(view)) || (view==='admin' && currentUser?.role!=='admin')) view='dashboard';
  currentView=view;
  if(location.hash!=='#'+view)history[replace?'replaceState':'pushState'](null,'','#'+view);
  $$('.view').forEach(el=>el.classList.toggle('active',el.id===`view-${view}`));
  $$('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  $('#page-title').textContent=titles[view];
  if(view==='participants')renderParticipants();if(view==='results')renderResults();
  Workspace.route(view);
}
window.addEventListener('hashchange',()=>{
  if(currentUser)navigate(requestedView(),true);
  else setAuthMode(requestedView()==='register'?'register':'login');
});

$$('.nav-item').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.view)));
$$('[data-go]').forEach((button) => button.addEventListener('click', () => navigate(button.dataset.go)));
$('#add-top').addEventListener('click', () => openParticipant());
$('#add-main').addEventListener('click', () => openParticipant());
$('#close-modal').addEventListener('click', closeModal); $('#cancel-modal').addEventListener('click', closeModal);
$('#participant-form').addEventListener('submit', async event => {
  event.preventDefault();
  return runOperation(async () => {
    const id = $('#participant-id').value;
    const name = $('#participant-name').value.trim();
    const className = $('#participant-class').value.trim();
    const raw = $('#participant-score').value;
    const score = raw === '' ? null : Number(raw);
    if (!name || name.length > 100 || !className || className.length > 30 ||
        (score !== null && (!Number.isFinite(score) || score < 0 || score > state.maxScore))) {
      throw Error(`Проверьте данные. Баллы: от 0 до ${state.maxScore}`);
    }
    if (id && !state.participants.some(p => p.id === id)) throw Error('Участник уже удалён. Откройте запись заново.');
    if (!id && state.participants.length >= 10000) throw Error('Допускается до 10000 участников');
    const person = {id:id || crypto.randomUUID(), name, className, score};
    if(state.tasks?.length){
      const taskScores={};
      $$('[data-task-score]').forEach(input=>{taskScores[input.dataset.taskScore]=input.value===''?null:Number(input.value);});
      const values=Object.values(taskScores).filter(v=>v!==null);
      const existing=state.participants.find(p=>p.id===id);
      if(values.length || existing?.taskScores || !existing){person.taskScores=taskScores;person.score=values.length?values.reduce((a,b)=>a+b,0):null;}
      else person.score=existing.score;
    }
    const participants = id ? state.participants.map(p => p.id === id ? person : p) : [...state.participants, person];
    if (!await saveState({...state, participants})) return false;
    closeModal();
    showToast(id ? 'Данные участника обновлены' : 'Участник добавлен');
    return true;
  }, true);
});
$('#participants-table').addEventListener('click', async event => {
  if (saving || needsSync || !isTeacher()) return;
  const edit = event.target.closest('[data-edit]');
  const remove = event.target.closest('[data-delete]');
  if (edit) {
    const person = state.participants.find(p => p.id === edit.dataset.edit);
    if (person) openParticipant(person);
  }
  if (remove) return runOperation(async () => {
    const person = state.participants.find(p => p.id === remove.dataset.delete);
    if (!person || !confirm(`Удалить участника «${person.name}»?`)) return false;
    if (!await saveState({...state, participants:state.participants.filter(p => p.id !== person.id)})) return false;
    showToast('Участник удалён'); return true;
  }, true);
});
$('#search').addEventListener('input', () => { participantPage = 0; renderParticipants(); });
$('#participants-prev').addEventListener('click', () => {
  if (!saving && participantPage > 0) { participantPage--; renderParticipants(); }
});
$('#participants-next').addEventListener('click', () => {
  if (!saving && participantPage < participantPages - 1) { participantPage++; renderParticipants(); }
});
$('#save-event').addEventListener('click', () => Workspace.saveEvent());
$('#import-file').addEventListener('change', e => {
  const file = e.target.files[0]; e.target.value = ''; return importCSV(file);
});
$('#import-file-report').addEventListener('change', e => {
  const file = e.target.files[0]; e.target.value = ''; return importCSV(file);
});
$('#export-csv').addEventListener('click', exportCSV);
$('#export-json').addEventListener('click', exportJSON);
$('#print-report').addEventListener('click', () => {
  if (!currentUser || saving || needsSync) return;
  navigate('results'); window.print();
});
$('#refresh-ranking').addEventListener('click', refreshState);
$('#sync-retry').addEventListener('click', refreshState);
$('#today').textContent = new Intl.DateTimeFormat('ru-RU', {day:'numeric', month:'long', year:'numeric'}).format(new Date());
async function boot() {
  const session = await api('session');
  if (!session.user) {
    clearSession();setAuthMode(requestedView()==='register'?'register':'login');
    const invite=new URLSearchParams(location.hash.split('?')[1]||'').get('invite');
    if(invite)$('#register-invite').value=invite;
    return;
  }
  currentUser = session.user;
  await loadState();
  $('#participant-dialog').close();
  document.body.classList.toggle('signed-out', false);
  document.body.classList.toggle('student', currentUser.role === 'student');
  document.body.classList.toggle('manager', isTeacher());
  document.body.classList.toggle('admin', currentUser.role === 'admin');
  $('#role-label').textContent = ({teacher:'Учитель',admin:'Администратор',student:'Ученик'})[currentUser.role];
  $('#profile-login').textContent = currentUser.login;
  await Workspace.loadProfile();
  const invite=new URLSearchParams(location.hash.split('?')[1]||'').get('invite');
  if(invite)$('#join-code').value=invite;
  navigate(requestedView(),true);
}
function setAuthMode(mode) {
  const registering = mode === 'register';
  $('#login-form').hidden = registering;
  $('#register-form').hidden = !registering;
  $('#auth-login-tab').classList.toggle('active', !registering);
  $('#auth-register-tab').classList.toggle('active', registering);
  $('#auth-login-tab').setAttribute('aria-pressed', String(!registering));
  $('#auth-register-tab').setAttribute('aria-pressed', String(registering));
  $('#login-error').textContent = ''; $('#register-error').textContent = '';
  $('#register-password').value = ''; $('#register-confirm').value = ''; $('#register-key').value = '';
  $('#auth-success').hidden = true;
}
$('#auth-login-tab').addEventListener('click', () => {setAuthMode('login');history.replaceState(null,'','#login');});
$('#auth-register-tab').addEventListener('click', () => {setAuthMode('register');history.replaceState(null,'','#register');});
$('#register-form').addEventListener('submit', event => {
  event.preventDefault();
  return runOperation(async () => {
    $('#register-error').textContent = '';
    const login = $('#register-name').value.trim().toLowerCase();
    const password = $('#register-password').value;
    const teacherKey = $('#register-key').value.trim();
    if (!/^[a-z0-9_.-]{3,32}$/.test(login) || password.length < 10 || password.length > 128) {
      $('#register-error').textContent = 'Проверьте логин и пароль (не менее 10 символов).'; return false;
    }
    if (password !== $('#register-confirm').value) {
      $('#register-error').textContent = 'Пароли не совпадают'; return false;
    }
    try {
      const created = await api('register', {login, password, teacherKey, name:$('#register-fullname').value, email:$('#register-email').value, inviteCode:$('#register-invite').value.trim()});
      setAuthMode('login');
      history.replaceState(null,'','#login');
      $('#login-name').value = created.login; $('#login-password').value = '';
      $('#auth-success').textContent = `Аккаунт ${created.role === 'teacher' ? 'учителя' : 'ученика'} создан. Теперь войдите.`;
      $('#auth-success').hidden = false;
      $('#login-password').focus(); return true;
    } catch (error) {
      $('#register-error').textContent = error.message; return false;
    } finally { $('#register-key').value = ''; }
  });
});
$('#login-form').addEventListener('submit', event => {
  event.preventDefault();
  return runOperation(async () => {
    try {
      await api('login', {login:$('#login-name').value, password:$('#login-password').value});
      $('#login-error').textContent = ''; $('#login-password').value = '';
      await boot(); return true;
    } catch (error) {
      clearSession(); $('#login-error').textContent = error.message; return false;
    }
  });
});
function logout() {
  return runOperation(async () => {
    try { await api('logout', {}); }
    catch (error) { if (error.status !== 401) throw error; }
    clearSession(); return true;
  });
}
$('#logout').addEventListener('click', logout);
$('#logout-mobile').addEventListener('click', logout);
$('#restore-json').addEventListener('change', event => {
  const file = event.target.files[0]; event.target.value = '';
  if (!file) return false;
  return runOperation(async () => {
    if (file.size > 5000000) throw Error('Файл больше 5 МБ');
    const data = JSON.parse(await file.text());
    if (!data || !Array.isArray(data.participants)) throw Error('Нет списка участников');
    if (data.participants.length > 10000) throw Error('Допускается до 10000 участников');
    if (!confirm('Заменить текущее мероприятие данными из копии? Сначала сохраните JSON текущих данных.')) return false;
    const candidate = {
      eventName:data.eventName, maxScore:data.maxScore, revision:state.revision,
      tasks:data.tasks||[],settings:data.settings||{},
      participants:data.participants.map(p => ({...p, id:p?.id || crypto.randomUUID()}))
    };
    if (!await saveState(candidate)) return false;
    showToast('Копия восстановлена'); return true;
  }, true);
});
Workspace.init({
  get state(){return state;},get user(){return currentUser;},get saving(){return saving;},get view(){return currentView;},
  api,runOperation,saveState,loadState,clearSession,boot,ranking:sortedParticipants,toast:showToast
});
Icons.mount();
runOperation(boot);
