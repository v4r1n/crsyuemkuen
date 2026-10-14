const {test,expect}=require('@playwright/test');
const {mkdirSync}=require('node:fs');
const {installOfflineAssets}=require('./offline-assets.cjs');
test.beforeEach(async({page})=>installOfflineAssets(page));
const {bootstrappedHarness,createEquipment}=require('../backend/test-helpers.cjs');
const notice={id:'n'.repeat(43),borrow_id:'BR-000001',action:'APPROVE',created_at:'2026-10-11T04:00:00Z',read_at:null};
async function fixture(page,{restricted=false,admin=true,inbox}={}){
  const harness=bootstrappedHarness();createEquipment(harness);const calls=[];
  await page.addInitScript(()=>sessionStorage.setItem('crs.auth.session.v1',JSON.stringify({version:1,token:'session1_'+'a'.repeat(43),expiresAt:Math.floor(Date.now()/1000)+600})));
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();calls.push(input);
    if(input.method==='listPublicEquipment')return route.fulfill({json:{ok:true,data:{items:[],page:1,total:0,totalPages:1}}});
    if(input.method==='getNotificationPreferences')return route.fulfill({json:{ok:true,data:{items:[],channels:{inApp:true,push:false,email:false},securityEmailRequired:true}}});
    if(input.method==='listNotifications'){
      const value=inbox?await inbox(input.args[0]||{}):{items:[notice],unread:1};
      if(value.status)return route.fulfill({status:value.status,json:{}});
      return route.fulfill({json:value.error?{ok:false,error:value.error}:{ok:true,data:value}});
    }
    const response=harness.invoke(input.method,...input.args);
    if(input.method==='getAppBootstrap'&&response.ok)Object.assign(response.data.session,{mustChangePassword:restricted,isAdmin:admin,unreadNotifications:1});
    await route.fulfill({json:response});
  });
  await page.goto('/?view=equipment');await expect(page.locator('#app-shell')).toBeVisible();
  return calls;
}
const bell=page=>page.locator('.topbar-actions [data-experience-action="notifications"]');
const panel=page=>page.locator('#crs-notification-popover');
async function capture(page,name){
  if(process.env.CRS_UI_CAPTURE!=='1')return;mkdirSync('test-results/ui',{recursive:true});
  await page.screenshot({path:'test-results/ui/'+name+'.png',animations:'disabled'});
}

test('original full-screen 404 returns real 404, canonical Home and no private/auth request',async({page,baseURL})=>{
  await page.route('**/api/rpc',route=>route.fulfill({json:{ok:true,data:{items:[],page:1,total:0,totalPages:1}}}));
  const requests=[];page.on('request',request=>{if(request.url().includes('/api/'))requests.push(request.url());});
  for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:844});
    const response=await page.goto('/missing/fixture?next=https://attacker.invalid&email=not-reflected');
    expect(response.status()).toBe(404);await expect(page).toHaveTitle('404 · CRS Yuem-Kuen');
    await expect(page.locator('h1')).toHaveText('ไม่พบหน้าที่คุณต้องการ');
    await expect(page.locator('.not-found-home')).toHaveAttribute('href',baseURL);
    expect(await page.locator('body').innerText()).not.toContain('attacker.invalid');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await expect(page.locator('.not-found-home')).toBeInViewport({ratio:1});
  }
  expect(requests).toEqual([]);await capture(page,'404-desktop-light-th');
  const forged=await page.request.get('/unknown-fixture',{headers:{host:'attacker.invalid'}});expect(forged.status()).toBe(404);
  const html=await forged.text();expect(html).toContain(baseURL);expect(html).not.toContain('attacker.invalid');
  await page.locator('.not-found-home').click();await expect(page.locator('#guest-equipment')).toBeVisible();
});

