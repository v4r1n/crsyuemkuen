(function(global){
  'use strict';
  // The DOM adapter owns presentation only. All owners/roles/counts come from
  // guarded RPCs; no browser-authored event or private database access.
  function mount(section,host,params,{CRS,passwordForm,bindPasswordForm,inbox}) {
    const escape=CRS.escapeHtml,view=CRS.state.viewToken;
    const valid=()=>host.isConnected && view===CRS.state.viewToken && CRS.auth.hasSession();
    const en=()=>CRS.language.effective()==='en';
    const t=(th,english)=>en()?english:th;
    const request=(method,input)=>CRS.auth.requestSecurity(method,input);
    const title=section==='security'?t('ความปลอดภัยและการเข้าสู่ระบบ','Security and login'):section==='account'?t('บัญชี','Account'):t('การแจ้งเตือน','Notifications');
    const card=html=>'<section class="settings-card settings-security-card">'+html+'</section>';
    const heading=value=>'<h3 class="h5">'+escape(value)+'</h3>';
    const action=(label,attribute='',style='btn-outline-secondary')=>'<button type="button" class="btn '+style+'" '+attribute+'>'+escape(label)+'</button>';
    const back=()=>action(t('← ย้อนกลับ','← Back'),'data-security-back');
    host.querySelector('.settings-placeholder')?.remove();
    host.querySelectorAll('.settings-card').forEach(node=>node.remove());
    const root=document.createElement('div');root.className='settings-security-root';host.append(root);
    const status=document.createElement('p');status.role='status';status.setAttribute('aria-live','polite');root.append(status);
    function showError(error,retry) {
      if(!valid())return;
      status.textContent=error.message || t('โหลดไม่สำเร็จ','Unable to load');
      const node=document.createElement('button');node.type='button';node.className='btn btn-outline-secondary';node.textContent=t('ลองอีกครั้ง','Try again');node.onclick=()=>{node.remove();retry();};root.append(node);
    }
    function passwordBlock() {
      const node=document.createElement('section');node.className='settings-card';node.innerHTML=heading(t('เปลี่ยนรหัสผ่าน','Change password'))+passwordForm('CHANGE');root.append(node);bindPasswordForm(node.querySelector('form'));
    }
    if(CRS.state.bootstrap?.session.mustChangePassword) {passwordBlock();return;}
    function bindBack() {root.querySelector('[data-security-back]').onclick=()=>CRS.navigate('settings',{section:'security'});}
    function remember() {
      const control=root.querySelector('[data-settings-remember]');if(!control)return;
      control.checked=CRS.auth.rememberSession();
      control.onchange=()=>{try{CRS.auth.setRememberSession(control.checked);status.textContent=t('บันทึกแล้ว อายุเซสชันไม่เปลี่ยน','Saved. Session expiry is unchanged.');}catch(error){control.checked=CRS.auth.rememberSession();status.textContent=error.message;}};
    }
    async function overview() {
      status.textContent=t('กำลังโหลด…','Loading…');
      try {
        const data=await request('getSettingsSecurity');if(!valid())return;
        status.textContent='';
        const role=data.role==='ADMIN'?t('ผู้ดูแลระบบ','Administrator'):t('ผู้ใช้งาน','User');
        if(section==='account') {
          root.insertAdjacentHTML('beforeend',card(heading(title)+'<dl class="settings-account-fields"><dt>'+t('ชื่อ','Name')+'</dt><dd>'+escape(data.name)+'</dd><dt>'+t('อีเมล (อ่านอย่างเดียว)','Email (read-only)')+'</dt><dd>'+escape(data.email)+'</dd><dt>'+t('หน่วยงาน','Department')+'</dt><dd>'+escape(data.department||t('ไม่ระบุ','Not provided'))+'</dd><dt>'+t('สถานะ','Status')+'</dt><dd>'+escape(role)+'</dd></dl>'));return;
        }
        root.insertAdjacentHTML('beforeend',card(heading(t('วิธีการลงชื่อเข้าใช้','Sign-in methods'))+
          '<p>'+escape(data.email)+'</p><p>Google · '+escape(data.googleAvailable?t('ใช้บัญชี Google ที่ได้รับสิทธิ์','Authorized Google account'):t('ไม่พร้อมใช้งาน','Unavailable'))+'</p><p>Local Password · '+escape(data.passwordConfigured?t('ตั้งค่าแล้ว','Configured'):t('ยังไม่ได้ตั้งค่า','Not configured'))+'</p><label class="settings-remember"><input type="checkbox" data-settings-remember> '+t('จดจำเซสชันบนอุปกรณ์นี้','Remember session on this device')+'</label><p class="form-text">'+t('ไม่ต่ออายุเซสชัน อีเมลเปลี่ยนได้ผ่านผู้ดูแลระบบเท่านั้น','Does not extend expiry. Only an administrator can change your email.')+'</p>')+
          card(heading(t('เซสชัน','Sessions'))+action(t('เซสชันที่ใช้งานอยู่','Active sessions')+' · '+data.activeSessionCount+' ›','data-security-sessions')+'<p>'+t('ตรวจสอบอุปกรณ์และเซสชันที่เข้าสู่ระบบอยู่','Review your signed-in sessions and devices')+'</p>'+action(t('ประวัติความปลอดภัย','Security activity')+' ›','data-security-activity')));
        root.querySelector('[data-security-sessions]').onclick=()=>CRS.navigate('settings',{section:'security',subview:'sessions'});
        root.querySelector('[data-security-activity]').onclick=()=>CRS.navigate('settings',{section:'security',subview:'activity'});
        remember();passwordBlock();
      }catch(error){showError(error,overview);}
    }
    async function sessions() {
      status.textContent=t('กำลังโหลด…','Loading…');
      try {
        const data=await request('listActiveSessions');if(!valid())return;
        root.querySelectorAll('section').forEach(node=>node.remove());status.textContent='';
        const panel=document.createElement('section');panel.className='settings-card';panel.innerHTML=back()+heading(t('เซสชันที่ใช้งานอยู่','Active sessions'))+'<p>'+t('ข้อมูลอุปกรณ์เป็นข้อมูลประกอบ ไม่ใช่หลักฐานยืนยันตัวตน','Device labels are informational, not identity verification.')+'</p>';root.append(panel);bindBack();
        for(const item of data.items) {
          const node=document.createElement('div');node.className='settings-session-row';
          const label=document.createElement('div');label.innerHTML='<strong></strong><p></p>';
          label.querySelector('strong').textContent=item.browser||t('ไม่ทราบเบราว์เซอร์','Unknown browser');
          label.querySelector('p').textContent=(item.os||t('ไม่ทราบอุปกรณ์','Unknown device'))+' · '+(item.lastActiveAt?t('ใช้งานล่าสุด ','Last active ')+CRS.formatDateTime(item.lastActiveAt):t('ไม่มีข้อมูลการใช้งานล่าสุด','Last activity unknown'));
          node.append(label);
          if(item.createdAt) {const stamp=document.createElement('small');stamp.textContent=t('สร้างเมื่อ ','Created ')+CRS.formatDateTime(item.createdAt);label.append(stamp);}
          if(item.current) {const badge=document.createElement('span');badge.className='badge bg-primary';badge.textContent=t('เซสชันปัจจุบัน','Current session');node.append(badge);}
          else {const button=document.createElement('button');button.type='button';button.className='btn btn-outline-danger';button.textContent=t('ลงชื่อออก','Sign out');button.onclick=()=>revoke(button,{publicId:item.publicId});node.append(button);}
          panel.append(node);
        }
        if(!data.items.length) {const empty=document.createElement('p');empty.textContent=t('ไม่มีเซสชันที่ใช้งานอยู่','No active sessions');panel.append(empty);}
        panel.insertAdjacentHTML('beforeend',action(t('ลงชื่อออกจากอุปกรณ์อื่นทั้งหมด','Sign out of all other devices'),'data-security-revoke-all','btn-outline-danger'));
        const all=panel.querySelector('[data-security-revoke-all]');all.disabled=!data.items.some(item=>!item.current);all.onclick=()=>revoke(all,{allOthers:true});
      }catch(error){showError(error,sessions);}
    }
    async function revoke(button,input) {
      if(button.disabled||!valid())return;
      button.disabled=true;
      const confirmed=await CRS.confirm({title:t('ยืนยันลงชื่อออก','Confirm sign-out'),message:t('เพิกถอนเซสชันที่เลือก โดยคงเซสชันปัจจุบันไว้?','Revoke selected sessions while keeping this session?'),confirmText:t('ลงชื่อออก','Sign out')});
      if(!valid())return;
      if(!confirmed){button.disabled=false;return;}
      // Keep the command on this action until a definitive response; a lost
      // response must not turn retry into a new revoke-all command.
      const commandId=button.dataset.revokeCommand || crypto.randomUUID();
      button.dataset.revokeCommand=commandId;root.setAttribute('aria-busy','true');
      try {const result=await request('revokeOtherSessions',{...input,commandId});if(!valid())return;delete button.dataset.revokeCommand;await sessions();status.textContent=result.alreadyRevoked?t('เซสชันนี้ออกจากระบบแล้ว','Session was already signed out'):t('ลงชื่อออกแล้ว','Signed out');}
      catch(error){if(valid()){status.textContent=error.message;button.disabled=false;}}
      finally{if(valid())root.setAttribute('aria-busy','false');}
    }
    async function activity() {
      status.textContent=t('กำลังโหลด…','Loading…');
      try {
        const data=await request('listSecurityActivity');if(!valid())return;status.textContent='';
        const panel=document.createElement('section');panel.className='settings-card';panel.innerHTML=back()+heading(t('ประวัติความปลอดภัย','Security activity'));root.append(panel);bindBack();
        const labels={LOGIN_GOOGLE:t('เข้าสู่ระบบด้วย Google','Google sign-in'),LOGIN_PASSWORD:t('เข้าสู่ระบบด้วยรหัสผ่าน','Password sign-in'),LOGOUT:t('ลงชื่อออก','Signed out'),REVOKE_SESSION:t('เพิกถอนเซสชัน','Session revoked'),REVOKE_OTHER_SESSIONS:t('เพิกถอนเซสชันอื่น','Other sessions revoked'),CHANGE_PASSWORD:t('เปลี่ยน/รีเซ็ตรหัสผ่าน','Password changed/reset'),ISSUE_TEMPORARY_PASSWORD:t('ออกรหัสผ่านชั่วคราว','Temporary password issued')};
        for(const item of data.items) {const node=document.createElement('p');node.textContent=(item.outcome==='NO_OP'?t('ตรวจสอบการเพิกถอน · ออกจากระบบแล้ว','Revocation checked · already signed out'):(labels[item.action]||t('กิจกรรมความปลอดภัย','Security activity')))+' · '+CRS.formatDateTime(item.timestamp);panel.append(node);}
        if(!data.items.length)panel.insertAdjacentHTML('beforeend','<p>'+t('ยังไม่มีประวัติ','No activity yet')+'</p>');
      }catch(error){showError(error,activity);}
    }
    async function notifications() {
      status.textContent=t('กำลังโหลด…','Loading…');
      try {
        const data=await request('getNotificationPreferences');if(!valid())return;status.textContent='';
        const labels={BORROW_REQUEST:t('คำขอยืม','Borrow request'),APPROVE:t('อนุมัติ','Approved'),REJECT:t('ไม่อนุมัติ','Rejected'),CHECKOUT:t('จ่ายอุปกรณ์','Checkout'),REQUEST_RETURN:t('คำขอคืน','Return request'),RETURN:t('ตรวจรับคืน','Returned'),ADMIN_BORROW_REQUEST:t('คำขอยืมใหม่','New borrow request'),ADMIN_REQUEST_RETURN:t('คำขอคืนใหม่','New return request')};
        const general=document.createElement('section');general.className='settings-card';general.innerHTML=heading(t('ทั่วไป','General'))+'<p>'+t('ตั้งค่าช่องทางแสดงผล ไม่เปลี่ยนรายการยืมหรือ History','Delivery preferences never change borrowing or History.')+'</p><p>🔒 '+t('อีเมลด้านความปลอดภัย · บังคับส่ง ปิดไม่ได้','Security email · mandatory; cannot be disabled')+'</p>';root.append(general);
        for(const admin of [false,true]) {
          const items=data.items.filter(item=>item.event.startsWith('ADMIN_')===admin);if(!items.length)continue;
          const panel=document.createElement('section');panel.className='settings-card';panel.innerHTML=heading(admin?t('การแจ้งเตือนผู้ดูแล','Admin notifications'):t('กิจกรรมยืม–คืน','Borrowing activity'));root.append(panel);
          for(const item of items) {
            const row=document.createElement('div');row.className='settings-preference-row';
            const label=document.createElement('span');label.textContent=labels[item.event];row.append(label);
            const details=document.createElement('details');details.className='settings-channel-picker';details.innerHTML='<summary></summary><div><label><input type="checkbox" data-in-app> '+t('ในระบบ','In-app')+'</label><label><input type="checkbox" disabled> '+t('พุช · ยังไม่พร้อม','Push · unavailable')+'</label><label><input type="checkbox" disabled> '+t('อีเมล · ยังไม่พร้อม','Email · unavailable')+'</label></div>';
            const summary=details.querySelector('summary'),checkbox=details.querySelector('[data-in-app]');
            const sync=()=>{checkbox.checked=item.inApp;summary.textContent=(item.inApp?t('ในระบบ','In-app'):t('ปิด','Off'))+' ▾';};sync();summary.setAttribute('aria-label',label.textContent);
            checkbox.onchange=async()=>{
              checkbox.disabled=true;
              try {const saved=await request('saveNotificationPreference',{event:item.event,inApp:checkbox.checked,expectedVersion:item.version});if(!valid())return;Object.assign(item,saved.items.find(value=>value.event===item.event));await inbox.refreshCount();status.textContent=t('บันทึกแล้ว','Saved');}
              catch(error){
                if(!valid())return;status.textContent=error.message;
                if(error.code==='STATE_CONFLICT') {
                  try {const fresh=await request('getNotificationPreferences');if(!valid())return;const current=fresh.items.find(value=>value.event===item.event);if(current)Object.assign(item,current);}
                  catch{/* Keep the failure visible; no unguarded or optimistic write. */}
                }
              }
              finally{if(valid()){sync();checkbox.disabled=false;}}
            };
            details.onkeydown=event=>{if(event.key==='Escape'){event.stopPropagation();details.open=false;summary.focus();}};
            row.append(details);panel.append(row);
          }
        }
        root.insertAdjacentHTML('beforeend',card(heading(t('การเตือนกำหนดคืน','Due date reminders'))+'<p>'+t('ใกล้ครบกำหนด / เกินกำหนด · ยังไม่มี scheduler จึงยังไม่เปิดใช้','Due soon / overdue · scheduler not installed; unavailable')+'</p>')+card(heading(t('สถานะ Email / Push','Email / Push status'))+'<p>'+t('อีเมลธุรกิจและ Web Push ยังไม่พร้อมใช้งาน อีเมล OTP และความปลอดภัยใช้ระบบเดิม','Business email and Web Push are unavailable. OTP/security email retains the existing delivery system.')+'</p>'));
        const recent=document.createElement('section');recent.className='settings-card';recent.innerHTML=heading(t('การแจ้งเตือนล่าสุด','Recent notifications'))+action(t('อ่านทั้งหมดแล้ว','Mark all as read'),'data-settings-read-all')+'<div class="notification-list mt-3" data-settings-inbox></div>';root.append(recent);inbox.mount(recent.querySelector('[data-settings-inbox]'));
        const mark=recent.querySelector('[data-settings-read-all]');mark.disabled=typeof inbox.markAllRead!=='function';mark.onclick=async()=>{mark.disabled=true;try{await inbox.markAllRead();}catch(error){if(valid())status.textContent=error.message;}finally{if(valid())mark.disabled=false;}};
        const controller=new AbortController();document.addEventListener('pointerdown',event=>{root.querySelectorAll('details[open]').forEach(node=>{if(!node.contains(event.target))node.open=false;});},{signal:controller.signal});
        const previousCleanup=CRS.state.routeCleanup;
        CRS.setRouteCleanup(async()=>{controller.abort();if(previousCleanup)await previousCleanup();});
      }catch(error){showError(error,notifications);}
    }
    if(section==='notifications')notifications();
    else if(section==='security'&&params.subview==='sessions')sessions();
    else if(section==='security'&&params.subview==='activity')activity();
    else overview();
  }
  global.CRSSettingsSecurity=Object.freeze({mount});
})(window);
