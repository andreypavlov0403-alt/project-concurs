/* Account, membership, event settings and student monitoring modules. */
(function(root){
  'use strict';
  const $=s=>document.querySelector(s);
  let app,profile=null,roster={members:[],invites:[]},pollTimer,clockTimer;
  const html=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const roles={student:'Ученик',teacher:'Учитель',admin:'Администратор'};
  const access={active:'Активен',pending:'На подтверждении',frozen:'Заморожен',detached:'Отвязан'};
  const dateInput=value=>{if(!value)return '';const date=new Date(value);return new Date(date-date.getTimezoneOffset()*60000).toISOString().slice(0,16);};
  function codeFrom(value){
    value=value.trim();
    if(value.includes('?invite='))return new URLSearchParams(value.split('?')[1]).get('invite')||'';
    return value;
  }
  function parseEmails(text){
    const values=text.replace(/^\uFEFF/,'').split(/[\s,;]+/).map(s=>s.replace(/^"|"$/g,'')).filter(Boolean);
    const filtered=values.filter(v=>!['email','e-mail','почта'].includes(v.toLowerCase()));
    if(filtered.some(v=>!/^\S+@[^\s@]+\.[^\s@]+$/.test(v)))throw Error('CSV должен содержать один столбец email. Проверьте адреса.');
    if(filtered.length>100)throw Error('До 100 email за один раз');
    return [...new Set(filtered.map(v=>v.toLowerCase()))];
  }
  function reset(){clearInterval(pollTimer);clearInterval(clockTimer);profile=null;roster={members:[],invites:[]};$('#invite-output').value='';$('#invite-dialog').close();$('#link-dialog').close();}
  async function loadProfile(){
    profile=await app.api('profile');
    $('#profile-name').value=profile.name;$('#profile-email').value=profile.email;
    $('#profile-school').value=profile.school;$('#profile-class').value=profile.className;
    $('#profile-notifications').checked=profile.notifications;$('#account-role').textContent=roles[profile.role];
    clearInterval(pollTimer);clearInterval(clockTimer);
    pollTimer=setInterval(async()=>{
      if(!app.user || app.saving || document.hidden || !['dashboard','results'].includes(app.view))return;
      const before=app.state.revision;
      await app.runOperation(async()=>{await app.loadState();});
      if(profile?.notifications && before!==app.state.revision)app.toast('Результаты обновлены');
    },15000);
    clockTimer=setInterval(renderClock,1000);
  }
  function renderClock(){
    if(!app?.user)return;
    const config=app.state.settings||{},now=Date.now();
    let value='Не задано',label='Расписание появится после настройки';
    if(config.status==='finished'){value='Завершено';label='Итоговые результаты';}
    else if(config.startsAt && new Date(config.startsAt)>now){value=new Date(config.startsAt).toLocaleString('ru-RU');label='Начало мероприятия';}
    else if(config.status==='draft'){value='Не началось';label='Мероприятие готовится';}
    else if(config.endsAt){
      const seconds=Math.max(0,Math.floor((new Date(config.endsAt)-now)/1000));
      value=seconds?`${Math.floor(seconds/3600)}:${String(Math.floor(seconds%3600/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:'Время вышло';
      label=seconds?'До окончания':'Приём результатов завершён';
    }
    $('#my-time').textContent=value;$('#my-time-label').textContent=label;
  }
  function render(state,user){
    if(!user)return;
    const config=state.settings||{};
    $('#event-subject').textContent=config.subject||'ТЕКУЩЕЕ МЕРОПРИЯТИЕ';
    $('#event-description').textContent=config.description||config.school||'';
    $('#event-status').textContent=({draft:'Черновик',live:'Идёт',finished:'Завершено'})[config.status]||'Черновик';
    if(app.view!=='event' || !$('#event-tasks').dataset.dirty)fillEvent();
    renderClock();
    const list=app.ranking(),index=list.findIndex(p=>p.id===state.ownParticipantId),person=state.participants.find(p=>p.id===state.ownParticipantId);
    $('#my-score').textContent=person?.score??'—';$('#my-score-label').textContent=`Максимум ${state.maxScore}`;
    $('#my-rank').textContent=index>=0?list[index].rank:'—';
    const above=index>0?list[index-1].score-list[index].score:null;
    const below=index>=0&&index<list.length-1?list[index].score-list[index+1].score:null;
    $('#my-neighbors').textContent=index>=0?[above===null?'Выше никого':`До строки выше: ${above}`,below===null?'Ниже никого':`От строки ниже: ${below}`].join(' / '):'Появится после проверки';
    const status=state.accessStatus||'not_joined';
    $('#join-panel').hidden=status==='active';$('#join-form').hidden=!['not_joined','detached'].includes(status);
    $('#join-title').textContent=({pending:'Участие ожидает подтверждения',frozen:'Доступ приостановлен',detached:'Вы отвязаны от мероприятия'})[status]||'Присоединиться к мероприятию';
    $('#join-description').textContent=['pending','frozen'].includes(status)?'Обратитесь к учителю. Настройки аккаунта остаются доступны.':'Введите код, который выдал учитель.';
    const nearby=index>=0?list.slice(Math.max(0,index-1),index+2):list.slice(0,3);
    $('#my-standing').innerHTML=nearby.map(p=>`<div class="standing-row ${p.id===state.ownParticipantId?'own-row':''}"><span class="mono">${p.rank}</span><span>${html(p.name)}${p.id===state.ownParticipantId?' <small class="muted">Вы</small>':''}</span><strong class="mono">${p.score}</strong></div>`).join('')||'<p class="muted">Личные результаты появятся после подключения и проверки работы.</p>';
  }
  function fillEvent(){
    const state=app.state,config=state.settings||{};
    $('#event-name').value=state.eventName;$('#max-score').value=state.maxScore;
    $('#event-subject-input').value=config.subject||'';$('#event-school').value=config.school||'';
    $('#event-description-input').value=config.description||'';$('#event-status-input').value=config.status||'draft';
    $('#event-start').value=dateInput(config.startsAt);$('#event-end').value=dateInput(config.endsAt);
    $('#event-approval').checked=config.approvalRequired!==false;$('#event-leaderboard').checked=config.showLeaderboard!==false;
    $('#event-visibility').value=config.visibility||'names';
    $('#event-tasks').value=(state.tasks||[]).map(t=>`${t.id} | ${t.title} | ${t.maxScore}`).join('\n');
  }
  function saveEvent(){return app.runOperation(async()=>{
    const tasks=$('#event-tasks').value.split(/\r?\n/).filter(l=>l.trim()).map(line=>{
      const cells=line.split('|').map(v=>v.trim());
      if(cells.length!==3||!cells[0]||!cells[1]||!Number.isInteger(Number(cells[2]))||Number(cells[2])<1)throw Error('Задача: код | название | целый положительный максимум');
      return {id:cells[0],title:cells[1],maxScore:Number(cells[2])};
    });
    const ids=new Set(tasks.map(t=>t.id));
    if(app.state.participants.some(p=>Object.keys(p.taskScores||{}).some(id=>!ids.has(id))))throw Error('Сначала уберите баллы удаляемых задач из работ. Иначе результаты будут потеряны.');
    const state={...app.state,eventName:$('#event-name').value.trim(),maxScore:tasks.length?tasks.reduce((n,t)=>n+t.maxScore,0):Number($('#max-score').value),tasks,
      settings:{subject:$('#event-subject-input').value,description:$('#event-description-input').value,school:$('#event-school').value,
        startsAt:$('#event-start').value?new Date($('#event-start').value).toISOString():'',endsAt:$('#event-end').value?new Date($('#event-end').value).toISOString():'',
        status:$('#event-status-input').value,visibility:$('#event-visibility').value,approvalRequired:$('#event-approval').checked,showLeaderboard:$('#event-leaderboard').checked}};
    if(await app.saveState(state)){$('#event-tasks').dataset.dirty='';$('#event-save-status').textContent='Сохранено';}
  },true);}
  async function loadRoster(){
    try{roster=await app.api('roster');renderRoster();$('#roster-error').textContent='';}
    catch(error){$('#roster-error').textContent=error.message;}
  }
  function memberControls(row){
    const action=row.status==='active'?'frozen':'active',title=row.status==='active'?'Заморозить':'Разрешить';
    return `<button class="action-btn" data-member="${html(row.login)}" data-status="${action}">${title}</button><button class="action-btn" data-link="${html(row.login)}">Связь</button>${row.status!=='detached'?`<button class="action-btn" data-member="${html(row.login)}" data-status="detached">Отвязать</button>`:''}`;
  }
  function renderRoster(){
    $('#active-members').innerHTML=roster.members.filter(r=>r.status!=='pending').map(row=>`<tr><td>${html(row.name)}<small class="cell-note">${html(row.login)}</small></td><td>${html(row.participant?.className||'—')}</td><td>${html(row.participant?.name||'Нет связи')}</td><td><span class="badge">${access[row.status]}</span></td><td class="actions">${memberControls(row)}</td></tr>`).join('')||'<tr><td colspan="5" class="empty-state">Пригласите учеников, чтобы связать аккаунты с работами.</td></tr>';
    $('#pending-members').innerHTML=roster.members.filter(r=>r.status==='pending').map(row=>`<div class="list-row"><div><strong>${html(row.name)}</strong><small class="cell-note">${html(row.login)} / ${html(row.participant?.className)}</small></div><button class="btn btn-secondary" data-member="${html(row.login)}" data-status="active">Подтвердить</button></div>`).join('')||'<p class="muted">Новых заявок нет.</p>';
    $('#pending-invites').innerHTML=roster.invites.map(row=>`<div class="list-row"><div><strong>${html(row.email||'Код для класса '+row.class_name)}</strong><small class="cell-note">${html(row.class_name)} / ${new Date(row.expires_at*1000).toLocaleDateString('ru-RU')} / ${row.status==='pending'&&row.expires_at*1000>Date.now()?'Ожидает':row.status==='used'?'Использовано':'Недоступно'}</small></div>${row.status==='pending'?`<button class="action-btn" data-revoke="${html(row.id)}">Отменить</button>`:''}</div>`).join('')||'<p class="muted">Приглашений нет.</p>';
  }
  async function loadAdmin(){try{
    const result=await app.api('admin/users');
    $('#admin-users').innerHTML=result.users.map(row=>`<tr><td>${html(row.login)}</td><td><select class="field" data-admin-role="${html(row.login)}" data-admin-disabled="${Boolean(row.disabled)}">${Object.entries(roles).map(([value,label])=>`<option value="${value}" ${row.role===value?'selected':''}>${label}</option>`).join('')}</select></td><td>${row.disabled?'Отключён':'Активен'}</td><td><button class="action-btn" data-admin-login="${html(row.login)}" data-disabled="${!row.disabled}">${row.disabled?'Включить':'Отключить'}</button></td></tr>`).join('');
  }catch(error){$('#admin-status').textContent=error.message;}}
  function route(view){if(view==='students')loadRoster();if(view==='admin')loadAdmin();if(view==='event'){fillEvent();$('#event-tasks').dataset.dirty='';}}
  function init(adapter){
    app=adapter;
    $('#event-tasks').addEventListener('input',()=>{$('#event-tasks').dataset.dirty='true';});
    $('#profile-form').addEventListener('submit',event=>{event.preventDefault();return app.runOperation(async()=>{
      profile=await app.api('profile',{name:$('#profile-name').value,school:$('#profile-school').value,className:$('#profile-class').value,email:$('#profile-email').value,notifications:$('#profile-notifications').checked});
      $('#profile-status').textContent='Сохранено';app.toast('Профиль сохранён');
    });});
    $('#password-form').addEventListener('submit',event=>{event.preventDefault();return app.runOperation(async()=>{
      $('#password-status').textContent='';
      if($('#password-new').value!==$('#password-confirm').value){$('#password-status').textContent='Пароли не совпадают';return;}
      try{await app.api('password',{currentPassword:$('#password-current').value,newPassword:$('#password-new').value});
        $('#password-current').value='';$('#password-new').value='';$('#password-confirm').value='';app.clearSession();app.toast('Пароль изменён. Войдите заново.');}
      catch(error){$('#password-status').textContent=error.message;}
    });});
    $('#join-form').addEventListener('submit',event=>{event.preventDefault();return app.runOperation(async()=>{
      await app.api('invites/accept',{code:codeFrom($('#join-code').value)});$('#join-code').value='';await app.loadState();app.toast('Заявка отправлена');
    });});
    for(const name of ['active','pending','access'])$('#roster-tab-'+name).addEventListener('click',()=>{
      for(const tab of ['active','pending','access']){$('#roster-'+tab).hidden=tab!==name;$('#roster-tab-'+tab).classList.toggle('active',tab===name);}
    });
    $('#invite-open').addEventListener('click',()=>{$('#invite-created').hidden=true;$('#invite-output').value='';$('#invite-error').textContent='';$('#invite-dialog').showModal();});
    $('#invite-close').addEventListener('click',()=>{$('#invite-dialog').close();$('#invite-output').value='';});
    $('#invite-csv').addEventListener('change',async event=>{
      const selected=event.target.files[0];event.target.value='';if(!selected)return;
      try{if(selected.size>100000)throw Error('Файл должен быть меньше 100 КБ');$('#invite-emails').value=parseEmails(await selected.text()).join('\n');}
      catch(error){$('#invite-error').textContent=error.message;}
    });
    $('#invite-form').addEventListener('submit',event=>{event.preventDefault();return app.runOperation(async()=>{
      try{
        const result=await app.api('invites',{className:$('#invite-class').value,emails:parseEmails($('#invite-emails').value)});
        const base=location.origin+location.pathname;
        $('#invite-output').value=result.invites.map(invite=>`${invite.email?invite.email+'\t':''}${base}#register?invite=${encodeURIComponent(invite.code)}`).join('\n');
        $('#invite-created').hidden=false;$('#invite-error').textContent='';await loadRoster();
      }catch(error){$('#invite-error').textContent=error.message;}
    },true);});
    $('#invite-copy').addEventListener('click',async()=>{
      try{await navigator.clipboard.writeText($('#invite-output').value);app.toast('Ссылки скопированы');}
      catch{$('#invite-output').focus();$('#invite-output').select();app.toast('Скопируйте выделенный текст');}
    });
    $('#view-students').addEventListener('click',event=>{
      const target=event.target.closest('[data-member],[data-revoke],[data-link]');if(!target)return;
      if(target.dataset.link){
        $('#link-login').value=target.dataset.link;
        $('#link-participant').innerHTML=app.state.participants.map(p=>`<option value="${html(p.id)}">${html(p.name)} / ${html(p.className)}</option>`).join('');
        $('#link-dialog').showModal();return;
      }
      return app.runOperation(async()=>{
        if(target.dataset.member){if(target.dataset.status==='detached'&&!confirm('Отвязать аккаунт? Работа и баллы сохранятся.'))return;
          await app.api('membership',{login:target.dataset.member,status:target.dataset.status});await app.loadState();}
        else await app.api('invites/revoke',{id:target.dataset.revoke});
        await loadRoster();
      },true);
    });
    $('#link-close').addEventListener('click',()=>$('#link-dialog').close());
    $('#link-form').addEventListener('submit',event=>{event.preventDefault();return app.runOperation(async()=>{
      const row=roster.members.find(r=>r.login===$('#link-login').value);
      await app.api('membership',{login:row.login,status:row.status,participantId:$('#link-participant').value});
      $('#link-dialog').close();await app.loadState();await loadRoster();
    },true);});
    $('#admin-users').addEventListener('change',event=>{const login=event.target.dataset.adminRole;if(!login)return;
      return app.runOperation(async()=>{await app.api('admin/users',{login,role:event.target.value,disabled:event.target.dataset.adminDisabled==='true'});await loadAdmin();await app.boot();});
    });
    $('#admin-users').addEventListener('click',event=>{const target=event.target.closest('[data-admin-login]');if(!target)return;
      return app.runOperation(async()=>{
        const role=$('#admin-users').querySelector(`[data-admin-role="${CSS.escape(target.dataset.adminLogin)}"]`).value;
        await app.api('admin/users',{login:target.dataset.adminLogin,role,disabled:target.dataset.disabled==='true'});await loadAdmin();await app.boot();
      });
    });
  }
  root.Workspace={init,render,reset,loadProfile,saveEvent,route,parseEmails,codeFrom};
})(typeof window!=='undefined'?window:globalThis);
