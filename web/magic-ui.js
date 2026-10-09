/* DOM adapters of Magic UI Ripple, Animated Grid Pattern, Magic Card,
 * Animated Theme Toggler and Progressive Blur. Sources: magicui.design/r and
 * github.com/magicuidesign/magicui (2026-10-09). No React/auth/data ownership.
 *
 * MIT License
 * Copyright (c) Magic UI
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
(function(global){
  'use strict';
  const fine='(min-width:768px) and (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference)',svgNS='http://www.w3.org/2000/svg';
  let gridSerial=0,themeTransition=null;
  // Every decoration owns its listeners/observers. No data calls, timers or idle RAF.
  function watch(host,change,cleanup,query=fine){
    const media=global.matchMedia?.(query);
    let disposed=false,paused=false,intersecting=true,active=null;
    function sync(){
      if(disposed)return;
      if(!host.isConnected){dispose();return;}
      const next=!paused&&!document.hidden&&intersecting&&!host.closest('[hidden]')&&host.getClientRects().length>0&&(!media||media.matches);
      if(next!==active){active=next;change(next);}
    }
    const hidden=()=>sync(),suspend=()=>{paused=true;sync();},resume=()=>{paused=false;sync();};
    const mutations=new MutationObserver(sync);
    for(let node=host;node;node=node.parentNode)mutations.observe(node,{childList:true,attributes:true,attributeFilter:['hidden']});
    const intersection=global.IntersectionObserver?new global.IntersectionObserver(entries=>{intersecting=entries[0].isIntersecting;sync();}):null;
    intersection?.observe(host);media?.addEventListener('change',sync);
    document.addEventListener('visibilitychange',hidden);global.addEventListener('pagehide',suspend);global.addEventListener('pageshow',resume);
    function dispose(){
      if(disposed)return;disposed=true;change(false);cleanup?.();mutations.disconnect();intersection?.disconnect();
      media?.removeEventListener('change',sync);document.removeEventListener('visibilitychange',hidden);
      global.removeEventListener('pagehide',suspend);global.removeEventListener('pageshow',resume);
    }
    sync();return dispose;
  }
  function mountRipple(art){
    const ripple=art?.querySelector('.magic-ripple');if(!ripple)return ()=>{};
    return watch(art,active=>ripple.dataset.motion=active?'active':'paused',()=>delete ripple.dataset.motion);
  }
  function mountCard(host){
    if(!host?.isConnected)return {reset(){},dispose(){}};
    let enabled=false,frame=0,point=null;
    host.classList.add('magic-card');
    function reset(){if(frame)global.cancelAnimationFrame(frame);frame=0;point=null;delete host.dataset.magicCardActive;}
    function paint(){
      frame=0;if(!enabled||!point){reset();return;}
      const r=host.getBoundingClientRect();
      if(!r.width||!r.height||point.x<r.left||point.x>r.right||point.y<r.top||point.y>r.bottom){reset();return;}
      // Convert viewport coordinates to the card's border-box, including scale.
      host.style.setProperty('--magic-x',((point.x-r.left)*host.offsetWidth/r.width).toFixed(2)+'px');
      host.style.setProperty('--magic-y',((point.y-r.top)*host.offsetHeight/r.height).toFixed(2)+'px');
      host.dataset.magicCardActive='true';
    }
    function schedule(){if(point&&!frame)frame=global.requestAnimationFrame(paint);}
    function move(event){if(!enabled||event.pointerType!=='mouse'){reset();return;}point={x:event.clientX,y:event.clientY};schedule();}
    function out(event){if(!event.relatedTarget)reset();}
    const bindings=[[host,'pointermove',move],[host,'pointerleave',reset],[host,'pointercancel',reset],[global,'pointerout',out],[global,'blur',reset],[global,'resize',schedule],[document,'scroll',schedule,true]];
    const dispose=watch(host,active=>{enabled=active;reset();},()=>{
      for(const [target,type,fn,capture]of bindings)target.removeEventListener(type,fn,capture);
      host.classList.remove('magic-card');host.style.removeProperty('--magic-x');host.style.removeProperty('--magic-y');
    });
    for(const [target,type,fn,capture]of bindings)target.addEventListener(type,fn,capture||{passive:true});
    return {reset,dispose};
  }
  function svg(name,attributes={}){const node=document.createElementNS(svgNS,name);for(const [key,value]of Object.entries(attributes))node.setAttribute(key,String(value));return node;}
  function mountGrid(host){
    if(!host?.isConnected)return ()=>{};
    const id='crs-magic-grid-'+(++gridSerial),cell=40,layer=svg('svg',{'aria-hidden':'true',focusable:'false',class:'magic-grid-pattern'});
    const defs=svg('defs'),pattern=svg('pattern',{id,width:cell,height:cell,patternUnits:'userSpaceOnUse',x:-1,y:-1});
    pattern.append(svg('path',{d:'M.5 40V.5H40',fill:'none'}));defs.append(pattern);
    layer.append(defs,svg('rect',{width:'100%',height:'100%',fill:'url(#'+id+')'}));
    const cells=Array.from({length:16},()=>svg('rect',{width:39,height:39,fill:'currentColor','stroke-width':0,class:'magic-grid-square'}));
    layer.append(...cells);host.prepend(layer);host.dataset.renderer='svg';
    let active=false,disposed=false,dimensions={width:0,height:0},revision=0;
    const animations=new Map();
    function position(node){
      node.setAttribute('x',Math.floor(Math.random()*Math.max(1,Math.ceil(dimensions.width/cell)))*cell);
      node.setAttribute('y',Math.floor(Math.random()*Math.max(1,Math.ceil(dimensions.height/cell)))*cell);
    }
    function cancel(){revision++;for(const animation of animations.values())animation.cancel();animations.clear();}
    function animate(node,index){
      if(disposed||!active||!node.animate)return;
      const version=revision;
      const animation=node.animate([{opacity:0},{opacity:.14,offset:.45},{opacity:0}],{duration:6000,delay:index*100,easing:'ease-in-out',fill:'none'});
      animations.set(node,animation);
      animation.finished.then(()=>{
        if(disposed||version!==revision)return;
        animations.delete(node);position(node);animate(node,index);
      }).catch(()=>{});
    }
    function resize(){
      const r=host.getBoundingClientRect(),height=Math.min(r.height,600);
      if(dimensions.width===r.width&&dimensions.height===height)return;
      dimensions={width:r.width,height};cancel();for(const [index,node]of cells.entries()){position(node);animate(node,index);}
    }
    const observer=global.ResizeObserver?new global.ResizeObserver(resize):null;
    const dispose=watch(host,visible=>{
      active=visible;layer.dataset.motion=active?'active':'paused';
      if(active){for(const [index,node]of cells.entries()){const animation=animations.get(node);if(animation)animation.play();else animate(node,index);}}
      else for(const animation of animations.values())animation.pause();
    },()=>{disposed=true;cancel();observer?.disconnect();global.removeEventListener('resize',resize);layer.remove();delete host.dataset.renderer;});
    observer?.observe(host);global.addEventListener('resize',resize,{passive:true});resize();return dispose;
  }
  function mountBlur(host){
    if(!host?.isConnected)return ()=>{};
    const layer=document.createElement('div');layer.className='magic-progressive-blur';layer.setAttribute('aria-hidden','true');layer.hidden=true;
    for(let i=0;i<4;i++){
      const node=document.createElement('span');node.style.setProperty('--blur-level',(.5*2**i)+'px');
      node.style.setProperty('--blur-mask','linear-gradient(to bottom,transparent '+Math.max(0,i*25-25)+'%,black '+i*25+'%,black '+(i+1)*25+'%,transparent '+(i+2)*25+'%)');layer.append(node);
    }
    host.append(layer);let enabled=false,frame=0;
    function hide(){if(frame)global.cancelAnimationFrame(frame);frame=0;layer.hidden=true;}
    function paint(){
      frame=0;if(!enabled||!host.isConnected){hide();return;}
      const r=host.getBoundingClientRect(),nav=document.querySelector('.mobile-bottom-nav');
      const navTop=nav?.getClientRects().length?nav.getBoundingClientRect().top:global.innerHeight;
      const bottom=Math.min(global.innerHeight,navTop),left=Math.max(0,r.left),right=Math.min(global.innerWidth,r.right),height=28;
      // Route roots receive programmatic focus (tabindex=-1); they are not
      // controls and must not suppress the scroll cue over the entire page.
      const focused=document.activeElement?.closest('input,button,a,select,textarea,[tabindex]:not([tabindex="-1"])'),focus=focused&&host.contains(focused)?focused.getBoundingClientRect():null;
      const focusOverlaps=focus&&focus.bottom>bottom-height&&focus.top<bottom;
      if(r.bottom<=bottom+1||r.top>=bottom-height||right<=left||focusOverlaps){layer.hidden=true;return;}
      layer.style.left=left+'px';layer.style.top=(bottom-height)+'px';layer.style.width=(right-left)+'px';layer.hidden=false;
    }
    function schedule(){if(enabled&&!frame)frame=global.requestAnimationFrame(paint);}
    const bindings=[[document,'scroll',schedule,true],[global,'resize',schedule],[document,'focusin',schedule],[document,'focusout',schedule]];
    const observer=global.ResizeObserver?new global.ResizeObserver(schedule):null;
    const dispose=watch(host,active=>{enabled=active;if(active)schedule();else hide();},()=>{
      for(const [target,type,fn,capture]of bindings)target.removeEventListener(type,fn,capture);
      observer?.disconnect();layer.remove();
    },'(forced-colors:none)');
    for(const [target,type,fn,capture]of bindings)target.addEventListener(type,fn,capture||{passive:true});observer?.observe(host);
    return dispose;
  }
  function mountGuest(section){
    const grid=mountGrid(section?.querySelector('.guest-showcase')),blur=mountBlur(section);
    return ()=>{grid();blur();};
  }
  // Controlled theme adapter: the existing cycleTheme callback owns storage,
  // System preference, button naming, color-scheme and all application state.
  function toggleTheme(button,apply){
    if(themeTransition)return;
    if(!button||document.hidden||global.matchMedia?.('(prefers-reduced-motion:reduce)').matches||typeof document.startViewTransition!=='function'){apply();return;}
    const root=document.documentElement,r=button.getBoundingClientRect(),w=global.innerWidth,h=global.innerHeight;
    const x=r.left+r.width/2,y=r.top+r.height/2,radius=Math.hypot(Math.max(x,w-x),Math.max(y,h-y));
    if(!w||!h){apply();return;}
    const point=(x/w*100)+'% '+(y/h*100)+'%',from='circle(0% at '+point+')',to='circle('+(radius/(Math.hypot(w,h)/Math.SQRT2)*100)+'% at '+point+')';
    let applied=false,animation=null;
    const change=()=>{if(!applied){applied=true;apply();}},token={};themeTransition=token;
    function cleanup(){
      animation?.cancel();if(themeTransition!==token)return;themeTransition=null;
      delete root.dataset.magicuiThemeVt;root.style.removeProperty('--magic-theme-from');
      document.removeEventListener('visibilitychange',visibility);global.removeEventListener('pagehide',cancel);
    }
    let transition;
    function cancel(){transition?.skipTransition();cleanup();}
    function visibility(){if(document.hidden)cancel();}
    root.dataset.magicuiThemeVt='active';root.style.setProperty('--magic-theme-from',from);
    try{transition=document.startViewTransition(change);}catch{cleanup();change();return;}
    document.addEventListener('visibilitychange',visibility);global.addEventListener('pagehide',cancel);
    Promise.resolve(transition.ready).then(()=>{
      if(themeTransition!==token||document.hidden)return;
      animation=root.animate({clipPath:[from,to]},{duration:400,easing:'ease-in-out',fill:'forwards',pseudoElement:'::view-transition-new(root)'});
    }).catch(()=>{change();transition.skipTransition();cleanup();});
    Promise.resolve(transition.finished).then(cleanup,()=>{change();cleanup();});
  }
  global.CRSMagicUI=Object.freeze({mountRipple,mountCard,mountGuest,mountBlur,toggleTheme});
})(window);
