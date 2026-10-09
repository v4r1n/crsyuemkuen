(function(global){
  'use strict';
  // Presentation only: no auth, requests, timers or continuous render loop.
  function mount(story){
    const art=story?.querySelector('.login-art'),access=story?.closest('#access-state');
    if(!art||!access||!global.matchMedia)return ()=>{};
    const media=global.matchMedia('(min-width:768px) and (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference)');
    let disposed=false,listening=false,paused=false,intersecting=true,frame=0,point=null;
    const visible=()=>!paused&&!document.hidden&&!access.hidden&&story.isConnected&&intersecting&&media.matches&&art.getClientRects().length>0;
    function reset(){
      if(frame)global.cancelAnimationFrame(frame);
      frame=0;point=null;art.classList.remove('is-parallax-active');
      art.style.removeProperty('--login-parallax-x');art.style.removeProperty('--login-parallax-y');
    }
    function paint(){
      frame=0;
      if(!point||!visible()){reset();return;}
      // Measure the stationary story in viewport coordinates, not the tilted
      // artwork; this also works inside scaled/scrolled Login containers.
      const bounds=story.getBoundingClientRect(),image=art.getBoundingClientRect();
      if(!bounds.width||!bounds.height||point.x<bounds.left||point.x>bounds.right||point.y<bounds.top||point.y>bounds.bottom||image.bottom<=0||image.top>=global.innerHeight){reset();return;}
      const clamp=value=>Math.max(-1,Math.min(1,value));
      art.style.setProperty('--login-parallax-x',clamp(2*(point.x-bounds.left)/bounds.width-1).toFixed(4));
      art.style.setProperty('--login-parallax-y',clamp(2*(point.y-bounds.top)/bounds.height-1).toFixed(4));
      art.classList.add('is-parallax-active');
    }
    function move(event){
      if(event.pointerType!=='mouse'||!visible()){reset();return;}
      point={x:event.clientX,y:event.clientY};
      if(!frame)frame=global.requestAnimationFrame(paint);
    }
    function detach(){
      reset();if(!listening)return;listening=false;
      story.removeEventListener('pointermove',move);story.removeEventListener('pointerleave',reset);story.removeEventListener('pointercancel',reset);
      global.removeEventListener('blur',reset);global.removeEventListener('resize',reset);document.removeEventListener('scroll',reset,true);
    }
    function reconcile(){
      if(disposed)return;
      if(!story.isConnected){dispose();return;}
      if(!visible()){detach();return;}
      if(listening)return;listening=true;
      story.addEventListener('pointermove',move,{passive:true});story.addEventListener('pointerleave',reset);story.addEventListener('pointercancel',reset);
      global.addEventListener('blur',reset);global.addEventListener('resize',reset);document.addEventListener('scroll',reset,true);
    }
    function suspend(){paused=true;reconcile();}
    function resume(){paused=false;reconcile();}
    const changes=new MutationObserver(reconcile);
    // Observe only ancestor child lists: unrelated view/style mutations do not
    // wake the effect, while removing any ancestor disposes every listener.
    for(let parent=story.parentNode;parent;parent=parent.parentNode)changes.observe(parent,{childList:true});
    // observe() replaces a target's options: retain both hidden-state and child
    // removal observation when access is also an ancestor of the story.
    changes.observe(access,{attributes:true,attributeFilter:['hidden'],childList:true});
    const intersection=global.IntersectionObserver?new global.IntersectionObserver(entries=>{intersecting=entries[0].isIntersecting;reconcile();}):null;
    intersection?.observe(art);
    media.addEventListener('change',reconcile);document.addEventListener('visibilitychange',reconcile);
    global.addEventListener('pagehide',suspend);global.addEventListener('pageshow',resume);
    function dispose(){
      if(disposed)return;disposed=true;detach();changes.disconnect();intersection?.disconnect();
      media.removeEventListener('change',reconcile);document.removeEventListener('visibilitychange',reconcile);
      global.removeEventListener('pagehide',suspend);global.removeEventListener('pageshow',resume);
    }
    reconcile();return dispose;
  }
  global.CRSLoginParallax=Object.freeze({mount});
})(window);
