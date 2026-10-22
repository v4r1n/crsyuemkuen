(function(global){
  'use strict';
  // Presentation only. All inbox/read authority remains requestSecurity.
  function create({CRS,t}){
    let epoch=0,revision=0,countJob=null,unreadCount=0,popup=null,trigger=null,dispose=null;
    const views=new Set(),escape=CRS.escapeHtml;
    const eligible=()=>CRS.auth.hasSession()&&!CRS.state.bootstrap?.session.mustChangePassword;
    const current=version=>version===epoch&&eligible();
    const copy=()=>CRS.language.effective()==='en'?{empty:'You’re all caught up',hint:'Borrowing updates will appear here.',retry:'Try again',open:'Open notifications',unread:'unread',read:'Read',fresh:'Unread'}:{empty:'ยังไม่มีการแจ้งเตือน',hint:'อัปเดตการยืม–คืนจะแสดงที่นี่',retry:'ลองอีกครั้ง',open:'เปิดหน้าการแจ้งเตือน',unread:'ยังไม่อ่าน',read:'อ่านแล้ว',fresh:'ยังไม่อ่าน'};
    const readAllCopy=()=>CRS.language.effective()==='en'?'Mark all as read':'อ่านทั้งหมด';
    const labels=()=>CRS.language.effective()==='en'?{BORROW_REQUEST:'Borrow request',APPROVE:'Approved',REJECT:'Rejected',CHECKOUT:'Checked out',REQUEST_RETURN:'Return requested',RETURN:'Returned',DUE_SOON:'Due tomorrow',OVERDUE:'Overdue'}:{BORROW_REQUEST:'คำขอยืม',APPROVE:'อนุมัติ',REJECT:'ไม่อนุมัติ',CHECKOUT:'จ่ายอุปกรณ์',REQUEST_RETURN:'แจ้งคืน',RETURN:'ตรวจรับคืน',DUE_SOON:'ครบกำหนดคืนพรุ่งนี้',OVERDUE:'เกินกำหนดคืน'};
    const icons={BORROW_REQUEST:'bi-inbox',APPROVE:'bi-check-circle',REJECT:'bi-x-circle',CHECKOUT:'bi-box-arrow-up',REQUEST_RETURN:'bi-arrow-return-left',RETURN:'bi-box-seam'};
    function badge(count){
      const value=Number.isSafeInteger(count)&&count>0?count:0;
      unreadCount=value;
      document.querySelectorAll('[data-experience-action="notifications"]').forEach(node=>{
        node.hidden=!eligible();node.setAttribute('aria-label',t('notifications')+(value?' · '+value+' '+copy().unread:''));
        node.setAttribute('aria-expanded',String(node===trigger&&!!popup));
        const indicator=node.querySelector('[data-notification-count]');indicator.textContent=value>99?'99+':String(value);indicator.hidden=!value;
      });
      if(popup)popup.querySelector('[data-inbox-unread]').textContent=value+' '+copy().unread;
    }
    function button(){return '<button type="button" class="btn btn-outline-secondary notification-bell" data-experience-action="notifications" aria-haspopup="dialog" aria-expanded="false" aria-controls="crs-notification-popover" aria-label="'+escape(t('notifications'))+'"><i class="bi bi-bell" aria-hidden="true"></i><span data-notification-count aria-hidden="true" hidden></span></button>';}
    function draw(view){
      if(!current(view.epoch)||!view.host.isConnected||view.reading)return;
      const focused=document.activeElement?.closest('[data-notice-id]')?.dataset.noticeId;
      view.host.replaceChildren();view.host.setAttribute('aria-busy','false');
      if(!view.items.length){
        const empty=document.createElement('div');empty.className='notification-empty';
        empty.innerHTML='<i class="bi bi-bell" aria-hidden="true"></i><p></p><span></span>';
        empty.querySelector('p').textContent=copy().empty;empty.querySelector('span').textContent=copy().hint;view.host.append(empty);return;
      }
      for(const item of view.items){
        const node=document.createElement('button');node.type='button';node.className='notification-item';node.dataset.unread=String(!item.read_at);node.dataset.noticeId=item.id;
        node.innerHTML='<span class="notification-icon" aria-hidden="true"><i class="bi '+(icons[item.action]||'bi-bell')+'"></i></span><span class="notification-copy"><strong></strong><span class="notification-reference"></span><span class="notification-time"></span></span><span class="notification-read-state"></span>';
        node.querySelector('strong').textContent=labels()[item.action]||t('notifications');node.querySelector('.notification-reference').textContent=[item.borrow_id,item.asset_id].filter(Boolean).join(' · ');
        node.querySelector('.notification-time').textContent=CRS.formatDateTime(item.created_at);node.querySelector('.notification-read-state').textContent=item.read_at?copy().read:copy().fresh;
        node.onclick=async()=>{
          if(node.disabled||view.reading||!current(view.epoch)||!node.isConnected)return;
          node.disabled=true;view.reading=true;revision++;
          try{
            const result=await CRS.auth.requestSecurity('listNotifications',{readId:item.id});
            if(!current(view.epoch)||!node.isConnected)return;
            view.items=result.items||[];badge(result.unread);close(false);
            CRS.navigate(CRS.state.bootstrap?.session.isAdmin?'admin':'my-borrow',{tab:'borrowing',highlight:item.borrow_id});
          }catch(error){if(current(view.epoch)&&node.isConnected)CRS.toast(error.message,'danger');}
          finally{
            if(current(view.epoch))revision++;
            view.reading=false;node.disabled=false;
            if(views.has(view))draw(view);
          }
        };
        view.host.append(node);if(focused===item.id)node.focus({preventScroll:true});
      }
    }
    async function load(view){
      if(!current(view.epoch)||!view.host.isConnected||view.busy)return;
      view.busy=true;view.items=null;view.host.replaceChildren();view.host.setAttribute('aria-busy','true');let stale=false;
      const status=document.createElement('p');status.className='notification-status';status.role='status';status.textContent=t('loading');view.host.append(status);
      const requestedRevision=revision;
      try{
        const result=await CRS.auth.requestSecurity('listNotifications',{});
        if(!current(view.epoch)||!view.host.isConnected||!views.has(view))return;
        if(requestedRevision!==revision){stale=true;return;}
        view.items=result.items||[];draw(view);if(requestedRevision===revision)badge(result.unread);
      }catch(error){
        if(!current(view.epoch)||!view.host.isConnected||!views.has(view))return;
        view.host.setAttribute('aria-busy','false');status.textContent=error.message;
        const retry=document.createElement('button');retry.type='button';retry.className='btn btn-outline-secondary';retry.dataset.inboxRetry='';retry.textContent=copy().retry;retry.onclick=()=>load(view);view.host.append(retry);
      }finally{view.busy=false;if(stale&&current(view.epoch)&&view.host.isConnected)load(view);}
    }
    async function markAllRead(){
      if(!eligible())return;
      const ownerEpoch=epoch;revision++;
      const result=await CRS.auth.requestSecurity('listNotifications',{markAllRead:true});
      if(!current(ownerEpoch))return;
      revision++;badge(result.unread);
      for(const view of views)if(view.host.isConnected&&!view.busy&&!view.reading){view.items=result.items||[];draw(view);}
    }
    function mount(host){
      for(const view of views)if(!view.host.isConnected)views.delete(view);
      const view={host,epoch,items:null,busy:false,reading:false};views.add(view);load(view);return view;
    }
    async function refreshCount(){
      if(countJob||document.hidden||!eligible())return;
      const job={epoch,revision};countJob=job;
      try{
        const result=await CRS.auth.requestSecurity('listNotifications',{});
        if(current(job.epoch)&&job.revision===revision){badge(result.unread);for(const view of views){if(view.host.isConnected&&!view.busy&&!view.reading){view.items=result.items||[];draw(view);}}}
      }catch{/* The guarded transport owns identity failure handling. */}finally{if(countJob===job)countJob=null;}
    }
    function close(restore=true){
      if(!popup)return;
      const old=trigger;dispose?.();dispose=null;
      for(const view of views)if(popup.contains(view.host))views.delete(view);
      popup.replaceChildren();popup.remove();popup=null;trigger=null;
      document.querySelectorAll('[data-experience-action="notifications"]').forEach(node=>node.setAttribute('aria-expanded','false'));
      if(restore&&old?.isConnected&&!old.hidden)old.focus({preventScroll:true});
    }
    function toggle(anchor){
      if(!eligible())return;
      if(popup&&trigger===anchor){close();return;}close(false);trigger=anchor;
      const node=document.createElement('section');popup=node;node.id='crs-notification-popover';node.className='notification-popover';node.role='dialog';node.setAttribute('aria-modal','false');node.setAttribute('aria-labelledby','notification-popover-title');
      node.innerHTML='<header><div><h2 id="notification-popover-title" data-experience-text="notifications">'+escape(t('notifications'))+'</h2><span data-inbox-unread></span></div><button type="button" class="notification-close" aria-label="'+escape(t('close'))+'"><i class="bi bi-x-lg" aria-hidden="true"></i></button></header><div class="notification-list" data-notification-list></div><footer><button type="button" class="btn btn-outline-secondary" data-inbox-read-all></button><button type="button" class="btn btn-outline-secondary" data-inbox-all></button></footer>';
      document.body.append(node);anchor.setAttribute('aria-expanded','true');node.querySelector('[data-inbox-all]').textContent=copy().open;
      node.querySelector('.notification-close').onclick=()=>close();node.querySelector('[data-inbox-all]').onclick=()=>{close(false);CRS.navigate('settings',{section:'notifications'});};
      const mark=node.querySelector('[data-inbox-read-all]');mark.textContent=readAllCopy();
      mark.onclick=async()=>{if(mark.disabled)return;mark.disabled=true;try{await markAllRead();}catch(error){if(node===popup)CRS.toast(error.message,'danger');}finally{if(node===popup)mark.disabled=false;}};
      const position=()=>{
        if(!anchor.isConnected||!eligible()){close(false);return;}
        const box=anchor.getBoundingClientRect(),viewport=global.visualViewport,width=viewport?.width||innerWidth,height=viewport?.height||innerHeight,left=viewport?.offsetLeft||0,top=viewport?.offsetTop||0;
        const below=top+height-box.bottom-22,above=box.top-top-22,under=below>=240||below>=above;
        node.style.maxHeight=Math.max(120,Math.min(height-24,under?below:above))+'px';node.style.width=Math.min(384,width-24)+'px';
        node.style.left=Math.max(left+12,Math.min(box.right-node.offsetWidth,left+width-node.offsetWidth-12))+'px';
        node.style.top=Math.max(top+12,Math.min(under?box.bottom+10:box.top-node.offsetHeight-10,top+height-node.offsetHeight-12))+'px';
      };
      const controller=new AbortController(),options={signal:controller.signal};
      document.addEventListener('pointerdown',event=>{if(!node.contains(event.target)&&!anchor.contains(event.target))close(false);},options);
      document.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}},{...options,capture:true});
      document.addEventListener('focusin',event=>{if(!node.contains(event.target)&&!anchor.contains(event.target))close(false);},options);
      global.addEventListener('resize',position,options);global.addEventListener('scroll',position,{...options,capture:true});
      global.visualViewport?.addEventListener('resize',position,options);global.visualViewport?.addEventListener('scroll',position,options);
      const observer=new ResizeObserver(position);observer.observe(node);dispose=()=>{controller.abort();observer.disconnect();};
      position();node.querySelector('.notification-close').focus({preventScroll:true});mount(node.querySelector('[data-notification-list]'));
    }
    function reset(){epoch++;revision++;countJob=null;close(false);for(const view of views)view.host.replaceChildren();views.clear();badge(0);}
    function sync(){
      badge(unreadCount);
      if(popup){popup.querySelector('.notification-close').setAttribute('aria-label',t('close'));popup.querySelector('[data-inbox-all]').textContent=copy().open;popup.querySelector('[data-inbox-read-all]').textContent=readAllCopy();}
      for(const view of views){if(view.items)draw(view);else{const status=view.host.querySelector('[role="status"]');if(view.busy&&status)status.textContent=t('loading');const retry=view.host.querySelector('[data-inbox-retry]');if(retry)retry.textContent=copy().retry;}}
    }
    global.addEventListener('pagehide',reset);
    return Object.freeze({button,badge,mount,toggle,refreshCount,markAllRead,reset,sync});
  }
  global.CRSNotificationInbox=Object.freeze({create});
})(window);
