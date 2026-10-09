(function(global){
  'use strict';
  const CRS=global.CRS, escape=value=>CRS.escapeHtml(value), handoffKey='crs.guest.borrow-intent.v1';
  const text={
    th:{signIn:'เข้าสู่ระบบ',intro:'ใช้บัญชีที่ได้รับสิทธิ์จากผู้ดูแลระบบ',email:'อีเมล',password:'รหัสผ่าน',forgot:'ลืมรหัสผ่าน?',or:'หรือดำเนินการต่อด้วย',guide:'คู่มือ',guest:'ดูอุปกรณ์สาธารณะ',privacy:'ความเป็นส่วนตัว',terms:'ข้อกำหนด',close:'ปิด',security:'ความปลอดภัย',change:'เปลี่ยนรหัสผ่าน',sendOtp:'ส่ง OTP ทางอีเมล',otp:'รหัสยืนยัน 6 หลัก',verify:'ยืนยัน OTP',newPassword:'รหัสผ่านใหม่',confirmPassword:'ยืนยันรหัสผ่านใหม่',policy:'ใช้ 15–128 ตัวอักษร ไม่ใช่รหัสทั่วไปหรืออีเมลของคุณ',reset:'รีเซ็ตรหัสผ่าน',sent:'หากบัญชีได้รับสิทธิ์ ระบบจะส่งรหัสยืนยันทางอีเมล',changed:'เปลี่ยนรหัสผ่านแล้ว กรุณาเข้าสู่ระบบใหม่',required:'ต้องเปลี่ยนรหัสผ่านก่อนใช้งาน',notifications:'การแจ้งเตือน',none:'ยังไม่มีรายการ',equipment:'อุปกรณ์สาธารณะ',borrow:'ยืม',confirmBorrow:'ต้องเข้าสู่ระบบก่อนส่งคำขอยืม เมื่อเข้าสู่ระบบแล้วจะกลับมายังอุปกรณ์นี้',continue:'ดำเนินการต่อ',temporary:'ส่งรหัสผ่านชั่วคราว',temporaryConfirm:'ส่งรหัสชั่วคราวทางอีเมลและเพิกถอน session ของผู้ใช้ ต้องเปลี่ยนรหัสก่อนใช้งาน ยืนยันหรือไม่?',temporarySent:'ส่งและเปิดใช้รหัสชั่วคราวแล้ว',publish:'เปิดให้ Guest ดู',unpublish:'ปิดการแสดงต่อ Guest',publication:'เผยแพร่เฉพาะชื่อ หมวดหมู่ ยี่ห้อ รุ่น และการยืมได้ ไม่เผยข้อมูลภายในหรือภาพ',unavailable:'ยังไม่ได้กำหนดหน้าความเป็นส่วนตัว/ข้อกำหนด กรุณาติดต่อผู้ดูแลระบบ',loading:'กำลังโหลด…',search:'ค้นหาอุปกรณ์',before:'ก่อนหน้า',next:'ถัดไป',hold:'กดค้างเพื่อดูรหัสผ่าน',signInGoogle:'เข้าสู่ระบบด้วย Google',remember:'จดจำการเข้าสู่ระบบในอุปกรณ์นี้',securityNote:'ช่วยป้องกันสแปมด้วย reCAPTCHA ของ Google',loginKicker:'อุปกรณ์พร้อมใช้ มีไหมนั่นอีกเรื่อง'},
    en:{signIn:'Sign in',intro:'Use an account authorized by your administrator',email:'Email',password:'Password',forgot:'Forgot password?',or:'Or continue with',guide:'Guide',guest:'Browse public equipment',privacy:'Privacy',terms:'Terms',close:'Close',security:'Security',change:'Change password',sendOtp:'Email a verification code',otp:'6-digit verification code',verify:'Verify code',newPassword:'New password',confirmPassword:'Confirm new password',policy:'Use 15–128 characters; avoid common passwords and your email',reset:'Reset password',sent:'If the account is authorized, a code will be emailed',changed:'Password changed. Please sign in again',required:'Change your password before continuing',notifications:'Notifications',none:'No items yet',equipment:'Public equipment',borrow:'Borrow',confirmBorrow:'Sign in to request this equipment. You will return here after sign-in.',continue:'Continue',temporary:'Email temporary password',temporaryConfirm:'Email a temporary password and revoke the user’s sessions? They must change it before continuing.',temporarySent:'Temporary password emailed and activated',publish:'Publish to guests',unpublish:'Hide from guests',publication:'Publish name, category, brand, model and borrow availability only. No internal data or images.',unavailable:'Privacy/Terms pages have not been configured. Contact your administrator.',loading:'Loading…',search:'Search equipment',before:'Previous',next:'Next',hold:'Hold to reveal password',signInGoogle:'Continue with Google',remember:'Remember sign-in on this device',securityNote:'Google reCAPTCHA helps protect against spam',loginKicker:'Equipment ready. Available? That’s another story.'}
  };
  const inputHints={th:{email:'กรอกอีเมลของคุณ',password:'กรอกรหัสผ่านของคุณ'},en:{email:'Enter your email',password:'Enter your password'}};
  const t=key=>(text[CRS.language.effective()]||text.th)[key]||key;
  const security=(method,input)=>CRS.auth.requestSecurity(method,input);
  let guestPage=null,guestSerial=0,guestDispose=null,guestInput={},guestResult=null,notifications=[],inboxBusy=false,dialogSerial=0,entryView='guest',cardEffect=null;
  let dashboardPage=null,dashboardDispose=null,dashboardResult=null,dashboardSerial=0,dashboardSearch='';
  const statusText=status=>global.CRSReactBits?.statusLabel(status)||CRS.statusLabel(status);
  function badge(count){document.querySelectorAll('[data-notification-count]').forEach(node=>{node.textContent=count||'';});}
  async function refreshInboxCount(){
    if(inboxBusy||document.hidden||!CRS.auth.hasSession()||CRS.state.bootstrap?.session.mustChangePassword)return;
    inboxBusy=true;
    try{const result=await security('listNotifications',{});if(CRS.auth.hasSession())badge(result.unread);}catch{/* Session/access failures do not expose inbox state. */}finally{inboxBusy=false;}
  }
  function notificationButton(){return '<button type="button" class="btn btn-outline-secondary" data-experience-action="notifications" aria-label="'+escape(t('notifications'))+'"><i class="bi bi-bell" aria-hidden="true"></i><span data-notification-count></span></button>';}
  function translate(root=document){
    root.querySelectorAll('[data-experience-text]').forEach(node=>{node.textContent=t(node.dataset.experienceText);});
    root.querySelectorAll('[data-reveal-for]').forEach(node=>node.setAttribute('aria-label',t('hold')));
    root.querySelectorAll('[data-experience-placeholder]').forEach(node=>node.placeholder=(inputHints[CRS.language.effective()]||inputHints.th)[node.dataset.experiencePlaceholder]||'');
    root.querySelectorAll('.entry-navigation').forEach(node=>node.setAttribute('aria-label',t('equipment')));
    root.querySelectorAll('[data-experience-action="language"]').forEach(node=>{const language=CRS.language.effective();node.textContent=language==='en'?'EN':'TH';node.setAttribute('aria-label',language==='en'?'Language: English. Switch to Thai':'ภาษา: ไทย เปลี่ยนเป็นอังกฤษ');});
    if(root===document){
      const title=document.querySelector('#access-state-title');
      if(title && title.textContent!==t('signIn') && ['ลงชื่อเข้าใช้ด้วย Google','กรุณาลงชื่อเข้าใช้ Google','เข้าสู่ระบบ','Sign in'].includes(title.textContent)) title.textContent=t('signIn');
      const message=document.querySelector('#access-state-message');
      if(message && /^(เลือกบัญชี Google|ใช้บัญชีที่ได้รับสิทธิ์|Use an account)/.test(message.textContent.trim())) message.textContent=t('intro');
      const google=document.querySelector('[data-auth-button-label]');
      if(google && !document.querySelector('#google-signin-button').disabled) google.textContent=t('signInGoogle');
      const remember=document.querySelector('label[for="remember-session"]');if(remember) remember.textContent=t('remember');
    }
  }
  const button=(key,action,classes='btn btn-outline-secondary')=>'<button type="button" class="'+classes+'" data-experience-action="'+action+'" data-experience-text="'+key+'">'+escape(t(key))+'</button>';
  function actions({guide=true,login=true}={}){return '<div class="experience-actions">'+(guide?button('guide','guide'):'')+'<button type="button" class="btn btn-outline-secondary" data-experience-action="language">'+(CRS.language.effective()==='en'?'EN':'TH')+'</button>'+((login&&!CRS.auth.hasSession())?button('signIn','login'):'')+'</div>';}
  function dialog(title,content){
    const node=document.createElement('dialog');node.className='experience-dialog';
    node.innerHTML='<header><h2>'+escape(title)+'</h2><button type="button" class="close-dialog" aria-label="'+escape(t('close'))+'"><i class="bi bi-x" aria-hidden="true"></i></button></header>'+content;
    node.querySelector('h2').id='experience-dialog-title-'+(++dialogSerial);node.setAttribute('aria-labelledby',node.querySelector('h2').id);
    document.body.append(node);node.querySelector('.close-dialog').onclick=()=>node.close();
    node.addEventListener('close',()=>{node.querySelectorAll('input').forEach(input=>input.value='');node.remove();},{once:true});
    node.showModal();translate(node);return node;
  }
  function showLogin(){
    entryView='login';stopGuest();cardEffect?.reset();
    CRS.auth.showGoogleSignIn();translate();document.querySelector('#login-email').focus();
  }
  function showGuest(){
    if(CRS.auth.hasSession())return;
    entryView='guest';maskAll();cardEffect?.reset();document.querySelector('#login-password').value='';document.querySelector('#password-login-error').hidden=true;
    browseGuest(guestInput,guestResult);
  }
  function stopGuest(){guestSerial++;if(guestDispose)guestDispose();guestDispose=null;if(guestPage)guestPage.hidden=true;}
  function normalizeOtp(value){return String(value||'').normalize('NFKC').replace(/[๐-๙]/g,d=>String(d.charCodeAt(0)-0xe50)).replace(/[٠-٩]/g,d=>String(d.charCodeAt(0)-0x660)).replace(/[۰-۹]/g,d=>String(d.charCodeAt(0)-0x6f0)).replace(/\D/g,'');}
  function passwordPolicy(value,email){const v=value.normalize('NFC'),lower=v.toLowerCase();return [...v].length>=15 && [...v].length<=128 && !/[\u0000-\u001f\u007f]/.test(v) && new Set(v).size>=4 && !['passwordpassword','123456789012345','qwertyuiopasdfgh','letmeinletmein12','administrator123'].includes(lower) && !(email&&lower.includes(email.trim().toLowerCase()));}
  function passwordForm(mode){
    return '<form class="security-settings" data-password-flow="'+mode+'">'+(mode==='RESET'?'<label for="reset-email" data-experience-text="email">'+t('email')+'</label><input id="reset-email" class="form-control" type="email" autocomplete="username" required maxlength="254">':'')+
      '<p class="text-warning" data-password-required hidden>'+escape(t('required'))+'</p>'+button('sendOtp','request-password-otp','btn btn-outline-primary mt-3')+
      '<div data-password-otp-step hidden><label data-experience-text="otp" for="password-email-otp">'+t('otp')+'</label><input id="password-email-otp" class="form-control" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="12">'+button('verify','verify-password-otp','btn btn-outline-primary mt-3')+'</div>'+
      '<div data-password-new-step hidden><label for="password-new" data-experience-text="newPassword">'+t('newPassword')+'</label><div class="password-field"><input id="password-new" class="form-control" type="password" autocomplete="new-password" maxlength="256"><button type="button" class="password-reveal" data-reveal-for="password-new" aria-pressed="false"><i class="bi bi-eye" aria-hidden="true"></i></button></div>'+
      '<label for="password-confirm" data-experience-text="confirmPassword">'+t('confirmPassword')+'</label><input id="password-confirm" class="form-control" type="password" autocomplete="new-password" maxlength="256"><p class="form-text" data-experience-text="policy">'+t('policy')+'</p><button class="btn btn-primary" type="submit" data-experience-text="change" disabled>'+t('change')+'</button></div><p data-password-status role="status" aria-live="polite" class="mt-3"></p></form>';
  }
  function bindPasswordForm(form){
    let challenge='',expiresAt=0,verified=false,busy=false,cooldown=0;
    const status=form.querySelector('[data-password-status]'),request=form.querySelector('[data-experience-action="request-password-otp"]'),verify=form.querySelector('[data-experience-action="verify-password-otp"]');
    const otp=form.querySelector('#password-email-otp'),first=form.querySelector('#password-new'),second=form.querySelector('#password-confirm'),submit=form.querySelector('[type="submit"]');
    function sync(){const email=form.querySelector('#reset-email')?.value||CRS.state.bootstrap?.session.email;verify.disabled=busy||normalizeOtp(otp.value).length!==6||!challenge;submit.disabled=busy||!verified||Date.now()/1000>=expiresAt||first.value!==second.value||!passwordPolicy(first.value,email);}
    form.addEventListener('input',sync);sync();
    request.onclick=async()=>{
      if(busy||Date.now()<cooldown) return;
      const email=form.querySelector('#reset-email');if(email&&!email.reportValidity()) return;
      busy=true;request.disabled=true;sync();
      try{
        const result=await security('requestPasswordOtp',{purpose:form.dataset.passwordFlow,email:email&&email.value});
        challenge=result.challenge;expiresAt=result.expiresAt;verified=false;cooldown=Date.now()+result.resendAfter*1000;
        form.querySelector('[data-password-otp-step]').hidden=false;form.querySelector('[data-password-new-step]').hidden=true;
        status.textContent=t('sent');otp.value='';first.value='';second.value='';otp.focus();
        global.setTimeout(()=>{if(form.isConnected) request.disabled=false;},result.resendAfter*1000);
      }catch(error){status.textContent=error.message;request.disabled=false;}
      finally{busy=false;sync();}
    };
    verify.onclick=async()=>{
      if(busy||normalizeOtp(otp.value).length!==6) return;busy=true;sync();
      try{const result=await security('verifyPasswordOtp',{challenge,otp:normalizeOtp(otp.value)});verified=result.verified;expiresAt=result.expiresAt;otp.value='';form.querySelector('[data-password-otp-step]').hidden=true;form.querySelector('[data-password-new-step]').hidden=false;status.textContent='';first.focus();}
      catch(error){status.textContent=error.message;}finally{busy=false;sync();}
    };
    form.addEventListener('submit',async event=>{
      event.preventDefault();sync();if(submit.disabled) return;busy=true;sync();
      try{await security('changePassword',{challenge,password:first.value,confirmPassword:second.value});first.value='';second.value='';verified=false;const parent=form.closest('dialog');if(parent) parent.close();await CRS.auth.signOut();showLogin();CRS.toast(t('changed'),'success');}
      catch(error){status.textContent=error.message;}finally{busy=false;sync();}
    });
    if(form.dataset.passwordFlow==='CHANGE'&&CRS.state.bootstrap?.session.mustChangePassword) form.querySelector('[data-password-required]').hidden=false;
  }
  function mountSettings(key,host){
    if(!host) return;
    const controls=document.createElement('div');controls.className='settings-global-actions mb-3';
    controls.innerHTML=(!CRS.state.bootstrap?.session.mustChangePassword?notificationButton():'')+actions()+'<button type="button" class="theme-toggle" data-action="theme-toggle"><i class="bi bi-sun-fill" data-theme-icon aria-hidden="true"></i><span class="visually-hidden" data-theme-label></span></button>';
    host.querySelector('h2').after(controls);CRS.theme.apply(CRS.theme.current(),false);
    refreshInboxCount();
    if(key==='security'){host.querySelector('.settings-placeholder')?.remove();host.insertAdjacentHTML('beforeend','<div class="settings-card"><h3 class="h5" data-experience-text="change">'+t('change')+'</h3>'+passwordForm('CHANGE')+'</div>');bindPasswordForm(host.querySelector('[data-password-flow]'));}
    if(key==='profile'){host.insertAdjacentHTML('beforeend','<div class="settings-card mt-3"><h3 class="h5" data-experience-text="security">'+t('security')+'</h3>'+button('change','profile-security')+'</div>');}
    if(key==='notifications'){host.querySelector('.settings-placeholder')?.remove();renderNotifications(host);}
    translate(host);
  }
  async function renderNotifications(host){
    try{
      const result=await security('listNotifications',{});notifications=result.items||[];
      host.insertAdjacentHTML('beforeend','<div class="settings-card" data-notification-list></div>');const list=host.querySelector('[data-notification-list]');
      list.replaceChildren();
      const labels=CRS.language.effective()==='en'?{BORROW_REQUEST:'Borrow request',APPROVE:'Approved',REJECT:'Rejected',CHECKOUT:'Checked out',REQUEST_RETURN:'Return requested',RETURN:'Returned'}:{BORROW_REQUEST:'คำขอยืม',APPROVE:'อนุมัติ',REJECT:'ไม่อนุมัติ',CHECKOUT:'จ่ายอุปกรณ์',REQUEST_RETURN:'แจ้งคืน',RETURN:'ตรวจรับคืน'};
      for(const item of notifications){const node=document.createElement('button');node.type='button';node.className='notification-item';node.dataset.unread=String(!item.read_at);node.textContent=(labels[item.action]||item.action)+' · '+item.borrow_id;const time=document.createElement('span');time.className='notification-time';time.textContent=CRS.formatDateTime(item.created_at);node.append(time);node.onclick=async()=>{try{const result=await security('listNotifications',{readId:item.id});badge(result.unread);node.dataset.unread='false';CRS.navigate(CRS.state.bootstrap?.session.isAdmin?'admin':'my-borrow',{tab:'borrowing',highlight:item.borrow_id});const modal=host.closest('dialog');if(modal)modal.close();}catch(error){CRS.toast(error.message,'danger');}};list.append(node);}
      if(!notifications.length)list.textContent=t('none');
      badge(result.unread);
    }catch(error){host.insertAdjacentHTML('beforeend','<p role="status">'+escape(error.message)+'</p>');}
  }
  async function allEquipment(load,valid){
    const items=new Map();let total=null,pages=1;
    for(let page=1;page<=pages;page++){
      const result=await load(page);if(!valid())return null;
      if(!Array.isArray(result.items)||result.page!==page||!Number.isSafeInteger(result.total)||!Number.isSafeInteger(result.totalPages)||result.totalPages<1||result.totalPages>10000||result.total<0||(total!==null&&total!==result.total))throw new Error(CRS.language.effective()==='en'?'Catalog changed. Please refresh.':'รายการอุปกรณ์เปลี่ยนแปลง กรุณาโหลดใหม่');
      total=result.total;pages=result.totalPages;
      for(const item of result.items){if(!/^AST-\d{6}$/.test(item.asset_id)||items.has(item.asset_id))throw new Error('Invalid equipment catalog');items.set(item.asset_id,item);}
    }
    if(items.size!==total)throw new Error(CRS.language.effective()==='en'?'Catalog changed. Please refresh.':'รายการอุปกรณ์เปลี่ยนแปลง กรุณาโหลดใหม่');
    return {items:[...items.values()],total,page:1,totalPages:1};
  }
  async function selectEquipment(item,node,publicView){
    if(!item.can_borrow){
      const popup=dialog(item.name,'<p class="mb-2">'+escape(statusText(item.status||'UNKNOWN'))+'</p><p class="text-secondary">'+escape(CRS.language.effective()==='en'?'This equipment is not available to borrow.':'อุปกรณ์นี้ยังไม่พร้อมให้ยืม')+'</p>');
      const focusTarget=node.hasAttribute('data-wall-copy')?node.closest('.equipment-wall').querySelector('[data-wall-asset="'+item.asset_id+'"]:not([data-wall-copy])'):node;
      popup.addEventListener('close',()=>{if(focusTarget.isConnected)focusTarget.focus({preventScroll:true});},{once:true});return;
    }
    if(!publicView){CRS.navigate('borrow',{id:item.asset_id});return;}
    const confirmed=await CRS.confirm({title:t('signIn'),message:t('confirmBorrow'),confirmText:t('continue')});if(!confirmed)return;
    if(CRS.auth.hasSession()){CRS.navigate('borrow',{id:item.asset_id});return;}
    try{sessionStorage.setItem(handoffKey,JSON.stringify({assetId:item.asset_id,expiresAt:Date.now()+600000}));}catch{CRS.toast('ไม่สามารถจดจำอุปกรณ์ในเบราว์เซอร์นี้','danger');return;}showLogin();
  }
  const normalizeSearch=value=>String(value||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
  function matchingEquipment(result,query,publicView){
    // Search only fields already authorized for this view. Guest never fetches
    // private descriptions, images or the authenticated catalog as a fallback.
    const fields=publicView?['name','brand','model','category_name']:['asset_id','sku','name','brand','model','category_name','serial_number','description','specification'];
    return query?result.items.filter(item=>fields.some(field=>normalizeSearch(item[field]).includes(query))):result.items;
  }
  function catalogStatus(result,items,query,publicView){
    const en=CRS.language.effective()==='en';
    if(!result.total)return publicView?(en?'No public equipment yet. Sign in to view equipment your account is authorized to access.':'ยังไม่มีอุปกรณ์สาธารณะ เข้าสู่ระบบเพื่อดูอุปกรณ์ตามสิทธิ์ของบัญชีคุณ'):t('none');
    if(!items.length)return en?'No equipment matches your search.':'ไม่พบอุปกรณ์ที่ตรงกับคำค้นหา';
    return en?(query?items.length+' matching items':items.length+' items'):(query?'พบอุปกรณ์ '+items.length+' รายการ':'อุปกรณ์ '+items.length+' รายการ');
  }
  function renderWall(content,result,publicView,layout='wall'){
    const select=(item,node)=>selectEquipment(item,node,publicView);
    if(global.CRSReactBits)return global.CRSReactBits.mountWall(content,result.items,{publicView,onSelect:select,layout});
    // Semantic fallback when the optional presentation script is unavailable.
    content.innerHTML='<div class="guest-grid">'+result.items.map(item=>'<article class="card guest-card h-100"><div class="card-body"><span class="guest-card-icon" aria-hidden="true"><i class="bi bi-box-seam"></i></span><h3 class="h5">'+escape(item.name)+'</h3><p>'+escape(statusText(item.status||(item.can_borrow?'AVAILABLE':'UNKNOWN')))+'</p><button type="button" class="btn btn-primary" '+(publicView&&item.can_borrow?'data-guest-borrow="'+escape(item.asset_id)+'" ':'')+'data-wall-asset="'+escape(item.asset_id)+'">'+escape(item.can_borrow?t('borrow'):(CRS.language.effective()==='en'?'View status':'ดูสถานะ'))+'</button></div></article>').join('')+'</div>';
    content.querySelectorAll('[data-wall-asset]').forEach(node=>node.onclick=()=>select(result.items.find(item=>item.asset_id===node.dataset.wallAsset),node));return ()=>content.replaceChildren();
  }
  function catalogSearch(form,content,status,{publicView,cached,valid,loadPage,onSearch,onResult}){
    const input=form.querySelector('input');let result=cached,disposeWall=null,request=0,disposed=false;
    const current=()=>!disposed&&valid();
    function draw(){
      if(!current()||!result)return;
      disposeWall?.();disposeWall=null;content.replaceChildren();content.setAttribute('aria-busy','false');
      const query=normalizeSearch(input.value),items=matchingEquipment(result,query,publicView);
      status.textContent=catalogStatus(result,items,query,publicView);
      if(items.length)disposeWall=renderWall(content,{items},publicView,query?'gallery':'wall');
    }
    const change=event=>{if(event.isComposing)return;onSearch(input.value);draw();};
    async function load(){
      if(!current())return;
      const serial=++request;result=null;onResult(null);disposeWall?.();disposeWall=null;content.replaceChildren();
      content.setAttribute('aria-busy','true');status.textContent=t('loading');
      const fresh=()=>current()&&serial===request;
      try{const snapshot=await allEquipment(loadPage,fresh);if(!fresh())return;result=snapshot;onResult(result);draw();}
      catch(error){if(fresh()){content.setAttribute('aria-busy','false');status.textContent=error.message;}}
    }
    const submit=event=>{event.preventDefault();onSearch(input.value);load();};
    input.addEventListener('input',change);input.addEventListener('search',change);input.addEventListener('compositionend',change);form.addEventListener('submit',submit);
    if(cached){onResult(cached);draw();}else load();
    return ()=>{disposed=true;request++;disposeWall?.();input.removeEventListener('input',change);input.removeEventListener('search',change);input.removeEventListener('compositionend',change);form.removeEventListener('submit',submit);};
  }
  async function browseGuest(input={},cached=null){
    if(CRS.auth.hasSession())return;
    const serial=++guestSerial;
    guestInput={...input};guestResult=null;if(guestDispose)guestDispose();guestDispose=null;
    if(!guestPage){guestPage=document.createElement('section');guestPage.className='guest-equipment';guestPage.id='guest-equipment';}
    const access=document.querySelector('#access-state');
    access.after(guestPage);guestPage.setAttribute('aria-labelledby','guest-title');
    access.hidden=true;document.querySelector('#app-splash').hidden=true;document.querySelector('#app-shell').hidden=true;
    guestPage.hidden=false;
    guestPage.innerHTML='<div class="guest-showcase"><header class="guest-heading"><div class="guest-brand"><span class="brand-mark" aria-hidden="true"><img src="/brand/icon-yuemkuen.png" alt="" width="44" height="44" decoding="async"></span><div><p class="eyebrow mb-1">CRS Yuem-Kuen</p><h1 id="guest-title" class="h3">'+escape(t('equipment'))+'</h1></div></div><div class="guest-controls">'+actions()+'<button type="button" class="theme-toggle" data-action="theme-toggle"><i class="bi bi-sun-fill" data-theme-icon aria-hidden="true"></i><span class="visually-hidden" data-theme-label></span></button></div></header><form data-guest-search class="catalog-search mb-4"><label for="guest-search" class="form-label">'+escape(t('search'))+'</label><input id="guest-search" class="form-control" type="search" autocomplete="off" maxlength="100" aria-describedby="guest-catalog-status" value="'+escape(input.search||'')+'"><button class="btn btn-primary mt-2" type="submit">'+escape(t('search'))+'</button></form><p id="guest-catalog-status" class="guest-status" role="status" aria-live="polite">'+escape(t('loading'))+'</p><div data-guest-content aria-busy="true"></div></div>';
    CRS.theme.apply(CRS.theme.current(),false);
    const disposeEffect=global.CRSMagicUI?.mountGuest(guestPage);
    translate(guestPage);
    const disposeCatalog=catalogSearch(guestPage.querySelector('form'),guestPage.querySelector('[data-guest-content]'),guestPage.querySelector('.guest-status'),{
      publicView:true,cached,valid:()=>serial===guestSerial&&!guestPage.hidden&&!CRS.auth.hasSession(),
      loadPage:async page=>{const response=await global.CRS_SERVER_RPC('listPublicEquipment',[{...(input.assetId?{assetId:input.assetId}:{}),page}]);if(!response.ok)throw new CRS.ClientApiError(response.error);return response.data;},
      onSearch:value=>guestInput.search=value,onResult:value=>guestResult=value
    });
    guestDispose=()=>{disposeCatalog();disposeEffect?.();};
  }
  function stopDashboard(){dashboardSerial++;dashboardDispose?.();dashboardDispose=null;dashboardPage=null;dashboardResult=null;dashboardSearch='';}
  async function mountDashboard(cached=null,refresh=false){
    const page=document.querySelector('#page-dashboard');
    if(!page||!CRS.auth.hasSession()||CRS.state.bootstrap?.session.mustChangePassword){if(dashboardPage)stopDashboard();return;}
    if(page===dashboardPage&&!cached&&!refresh)return;
    if(page!==dashboardPage)stopDashboard();dashboardPage=page;
    const serial=++dashboardSerial;dashboardDispose?.();dashboardDispose=null;
    let host=page.querySelector('.dashboard-equipment-wall');
    if(!host){host=document.createElement('section');host.className='dashboard-equipment-wall';page.append(host);}
    host.innerHTML='<h2 class="h4">'+escape(CRS.language.effective()==='en'?'All equipment':'อุปกรณ์ทั้งหมด')+'</h2><form class="catalog-search mb-3"><label class="form-label" for="dashboard-equipment-search">'+escape(t('search'))+'</label><input id="dashboard-equipment-search" class="form-control" type="search" autocomplete="off" maxlength="100" aria-describedby="dashboard-catalog-status" value="'+escape(dashboardSearch)+'"><button class="btn btn-primary mt-2" type="submit">'+escape(t('search'))+'</button></form><p id="dashboard-catalog-status" role="status" aria-live="polite">'+escape(t('loading'))+'</p><div data-dashboard-wall aria-busy="true"></div>';
    dashboardDispose=catalogSearch(host.querySelector('form'),host.querySelector('[data-dashboard-wall]'),host.querySelector('[role="status"]'),{
      publicView:false,cached,valid:()=>serial===dashboardSerial&&page.isConnected&&CRS.auth.hasSession(),
      loadPage:pageNumber=>CRS.api.listEquipment({page:pageNumber,pageSize:100}),
      onSearch:value=>dashboardSearch=value,onResult:value=>dashboardResult=value
    });
  }
  function loginTarget(){
    if(CRS.state.bootstrap?.session.mustChangePassword)return {name:'settings',params:{section:'security'}};
    try{const intent=JSON.parse(sessionStorage.getItem(handoffKey)||'null');sessionStorage.removeItem(handoffKey);if(intent&&/^AST-\d{6}$/.test(intent.assetId)&&Number.isFinite(intent.expiresAt)&&intent.expiresAt>Date.now()&&intent.expiresAt<=Date.now()+600000)return {name:'borrow',params:{id:intent.assetId}};}catch{/* Untrusted browser state grants no authority. */}
    return null;
  }
  function decorate(root){
    if(!CRS.state.bootstrap?.session.isAdmin)return;
    root.querySelectorAll('[data-action="edit-admin-user"]').forEach(node=>{
      if(node.parentElement.querySelector('[data-temporary-user]'))return;
      const control=document.createElement('button');control.type='button';control.className='btn btn-sm btn-outline-secondary ms-2';control.dataset.temporaryUser=node.dataset.userId;control.textContent=t('temporary');node.after(control);
      control.onclick=async()=>{
        if(!await CRS.confirm({title:t('temporary'),message:t('temporaryConfirm')}))return;
        control.disabled=true;
        control.dataset.commandId=control.dataset.commandId||crypto.randomUUID();
        try{const result=await security('adminIssueTemporaryPassword',{userId:control.dataset.temporaryUser,commandId:control.dataset.commandId});const success=result.deliveryStatus==='SENT';CRS.toast(success?t('temporarySent'):(CRS.language.effective()==='en'?'Delivery is pending or uncertain. A new issuance needs explicit confirmation.':'สถานะการส่งค้างหรือไม่แน่นอน การออกใหม่ต้องยืนยันอีกครั้ง'),success?'success':'warning');if(['SENT','DENIED','UNCERTAIN'].includes(result.deliveryStatus))delete control.dataset.commandId;if(result.signedOut)await CRS.auth.signOut();}
        catch(error){CRS.toast(error.message,'danger');}finally{control.disabled=false;}
      };
    });
    const toolbar=root.querySelector('#equipment-detail-admin-actions'),asset=root.querySelector('#equipment-detail-asset-id')?.textContent;
    if(!toolbar || !/^AST-\d{6}$/.test(asset||'') || toolbar.dataset.publicBound===asset)return;
    toolbar.dataset.publicBound=asset;
    const control=document.createElement('button');control.type='button';control.dataset.equipmentPublic=asset;control.className='btn btn-outline-secondary';control.disabled=true;control.textContent=t('publish');toolbar.append(control);
    Promise.all([security('adminGetEquipmentVisibility',{assetId:asset}),CRS.api.getEquipmentDetail(asset)]).then(([visibility,detail])=>{
      if(!control.isConnected)return;
      let isPublic=visibility.isPublic;control.disabled=false;control.textContent=t(isPublic?'unpublish':'publish');
      control.onclick=async()=>{
        if(!await CRS.confirm({title:t(isPublic?'unpublish':'publish'),message:t('publication')}))return;
        control.disabled=true;
        try{await security('adminSetEquipmentPublic',{assetId:asset,expectedVersion:detail.row_version,isPublic:!isPublic,commandId:crypto.randomUUID()});isPublic=!isPublic;control.textContent=t(isPublic?'unpublish':'publish');}
        catch(error){CRS.toast(error.message,'danger');}finally{control.disabled=false;}
      };
    }).catch(()=>{control.title='ไม่สามารถตรวจการเผยแพร่ได้ กรุณาโหลดหน้าใหม่';control.disabled=true;});
  }
  function reveal(button,visible){const input=document.getElementById(button.dataset.revealFor);if(input){input.type=visible?'text':'password';button.setAttribute('aria-pressed',String(visible));}}
  document.addEventListener('DOMContentLoaded',()=>{
    const card=document.querySelector('.access-card'),controls=document.createElement('div');controls.className='login-controls';
    controls.innerHTML=actions({guide:false,login:false});controls.append(document.querySelector('#theme-toggle-login'));card.prepend(controls);
    document.querySelector('#access-state').insertAdjacentHTML('afterbegin','<nav class="entry-navigation" aria-label="'+escape(t('equipment'))+'"><button type="button" class="btn btn-outline-secondary" data-experience-action="home"><i class="bi bi-arrow-left me-2" aria-hidden="true"></i><span data-experience-text="equipment">'+escape(t('equipment'))+'</span></button></nav>');
    card.insertAdjacentHTML('beforeend','<div class="login-footer">'+button('privacy','privacy','btn btn-link btn-sm')+button('terms','terms','btn btn-link btn-sm')+'</div>');
    const note=card.querySelector('.login-security-note span');note.dataset.experienceText='securityNote';
    const top=document.querySelector('.topbar-actions');top.querySelector('.theme-toggle').insertAdjacentHTML('beforebegin',notificationButton()+actions());
    fetch('/api/experience',{cache:'no-store'}).then(response=>response.ok?response.json():{}).then(links=>{
      for(const [key,value]of[['privacy',links.privacyUrl],['terms',links.termsUrl]]){
        let url;try{url=new URL(value);}catch{continue;}if(url.protocol!=='https:'||url.username||url.password)continue;
        const old=card.querySelector('[data-experience-action="'+key+'"]'),link=document.createElement('a');link.className=old.className;link.dataset.experienceAction=key;link.dataset.experienceText=key;link.textContent=t(key);link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';old.replaceWith(link);
      }
    }).catch(()=>{/* Keep a visible failure notice when metadata is unavailable. */});
    const form=document.querySelector('#password-login-form'),error=document.querySelector('#password-login-error');
    form.addEventListener('submit',async event=>{event.preventDefault();if(!form.reportValidity())return;const submit=form.querySelector('[type="submit"]');if(submit.disabled)return;submit.disabled=true;error.hidden=true;try{await CRS.auth.passwordSignIn(form.email.value,form.password.value);}catch(problem){error.textContent=problem.message;error.hidden=false;}finally{form.password.value='';submit.disabled=false;translate();}});
    const observer=new MutationObserver(()=>translate());observer.observe(document.querySelector('#access-state-title'),{childList:true});
    const views=new MutationObserver(()=>{decorate(document.querySelector('#view-root'));mountDashboard();});views.observe(document.querySelector('#view-root'),{childList:true,subtree:true});
    if(global.CRSReactBits)global.CRSReactBits.mountDeletes();
    else{
      // Never silently restore click-to-delete when the hold adapter fails.
      document.addEventListener('click',event=>{if(event.target.closest('button[data-action="delete-equipment"],#equipment-delete-form button[data-submit]')){event.preventDefault();event.stopImmediatePropagation();CRS.toast(CRS.language.effective()==='en'?'Delete control unavailable. Reload the page.':'ปุ่มลบไม่พร้อมใช้งาน กรุณาโหลดหน้าใหม่','danger');}},true);
      document.addEventListener('submit',event=>{if(event.target.id==='equipment-delete-form'){event.preventDefault();event.stopImmediatePropagation();}},true);
    }
    translate();cardEffect=global.CRSMagicUI?.mountCard(card)||null;
    global.CRSMagicUI?.mountRipple(document.querySelector('.login-art'));
    global.CRSMagicUI?.mountBlur(document.querySelector('.app-main'));
    global.CRSLoginParallax?.mount(document.querySelector('.login-story'));
    if(!CRS.auth.hasSession())showGuest();
  });
  const maskAll=()=>document.querySelectorAll('[data-reveal-for]').forEach(node=>reveal(node,false));
  document.addEventListener('pointerdown',event=>{const node=event.target.closest('[data-reveal-for]');if(node&&event.isPrimary&&event.button===0){event.preventDefault();maskAll();reveal(node,true);try{node.setPointerCapture(event.pointerId);}catch{maskAll();}}});
  ['pointerup','pointercancel','lostpointercapture'].forEach(type=>document.addEventListener(type,maskAll));
  document.addEventListener('contextmenu',event=>{if(event.target.closest('[data-reveal-for]')){event.preventDefault();maskAll();}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')maskAll();const node=event.target.closest('[data-reveal-for]');if(node&&[' ','Enter'].includes(event.key)){event.preventDefault();if(!event.repeat)reveal(node,true);}});
  document.addEventListener('keyup',maskAll);
  document.addEventListener('focusout',maskAll);
  global.addEventListener('blur',maskAll);
  document.addEventListener('visibilitychange',()=>{if(document.hidden)maskAll();});
  document.addEventListener('click',async event=>{
    const action=event.target.closest('[data-experience-action]');if(!action)return;
    const key=action.dataset.experienceAction;
    if(key==='language')CRS.language.set(CRS.language.effective()==='th'?'en':'th');
    if(key==='login')showLogin();
    if(key==='home'&&!document.querySelector('#google-signin-button').disabled&&!document.querySelector('#password-login-submit').disabled){showGuest();guestPage.querySelector('[data-experience-action="login"]').focus();}
    if(key==='profile-security')CRS.navigate('settings',{section:'security'});
    if(key==='reset-password'){const node=dialog(t('reset'),passwordForm('RESET'));bindPasswordForm(node.querySelector('form'));}
    if((key==='privacy'||key==='terms')&&!action.href)dialog(t(key),'<p>'+escape(t('unavailable'))+'</p>');
    if(key==='guide')dialog(t('guide'),'<p>'+escape(CRS.language.effective()==='en'?'Browse equipment, sign in with an authorized account, then submit a borrow request. Only an administrator can approve and check out equipment. Request a return; the administrator inspects it before completing the return.':'ค้นหาอุปกรณ์ ลงชื่อเข้าใช้ด้วยบัญชีที่ได้รับสิทธิ์ และส่งคำขอยืม ผู้ดูแลระบบจะอนุมัติและจ่ายอุปกรณ์ เมื่อต้องการคืนให้แจ้งคืน แล้วรอผู้ดูแลตรวจรับ')+'</p>');
    if(key==='notifications'){const node=dialog(t('notifications'),'<div data-inbox></div>');renderNotifications(node.querySelector('[data-inbox]'));}
  });
  global.addEventListener('crs:bootstrapped',event=>{entryView='guest';stopGuest();guestResult=null;maskAll();cardEffect?.reset();badge(event.detail.session.unreadNotifications);document.querySelectorAll('.topbar-actions [data-experience-action="login"]').forEach(node=>node.hidden=true);});
  global.addEventListener('crs:authentication-required',()=>{stopDashboard();badge(0);document.querySelectorAll('.topbar-actions [data-experience-action="login"]').forEach(node=>node.hidden=false);if(!CRS.auth.hasSession()){if(entryView==='login')showLogin();else showGuest();}});
  global.addEventListener('crs:rpc-completed',event=>{if(['createBorrowRequest','adminApproveBorrow','adminRejectBorrow','adminCheckoutBorrow','requestReturn','adminCompleteReturn'].includes(event.detail.method))refreshInboxCount();});
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)refreshInboxCount();});
  global.setInterval(refreshInboxCount,60000); // No polling when signed out, restricted or in a hidden tab.
  global.addEventListener('crs:language-changed',()=>{
    if(dashboardPage?.isConnected&&dashboardResult)mountDashboard(dashboardResult);
    translate();if(guestPage&&!guestPage.hidden){
      const languageFocused=document.activeElement===guestPage.querySelector('[data-experience-action="language"]');
      browseGuest(guestInput,guestResult);
      if(languageFocused)guestPage.querySelector('[data-experience-action="language"]').focus({preventScroll:true});
    }
  });
  document.addEventListener('click',event=>{if(event.target.closest('[data-action="refresh-dashboard"]')&&dashboardPage)mountDashboard(null,true);});
  CRS.features=Object.freeze({mountSettings,loginTarget});
})(window);
