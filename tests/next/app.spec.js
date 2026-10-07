const {test,expect}=require('@playwright/test');
const {mkdirSync}=require('node:fs');
const {bootstrappedHarness,createEquipment}=require('../backend/test-helpers.cjs');
const canonical='https://example.test';
async function mock(page,{signedOut=false,restricted=false}={}){
  const harness=bootstrappedHarness();const record=createEquipment(harness);
  const session=harness.records('Users').find(row=>row.role==='ADMIN');
  const calls=[];
  if(!signedOut)await page.addInitScript(()=>sessionStorage.setItem('crs.auth.session.v1',JSON.stringify({version:1,token:'session1_'+'a'.repeat(43),expiresAt:Math.floor(Date.now()/1000)+600})));
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();calls.push(input);
    let response;
    if(input.method==='passwordSignIn') response={ok:true,data:{status:'COMPLETE',expiresAt:Math.floor(Date.now()/1000)+600}};
    else if(input.method==='listPublicEquipment') response={ok:true,data:{items:[{asset_id:record.asset_id,name:record.name,brand:'Fixture',model:'Public',category_name:'Public',can_borrow:true,imageAvailable:false}],page:1,total:1,totalPages:1}};
    else if(input.method==='adminGetEquipmentVisibility') response={ok:true,data:{isPublic:false}};
    else if(input.method==='adminSetEquipmentPublic') response={ok:true,data:{updated:true}};
    else if(input.method==='adminIssueTemporaryPassword') response={ok:true,data:{deliveryStatus:'SENT',activated:true,mustChangePassword:true}};
    else if(input.method==='listNotifications') response={ok:true,data:{items:[{id:'n'.repeat(43),borrow_id:'BR-000001',action:'APPROVE',created_at:new Date().toISOString(),read_at:null}],unread:1}};
    else if(input.method==='requestPasswordOtp') response={ok:true,data:{challenge:'password1_'+'c'.repeat(43),expiresAt:Math.floor(Date.now()/1000)+300,resendAfter:60}};
    else if(input.method==='verifyPasswordOtp') response={ok:true,data:{verified:true,expiresAt:Math.floor(Date.now()/1000)+300}};
    else if(input.method==='changePassword') response={ok:true,data:{changed:true,signedOut:true}};
    else if(input.method==='prepareEquipmentImage') response={ok:true,data:{resourceId:'storage-file',uploadUrl:'https://test.supabase.co/storage/v1/object/upload/sign/crs-images/test?token=private'}};
    else if(input.method==='finalizeEquipmentImage') response={ok:true,data:{...record,row_version:2,imageAvailable:true,image_url:'/api/image-placeholder',included_items:[]}};
    else if(input.method==='getEquipmentImage') response={ok:true,data:{available:true,mime_type:'image/png',row_version:record.row_version,signed_url:'https://test.supabase.co/storage/v1/object/sign/crs-images/test?token=private'}};
    else {
      response=harness.invoke(input.method,...input.args);
      if(input.method==='getAppBootstrap' && response.ok) {response.data.app.webAppUrl=canonical;response.data.session.mustChangePassword=restricted;response.data.session.unreadNotifications=restricted?0:1;}
      if(input.method==='getEquipmentDetail' && response.ok) Object.assign(response.data,{imageAvailable:true,image_url:'/api/image-placeholder'});
    }
    await route.fulfill({json:response});
  });
  // Keep the fixture's admin object live and report transport calls, not a GAS bridge.
  expect(session).toBeTruthy();
  return {calls,record};
}
test('actual Next shell preserves query navigation, Thai settings and canonical QR without GAS runtime',async({page})=>{
  const {record}=await mock(page);
  await page.goto('/?view=equipment-detail&id='+record.asset_id);
  await expect(page.locator('#equipment-detail-title')).toHaveText(record.name);
  const url=await page.evaluate(id=>window.CRS.qr.canonicalAssetUrl(id),record.asset_id);
  expect(url).toBe(canonical+'/?view=equipment-detail&id='+record.asset_id);
  expect(await page.evaluate(()=>typeof window.google)).toBe('undefined');
  await page.locator('[data-route="equipment"]').first().click();
  await expect(page.locator('#page-equipment')).toBeVisible();
});
test('protected image failure leaves standard placeholder; direct upload never sends base64 to Vercel',async({page})=>{
  const {record,calls}=await mock(page);const storageRequests=[];
  await page.route('https://test.supabase.co/**',async route=>{
    storageRequests.push({method:route.request().method(),bytes:route.request().postDataBuffer()?.length||0});
    await route.fulfill({status:route.request().method()==='PUT'?200:404,contentType:'application/json',body:'{}'});
  });
  await page.goto('/?view=equipment-detail&id='+record.asset_id);
  await expect(page.locator('#equipment-detail-image-fallback')).toBeVisible();
  await expect(page.locator('#equipment-detail-image')).toBeHidden();
  const result=await page.evaluate(async id=>window.CRS_SERVER_RPC('adminUploadEquipmentImage',['session1_'+'a'.repeat(43),{asset_id:id,command_id:'next-direct-image-test',expected_version:1,mime_type:'image/png',base64_data:'iVBORw0KGgo='}]),record.asset_id);
  expect(result.ok).toBe(true);
  expect(storageRequests.some(value=>value.method==='PUT'&&value.bytes===8)).toBe(true);
  const prepare=calls.find(call=>call.method==='prepareEquipmentImage');
  expect(prepare.args[0]).not.toHaveProperty('base64_data');
  expect(prepare.args[0].digest).toMatch(/^[A-Za-z0-9_-]{43}$/);
});
test('RPC refuses cross-origin writes before database access',async({request})=>{
  const response=await request.post('/api/rpc',{headers:{Origin:'https://evil.test'},data:{method:'adminDeleteEquipment',args:[]}});
  expect(response.status()).toBe(403);
});

