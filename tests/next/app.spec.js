const {test,expect}=require('@playwright/test');
const {mkdirSync}=require('node:fs');
const {bootstrappedHarness,createEquipment}=require('../backend/test-helpers.cjs');
const canonical='https://example.test';
async function mock(page){
  const harness=bootstrappedHarness();const record=createEquipment(harness);
  const session=harness.records('Users').find(row=>row.role==='ADMIN');
  const calls=[];
  await page.addInitScript(()=>sessionStorage.setItem('crs.auth.session.v1',JSON.stringify({version:1,token:'session1_'+'a'.repeat(43),expiresAt:Math.floor(Date.now()/1000)+600})));
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();calls.push(input);
    let response;
    if(input.method==='prepareEquipmentImage') response={ok:true,data:{resourceId:'storage-file',uploadUrl:'https://test.supabase.co/storage/v1/object/upload/sign/crs-images/test?token=private'}};
    else if(input.method==='finalizeEquipmentImage') response={ok:true,data:{...record,row_version:2,imageAvailable:true,image_url:'/api/image-placeholder',included_items:[]}};
    else if(input.method==='getEquipmentImage') response={ok:true,data:{available:true,mime_type:'image/png',row_version:record.row_version,signed_url:'https://test.supabase.co/storage/v1/object/sign/crs-images/test?token=private'}};
    else {
      response=harness.invoke(input.method,...input.args);
      if(input.method==='getAppBootstrap' && response.ok) response.data.app.webAppUrl=canonical;
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

test('glass login is responsive, keyboard accessible and retains the Google-only sign-in contract',async({page})=>{
  // No cloud request or authentication bypass; the signed-out shell needs no identity.
  for (const viewport of [{width:1440,height:960},{width:768,height:720},{width:390,height:844},{width:320,height:600}]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('#access-state')).toBeVisible();
    await expect(page.locator('.login-layout')).toBeVisible();
    await expect(page.locator('#access-state-title')).toHaveText('ลงชื่อเข้าใช้ด้วย Google');
    await expect(page.locator('#google-signin-button')).toBeEnabled();
    await expect(page.locator('#oauth-handoff-panel')).toBeHidden();
    await expect(page.locator('.login-security-note')).toContainText('รหัสใช้ครั้งเดียว');
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
