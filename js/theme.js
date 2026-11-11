/* Runs before CSS to avoid a flash of the wrong theme. */
(function () {
  'use strict';
  const storageKey = 'schoolflow_theme';
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : {matches:false};
  let preference = null;
  try { preference = localStorage.getItem(storageKey); } catch {}
  if (!['light','dark'].includes(preference)) preference = null;
  let active;
  function apply() {
    active = preference || (media.matches ? 'dark' : 'light');
    document.documentElement.dataset.theme = active;
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.textContent = active === 'dark' ? 'Светлая тема' : 'Тёмная тема';
      button.setAttribute('aria-label', active === 'dark' ? 'Включить светлую тему' : 'Включить ночную тему');
      button.setAttribute('aria-pressed', String(active === 'dark'));
    });
  }
  apply();
  function bind() {
    document.querySelectorAll('[data-theme-toggle]').forEach(button => {
      button.addEventListener('click', () => {
        preference = active === 'dark' ? 'light' : 'dark';
        try { localStorage.setItem(storageKey, preference); } catch {}
        apply();
      });
    });
    apply();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, {once:true});
  else bind();
  media.addEventListener?.('change', () => { if (!preference) apply(); });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey && event.key !== null) return;
    preference = ['light','dark'].includes(event.newValue) ? event.newValue : null;
    apply();
  });
})();
