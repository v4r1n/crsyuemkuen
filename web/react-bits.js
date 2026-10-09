/* DOM adaptations of React Bits DriftWall and HoldButton, David Haz.
 * Upstream: DavidHDev/react-bits@7b69ba117ca7876dc9ca5ff3c09cf514de4b2d62.
 * Application use only; MIT + Commons Clause notice: react-bits-license.txt.
 * Presentation never grants borrowing/deletion authority. */
(function(global){
  'use strict';
  const CRS=global.CRS,escape=value=>CRS.escapeHtml(value);
  const en=()=>CRS.language.effective()==='en';
  const copy=(th,english)=>en()?english:th;
  const statuses={AVAILABLE:['พร้อมยืม','Available'],PENDING:['รออนุมัติ','Pending approval'],RESERVED:['จองแล้ว','Reserved'],BORROWED:['ถูกยืม','Borrowed'],RETURNING:['รอตรวจรับคืน','Awaiting inspection'],MAINTENANCE:['ซ่อมบำรุง','Maintenance'],DAMAGED:['ชำรุด','Damaged'],LOST:['สูญหาย','Lost'],RETIRED:['ปลดระวาง','Retired'],DELETED:['ลบแล้ว','Deleted']};
  const statusLabel=status=>(statuses[status]||['ไม่พร้อมยืม','Unavailable'])[en()?1:0];
  let wallSerial=0;
  function mountWall(host,items,{publicView=false,onSelect,layout='wall'}={}){
    const id='drift-wall-'+(++wallSerial),images=[],animations=[],cleanups=[];
    const gallery=layout==='gallery';
    let disposed=false,visible=true,manualStatic=gallery,pointerActive=false;
    const motion=matchMedia('(min-width:768px) and (hover:hover) and (pointer:fine) and (prefers-reduced-motion:no-preference)');
    const wall=document.createElement('div');wall.className='equipment-wall';
    wall.dataset.layout=gallery?'gallery':'wall';
    wall.innerHTML='<div class="drift-controls"><p class="small mb-0">'+escape(copy('คลิกอุปกรณ์เพื่อยืม หรือดูสถานะ','Select equipment to borrow or view its status'))+'</p><button type="button" class="btn btn-outline-secondary" data-wall-mode aria-controls="'+id+'"></button></div><div id="'+id+'" class="drift-wall" data-static="true"><div class="drift-wall__plane"></div></div>';
    host.append(wall);
    const stage=wall.querySelector('.drift-wall'),plane=wall.querySelector('.drift-wall__plane'),mode=wall.querySelector('[data-wall-mode]');
    mode.hidden=gallery;
    const columns=Array.from({length:5},()=>[]);
    items.forEach((item,index)=>columns[index%5].push(item));
    function tile(item,duplicate=false){
      const node=document.createElement('button');node.type='button';node.className='drift-wall__tile';node.dataset.wallAsset=item.asset_id;
      if(duplicate){node.dataset.wallCopy='true';node.tabIndex=-1;node.setAttribute('aria-hidden','true');node.addEventListener('pointerdown',event=>event.preventDefault());}
      else if(publicView&&item.can_borrow)node.dataset.guestBorrow=item.asset_id;
      const status=item.status||(item.can_borrow?'AVAILABLE':'UNKNOWN');
      node.setAttribute('aria-label',item.name+' · '+statusLabel(status));
      node.innerHTML='<span class="drift-wall__tile-inner"><span class="drift-image-fallback" aria-hidden="true"><i class="bi bi-box-seam"></i></span><span class="drift-wall__overlay" aria-hidden="true"></span><span class="drift-caption"><span class="drift-name">'+escape(item.name)+'</span><span class="drift-status" data-status="'+escape(status)+'">'+escape(statusLabel(status))+'</span><span class="drift-action">'+escape(item.can_borrow?copy('ยืม','Borrow'):copy('ดูสถานะ','View status'))+'</span></span></span>';
      node.addEventListener('click',()=>onSelect(item,node));
      // Private delivery only for authenticated catalog DTOs; Guest never reads images.
      if(!duplicate&&!publicView&&item.imageAvailable!==false&&item.image_url==='/api/image-placeholder'){
        const image=document.createElement('img');image.hidden=true;image.alt='';image.referrerPolicy='no-referrer';image.className='drift-image';
        node.querySelector('.drift-wall__tile-inner').prepend(image);images.push({image,item,fallback:node.querySelector('.drift-image-fallback')});
      }
      return node;
    }
    columns.forEach((column,index)=>{
      if(gallery){column.forEach(item=>plane.append(tile(item)));return;}
      const visualOnly=!column.length;
      if(visualOnly)column=[items[index%items.length]];
      const col=document.createElement('div');col.className='drift-wall__col';
      const track=document.createElement('div');track.className='drift-wall__track';
      column.forEach(item=>track.append(tile(item,visualOnly)));
      // Bounded visual repetitions. Only originals are focusable/announced.
      const copies=Math.max(2,Math.ceil(960/(column.length*150))+1);
      for(let i=1;i<copies;i++)column.forEach(item=>track.append(tile(item,true)));
      col.append(track);plane.append(col);
      const distance=column.length*150,factor=1+.45*(((index*.6180339887+.35)%1)*2-1);
      if(track.animate){
        const frames=index%2?[{transform:'translate3d(0,-'+distance+'px,0)'},{transform:'translate3d(0,0,0)'}]:[{transform:'translate3d(0,0,0)'},{transform:'translate3d(0,-'+distance+'px,0)'}];
        const animation=track.animate(frames,{duration:distance/(28*factor)*1000,iterations:Infinity});animation.pause();animations.push(animation);
      }
    });
    for(const value of images)value.image.addEventListener('load',()=>{
      if(disposed)return;
      // Copy decoded pixels, not signed URLs or Blob capabilities. One guarded
      // image read per asset, including when a visual repetition enters first.
      for(const node of wall.querySelectorAll('[data-wall-copy]'))if(node.dataset.wallAsset===value.item.asset_id){
        const canvas=document.createElement('canvas');canvas.width=200;canvas.height=132;canvas.className='drift-image';canvas.setAttribute('aria-hidden','true');
        try{const scale=Math.min(200/value.image.naturalWidth,132/value.image.naturalHeight),width=value.image.naturalWidth*scale,height=value.image.naturalHeight*scale;canvas.getContext('2d').drawImage(value.image,(200-width)/2,(132-height)/2,width,height);node.querySelector('.drift-image-fallback').hidden=true;node.querySelector('.drift-wall__tile-inner').prepend(canvas);}catch{/* Keep the standard placeholder. */}
      }
    },{once:true});
    const canMove=()=>motion.matches&&animations.length>0;
    function sync(){
      const staticView=manualStatic||!canMove();stage.dataset.static=String(staticView);
      mode.textContent=staticView?copy('แสดงแบบเคลื่อนไหว','Animate wall'):copy('หยุด / แสดงรายการทั้งหมด','Pause / show all');
      mode.disabled=!canMove();mode.setAttribute('aria-pressed',String(manualStatic));
      const running=!staticView&&!pointerActive&&visible&&!document.hidden&&wall.isConnected&&!host.closest('[hidden]');
      wall.dataset.motion=running?'running':'paused';
      animations.forEach(animation=>running?animation.play():animation.pause());
    }
    mode.onclick=()=>{manualStatic=!manualStatic;sync();};
    const focus=()=>{if(!pointerActive){manualStatic=true;sync();}};stage.addEventListener('focusin',focus);
    const press=()=>{pointerActive=true;sync();},release=()=>{pointerActive=false;sync();};stage.addEventListener('pointerdown',press,true);global.addEventListener('pointerup',release);global.addEventListener('pointercancel',release);global.addEventListener('blur',release);
    const visibility=()=>{if(document.hidden)pointerActive=false;sync();};document.addEventListener('visibilitychange',visibility);motion.addEventListener('change',sync);
    const observer=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{visible=entries[0].isIntersecting;sync();}):null;observer?.observe(wall);
    const requested=new Set();
    const imageObserver=typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){const value=images.find(value=>value.item.asset_id===entry.target.dataset.wallAsset);if(value&&!requested.has(value.item.asset_id)){requested.add(value.item.asset_id);CRS.recoverEquipmentImage(value.image,value.fallback,value.item);}imageObserver.unobserve(entry.target);}}):null;
    for(const value of images){if(imageObserver){for(const node of wall.querySelectorAll('[data-wall-asset]'))if(node.dataset.wallAsset===value.item.asset_id)imageObserver.observe(node);}else CRS.recoverEquipmentImage(value.image,value.fallback,value.item);}
    cleanups.push(()=>observer?.disconnect(),()=>imageObserver?.disconnect(),()=>document.removeEventListener('visibilitychange',visibility),()=>motion.removeEventListener('change',sync),()=>stage.removeEventListener('focusin',focus));
    cleanups.push(()=>stage.removeEventListener('pointerdown',press,true),()=>global.removeEventListener('pointerup',release),()=>global.removeEventListener('pointercancel',release),()=>global.removeEventListener('blur',release));
    sync();
    return ()=>{if(disposed)return;disposed=true;animations.forEach(animation=>animation.cancel());images.forEach(value=>CRS.cancelEquipmentImage(value.image));cleanups.forEach(clean=>clean());wall.remove();};
  }

  // One delegated hold controller covers catalog, table, detail and final dialog.
  // A completed entry hold opens the existing dialog; only a second completed
  // hold with its existing typed-ID/version/operation guards submits the form.
  function mountDeletes(){
    const selector='button[data-action="delete-equipment"],#equipment-delete-form button[data-submit]';
    let active=null,timer=0,raf=0,permit=null,submitPermit=null,disposed=false;
    const original=new WeakMap(),decorated=new WeakMap();
    function decorate(){
      document.querySelectorAll(selector).forEach(button=>{
        if(decorated.get(button)===CRS.language.effective())return;
        if(!original.has(button))original.set(button,{html:button.innerHTML,label:button.getAttribute('aria-label'),title:button.getAttribute('title'),description:button.getAttribute('aria-description')});
        decorated.set(button,CRS.language.effective());
        const final=button.closest('#equipment-delete-form'),label=copy(final?'กดค้าง 2 วินาทีเพื่อลบ':'กดค้างเพื่อลบ','Hold to delete');
        button.classList.add('hold-button');button.dataset.phase='idle';button.style.setProperty('--hb-p','0');
        button.setAttribute('aria-label',label+(final?'':' · '+(button.dataset.assetId||'')));
        button.title=copy('กดค้าง 2 วินาที ปล่อยเพื่อยกเลิก รองรับ Space / Enter','Hold for 2 seconds. Release to cancel. Space / Enter supported.');
        button.setAttribute('aria-description',button.title);
        button.innerHTML='<span class="hold-button__label"><i class="bi bi-trash" aria-hidden="true"></i><span>'+escape(label)+'</span></span><span class="hold-button__clip" aria-hidden="true"><span class="hold-button__fill"><span class="hold-button__label"><i class="bi bi-trash"></i><span>'+escape(label)+'</span></span></span></span>';
      });
      if(active&&(active.button.disabled||!active.button.isConnected||active.button.closest('[hidden],.modal:not(.show)')))cancel();
    }
    function cancel(){
      clearTimeout(timer);cancelAnimationFrame(raf);timer=raf=0;
      if(active){const button=active.button;button.dataset.phase='idle';button.style.setProperty('--hb-p','0');const pointer=active.pointer;active=null;try{if(pointer!==null&&button.hasPointerCapture(pointer))button.releasePointerCapture(pointer);}catch{/* Already cancelled. */}}
    }
    function complete(){
      if(!active||active.done||document.hidden||!document.hasFocus()||!active.button.isConnected||active.button.disabled)return cancel();
      if(performance.now()-active.start<2000)return;
      const button=active.button;active.done=true;clearTimeout(timer);cancelAnimationFrame(raf);timer=raf=0;
      button.style.setProperty('--hb-p','1');button.dataset.phase='done';
      // A one-use permit surrounds the synchronous native event, never an RPC.
      if(button.closest('#equipment-delete-form')){
        submitPermit=button.form;try{button.form.requestSubmit(button);}finally{submitPermit=null;}
      }else{permit=button;try{button.click();}finally{permit=null;}}
    }
    function begin(button,kind,pointer=null){
      if(disposed||button.disabled||active||document.hidden)return;
      active={button,kind,pointer,start:performance.now(),done:false};button.dataset.phase='holding';
      function tick(now){if(!active||active.button!==button)return;button.style.setProperty('--hb-p',String(Math.min(1,(now-active.start)/2000)));if(now-active.start>=2000)complete();else raf=requestAnimationFrame(tick);}
      raf=requestAnimationFrame(tick);timer=setTimeout(complete,2010);
    }
    const match=event=>event.target.closest?.(selector);
    const down=event=>{const button=match(event);if(!button||!event.isPrimary||event.button!==0)return;event.preventDefault();begin(button,'pointer',event.pointerId);if(active?.button===button)try{button.setPointerCapture(event.pointerId);}catch{cancel();}};
    const move=event=>{if(active?.kind!=='pointer'||active.pointer!==event.pointerId)return;const r=active.button.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)cancel();};
    const end=event=>{if(active?.kind==='pointer'&&active.pointer===event.pointerId)cancel();};
    const click=event=>{const button=match(event);if(button&&permit!==button){event.preventDefault();event.stopImmediatePropagation();}};
    const keydown=event=>{const button=match(event);if(event.key==='Escape'){cancel();return;}if(button&&[' ','Enter'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();if(!event.repeat)begin(button,'key');}};
    const keyup=event=>{if(active?.kind==='key'&&[' ','Enter'].includes(event.key)){event.preventDefault();cancel();}};
    const submit=event=>{if(event.target.id==='equipment-delete-form'&&submitPermit!==event.target){event.preventDefault();event.stopImmediatePropagation();}};
    const focusout=event=>{if(active?.button===event.target)cancel();};
    const visibility=()=>{if(document.hidden)cancel();};
    const context=event=>{if(match(event)){event.preventDefault();cancel();}};
    const events={pointerdown:down,pointermove:move,pointerup:end,pointercancel:end,lostpointercapture:end,click,keydown,keyup,submit,focusout,contextmenu:context,visibilitychange:visibility};
    Object.entries(events).forEach(([type,listener])=>document.addEventListener(type,listener,true));global.addEventListener('blur',cancel);
    global.addEventListener('scroll',cancel,true);global.addEventListener('resize',cancel);
    const observer=new MutationObserver(decorate);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['disabled','hidden','class']});
    const language=()=>{cancel();decorate();};global.addEventListener('crs:language-changed',language);
    decorate();
    return ()=>{disposed=true;cancel();observer.disconnect();Object.entries(events).forEach(([type,listener])=>document.removeEventListener(type,listener,true));global.removeEventListener('blur',cancel);global.removeEventListener('scroll',cancel,true);global.removeEventListener('resize',cancel);global.removeEventListener('crs:language-changed',language);document.querySelectorAll(selector).forEach(button=>{const value=original.get(button);if(!value)return;button.innerHTML=value.html;button.classList.remove('hold-button');button.removeAttribute('data-phase');button.style.removeProperty('--hb-p');for(const [attribute,name]of [['aria-label','label'],['title','title'],['aria-description','description']]){if(value[name]===null)button.removeAttribute(attribute);else button.setAttribute(attribute,value[name]);}});};
  }
  global.CRSReactBits=Object.freeze({mountWall,mountDeletes,statusLabel});
})(window);