test('private image capability loads a browser Blob and falls back when that image cannot decode',async({page})=>{
  const {record}=await mock(page);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=','base64');
  await page.route('https://test.supabase.co/**',route=>route.fulfill({status:200,contentType:'image/png',body:png}));
  await page.goto('/?view=equipment-detail&id='+record.asset_id);
  await expect(page.locator('#equipment-detail-image')).toBeVisible();
  await expect(page.locator('#equipment-detail-image-fallback')).toBeHidden();
  expect(await page.locator('#equipment-detail-image').getAttribute('src')).toMatch(/^blob:/);
  await page.evaluate(()=>document.getElementById('equipment-detail-image').dispatchEvent(new Event('error')));
  await expect(page.locator('#equipment-detail-image')).toBeHidden();
  await expect(page.locator('#equipment-detail-image-fallback')).toBeVisible();
});

async function captureUi(page, name) {
  // Opt-in local artifacts use only isolated synthetic fixtures, never live sessions.
  if (process.env.CRS_UI_CAPTURE !== '1') return;
  mkdirSync('test-results/ui', { recursive: true });
  await page.evaluate(async()=>{
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation=>animation.effect.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));
  });
  await page.screenshot({ path: 'test-results/ui/' + name + '.png', fullPage: true });
}

async function expectNoOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

