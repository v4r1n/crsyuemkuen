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
    const title=section==='security'?t('ความปลอดภัยและการลงชื่อเข้าใช้','Security and login'):section==='account'?t('บัญชี','Account'):t('การแจ้งเตือน','Notifications');
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
          root.insertAdjacentHTML('beforeend',card(heading(title)+'<dl class="settings-account-fields"><dt>'+t('ชื่อ','Name')+'</dt><dd data-profile-name-host>'+escape(data.name)+'</dd><dt>'+t('อีเมล','Email')+'</dt><dd>'+escape(data.email)+'</dd><dt>'+t('หน่วยงาน','Department')+'</dt><dd>'+escape(data.department||t('ไม่ระบุ','Not provided'))+'</dd><dt>'+t('สถานะ','Status')+'</dt><dd>'+escape(role)+'</dd></dl>'));
          global.CRSProfile?.mount(root,{CRS,nameOnly:true});return;
        }
        root.insertAdjacentHTML('beforeend',card(heading(t('วิธีการลงชื่อเข้าใช้','Sign-in methods'))+
          '<p class="settings-signin-email">'+escape(data.email)+'</p><dl class="settings-signin-methods"><dt>Google</dt><dd>'+escape(data.googleAvailable?t('ใช้บัญชี Google ที่ได้รับสิทธิ์','Authorized Google account'):t('ไม่พร้อมใช้งาน','Unavailable'))+'</dd><dt>Local Password</dt><dd>'+escape(data.passwordConfigured?t('ตั้งค่าแล้ว','Configured'):t('ยังไม่ได้ตั้งค่า','Not configured'))+'</dd></dl><label class="settings-remember"><input type="checkbox" data-settings-remember aria-describedby="settings-remember-note"> '+t('จดจำเซสชันบนอุปกรณ์นี้','Remember session on this device')+'</label><p id="settings-remember-note" class="form-text settings-signin-note">'+t('การจดจำไม่ต่ออายุเซสชัน หากต้องการเปลี่ยนอีเมล กรุณาติดต่อผู้ดูแลระบบ','Remembering does not extend session expiry. Contact an administrator to change your email.')+'</p>')+
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
        const labels={BORROW_REQUEST:t('คำขอยืม','Borrow request'),APPROVE:t('อนุมัติ','Approved'),REJECT:t('ไม่อนุมัติ','Rejected'),CHECKOUT:t('จ่ายอุปกรณ์','Checkout'),REQUEST_RETURN:t('คำขอคืน','Return request'),RETURN:t('ตรวจรับคืน','Returned'),ADMIN_BORROW_REQUEST:t('คำขอยืมใหม่','New borrow request'),ADMIN_REQUEST_RETURN:t('คำขอคืนใหม่','New return request'),DUE_SOON:t('ครบกำหนดคืนพรุ่งนี้','Due tomorrow'),OVERDUE:t('เกินกำหนดคืน','Overdue')};
        const availability=document.createElement('p');availability.className='settings-push-availability';availability.dataset.pushAvailability='';
        availability.textContent=!data.channels.push&&!data.channels.email?t('การส่งภายนอกยังปิดอยู่ หากหน้าต่างทดสอบหมดอายุ กรุณาติดต่อผู้ดูแลระบบ','External delivery is disabled. Contact an administrator if the test window has expired.'):!global.CRSPush?.supported()?t('เบราว์เซอร์นี้ไม่รองรับ Push; บน iOS ต้องใช้เว็บแอปที่เพิ่มบนหน้าจอโฮม','Push is unsupported here; on iOS use the web app added to the Home Screen.'):global.Notification?.permission==='denied'?t('Push ถูกบล็อก กรุณาอนุญาตในการตั้งค่าเว็บไซต์ของเบราว์เซอร์','Push is blocked. Allow notifications in your browser’s site settings.'):t('เลือก Push เพื่ออนุญาตแจ้งเตือนบนอุปกรณ์นี้','Choose Push to allow notifications on this device.');
        if(data.pushTestAvailable) {
          const panel=document.createElement('section');panel.className='settings-card';panel.dataset.pushTest='';
          panel.innerHTML=heading(t('ทดสอบ Push เฉพาะบัญชีนี้','Account-only Push test'))+'<p>'+t('ยังไม่เปิดส่งทั่วระบบ กดอนุญาตบนอุปกรณ์นี้แล้วส่งทดสอบหนึ่งครั้ง ผลรับจาก provider ยังไม่ยืนยันว่าอุปกรณ์แสดงข้อความ','Global delivery is disabled. Grant permission on this device, then send one test. Provider acceptance does not confirm device display.')+'</p>';
          const register=document.createElement('button'),send=document.createElement('button'),result=document.createElement('p');
          register.type=send.type='button';register.className=send.className='btn btn-outline-primary me-2 mb-2';
          register.textContent=t('ลงทะเบียนอุปกรณ์ทดสอบ','Register test device');send.textContent=t('ส่ง Push ทดสอบ','Send test Push');
          register.dataset.pushTestRegister='';send.dataset.pushTestSend='';result.setAttribute('role','status');result.setAttribute('aria-live','polite');
          register.disabled=!global.CRSPush?.supported();send.disabled=!data.pushRegistered;
          if(register.disabled)result.textContent=t('เบราว์เซอร์นี้ไม่รองรับ Push; บน iOS ต้องเพิ่มเว็บแอปบนหน้าจอโฮมก่อน','Push is unsupported here; on iOS add the web app to the Home Screen first.');
          register.onclick=async()=>{
            register.disabled=send.disabled=true;
            try{if(await global.CRSPush.enable(data.pushPublicKey,request,valid)){if(!valid())return;data.pushRegistered=true;send.disabled=false;result.textContent=t('ลงทะเบียนแล้ว กดส่งทดสอบได้','Registered. You may send a test.');}}
            catch(error){if(valid())result.textContent=error.message;}
            finally{if(valid()){register.disabled=!global.CRSPush?.supported();send.disabled=!data.pushRegistered;}}
          };
          send.onclick=async()=>{
            send.disabled=register.disabled=true;
            try{const response=await request('sendTestPush',{});if(!valid())return;result.textContent=response.status==='ACCEPTED'?t('Provider รับแล้ว กรุณายืนยันว่าเห็นแจ้งเตือนใน Windows / Edge','Provider accepted. Please confirm the notification appeared in Windows / Edge.'):t('ยังยืนยันการส่งไม่ได้ จะไม่ส่งซ้ำอัตโนมัติ','Delivery is unconfirmed. No automatic resend.');}
            catch(error){if(valid())result.textContent=error.message;}
            // No retry button after an uncertain request; the server also rate limits.
          };
          panel.append(register,send,result);root.append(panel);
        }
        for(const group of ['activity','admin','reminders']) {
          const items=data.items.filter(item=>(['DUE_SOON','OVERDUE'].includes(item.event)?'reminders':item.event.startsWith('ADMIN_')?'admin':'activity')===group);if(!items.length)continue;
          const panel=document.createElement('section');panel.className='settings-card';panel.innerHTML=heading(group==='admin'?t('การแจ้งเตือนผู้ดูแล','Admin notifications'):group==='reminders'?t('การเตือนกำหนดคืน','Due date reminders'):t('กิจกรรมยืม–คืน','Borrowing activity'));root.append(panel);
          if(group==='reminders'){const note=document.createElement('p');note.textContent=data.dueRemindersAvailable?t('เตือนก่อนครบกำหนด 1 วัน และเกินกำหนดวันละครั้ง ตามเวลาไทย จนผู้ดูแลตรวจรับคืน','One day before the due date, then once daily when overdue (Thailand time), until the return is inspected.'):t('การเตือนกำหนดคืนยังไม่เปิดใช้งาน','Due date reminders are not enabled.');panel.append(note);}
          for(const item of items) {
            const row=document.createElement('div');row.className='settings-preference-row';
            const label=document.createElement('span');label.textContent=labels[item.event];row.append(label);
            const controls=document.createElement('div');controls.className='settings-delivery-controls';
            const inApp=document.createElement('label');inApp.className='settings-in-app';
            inApp.innerHTML='<input type="checkbox" data-in-app> '+t('ในระบบ','In-app');controls.append(inApp);
            const checkbox=inApp.querySelector('input');checkbox.setAttribute('aria-label',label.textContent+' · '+t('ในระบบ','In-app'));
            const details=document.createElement('details');details.className='settings-channel-picker';
            details.innerHTML='<summary aria-haspopup="menu"></summary><div role="menu" class="settings-channel-menu"></div>';
            const summary=details.querySelector('summary'),menu=details.querySelector('[role="menu"]');
            menu.id='settings-channel-menu-'+item.event;summary.setAttribute('aria-controls',menu.id);
            summary.setAttribute('aria-label',label.textContent+' · '+t('ช่องทางภายนอก','External channel'));
            menu.setAttribute('aria-label',summary.getAttribute('aria-label'));
            if(typeof menu.showPopover==='function')menu.setAttribute('popover','manual');
            const options=['PUSH','EMAIL'].map(channel=>{
              const option=document.createElement('button');option.type='button';option.dataset.channel=channel;
              option.setAttribute('role','menuitemradio');
              const name=document.createElement('span');name.textContent=channel==='PUSH'?t('พุช','Push'):t('อีเมล','Email');
              const check=document.createElement('i');check.className='bi bi-check-lg';check.setAttribute('aria-hidden','true');option.append(name,check);menu.append(option);return option;
            });
            const clear=document.createElement('button');clear.type='button';clear.className='btn btn-outline-secondary';
            clear.textContent=t('ปิดการส่งภายนอก','Turn off external delivery');clear.dataset.deliveryOff='';
            const close=()=>{if(menu.hasAttribute('popover')&&menu.matches(':popover-open'))menu.hidePopover();details.open=false;summary.setAttribute('aria-expanded','false');};
            const position=()=>{
              if(!details.open || !menu.hasAttribute('popover'))return;
              const box=summary.getBoundingClientRect(),height=menu.getBoundingClientRect().height;
              menu.style.left=Math.max(8,Math.min(box.right-200,innerWidth-208))+'px';
              menu.style.top=Math.max(8,box.bottom+height+8>innerHeight?box.top-height-4:box.bottom+4)+'px';
            };
            let busy=false;
            const sync=()=>{
              if(!busy)checkbox.checked=item.inApp;checkbox.disabled=busy;
              summary.setAttribute('aria-expanded',String(details.open));
              summary.textContent=(item.channel==='PUSH'?t('พุช','Push'):item.channel==='EMAIL'?t('อีเมล','Email'):t('เลือกช่องทาง','Choose channel'))+' ▾';
              clear.hidden=!item.channel;clear.disabled=busy;
              for(const option of options){
                option.setAttribute('aria-checked',String(item.channel===option.dataset.channel));
                option.disabled=busy || (option.dataset.channel==='PUSH'?(!data.channels.push || !global.CRSPush?.supported()):!data.channels.email);
                option.title=option.disabled&&!busy?t('ยังไม่พร้อมใช้งาน','Unavailable'):'';
              }
            };sync();
            async function save(update){
              if(busy)return;busy=true;sync();status.textContent=t('กำลังบันทึก…','Saving…');
              try {
                if(update.channel==='PUSH') {
                  if(!await global.CRSPush.enable(data.pushPublicKey,request,valid))return;
                  data.pushRegistered=true;
                }
                if(!valid())return;
                const saved=await request('saveNotificationPreference',{event:item.event,...update,expectedVersion:item.version});
                if(!valid())return;Object.assign(item,saved.items.find(value=>value.event===item.event));
                await inbox.refreshCount();if(valid())status.textContent=t('บันทึกแล้ว','Saved');
              }
              catch(error){
                if(!valid())return;status.textContent=error.message;
                if(error.code==='STATE_CONFLICT') {
                  try {const fresh=await request('getNotificationPreferences');if(!valid())return;const current=fresh.items.find(value=>value.event===item.event);if(current)Object.assign(item,current);}
                  catch{/* Keep the failure visible; no unguarded or optimistic write. */}
                }
              }
              finally{if(valid()){busy=false;sync();}}
            }
            checkbox.onchange=()=>save({inApp:checkbox.checked});clear.onclick=()=>save({channel:null});
            for(const option of options)option.onclick=()=>{close();summary.focus();if(item.channel!==option.dataset.channel || option.dataset.channel==='PUSH'&&!data.pushRegistered)save({channel:option.dataset.channel});};
            details.ontoggle=()=>{
              summary.setAttribute('aria-expanded',String(details.open));
              if(details.open){
                root.querySelectorAll('.settings-channel-picker[open]').forEach(node=>{if(node!==details)node.open=false;});
                if(menu.hasAttribute('popover')){if(!menu.matches(':popover-open'))menu.showPopover();position();}
              }else if(menu.hasAttribute('popover')&&menu.matches(':popover-open'))menu.hidePopover();
            };
            details.onkeydown=event=>{
              if(event.key==='Escape'){event.stopPropagation();event.preventDefault();close();summary.focus();}
              if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
                event.preventDefault();details.open=true;
                // The native details toggle event is queued. Open the top
                // layer now so arrow-key focus cannot race that later event.
                if(menu.hasAttribute('popover')&&!menu.matches(':popover-open')){menu.showPopover();position();}
                const enabled=options.filter(option=>!option.disabled),index=enabled.indexOf(document.activeElement);
                const next=event.key==='Home'?0:event.key==='End'?enabled.length-1:index<0?(event.key==='ArrowUp'?enabled.length-1:0):(index+(event.key==='ArrowUp'?-1:1)+enabled.length)%enabled.length;
                requestAnimationFrame(()=>{if(valid()&&details.open)enabled[next]?.focus();});
              }
            };
            // Browser scroll/resize must not strand a top-layer menu.
            details._close=close;details._position=position;
            controls.append(details,clear);row.append(controls);panel.append(row);
          }
        }
        const recent=document.createElement('section');recent.className='settings-card';recent.innerHTML=heading(t('การแจ้งเตือนล่าสุด','Recent notifications'))+action(t('อ่านทั้งหมดแล้ว','Mark all as read'),'data-settings-read-all')+'<div class="notification-list mt-3" data-settings-inbox></div>';root.append(recent);inbox.mount(recent.querySelector('[data-settings-inbox]'));
        root.querySelector('.settings-card').append(availability);
        const mark=recent.querySelector('[data-settings-read-all]');mark.disabled=typeof inbox.markAllRead!=='function';mark.onclick=async()=>{mark.disabled=true;try{await inbox.markAllRead();}catch(error){if(valid())status.textContent=error.message;}finally{if(valid())mark.disabled=false;}};
        const controller=new AbortController(),closeOutside=event=>root.querySelectorAll('.settings-channel-picker[open]').forEach(node=>{if(!node.contains(event.target))node._close();});
        document.addEventListener('pointerdown',closeOutside,{signal:controller.signal});
        document.addEventListener('focusin',closeOutside,{signal:controller.signal});
        for(const name of ['resize','scroll'])global.addEventListener(name,()=>root.querySelectorAll('.settings-channel-picker[open]').forEach(node=>node._position()),{capture:true,passive:true,signal:controller.signal});
        const previousCleanup=CRS.state.routeCleanup;
        CRS.setRouteCleanup(async()=>{controller.abort();root.querySelectorAll('.settings-channel-picker').forEach(node=>node._close());if(previousCleanup)await previousCleanup();});
      }catch(error){showError(error,notifications);}
    }
    if(section==='notifications')notifications();
    else if(section==='security'&&params.subview==='sessions')sessions();
    else if(section==='security'&&params.subview==='activity')activity();
    else overview();
  }
  global.CRSSettingsSecurity=Object.freeze({mount});
})(window);
