import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const code=await readFile(new URL('../../web/magic-ui.js',import.meta.url),'utf8');
const css=await readFile(new URL('../../web/magic-ui.css',import.meta.url),'utf8');
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const flush=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
function fixture({supported=true,reduced=false,throws=false}={}){
  const window=new EventTarget(),document=new EventTarget(),styles=new Map(),ready=deferred(),finished=deferred(),calls=[];
  const root={dataset:{},style:{setProperty:(key,value)=>styles.set(key,value),removeProperty:key=>styles.delete(key)},animate:(frames,options)=>{calls.push({frames,options});return {cancel:()=>calls.push('cancel-animation')};}};
  window.innerWidth=1000;window.innerHeight=800;window.matchMedia=()=>({matches:reduced});
  document.documentElement=root;document.hidden=false;
  const transition={ready:ready.promise,finished:finished.promise,skipTransition:()=>calls.push('skip')};
  let update;
  if(supported)document.startViewTransition=callback=>{if(throws)throw Error('unsupported state');update=callback;calls.push('start');return transition;};
  const button={getBoundingClientRect:()=>({left:700,top:60,width:40,height:40})};
  runInNewContext(code,{window,document});
  return {window,document,root,styles,ready,finished,calls,button,api:window.CRSMagicUI,update:()=>update?.()};
}

test('theme adapter leaves state ownership to exactly one existing callback and uses percentage reveal coordinates',async()=>{
  const f=fixture();let changed=0;
  f.api.toggleTheme(f.button,()=>changed++);f.api.toggleTheme(f.button,()=>changed++);
  assert.equal(f.calls.filter(value=>value==='start').length,1);assert.equal(changed,0);
  f.update();f.update();assert.equal(changed,1);f.ready.resolve();await flush();
  assert.equal(f.calls[1].frames.clipPath[0],'circle(0% at 72% 10%)');
  assert.equal(f.calls[1].options.pseudoElement,'::view-transition-new(root)');assert.equal(f.calls[1].options.duration,400);
  f.finished.resolve();await flush();assert.equal(f.root.dataset.magicuiThemeVt,undefined);assert.equal(f.styles.size,0);
});

test('unavailable/reduced/hidden theme transitions fall back synchronously without decorative state',()=>{
  for(const options of [{supported:false},{reduced:true},{}]){
    const f=fixture(options);if(!Object.keys(options).length)f.document.hidden=true;
    let changed=0;f.api.toggleTheme(f.button,()=>changed++);assert.equal(changed,1);assert.equal(f.calls.length,0);assert.equal(f.styles.size,0);
  }
});

test('throwing or rejected native transition fails to the existing theme callback and clears the in-flight guard',async()=>{
  const thrown=fixture({throws:true});let changed=0;thrown.api.toggleTheme(thrown.button,()=>changed++);assert.equal(changed,1);assert.equal(thrown.styles.size,0);
  const f=fixture();f.api.toggleTheme(f.button,()=>changed++);f.ready.reject(Error('capture unavailable'));await flush();
  assert.equal(changed,2);assert.ok(f.calls.includes('skip'));assert.equal(f.styles.size,0);
  f.document.startViewTransition=undefined;f.api.toggleTheme(f.button,()=>changed++);assert.equal(changed,3);
  f.finished.resolve();await flush();assert.equal(changed,3);
});

test('tab/page suspension cancels the temporary animation and does not persist any presentation state',async()=>{
  for(const type of ['visibilitychange','pagehide']){
    const f=fixture();let changed=0;f.api.toggleTheme(f.button,()=>changed++);f.update();f.ready.resolve();await flush();
    if(type==='visibilitychange'){f.document.hidden=true;f.document.dispatchEvent(new Event(type));}else f.window.dispatchEvent(new Event(type));
    assert.equal(changed,1);assert.ok(f.calls.includes('skip'));assert.ok(f.calls.includes('cancel-animation'));assert.equal(f.styles.size,0);
    f.finished.resolve();await flush();assert.equal(changed,1);
  }
});

test('optional adapter exposes only decorative mounts and handles absent hosts without changing identity/data',()=>{
  const f=fixture();assert.deepEqual(Object.keys(f.api),['mountRipple','mountCard','mountGuest','mountBlur','toggleTheme']);
  f.api.mountRipple(null)();f.api.mountGuest(null)();f.api.mountBlur(null)();f.api.mountCard(null).reset();f.api.mountCard(null).dispose();
  assert.equal(f.calls.length,0);assert.equal(f.styles.size,0);
  assert.match(css,/\.magic-card::before \{ display:none;/);
  assert.match(css,/@supports \(mask-composite:exclude\) \{ \.magic-card::before \{ display:block;/);
});