test('glass login is responsive, keyboard accessible and offers linked Password and Google sign-in',async({page})=>{
  // No cloud request or authentication bypass; the signed-out shell needs no identity.
  for (const viewport of [{width:1440,height:960},{width:768,height:720},{width:390,height:844},{width:320,height:600}]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('#access-state')).toBeVisible();
    await expect(page.locator('.login-layout')).toBeVisible();
    await expect(page.locator('#access-state-title')).toHaveText('เข้าสู่ระบบ');
    await expect(page.locator('#google-signin-button')).toBeEnabled();
    await expect(page.locator('#oauth-handoff-panel')).toBeHidden();
    await expect(page.locator('.login-security-note')).toContainText('บัญชีเดียวกัน');
    const layout = await page.locator('.login-layout').evaluate(element => ({
      columns:getComputedStyle(element).gridTemplateColumns.split(' ').length,
      blur:getComputedStyle(element).backdropFilter
    }));
    expect(layout.columns).toBe(viewport.width < 768 ? 1 : 2);
    expect(layout.blur).toBe('blur(20px)');
    await expectNoOverflow(page);
    await page.locator('#google-signin-button').focus();
    await expect(page.locator('#google-signin-button')).toBeFocused();
    await expect(page.locator('#google-signin-button')).toBeInViewport();
    // The startup shell is a fixed, independently scrolling surface. Focusing
    // lower controls must not make the logo/theme unreachable on short screens.
    await page.locator('.login-footer').scrollIntoViewIfNeeded();
    await expect(page.locator('.login-footer')).toBeInViewport();
    if(viewport.width===390) await captureUi(page,'login-light-390-bottom');
    await page.locator('#access-state').evaluate(element=>element.scrollTo({top:0,behavior:'instant'}));
    await expect(page.locator('.login-logo')).toBeInViewport();
    await expect(page.locator('#theme-toggle-login')).toBeInViewport();
    const top=await page.locator('.login-layout').evaluate(element=>element.getBoundingClientRect().top);
    expect(top).toBeGreaterThanOrEqual(0);
    if(viewport.width===1440||viewport.width===390) await captureUi(page,'login-light-'+viewport.width);
  }
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>localStorage.setItem('crs-theme','dark'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme','dark');
  await expectNoOverflow(page);
  await captureUi(page,'login-dark-desktop');
});

test('glass app covers dashboard, catalog, admin, settings and mobile navigation without layout overflow',async({page})=>{
  const {record}=await mock(page);
  for(const viewport of [{width:1440,height:960},{width:768,height:900},{width:390,height:844},{width:320,height:700}]) {
    await page.setViewportSize(viewport);
    for(const [route,selector] of [['dashboard','#dashboard-content'],['equipment','#equipment-results'],['equipment-detail','#equipment-detail-title'],['admin','#page-admin'],['settings','.settings-content']]) {
      await page.goto('/?view='+route+(route==='equipment-detail'?'&id='+record.asset_id:''));
      await expect(page.locator(selector)).toBeVisible();
      await expectNoOverflow(page);
      if(route!=='settings') {
        await expect(page.locator(viewport.width<992?'#mobile-nav':'#desktop-sidebar')).toBeVisible();
        const bounds=await page.locator(viewport.width<992?'#mobile-nav':'.app-topbar').boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x+bounds.width).toBeLessThanOrEqual(viewport.width);
      }
      if(viewport.width===1440||viewport.width===390) await captureUi(page,route+'-light-'+viewport.width);
    }
  }
  await page.evaluate(()=>localStorage.setItem('crs-theme','dark'));
  await page.setViewportSize({width:1440,height:960});
  await page.goto('/?view=dashboard');
  await expect(page.locator('#dashboard-content')).toBeVisible();
  await captureUi(page,'dashboard-dark-desktop');
});

