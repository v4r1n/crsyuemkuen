/* Decorative data is deliberately absent: private activity requires login. */
self.addEventListener('push',event=>{
  let id,test;
  try{const data=event.data.json();id=data.id;test=data.test===true;}catch{return;}
  if(typeof id!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(id))return;
  event.waitUntil(self.registration.showNotification('CRS Yuem-Kuen',{
    body:test?'ทดสอบ Push สำเร็จบนอุปกรณ์นี้ · Push delivery test':'มีการแจ้งเตือนใหม่ · New notification',tag:'crs-'+id,
    icon:'/brand/icon-yuemkuen.png',data:{path:'/'}}));
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  // The worker is served by each canonical origin. Never trust payload URLs.
  const target=new URL('/',self.location.origin).href;
  event.waitUntil(self.clients.openWindow(target));
});
