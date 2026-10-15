(function(global){
  'use strict';
  // Presentation adapter only. The existing auth module alone owns hidden,
  // polling, OTP input/validation, attempt cancellation and session activation.
  function mount(panel){
    if(!panel||panel.dataset.handoffMounted)return ()=>{};
    panel.dataset.handoffMounted='true';
    const access=document.getElementById('access-state'),controller=new AbortController();
    let disposed=false,opened=false,native=typeof panel.showPopover==='function';
    const close=document.createElement('button'),reopen=document.createElement('button');
    close.type=reopen.type='button';close.className='oauth-handoff-close';reopen.className='btn btn-outline-primary oauth-handoff-reopen';
    close.innerHTML='<i class="bi bi-x-lg" aria-hidden="true"></i>';close.dataset.handoffClose='';
    reopen.dataset.handoffReopen='';reopen.setAttribute('aria-controls',panel.id);reopen.setAttribute('aria-haspopup','dialog');reopen.hidden=true;
    const label=document.getElementById('oauth-handoff-label'),guidance=panel.querySelector('.oauth-handoff-guidance');
    guidance.id='oauth-handoff-guidance';panel.setAttribute('role','dialog');panel.setAttribute('aria-modal','false');panel.setAttribute('aria-labelledby',label.id);panel.setAttribute('aria-describedby',guidance.id);
    const anchor=document.createComment('OAuth handoff presentation position');
    panel.classList.add('oauth-handoff-popover');panel.prepend(close);panel.before(reopen,anchor);document.body.append(panel);
    if(native)panel.setAttribute('popover','manual');
    const visible=()=>!disposed&&!panel.hidden&&!access.hidden;
    function translate(){
      const en=global.CRS.language.effective()==='en';close.setAttribute('aria-label',en?'Close verification popover':'ปิดหน้าต่างรหัสยืนยัน');
      reopen.textContent=en?'Enter verification code':'กรอกรหัสยืนยัน';
    }
    function hide(focus=false){
      if(native&&opened)try{panel.hidePopover();}catch{/* Hidden/disconnected by auth is already closed. */}
      opened=false;delete panel.dataset.handoffOpen;reopen.setAttribute('aria-expanded','false');reopen.hidden=!visible();
      if(focus&&!reopen.hidden)reopen.focus();
    }
    function show(){
      if(!visible())return;
      if(native)try{panel.showPopover();}catch{native=false;panel.removeAttribute('popover');}
      opened=true;panel.dataset.handoffOpen='true';reopen.hidden=false;reopen.setAttribute('aria-expanded','true');
      // Auth's synchronous focus can precede promotion to the top layer.
      queueMicrotask(()=>{if(visible()&&opened)panel.querySelector('[data-otp-digit]')?.focus({preventScroll:true});});
    }
    let wasVisible=false;
    function sync(){const now=visible();if(now&&!wasVisible)show();else if(!now)hide();wasVisible=now;}
    close.addEventListener('click',()=>hide(true),{signal:controller.signal});
    reopen.addEventListener('click',()=>opened?hide(true):show(),{signal:controller.signal});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&opened){event.preventDefault();event.stopPropagation();hide(true);}},{capture:true,signal:controller.signal});
    document.addEventListener('pointerdown',event=>{if(opened&&!panel.contains(event.target)&&!reopen.contains(event.target))hide();},{signal:controller.signal});
    document.addEventListener('focusin',event=>{if(opened&&!panel.contains(event.target)&&!reopen.contains(event.target))hide();},{signal:controller.signal});
    global.addEventListener('crs:language-changed',translate,{signal:controller.signal});
    global.addEventListener('crs:bootstrapped',()=>hide(),{signal:controller.signal});
    const observer=new MutationObserver(sync);observer.observe(panel,{attributes:true,attributeFilter:['hidden']});observer.observe(access,{attributes:true,attributeFilter:['hidden']});
    function dispose(){
      if(disposed)return;hide();disposed=true;observer.disconnect();controller.abort();close.remove();reopen.remove();panel.removeAttribute('popover');panel.classList.remove('oauth-handoff-popover');anchor.replaceWith(panel);delete panel.dataset.handoffMounted;delete panel.dataset.handoffOpen;
    }
    global.addEventListener('pagehide',dispose,{once:true,signal:controller.signal});
    translate();sync();return dispose;
  }
  global.CRSOAuthHandoff=Object.freeze({mount});
})(window);