test('finite animations honor reduced motion and glass text/button tokens retain AA contrast',async({page})=>{
  await page.emulateMedia({reducedMotion:'no-preference',colorScheme:'light'});
  await page.goto('/');
  await expect(page.locator('#access-state')).toBeVisible();
  await expect(page.locator('.login-layout')).toHaveCSS('animation-name','glass-reveal');
  await expect(page.locator('.login-layout')).toHaveCSS('animation-iteration-count','1');
  const palette=await page.evaluate(()=>{
    const style=getComputedStyle(document.documentElement);
    return ['blue','pink','blue-mist','pink-mist','white','gray'].map(name=>style.getPropertyValue('--crs-'+name).trim());
  });
  expect(palette).toEqual(['#014d8b','#ff488a','#cbdbe8','#ffdbe9','#ffffff','#797979']);
  for(const theme of ['light','dark']) {
    await page.evaluate(value=>document.documentElement.setAttribute('data-bs-theme',value),theme);
    const ratios=await page.evaluate(()=>{
      const style=getComputedStyle(document.documentElement);
      const token=name=>style.getPropertyValue('--crs-'+name).trim();
      const rgb=hex=>[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16));
      const luminance=channels=>channels.map(value=>value/255).map(value=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
      const contrast=(foreground,background)=>{const [high,low]=[luminance(foreground),luminance(background)].sort((a,b)=>b-a);return(high+.05)/(low+.05);};
      // Bound transparency against both ambient extremes rather than assuming white glass.
      const glass=token('glass-bg').match(/[\d.]+/g).map(Number);
      const backgrounds=[token('canvas'),token('blue-mist'),token('pink-mist')].map(rgb).map(base=>base.map((channel,index)=>channel*(1-glass[3])+glass[index]*glass[3]));
      const result={};
      for(const name of ['ink','heading','label','muted','link']) result[name]=Math.min(...backgrounds.map(bg=>contrast(rgb(token(name)),bg)));
      result.primaryButton=contrast(rgb(token('on-brand')),rgb(token('action')));
      result.primaryButtonHover=contrast(rgb(token('on-brand')),rgb(token('action-hover')));
      return result;
    });
    for(const [name,ratio] of Object.entries(ratios)) expect(ratio,theme+' '+name).toBeGreaterThanOrEqual(4.5);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await expect(page.locator('.login-layout')).toHaveCSS('animation-name','none');
  await page.locator('#google-signin-button').hover();
  await expect(page.locator('#google-signin-button')).toHaveCSS('transform','none');
  await mock(page);
  await page.goto('/?view=equipment');
  await expect(page.locator('#equipment-results')).toBeVisible();
  await expect(page.locator('.app-page')).toHaveCSS('animation-name','none');
  await page.locator('.equipment-card').first().hover();
  await expect(page.locator('.equipment-card').first()).toHaveCSS('transform','none');
});

test('real callback denial keeps the glass OTP page accessible without revealing any code',async({page})=>{
  for(const viewport of [{width:1280,height:800},{width:320,height:600}]) {
    await page.setViewportSize(viewport);
    const response=await page.goto('/auth/callback');
    expect(response.status()).toBe(400);
    expect(response.headers()['cache-control']).toContain('no-store');
    await expect(page.locator('main h1')).toHaveText('ลงชื่อเข้าใช้ไม่สำเร็จ');
    await expect(page.locator('#oauth-handoff-code')).toHaveCount(0);
    await expect(page.locator('main')).toHaveCSS('backdrop-filter','blur(20px)');
    await expectNoOverflow(page);
    await captureUi(page,'callback-denied-'+viewport.width);
  }
  await page.emulateMedia({reducedMotion:'reduce',colorScheme:'dark'});
  await expect(page.locator('main')).toHaveCSS('animation-name','none');
  await expect(page.locator('main h1')).toHaveCSS('color','rgb(245, 247, 250)');
});

test('password login uses the existing opaque remembered session and clears the submitted password',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});
  await page.goto('/');await expect(page.locator('#password-login-form')).toBeVisible();
  await page.locator('#login-email').fill('admin@example.test');await page.locator('#login-password').fill('Fixture passphrase only!');
  const reveal=page.locator('[data-reveal-for="login-password"]');await reveal.focus();await page.keyboard.down('Space');
  await expect(page.locator('#login-password')).toHaveAttribute('type','text');await page.keyboard.up('Space');await expect(page.locator('#login-password')).toHaveAttribute('type','password');
  await page.locator('#remember-session').check();await page.locator('#password-login-submit').click();
  await expect(page.locator('#dashboard-content')).toBeVisible();
  const input=calls.find(call=>call.method==='passwordSignIn').args[0];expect(input.sessionTokenHash).toMatch(/^[A-Za-z0-9_-]{43}$/);expect(input).not.toHaveProperty('role');
  const stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('crs.auth.session.v1')));expect(stored.token).toMatch(/^session1_/);
  expect(JSON.stringify(stored)).not.toContain('Fixture passphrase');await expect(page.locator('#login-password')).toHaveValue('');
});

