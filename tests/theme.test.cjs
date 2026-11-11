const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const code=fs.readFileSync(path.join(__dirname,'../js/theme.js'),'utf8');
function start(saved,system=false,blocked=false){
  let stored=saved;const listeners={};
  const media={matches:system,addEventListener(n,fn){listeners.media=fn;}};
  const buttons=[0,1].map(()=>({textContent:'',attrs:{},setAttribute(n,v){this.attrs[n]=v;},addEventListener(n,fn){this[n]=fn;}}));
  const html={dataset:{}};
  const context={document:{documentElement:html,readyState:'complete',querySelectorAll:()=>buttons},
    localStorage:{getItem(){if(blocked)throw Error('blocked');return stored;},setItem(k,v){if(blocked)throw Error('blocked');stored=v;}},
    window:{matchMedia:()=>media,addEventListener(n,fn){listeners[n]=fn;}}};
  vm.runInNewContext(code,context);return {html,buttons,listeners,media,get stored(){return stored;}};
}
let h=start(null,true);assert.equal(h.html.dataset.theme,'dark');
h.buttons[0].click();assert.equal(h.html.dataset.theme,'light');assert.equal(h.stored,'light');
assert.equal(h.buttons[1].attrs['aria-pressed'],'false');
assert.equal(start(h.stored,true).html.dataset.theme,'light');
h.media.matches=true;h.listeners.media();assert.equal(h.html.dataset.theme,'light');
h.listeners.storage({key:'schoolflow_theme',newValue:'dark'});assert.equal(h.html.dataset.theme,'dark');
h.listeners.storage({key:null,newValue:null});assert.equal(h.html.dataset.theme,'dark');
h=start(null,false,true);h.buttons[1].click();assert.equal(h.html.dataset.theme,'dark');
h=start('invalid',true);assert.equal(h.html.dataset.theme,'dark');
console.log('Theme: system preference, saved choice, toggles, storage sync, blocked storage passed');