test('404 retains Thai/English and theme preferences with reduced motion and keyboard focus',async({page})=>{
  await page.addInitScript(()=>{if(!localStorage.getItem('crs-ui-language'))localStorage.setItem('crs-ui-language','en');localStorage.setItem('crs-theme','dark');});
  await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:390,height:844});await page.goto('/missing');
  await expect(page.locator('h1')).toHaveText('Page not found');await expect(page.locator('html')).toHaveAttribute('data-bs-theme','dark');
  await page.keyboard.press('Tab');await expect(page.locator('.not-found-controls button')).toBeFocused();
  await page.keyboard.press('Tab');await expect(page.locator('.not-found-home')).toBeFocused();
  expect(await page.locator('.not-found-home').evaluate(node=>getComputedStyle(node).transitionDuration)).toBe('0s');
  await capture(page,'404-mobile-dark-en');
  await page.locator('.not-found-controls button').click();await expect(page.locator('h1')).toHaveText('ไม่พบหน้าที่คุณต้องการ');
  await page.reload();await expect(page.locator('h1')).toHaveText('ไม่พบหน้าที่คุณต้องการ');
});

test('404 remains readable and Home usable without JavaScript',async({browser,baseURL})=>{
  const context=await browser.newContext({javaScriptEnabled:false});const page=await context.newPage();
  try{const response=await page.goto(baseURL+'/missing');expect(response.status()).toBe(404);await expect(page.locator('h1')).toBeVisible();await expect(page.locator('.not-found-home')).toHaveAttribute('href',baseURL);}finally{await context.close();}
});

test('bell popover is single, non-modal, keyboard dismissible and keeps other dialogs',async({page})=>{
  await fixture(page);await bell(page).focus();await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();await expect(panel(page)).toHaveAttribute('aria-modal','false');
  await expect(panel(page).locator('.notification-item')).toContainText('อนุมัติ');await expect(page.locator('.experience-dialog')).toHaveCount(0);
  await expect(panel(page).locator('.notification-close')).toBeFocused();await expect(bell(page)).toHaveAttribute('aria-expanded','true');
  await page.keyboard.press('Tab');await expect(panel(page).locator('.notification-item')).toBeFocused();
  await page.keyboard.press('Escape');await expect(panel(page)).toHaveCount(0);await expect(bell(page)).toBeFocused();
  await bell(page).click();await bell(page).click();await expect(panel(page)).toHaveCount(0);
  await bell(page).click();await page.locator('#equipment-search').click();await expect(panel(page)).toHaveCount(0);
  await page.locator('.topbar-actions [data-experience-action="guide"]').click();await expect(page.locator('.experience-dialog')).toBeVisible();
});

test('popover loading, error/retry and empty states come only from guarded inbox',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);let attempt=0;
  const calls=await fixture(page,{inbox:async()=>{attempt++;if(attempt===1){await gate;return {status:503};}return {items:[],unread:0};}});
  try{
    await bell(page).click();await expect(panel(page)).toContainText('กำลังโหลด');
    release();await expect(panel(page).locator('[data-inbox-retry]')).toBeVisible();
    await panel(page).locator('[data-inbox-retry]').click();await expect(panel(page)).toContainText('ยังไม่มีการแจ้งเตือน');
    await expect(bell(page).locator('[data-notification-count]')).toBeHidden();expect(calls.filter(call=>call.method==='listNotifications')).toHaveLength(2);
  }finally{release();}
});

for(const admin of [true,false])test('notification read is awaited and routes the '+(admin?'Admin':'borrower')+' to the existing workflow',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);let reads=0;
  await fixture(page,{admin,inbox:async input=>{if(input.readId){reads++;await gate;return {items:[{...notice,read_at:'2026-10-11T05:00:00Z'}],unread:0};}return {items:[notice],unread:1};}});
  try{
    await bell(page).click();const item=panel(page).locator('.notification-item');await item.click();await expect(item).toBeDisabled();await expect(panel(page)).toBeVisible();
    expect(reads).toBe(1);expect(await page.evaluate(()=>CRS.state.route)).toBe('equipment');release();
    await expect(panel(page)).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>CRS.state.route)).toBe(admin?'admin':'my-borrow');
    await expect(bell(page).locator('[data-notification-count]')).toBeHidden();
  }finally{release();}
});

