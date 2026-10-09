import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const code=await readFile(new URL('../../web/login-parallax.js',import.meta.url),'utf8');
function fixture({eligible=true,hidden=false,rendered=true}={}){
  class Target extends EventTarget{
    listeners=new Map();
    addEventListener(type,fn,options){super.addEventListener(type,fn,options);if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
    removeEventListener(type,fn,options){super.removeEventListener(type,fn,options);this.listeners.get(type)?.delete(fn);}
    count(type){return this.listeners.get(type)?.size||0;}
    total(){return [...this.listeners.values()].reduce((sum,set)=>sum+set.size,0);}
    emit(type,properties={}){const event=new Event(type);Object.assign(event,properties);this.dispatchEvent(event);}
  }
  const window=new Target(),document=new Target(),media=new Target(),story=new Target(),access={hidden},styles=new Map(),classes=new Set(),frames=new Map(),observers=[];
  let serial=0,canceled=0;
  window.innerHeight=900;media.matches=eligible;document.hidden=hidden;
  const art={classList:{add:value=>classes.add(value),remove:value=>classes.delete(value)},style:{setProperty:(name,value)=>styles.set(name,value),removeProperty:name=>styles.delete(name)},getClientRects:()=>rendered?[{}]:[],getBoundingClientRect:()=>({top:300,bottom:600})};
  story.isConnected=true;story.querySelector=selector=>selector==='.login-art'?art:null;story.closest=()=>access;story.parentNode={parentNode:access};access.parentNode=document;document.parentNode=null;
  story.getBoundingClientRect=()=>({left:100,top:50,right:500,bottom:550,width:400,height:500});
  window.matchMedia=()=>media;
  window.requestAnimationFrame=callback=>{frames.set(++serial,callback);return serial;};
  window.cancelAnimationFrame=id=>{if(frames.delete(id))canceled++;};
  class MutationObserver{constructor(callback){this.callback=callback;this.targets=new Map();this.disconnected=false;observers.push(this);}observe(target,options){this.targets.set(target,options);}disconnect(){this.disconnected=true;}}
  window.IntersectionObserver=class{constructor(callback){this.callback=callback;this.disconnected=false;observers.push(this);}observe(){}disconnect(){this.disconnected=true;}};
  runInNewContext(code,{window,document,MutationObserver});
  const flush=()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback();};
  const move=(x=400,y=425,pointerType='mouse')=>story.emit('pointermove',{clientX:x,clientY:y,pointerType});
  return {window,document,media,story,access,art,styles,classes,frames,observers,flush,move,get canceled(){return canceled;},mount:()=>window.CRSLoginParallax.mount(story)};
}

test('parallax batches pointer bursts, paints latest bounded viewport coordinates and remains idle without input',()=>{
  const f=fixture(),dispose=f.mount();
  f.move(120,100);f.move();assert.equal(f.frames.size,1);f.flush();
  assert.equal(f.styles.get('--login-parallax-x'),'0.5000');assert.equal(f.styles.get('--login-parallax-y'),'0.5000');
  assert.ok(f.classes.has('is-parallax-active'));assert.equal(f.frames.size,0);
  f.flush();assert.equal(f.frames.size,0);
  f.story.getBoundingClientRect=()=>({left:200,top:100,right:400,bottom:350,width:200,height:250});
  f.move(250,162.5);f.flush();assert.equal(f.styles.get('--login-parallax-x'),'-0.5000');assert.equal(f.styles.get('--login-parallax-y'),'-0.5000');
  f.move(401,400);f.flush();assert.equal(f.styles.size,0);assert.equal(f.classes.size,0);dispose();
});

test('touch/pen, pointer exit/cancel, blur, scroll and resize restore the original static artwork',()=>{
  const f=fixture(),dispose=f.mount();
  for(const pointer of ['touch','pen']){f.move();f.flush();f.move(400,425,pointer);assert.equal(f.styles.size,0);assert.equal(f.frames.size,0);}
  for(const [target,type]of [[f.story,'pointerleave'],[f.story,'pointercancel'],[f.window,'blur'],[f.window,'resize'],[f.document,'scroll']]){
    f.move();f.flush();assert.equal(f.styles.size,2);target.emit(type);assert.equal(f.styles.size,0);assert.equal(f.classes.size,0);
    f.move();assert.equal(f.frames.size,1);target.emit(type);assert.equal(f.frames.size,0);
  }
  dispose();
});

test('stationary art stage, not the transformed illustration or story text, defines the activation region',()=>{
  const f=fixture(),query=f.story.querySelector;
  const stage={getBoundingClientRect:()=>({left:200,top:300,right:400,bottom:500,width:200,height:200})};
  f.story.querySelector=selector=>selector==='.login-art-stage'?stage:query(selector);
  const dispose=f.mount();f.move(350,450);f.flush();
  assert.equal(f.styles.get('--login-parallax-x'),'0.5000');assert.equal(f.styles.get('--login-parallax-y'),'0.5000');
  f.move(350,150);f.flush();assert.equal(f.classes.size,0);assert.equal(f.styles.size,0);dispose();
});

test('hidden Login/tab, reduced motion, offscreen artwork and page suspension cancel work and detach pointer listeners',()=>{
  const f=fixture(),dispose=f.mount();
  assert.equal(f.observers[0].targets.get(f.access).attributes,true);assert.equal(f.observers[0].targets.get(f.access).childList,true);
  assert.ok(f.observers[0].targets.get(f.access).attributeFilter.includes('hidden'));
  const transitions=[
    ()=>{f.access.hidden=true;f.observers[0].callback();},
    ()=>{f.document.hidden=true;f.document.emit('visibilitychange');},
    ()=>{f.media.matches=false;f.media.emit('change');},
    ()=>f.observers[1].callback([{isIntersecting:false}]),
    ()=>f.window.emit('pagehide')
  ];
  for(const pause of transitions){
    f.move();assert.equal(f.frames.size,1);pause();assert.equal(f.frames.size,0);assert.equal(f.story.count('pointermove'),0);assert.equal(f.styles.size,0);
    f.move();assert.equal(f.frames.size,0);
    f.access.hidden=false;f.document.hidden=false;f.media.matches=true;
    f.observers[1].callback([{isIntersecting:true}]);f.window.emit('pageshow');
    assert.equal(f.story.count('pointermove'),1);
  }
  assert.equal(f.canceled,5);dispose();
});

test('unmount disposes observers and every effect listener; dispose is idempotent and remount does not duplicate work',()=>{
  const f=fixture(),dispose=f.mount();f.move();f.story.isConnected=false;f.observers[0].callback();dispose();dispose();
  assert.equal(f.frames.size,0);assert.equal(f.styles.size,0);assert.ok(f.observers.every(observer=>observer.disconnected));
  for(const target of [f.story,f.window,f.document,f.media])assert.equal(target.total(),0);
  f.story.isConnected=true;const again=f.mount();assert.equal(f.story.count('pointermove'),1);f.move();assert.equal(f.frames.size,1);again();
  for(const target of [f.story,f.window,f.document,f.media])assert.equal(target.total(),0);
});

test('unsupported/disabled presentation keeps static fallback and never starts a frame',()=>{
  for(const options of [{eligible:false},{hidden:true},{rendered:false}]){
    const f=fixture(options),dispose=f.mount();f.move();assert.equal(f.frames.size,0);assert.equal(f.story.total(),0);assert.equal(f.styles.size,0);dispose();
  }
  const f=fixture();assert.equal(typeof f.window.CRSLoginParallax.mount(null),'function');
  delete f.window.matchMedia;f.mount()();assert.equal(f.window.total(),0);
});
