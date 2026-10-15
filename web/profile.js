(function(global){
  'use strict';
  function mount(host,{CRS,nameOnly=false}) {
    const view=CRS.state.viewToken,session=CRS.state.bootstrap.session;
    const valid=()=>!disposed&&host.isConnected&&view===CRS.state.viewToken&&CRS.auth.hasSession();
    const en=()=>CRS.language.effective()==='en',t=(th,english)=>en()?english:th;
    const request=(method,input)=>CRS.auth.requestSecurity(method,input);
    const target=nameOnly?host.querySelector('[data-profile-name-host]'):host.querySelector('#account-heading');
    if(!target)return;
    const editor=document.createElement('form');editor.className='profile-name-editor';
    const label=document.createElement('label');label.textContent=t('ชื่อที่แสดง','Name');
    const field=document.createElement('input');field.type='text';field.name='name';field.autocomplete='off';field.spellcheck=false;field.className='profile-name-input';field.readOnly=true;
    field.maxLength=64;field.setAttribute('aria-label',label.textContent);field.value=session.name||'';
    const save=document.createElement('button');save.type='submit';save.className='btn btn-outline-secondary';save.textContent=t('บันทึก','Save');save.disabled=true;
    const status=document.createElement('p');status.className='profile-save-status';status.role='status';status.setAttribute('aria-live','polite');status.id='profile-save-'+view;field.setAttribute('aria-describedby',status.id);
    label.append(field);editor.append(label,save,status);
    if(nameOnly)target.replaceChildren(editor);
    else {target.parentElement.classList.add('profile-account-copy');target.textContent=t('โปรไฟล์','Profile');target.after(editor);}
    let data=null,timer=null,pending=null,busy=false,composing=false,disposed=false,objectUrl=null,avatarCommand=null;
    let avatar=null,file=null;
    function message(value){if(valid())status.textContent=value;}
    function syncName(result) {
      session.name=result.name;
      document.querySelectorAll('[data-session-name]').forEach(node=>node.textContent=result.name);
      document.querySelectorAll('[data-session-initial]').forEach(node=>node.textContent=(result.name||session.email).slice(0,1).toUpperCase());
      const content=avatar?.querySelector('[data-avatar-content]');if(content&&!content.querySelector('img'))content.textContent=(result.name||session.email).slice(0,1).toUpperCase();
    }
    function pulse(){if(!avatar)return;avatar.classList.remove('is-profile-saved');void avatar.offsetWidth;avatar.classList.add('is-profile-saved');}
    async function loadAvatar() {
      if(!avatar || !valid())return;
      try {
        const result=await request('getOwnAvatar');if(!valid()||!result.signedUrl)return;
        const url=new URL(result.signedUrl);
        if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||!url.pathname.includes('/storage/v1/object/sign/'))throw new Error('Invalid avatar capability');
        const response=await fetch(url,{cache:'no-store',referrerPolicy:'no-referrer'});
        if(!response.ok)throw new Error('Unable to load avatar');
        const blob=await response.blob();
        if(!valid() || blob.type!==result.mimeType || blob.size!==result.byteLength || blob.size>1048576)return;
        const next=URL.createObjectURL(blob),image=document.createElement('img');image.alt='';image.src=next;
        avatar.querySelector('[data-avatar-content]').replaceChildren(image);if(objectUrl)URL.revokeObjectURL(objectUrl);objectUrl=next;
      }catch{message(t('โหลดรูปไม่สำเร็จ รูปเดิมยังถูกเก็บไว้','Unable to load avatar. Your saved image is retained.'));}
    }
    async function load() {
      try{const result=await request('getOwnProfile');if(!valid())return;data=result;field.value=result.name;field.readOnly=false;save.disabled=false;save.textContent=t('บันทึก','Save');if(avatar)avatar.disabled=false;syncName(result);await loadAvatar();}
      catch(error){message(error.message||t('โหลดโปรไฟล์ไม่สำเร็จ','Unable to load profile'));if(valid()){save.disabled=false;save.textContent=t('ลองอีกครั้ง','Try again');}}
    }
    async function flush() {
      clearTimeout(timer);if(!valid()||!data||busy||composing)return;
      const name=field.value.trim().replace(/\s+/g,' ');
      if(!pending && name===data.name)return;
      if(!pending && (!name||name.length>64)) {field.setAttribute('aria-invalid','true');message(t('ชื่อต้องมี 1–64 ตัวอักษร','Name must contain 1–64 characters'));return;}
      field.setAttribute('aria-invalid','false');pending=pending||{commandId:crypto.randomUUID(),name,expectedVersion:data.nameVersion};
      const sent=pending;let failed=false;busy=true;save.disabled=true;message(t('กำลังบันทึก…','Saving…'));
      try {
        const result=await request('saveOwnName',sent);
        if(CRS.state.bootstrap?.session===session&&CRS.auth.hasSession())syncName(result);
        if(!valid())return;
        data=result;pending=null;if(field.value.trim().replace(/\s+/g,' ')===sent.name)field.value=result.name;
        message(t('บันทึกแล้ว','Saved'));
      }catch(error){failed=true;if(valid()){
        message(error.message||t('บันทึกไม่สำเร็จ กดบันทึกเพื่อลองอีกครั้ง','Unable to save. Press Save to retry.'));
        if(error.code==='STATE_CONFLICT'){pending=null;data=null;field.readOnly=true;await load();message(t('ข้อมูลเปลี่ยนจากที่อื่น โปรดแก้ไขอีกครั้ง','Profile changed elsewhere. Please edit again.'));}
        else if(error.code&&error.code!=='TRANSPORT_ERROR')pending=null;
      }}finally{busy=false;if(valid())save.disabled=!data;}
      // Serialize edits typed while a previous request was in flight.
      if(!failed&&valid()&&data&&!pending&&field.value.trim().replace(/\s+/g,' ')!==data.name)timer=setTimeout(flush,800);
    }
    field.addEventListener('input',()=>{clearTimeout(timer);if(!composing)timer=setTimeout(flush,800);});
    field.addEventListener('compositionstart',()=>{composing=true;clearTimeout(timer);});
    field.addEventListener('compositionend',()=>{composing=false;timer=setTimeout(flush,800);});
    field.addEventListener('blur',flush);
    field.addEventListener('keydown',event=>{if(event.key==='Escape'&&!busy&&!pending&&data){clearTimeout(timer);field.value=data.name;message('');field.setAttribute('aria-invalid','false');}});
    editor.addEventListener('submit',event=>{event.preventDefault();if(!data)load();else flush();});
    if(!nameOnly) {
      const original=host.querySelector('.avatar.avatar-lg');
      if(original){
        avatar=document.createElement('button');avatar.type='button';avatar.disabled=true;avatar.className='avatar avatar-lg profile-avatar';avatar.setAttribute('aria-label',t('เปลี่ยนรูปโปรไฟล์','Change profile photo'));
        const content=document.createElement('span');content.dataset.avatarContent='';content.textContent=original.textContent;
        const pencil=document.createElement('i');pencil.className='bi bi-pencil profile-avatar-edit';pencil.setAttribute('aria-hidden','true');avatar.append(content,pencil);
        file=document.createElement('input');file.type='file';file.accept='image/jpeg,image/png,image/webp';file.hidden=true;original.replaceWith(avatar,file);
        avatar.onclick=()=>{if(data&&!avatar.disabled)file.click();};
        file.onchange=async()=>{
          const selected=file.files[0];if(!selected||!data)return;
          if(!['image/jpeg','image/png','image/webp'].includes(selected.type)||selected.size>1048576||!selected.size){message(t('ใช้ JPEG, PNG หรือ WebP ไม่เกิน 1 MiB','Use JPEG, PNG or WebP up to 1 MiB'));file.value='';return;}
          avatar.disabled=true;
          try {
            const bitmap=await createImageBitmap(selected);const square=bitmap.width===bitmap.height&&bitmap.width<=512;bitmap.close();
            if(!square)throw new Error(t('รูปต้องมีอัตราส่วน 1:1 และไม่เกิน 512×512','Image must be square and no larger than 512×512'));
            const bytes=await selected.arrayBuffer(),hash=btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
            // Reuse the same immutable command on retry of this file/reference.
            if(!avatarCommand||avatarCommand.digest!==hash||avatarCommand.previousId!==data.avatarId)avatarCommand={commandId:crypto.randomUUID(),mimeType:selected.type,byteLength:selected.size,digest:hash,previousId:data.avatarId};
            message(t('กำลังบันทึกรูป…','Saving photo…'));
            const prepared=await request('prepareOwnAvatar',avatarCommand);if(!valid())return;
            if(prepared.uploadUrl){
              const url=new URL(prepared.uploadUrl);
              if(url.protocol!=='https:'||!url.hostname.endsWith('.supabase.co')||!url.pathname.includes('/storage/v1/object/upload/sign/'))throw new Error('Invalid upload capability');
              const uploaded=await fetch(url,{method:'PUT',headers:{'Content-Type':selected.type,'x-upsert':'false'},body:selected});
              if(!uploaded.ok&&![400,409].includes(uploaded.status))throw new Error(t('อัปโหลดไม่สำเร็จ โปรดลองรูปเดิมอีกครั้ง','Upload failed. Select the same photo to retry.'));
            }
            const result=prepared.completed?await request('getOwnProfile'):await request('finalizeOwnAvatar',{commandId:avatarCommand.commandId,resourceId:prepared.resourceId});
            if(!valid())return;data=result;avatarCommand=null;await loadAvatar();pulse();message(t('บันทึกรูปแล้ว','Photo saved'));
          }catch(error){message(error.message||t('บันทึกรูปไม่สำเร็จ','Unable to save photo'));}
          finally{file.value='';if(valid())avatar.disabled=false;}
        };
      }
    }
    const previous=CRS.state.routeCleanup;
    CRS.setRouteCleanup(async()=>{disposed=true;clearTimeout(timer);if(objectUrl)URL.revokeObjectURL(objectUrl);if(previous)await previous();});
    // No unload autosave/beacon: authorization and confirmation require a live view.
    load();
  }
  global.CRSProfile=Object.freeze({mount});
})(window);
