(function(global){
  'use strict';
  // UI-only leases: an older bootstrap cannot dismiss a newer one's loader.
  // Start is called at the authenticated transport seam, never while waiting
  // for a password, OAuth popup or OTP. No identity/payload enters this module.
  let current=null,node=null,phase='bootstrap',held=[];
  const copy={
    th:{title:'กำลังเตรียมระบบ',bootstrap:'กำลังโหลดข้อมูลผู้ใช้…',view:'กำลังเตรียมหน้าแรกและข้อมูลที่ต้องใช้…'},
    en:{title:'Getting things ready',bootstrap:'Loading your user data…',view:'Preparing your first page and its data…'}
  };
  function translate(){
    if(!node)return;
    const text=copy[global.CRS?.language.effective()]||copy.th;
    node.querySelector('[data-session-loading-title]').textContent=text.title;
    node.querySelector('[data-session-loading-message]').textContent=text[phase];
  }
  function ensure(){
    if(node)return;
    node=document.createElement('section');node.id='session-loading';node.className='session-loading';node.hidden=true;
    node.setAttribute('role','status');node.setAttribute('aria-live','polite');node.setAttribute('aria-atomic','true');
    node.innerHTML='<div class="session-loading-card"><span class="spinner-border" aria-hidden="true"></span><h2 class="h5 mb-2" data-session-loading-title></h2><p class="mb-0" data-session-loading-message></p></div>';
    document.body.append(node);
  }
  function hide(){
    if(node)node.hidden=true;
    for(const [element,inert] of held)element.inert=inert;
    held=[];
  }
  global.CRSSessionLoading=Object.freeze({
    begin(){
      hide();const lease={
        view(){if(current!==lease)return;phase='view';translate();},
        finish(){if(current!==lease)return;hide();current=null;}
      };
      current=lease;phase='bootstrap';return lease;
    },
    start(){
      if(!current)return;
      ensure();translate();
      const splash=document.querySelector('#app-splash');if(splash)splash.hidden=true;
      if(node.hidden){
        held=[...document.querySelectorAll('#app-shell,#access-state,#guest-equipment')].map(element=>[element,element.inert]);
        for(const [element] of held)element.inert=true;
      }
      node.hidden=false;
    }
  });
  global.addEventListener('crs:language-changed',translate);
  global.addEventListener('pagehide',()=>{hide();current=null;});
})(window);