test('stale inbox response cannot reappear after dismissal/reopening or logout',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);let attempt=0;
  await fixture(page,{inbox:async()=>{attempt++;if(attempt===1){await gate;return {items:[{...notice,borrow_id:'OLD-INBOX'}],unread:9};}return {items:[notice],unread:1};}});
  try{
    await bell(page).click();await page.keyboard.press('Escape');await bell(page).click();await expect(panel(page)).toContainText('BR-000001');release();
    await expect(panel(page)).not.toContainText('OLD-INBOX');await expect(bell(page).locator('[data-notification-count]')).toHaveText('1');
    await page.evaluate(()=>CRS.auth.signOut());await expect(panel(page)).toHaveCount(0);await expect(bell(page)).toBeHidden();
  }finally{release();}
});

test('delayed read failure cannot navigate, mark locally or duplicate a read',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);let reads=0;
  await fixture(page,{inbox:async input=>{if(input.readId){reads++;await gate;return {error:{code:'SERVICE_UNAVAILABLE',message:'Fixture read unavailable'}};}return {items:[notice],unread:1};}});
  try{
    await bell(page).click();await panel(page).locator('.notification-item').click();
    await page.evaluate(()=>document.querySelector('.notification-item').click());expect(reads).toBe(1);release();
    await expect(panel(page).locator('.notification-item')).toBeEnabled();await expect(panel(page).locator('.notification-item')).toHaveAttribute('data-unread','true');
    expect(await page.evaluate(()=>CRS.state.route)).toBe('equipment');await expect(bell(page).locator('[data-notification-count]')).toHaveText('1');
  }finally{release();}
});

test('notification script failure cannot break existing auth/bootstrap/settings/guide',async({page})=>{
  await page.route('**/crs/notification-inbox.js',route=>route.abort());await fixture(page);
  await expect(page.locator('#equipment-results')).toBeVisible();await expect(bell(page)).toHaveCount(0);
  await page.locator('.topbar-actions [data-experience-action="guide"]').click();await expect(page.locator('.experience-dialog')).toBeVisible();await page.keyboard.press('Escape');
  await page.evaluate(()=>CRS.navigate('settings',{section:'notifications'}));await expect(page.locator('.settings-content')).toContainText('การแจ้งเตือนไม่พร้อมใช้งาน');
});

test('logout clears in-flight inbox and a late result cannot leak into a subsequent session',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);
  await fixture(page,{inbox:async()=>{await gate;return {items:[{...notice,borrow_id:'OLD-PRIVATE'}],unread:9};}});
  try{
    await bell(page).click();await expect(panel(page)).toContainText('กำลังโหลด');await page.evaluate(()=>CRS.auth.signOut());await expect(panel(page)).toHaveCount(0);
    release();await expect(bell(page)).toBeHidden();expect(await page.locator('body').innerText()).not.toContain('OLD-PRIVATE');
  }finally{release();}
});

test('late polling cannot undo a committed read and badge keeps its exact accessible count through translation',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);let requests=0;
  const calls=await fixture(page,{inbox:async input=>{
    if(input.readId)return {items:[{...notice,read_at:'2026-10-11T05:00:00Z'}],unread:0};
    requests++;if(requests===2){await gate;return {items:[notice],unread:204};}return {items:[notice],unread:204};
  }});
  try{
    await bell(page).click();await expect(bell(page).locator('[data-notification-count]')).toHaveText('99+');
    await page.evaluate(()=>CRS.language.set('en'));await expect(bell(page)).toHaveAttribute('aria-label','Notifications · 204 unread');expect(requests).toBe(1);
    await page.evaluate(()=>dispatchEvent(new CustomEvent('crs:rpc-completed',{detail:{method:'adminApproveBorrow'}})));await expect.poll(()=>requests).toBe(2);
    await panel(page).locator('.notification-item').click();await expect(panel(page)).toHaveCount(0);release();
    await expect(bell(page).locator('[data-notification-count]')).toBeHidden();
    expect(calls.filter(call=>call.method==='listNotifications'&&call.args[0].readId)).toHaveLength(1);
  }finally{release();}
});