test('Guest confirmation hands off only an asset intent and opens the unchanged borrow form after sign-in',async({page})=>{
  const {calls,record}=await mock(page,{signedOut:true});await page.goto('/');
  await page.locator('[data-experience-action="guest"]').click();await expect(page.locator('#guest-equipment')).toBeVisible();
  await page.locator('[data-guest-borrow]').click();await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('#confirm-modal [data-confirm-accept]').click();await expect(page.locator('#password-login-form')).toBeVisible();
  await page.locator('#login-email').fill('admin@example.test');await page.locator('#login-password').fill('Fixture passphrase only!');await page.locator('#password-login-submit').click();
  await expect(page.locator('#form-borrow-request')).toBeVisible();
  await expect(page.locator('#borrow-equipment-asset-id')).toHaveText(record.asset_id);
  expect(calls.filter(call=>call.method==='createBorrowRequest')).toHaveLength(0);
  expect(await page.evaluate(()=>sessionStorage.getItem('crs.guest.borrow-intent.v1'))).toBeNull();
});

test('security settings verify email OTP before revealing matching-policy password controls',async({page})=>{
  const {calls}=await mock(page);await page.goto('/?view=settings&section=profile');
  await page.locator('[data-experience-action="profile-security"]').click();
  await page.locator('[data-experience-action="request-password-otp"]').click();
  await expect(page.locator('[data-password-new-step]')).toBeHidden();
  const verify=page.locator('[data-experience-action="verify-password-otp"]');await expect(verify).toBeDisabled();
  await page.locator('#password-email-otp').fill('１２３４５６');await verify.click();
  expect(calls.find(call=>call.method==='verifyPasswordOtp').args[0].otp).toBe('123456');
  await expect(page.locator('[data-password-new-step]')).toBeVisible();const submit=page.locator('[data-password-flow] [type="submit"]');await expect(submit).toBeDisabled();
  await page.locator('#password-new').fill('Fixture new passphrase!');await page.locator('#password-confirm').fill('Mismatch');await expect(submit).toBeDisabled();
  await page.locator('#password-confirm').fill('Fixture new passphrase!');await expect(submit).toBeEnabled();
  await page.locator('#password-new').fill('passwordpassword');await page.locator('#password-confirm').fill('passwordpassword');await expect(submit).toBeDisabled();
});

test('forced password change routes to Security instead of the requested business view',async({page})=>{
  await mock(page,{restricted:true});await page.goto('/?view=equipment');
  await expect(page.locator('[data-password-required]')).toBeVisible();await expect(page.locator('[data-password-flow="CHANGE"]')).toBeVisible();
  await expect(page.locator('#equipment-results')).toHaveCount(0);
});

test('new actions translate TH/EN; quick theme has two states and System remains in Appearance',async({page})=>{
  await mock(page);await page.goto('/?view=settings&section=appearance');
  await page.locator('.settings-global-actions [data-experience-action="language"]').click();await expect(page.locator('.settings-global-actions [data-experience-action="guide"]')).toHaveText('Guide');
  await page.locator('.settings-global-actions [data-experience-action="language"]').click();await expect(page.locator('.settings-global-actions [data-experience-action="guide"]')).toHaveText('คู่มือ');
  await page.locator('[data-settings-theme="system"]').click();await expect(page.locator('html')).toHaveAttribute('data-theme-preference','system');
  await page.locator('.settings-global-actions [data-action="theme-toggle"]').click();await expect(page.locator('html')).not.toHaveAttribute('data-theme-preference','system');
  await page.locator('.settings-global-actions [data-action="theme-toggle"]').click();await expect(page.locator('html')).not.toHaveAttribute('data-theme-preference','system');
  await page.goto('/?view=dashboard');await page.locator('[data-experience-action="notifications"]').click();await expect(page.locator('dialog .notification-item')).toContainText('อนุมัติ');
});

