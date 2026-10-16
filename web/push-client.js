(function(global){
  'use strict';
  function supported(){return global.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in global && 'Notification' in global;}
  async function enable(publicKey,request,valid) {
    if(!supported())throw new Error('Push is unavailable on this browser. / เบราว์เซอร์นี้ไม่รองรับพุช');
    // This call starts synchronously in the explicit option-click gesture.
    const permission=await Notification.requestPermission();
    if(permission!=='granted')throw new Error('Push permission was not granted. / ยังไม่ได้อนุญาตพุช');
    if(!valid())return false;
    const registration=await navigator.serviceWorker.register('/notification-worker.js',{scope:'/'});
    // Await this registration, not navigator.serviceWorker.ready indefinitely.
    if(!registration.active)await new Promise((resolve,reject)=>{
      const worker=registration.installing||registration.waiting;
      if(!worker)return reject(new Error('Push setup failed. / ตั้งค่าพุชไม่สำเร็จ'));
      const timer=setTimeout(()=>{worker.removeEventListener('statechange',change);reject(new Error('Push setup timed out. / ตั้งค่าพุชเกินเวลา'));},10000);
      function change(){if(worker.state==='activated'||worker.state==='redundant'){clearTimeout(timer);worker.removeEventListener('statechange',change);worker.state==='activated'?resolve():reject(new Error('Push setup failed. / ตั้งค่าพุชไม่สำเร็จ'));}}
      worker.addEventListener('statechange',change);change();
    });
    if(!valid())return false;
    const bytes=Uint8Array.from(atob(publicKey.replace(/-/g,'+').replace(/_/g,'/')),character=>character.charCodeAt(0));
    const existing=await registration.pushManager.getSubscription();
    const sub=existing||await registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:bytes});
    if(!valid()){if(!existing)await sub.unsubscribe();return false;}
    try {
      const json=sub.toJSON();await request('registerPushSubscription',{endpoint:json.endpoint,keys:json.keys});
    }catch(error){
      if(!existing || error.code==='STATE_CONFLICT')await sub.unsubscribe();
      throw error;
    }
    return valid();
  }
  global.CRSPush=Object.freeze({supported,enable});
})(window);