for(const redraw of ['language','polling','both'])test(redraw+' redraw cannot detach a notice while its guarded read is pending',async({page})=>{
  let release;const gate=new Promise(resolve=>release=resolve);let polls=0;
  await fixture(page,{inbox:async input=>{if(input.readId){await gate;return {items:[{...notice,read_at:'2026-10-11T05:00:00Z'}],unread:0};}polls++;return {items:[notice],unread:1};}});
  try{
    await bell(page).click();await panel(page).locator('.notification-item').click();await expect(panel(page).locator('.notification-item')).toBeDisabled();
    const pending=await panel(page).locator('.notification-item').elementHandle();
    await page.evaluate(redraw=>{if(redraw!=='polling')CRS.language.set('en');if(redraw!=='language')dispatchEvent(new CustomEvent('crs:rpc-completed',{detail:{method:'adminApproveBorrow'}}));},redraw);
    await expect.poll(()=>polls).toBe(redraw==='language'?1:2);
    expect(await pending.evaluate(node=>({connected:node.isConnected,disabled:node.disabled}))).toEqual({connected:true,disabled:true});
    await expect(panel(page).locator('.notification-item')).toBeDisabled();
    release();await expect(panel(page)).toHaveCount(0);await expect.poll(()=>page.evaluate(()=>CRS.state.route)).toBe('admin');await expect(bell(page).locator('[data-notification-count]')).toBeHidden();
  }finally{release();}
});

test('session rejection clears notices; Guest and required-change users cannot open inbox',async({page})=>{
  await fixture(page,{inbox:async()=>({error:{code:'UNAUTHENTICATED',message:'Fixture session ended'}})});
  await bell(page).click();await expect(panel(page)).toHaveCount(0);await expect(page.locator('#guest-equipment')).toBeVisible();
  await page.evaluate(()=>document.querySelector('[data-experience-action="notifications"]').click());await expect(panel(page)).toHaveCount(0);
  await page.unroute('**/api/rpc');await fixture(page,{restricted:true});await expect(bell(page)).toBeHidden();
  await page.evaluate(()=>document.querySelector('[data-experience-action="notifications"]').click());await expect(panel(page)).toHaveCount(0);
});

test('popover is bounded, scrollable, translated and contrast-token themed on mobile/desktop',async({page})=>{
  await fixture(page,{inbox:async()=>({items:Array.from({length:20},(_,i)=>({...notice,id:String(i).padStart(43,'n'),action:i%2?'RETURN':'APPROVE',borrow_id:'<img src=x onerror=alert(1)>'})),unread:20})});
  for(const width of [320,390,768,1440])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:700});await page.evaluate(theme=>CRS.theme.apply(theme,true),theme);
    await bell(page).click();await expect(panel(page).locator('.notification-item')).toHaveCount(20);
    await expect(panel(page)).toBeInViewport({ratio:1});
    expect(await panel(page).locator('.notification-list').evaluate(node=>node.scrollHeight>node.clientHeight&&getComputedStyle(node).overflowY==='auto')).toBe(true);
    expect(await panel(page).locator('img').count()).toBe(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(width===390||width===1440)await capture(page,'inbox-'+width+'-'+theme+'-th');
    await page.evaluate(()=>CRS.language.set('en'));await expect(panel(page).locator('h2')).toHaveText('Notifications');await expect(panel(page)).toContainText('Approved');
    await expect(bell(page)).toHaveAttribute('aria-label','Notifications · 20 unread');
    await page.emulateMedia({reducedMotion:'reduce'});expect(await panel(page).evaluate(node=>getComputedStyle(node).animationName)).toBe('none');
    await page.keyboard.press('Escape');await page.evaluate(()=>CRS.language.set('th'));
  }
  await bell(page).click();await panel(page).locator('[data-inbox-all]').click();await expect(page.locator('.settings-content .notification-item')).toHaveCount(20);
  await expect(panel(page)).toHaveCount(0);
});