test('Login effects and icon/search geometry respect reduced motion, touch, theme and viewport',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:390,height:844});await page.goto('/');
  await expect(page.locator('.liquid-glass-cursor')).toBeHidden();await expect(page.locator('.login-foil')).toBeHidden();
  const location=await page.locator('#theme-toggle-login').evaluate(node=>{const style=getComputedStyle(node.querySelector('i'));return{inside:!!node.closest('.access-card'),align:style.alignItems,justify:style.justifyContent};});expect(location.inside).toBe(true);expect(location.align).toBe('center');expect(location.justify).toBe('center');
  await page.locator('.access-card [data-experience-action="language"]').click();await expect(page.locator('#access-state-title')).toHaveText('Sign in');await expect(page.locator('label[for="login-email"]')).toHaveText('Email');
  await page.evaluate(()=>window.CRS.theme.apply('dark',true));
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme','dark');
  await page.locator('#access-state').evaluate(element=>element.scrollTo({top:0,behavior:'instant'}));
  await expect(page.locator('.login-logo')).toBeInViewport();await expectNoOverflow(page);
  await captureUi(page,'login-dark-en-mobile-top');
  await page.locator('.login-footer').scrollIntoViewIfNeeded();
  await captureUi(page,'login-dark-en-mobile-bottom');
  await mock(page);await page.goto('/?view=equipment');await expect(page.locator('#equipment-search')).toBeVisible();
  for(const theme of ['light','dark']){await page.evaluate(theme=>window.CRS.theme.apply(theme,true),theme);const radii=await page.locator('#equipment-search').evaluate(node=>{const s=getComputedStyle(node);return [s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius];});expect(new Set(radii).size).toBe(1);}
});

test('forgot password modal clears secrets after OTP-verified matching reset; footer links use only approved HTTPS metadata',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});
  await page.route('**/api/experience',route=>route.fulfill({json:{privacyUrl:'https://example.test/privacy',termsUrl:'https://example.test/terms'}}));
  await page.goto('/');await expect(page.locator('.login-footer a')).toHaveCount(2);
  await expect(page.locator('.login-footer [data-experience-action="privacy"]')).toHaveAttribute('href','https://example.test/privacy');
  await page.locator('[data-experience-action="reset-password"]').click();const modal=page.locator('dialog');await expect(modal).toHaveAttribute('aria-labelledby',/experience-dialog-title/);
  await modal.locator('#reset-email').fill('admin@example.test');await modal.locator('[data-experience-action="request-password-otp"]').click();
  await modal.locator('#password-email-otp').fill('١٢٣٤٥٦');await modal.locator('[data-experience-action="verify-password-otp"]').click();
  await modal.locator('#password-new').fill('Fixture reset passphrase!');await modal.locator('#password-confirm').fill('Fixture reset passphrase!');
  await modal.locator('[type="submit"]').click();await expect(modal).toHaveCount(0);await expect(page.locator('#password-login-form')).toBeVisible();
  expect(calls.find(call=>call.method==='requestPasswordOtp').args[0].purpose).toBe('RESET');
  expect(calls.find(call=>call.method==='verifyPasswordOtp').args[0].otp).toBe('123456');
  expect(await page.evaluate(()=>JSON.stringify(Object.entries(sessionStorage))+JSON.stringify(Object.entries(localStorage)))).not.toContain('Fixture reset passphrase');
});

test('Admin can explicitly publish a narrow Guest projection and issue a password only by email',async({page})=>{
  const {calls,record}=await mock(page);await page.goto('/?view=equipment-detail&id='+record.asset_id);
  const publish=page.locator('[data-equipment-public]');await expect(publish).toHaveText('เปิดให้ Guest ดู');await expect(publish).toBeEnabled();await publish.click();
  await page.locator('#confirm-modal [data-confirm-accept]').click();await expect(publish).toHaveText('ปิดการแสดงต่อ Guest');
  const input=calls.find(call=>call.method==='adminSetEquipmentPublic').args[0];expect(input).toMatchObject({assetId:record.asset_id,isPublic:true,expectedVersion:1});
  await page.goto('/?view=admin&tab=users');const temporary=page.locator('[data-temporary-user]').last();await expect(temporary).toBeVisible();await temporary.click();
  await page.locator('#confirm-modal [data-confirm-accept]').click();await expect.poll(()=>calls.filter(call=>call.method==='adminIssueTemporaryPassword').length).toBe(1);
  expect(Object.keys(calls.find(call=>call.method==='adminIssueTemporaryPassword').args[0]).sort()).toEqual(['commandId','userId']);
  await expect(page.locator('.toast').last()).toContainText('ส่งและเปิดใช้รหัสชั่วคราวแล้ว');
});
