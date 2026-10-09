const {test,expect}=require('@playwright/test');
const {mkdirSync}=require('node:fs');
const {bootstrappedHarness,createEquipment}=require('../backend/test-helpers.cjs');
const canonical='https://example.test';
test.beforeEach(async({page})=>{
  // No Google requests/real CAPTCHA solving in deterministic UI tests.
  await page.route('**/api/auth/recaptcha',route=>route.fulfill({json:{siteKey:'fixture-public-site-key-000000',actions:{login:'password_login',reset:'password_reset'}}}));
  await page.addInitScript(()=>{let serial=0;window.fixtureCaptchaActions=[];window.grecaptcha={ready:callback=>callback(),execute:async(_key,{action})=>{window.fixtureCaptchaActions.push(action);return 'fixture-fresh-proof-'+(++serial);}};});
  // Auto Guest loading in UI tests must never use the operator's live database.
  // Individual public fixtures registered later override this deterministic default.
  await page.route('**/api/rpc',async route=>{
    if(route.request().postDataJSON().method==='listPublicEquipment')await route.fulfill({json:{ok:true,data:{items:[],page:1,total:0,totalPages:1}}});
    else await route.fallback();
  });
});
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
    await Promise.all(document.getAnimations().filter(animation=>animation.effect.getTiming().iterations!==Infinity&&!animation.effect.target?.closest('.magic-grid-pattern')).map(animation=>animation.finished.catch(()=>{})));
  });
  await page.screenshot({ path: 'test-results/ui/' + name + '.png', fullPage: true });
}

async function expectNoOverflow(page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - innerWidth);
  expect(overflow).toBeLessThanOrEqual(1);
}

async function openLogin(page) {
  if (!await page.locator('#login-email').isVisible()) {
    await page.locator('#guest-equipment [data-experience-action="login"]').click();
  }
  await expect(page.locator('#login-email')).toBeVisible();
}

test('Login restores the earlier story/card illustration while retaining current sign-in controls across themes/languages/breakpoints',async({page})=>{
  await mock(page,{signedOut:true});await page.goto('/');await openLogin(page);
  await expect(page.locator('#access-state-eyebrow')).toHaveCount(0);
  await expect(page.locator('.login-story .login-kicker')).toBeVisible();
  await expect(page.locator('.login-story .brand-mark img')).toHaveAttribute('src','/brand/icon-yuemkuen.png');
  await expect(page.locator('.login-story canvas,.login-glass-scene,.login-story-footer,.login-foil')).toHaveCount(0);
  const shell=await (await page.request.get('/')).text();
  expect(shell).toContain('.login-kicker');expect(shell).not.toContain('/crs/login-scene.js');
  expect(shell).toContain('/crs/recaptcha.js');
  expect((await page.request.get('/crs/login-scene.js')).status()).toBe(404);
  expect(await page.evaluate(()=>typeof window.CRSLoginScene)).toBe('undefined');
  for(const width of [320,390,768,1440])for(const theme of ['light','dark'])for(const language of ['th','en']){
    await page.setViewportSize({width,height:900});await page.evaluate(({theme,language})=>{window.CRS.theme.apply(theme,true);window.CRS.language.set(language);},{theme,language});
    await expect(page.locator('.login-story .login-kicker')).toBeVisible();
    await expect(page.locator('.login-kicker')).toHaveText(language==='th'?'อุปกรณ์พร้อมใช้ มีไหมนั่นอีกเรื่อง':'Equipment ready. Available? That’s another story.');
    await expect(page.locator('[data-experience-text="securityNote"]')).toHaveText(language==='th'?'ช่วยป้องกันสแปมด้วย reCAPTCHA ของ Google':'Google reCAPTCHA helps protect against spam');
    for(const selector of ['.login-art-card','.login-art-chip-qr','.login-art-chip-return']){
      if(width>=768)await expect(page.locator(selector)).toBeVisible();else await expect(page.locator(selector)).toBeHidden();
    }
    const styles=await page.evaluate(()=>{
      const password=getComputedStyle(document.querySelector('#password-login-submit')),google=getComputedStyle(document.querySelector('#google-signin-button'));
      return {password:password.borderRadius,google:google.borderRadius,title:document.querySelector('#access-state-title').getBoundingClientRect().height,headline:getComputedStyle(document.querySelector('.login-headline')).marginTop};
    });
    expect(styles.password).toBe(styles.google);expect(styles.title).toBeGreaterThan(0);expect(styles.headline).toBe('0px');await expectNoOverflow(page);
  }
  await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:1440,height:900});
  await expect(page.locator('.login-art-card')).toBeVisible();await expect(page.locator('.login-art-card')).toHaveCSS('animation-name','none');
  await captureUi(page,'login-story-restored-desktop-dark');
  await page.evaluate(()=>window.CRS.theme.apply('light',true));await captureUi(page,'login-story-restored-desktop-light');
  await page.setViewportSize({width:390,height:844});await captureUi(page,'login-story-restored-mobile');
});

test('original Login illustration responds to mouse with bounded 3D tilt and independent depth without moving text or controls',async({page})=>{
  await mock(page,{signedOut:true});await page.setViewportSize({width:1440,height:1000});await page.goto('/');await openLogin(page);
  await page.evaluate(async()=>{await Promise.all(document.getAnimations().filter(animation=>animation.effect.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})));});
  const story=page.locator('.login-story'),art=page.locator('.login-art');
  const stationary=await page.locator('.login-headline,#password-login-form').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}));
  const bounds=await page.locator('.login-art-stage').boundingBox();
  for(const direction of [-1,1]){
    await page.mouse.move(bounds.x+bounds.width*(direction<0?.25:.75),bounds.y+bounds.height*(direction<0?.25:.75));
    await expect(art).toHaveClass(/is-parallax-active/);
    await expect.poll(()=>art.evaluate((node,sign)=>Number(node.style.getPropertyValue('--login-parallax-x'))*sign,direction)).toBeCloseTo(.5,2);
    await expect.poll(()=>art.evaluate((node,sign)=>Number(node.style.getPropertyValue('--login-parallax-y'))*sign,direction)).toBeCloseTo(.5,2);
    await expect.poll(()=>art.evaluate(node=>new DOMMatrixReadOnly(getComputedStyle(node).transform).is2D)).toBe(false);
    await expect.poll(()=>page.locator('.login-art-card').evaluate((node,sign)=>parseFloat(getComputedStyle(node).translate)*sign,direction)).toBeCloseTo(4,1);
    await expect.poll(()=>page.locator('.login-art-chip-qr').evaluate((node,sign)=>parseFloat(getComputedStyle(node).translate)*sign,direction)).toBeCloseTo(6,1);
    await expect.poll(()=>page.locator('.login-art-chip-return').evaluate((node,sign)=>parseFloat(getComputedStyle(node).translate)*sign,direction)).toBeCloseTo(8,1);
    expect(await page.locator('.login-headline,#password-login-form').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};}))).toEqual(stationary);
    await expect(art).toHaveAttribute('aria-hidden','true');await expect(art).toHaveCSS('pointer-events','none');await expectNoOverflow(page);
  }
  await captureUi(page,'login-story-mouse-tilt-desktop');
  await page.locator('.login-layout').evaluate(node=>{node.style.transform='scale(.9)';node.style.transformOrigin='top left';});
  const scaled=await page.locator('.login-art-stage').boundingBox();await page.mouse.move(scaled.x+scaled.width*.75,scaled.y+scaled.height*.75);
  await expect.poll(()=>art.evaluate(node=>Number(node.style.getPropertyValue('--login-parallax-x')))).toBeCloseTo(.5,2);
  await expect.poll(()=>art.evaluate(node=>Number(node.style.getPropertyValue('--login-parallax-y')))).toBeCloseTo(.5,2);
  await page.mouse.move(0,0);await expect(art).not.toHaveClass(/is-parallax-active/);
  await expect.poll(()=>art.evaluate(node=>{const m=new DOMMatrixReadOnly(getComputedStyle(node).transform);return Math.abs(m.m12)+Math.abs(m.m13)+Math.abs(m.m23);})).toBeLessThan(.001);
  await expect(page.locator('.login-art-card')).toHaveCSS('translate','0px');
  const rotation=await page.locator('.login-art-card').evaluate(node=>{const m=new DOMMatrixReadOnly(getComputedStyle(node).transform);return Math.atan2(m.b,m.a)*180/Math.PI;});
  expect(rotation).toBeCloseTo(-6,1);
});

test('blocked parallax script keeps static artwork, translated copy, Guest entry and Login controls usable',async({page})=>{
  const {calls}=await mock(page,{signedOut:true}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/crs/login-parallax.js',route=>route.abort());
  await page.goto('/');await expect(page.locator('.guest-showcase')).toBeVisible();await openLogin(page);
  await expect(page.locator('.login-kicker')).toHaveText('อุปกรณ์พร้อมใช้ มีไหมนั่นอีกเรื่อง');
  await expect(page.locator('[data-experience-text="securityNote"]')).toHaveText('ช่วยป้องกันสแปมด้วย reCAPTCHA ของ Google');
  await expect(page.locator('#password-login-submit')).toBeEnabled();await expect(page.locator('#google-signin-button')).toBeEnabled();
  await page.locator('.login-story').dispatchEvent('pointermove',{pointerType:'mouse',clientX:400,clientY:450});
  await expect(page.locator('.login-art')).not.toHaveClass(/is-parallax-active/);
  expect(calls.some(call=>['getAppBootstrap','listEquipment','createBorrowRequest'].includes(call.method))).toBe(false);expect(errors).toEqual([]);
});

test('Login parallax resets on viewport/visibility changes, reduced motion, Guest handoff and unmount',async({page})=>{
  await mock(page,{signedOut:true});await page.setViewportSize({width:1440,height:1000});await page.goto('/');await openLogin(page);
  const story=page.locator('.login-story'),art=page.locator('.login-art');
  // Media/IntersectionObserver delivery is asynchronous after a viewport change;
  // keep moving like a real pointer until the eligible view is listening again.
  const move=async()=>{await expect.poll(async()=>{const bounds=await page.locator('.login-art-stage').boundingBox();await story.dispatchEvent('pointermove',{pointerType:'mouse',clientX:bounds.x+bounds.width*.75,clientY:bounds.y+bounds.height*.75});return art.evaluate(node=>node.classList.contains('is-parallax-active'));}).toBe(true);};
  await move();await page.locator('#access-state').evaluate(node=>node.hidden=true);await expect(art).not.toHaveClass(/is-parallax-active/);
  await page.locator('#access-state').evaluate(node=>node.hidden=false);await move();
  await move();await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await expect(art).not.toHaveClass(/is-parallax-active/);
  await move();await page.locator('#access-state').evaluate(node=>node.dispatchEvent(new Event('scroll')));await expect(art).not.toHaveClass(/is-parallax-active/);
  await move();await page.emulateMedia({reducedMotion:'reduce'});await expect(art).not.toHaveClass(/is-parallax-active/);
  await story.dispatchEvent('pointermove',{pointerType:'mouse',clientX:400,clientY:450});await expect(art).toHaveCSS('transform','none');
  await page.emulateMedia({reducedMotion:'no-preference'});await move();await page.setViewportSize({width:390,height:844});await expect(art).not.toHaveClass(/is-parallax-active/);await expect(art).toBeHidden();
  await page.setViewportSize({width:1440,height:1000});await move();
  await page.locator('.entry-navigation [data-experience-action="home"]').click();await expect(page.locator('.guest-showcase')).toBeVisible();await expect(art).not.toHaveClass(/is-parallax-active/);
  await openLogin(page);await move();
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});await expect(art).not.toHaveClass(/is-parallax-active/);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await move();
  const removed=await story.evaluateHandle(node=>{node.remove();return node;});
  await expect.poll(()=>removed.evaluate(node=>node.querySelector('.login-art').style.getPropertyValue('--login-parallax-x'))).toBe('');
  await removed.evaluate(node=>node.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:400,clientY:450})));
  expect(await removed.evaluate(node=>node.querySelector('.login-art').classList.contains('is-parallax-active'))).toBe(false);await removed.dispose();
});

test('password attempts get fresh action-bound reCAPTCHA proofs, clear inputs and never store a proof',async({page})=>{
  await mock(page,{signedOut:true});const inputs=[];
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();if(input.method!=='passwordSignIn')return route.fallback();inputs.push(input.args[0]);
    await route.fulfill({json:{ok:false,error:{code:'LOGIN_INVALID',message:'Fixture invalid login'}}});
  });
  await page.goto('/');await openLogin(page);
  for(let i=0;i<2;i++){
    await page.locator('#login-email').fill('authorized@example.test');await page.locator('#login-password').fill('Synthetic passphrase only!');
    await page.locator('#password-login-submit').click();await expect(page.locator('#password-login-error')).toHaveText('Fixture invalid login');
    await expect(page.locator('#login-password')).toHaveValue('');
  }
  expect(inputs.map(input=>input.recaptchaToken)).toEqual(['fixture-fresh-proof-1','fixture-fresh-proof-2']);
  expect(await page.evaluate(()=>window.fixtureCaptchaActions)).toEqual(['password_login','password_login']);
  expect(await page.evaluate(()=>JSON.stringify([Object.entries(sessionStorage),Object.entries(localStorage)]))).not.toContain('fixture-fresh-proof');
  await expect(page.locator('#google-signin-button')).toBeEnabled();
});

test('blocked CAPTCHA fails closed without a password/reset RPC; Google OAuth transport does not require CAPTCHA',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});
  await page.route('**/api/auth/recaptcha',route=>route.fulfill({status:503,json:{error:'RECAPTCHA_UNAVAILABLE'}}));
  await page.route('**/api/rpc',async route=>{
    if(route.request().postDataJSON().method==='beginOAuthSignIn')return route.fulfill({json:{ok:true,data:{fixtureOAuthStart:true}}});
    await route.fallback();
  });
  await page.goto('/');await openLogin(page);await page.locator('#login-email').fill('authorized@example.test');await page.locator('#login-password').fill('Synthetic passphrase only!');
  await page.locator('#password-login-submit').click();await expect(page.locator('#password-login-error')).toContainText('Google');
  expect(calls.some(call=>call.method==='passwordSignIn')).toBe(false);await expect(page.locator('#login-password')).toHaveValue('');
  await page.locator('[data-experience-action="reset-password"]').click();await page.locator('#reset-email').fill('authorized@example.test');
  await page.locator('[data-experience-action="request-password-otp"]').click();await expect(page.locator('[data-password-status]')).toContainText('Google');
  expect(calls.some(call=>call.method==='requestPasswordOtp')).toBe(false);await expect(page.locator('#google-signin-button')).toBeEnabled();
  const result=await page.evaluate(()=>window.CRS_SERVER_RPC('beginOAuthSignIn',[{fixture:'no-session'}]));expect(result.data.fixtureOAuthStart).toBe(true);
  expect(await page.evaluate(()=>window.fixtureCaptchaActions)).toEqual([]);
});

test('anonymous reset gets the distinct CAPTCHA action; session-bound security change does not execute it',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});await page.goto('/');await openLogin(page);
  await page.locator('[data-experience-action="reset-password"]').click();await page.locator('#reset-email').fill('authorized@example.test');
  await page.locator('[data-experience-action="request-password-otp"]').click();await expect(page.locator('#password-email-otp')).toBeVisible();
  expect(calls.find(call=>call.method==='requestPasswordOtp').args[0].recaptchaToken).toBe('fixture-fresh-proof-1');
  await page.evaluate(()=>window.CRS_SERVER_RPC('requestPasswordOtp',['session1_fixture',{purpose:'CHANGE'}]));
  expect(await page.evaluate(()=>window.fixtureCaptchaActions)).toEqual(['password_reset']);
  expect(calls.filter(call=>call.method==='requestPasswordOtp')[1].args[0]).not.toHaveProperty('recaptchaToken');
});

test('blocked CAPTCHA SDK and rejected execution stay lazy, fail closed and never reflect provider errors',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});let scriptLoads=0;
  await page.addInitScript(()=>{delete window.grecaptcha;});
  await page.route('https://www.google.com/recaptcha/api.js?render=*',route=>{scriptLoads++;return route.abort();});
  await page.goto('/');await openLogin(page);expect(scriptLoads).toBe(0);
  for(let attempt=0;attempt<2;attempt++){
    if(attempt)await page.evaluate(()=>{window.grecaptcha={ready:callback=>callback(),execute:()=>Promise.reject(new Error('fixture-provider-error-must-not-be-reflected'))};});
    await page.locator('#login-email').fill('authorized@example.test');await page.locator('#login-password').fill('Synthetic passphrase only!');
    await page.locator('#password-login-submit').click();await expect(page.locator('#password-login-error')).toContainText('Google');
    await expect(page.locator('#password-login-error')).not.toContainText('fixture-provider-error');
    await expect(page.locator('#login-password')).toHaveValue('');await expect(page.locator('#google-signin-button')).toBeEnabled();
    expect(calls.some(call=>call.method==='passwordSignIn')).toBe(false);
  }
  expect(scriptLoads).toBe(1);
});

test('Magic Card spotlight uses real card coordinates after scrolling/scaling and removes the old cursor',async({page})=>{
  await mock(page,{signedOut:true});
  await page.route('**/*.woff2',route=>route.abort());
  await page.setViewportSize({width:1440,height:600});
  await page.emulateMedia({reducedMotion:'no-preference'});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await openLogin(page);
  await expect(page.locator('.liquid-glass-cursor')).toHaveCount(0);
  await page.locator('.login-layout').evaluate(node=>node.style.animation='none');
  if(process.env.CRS_UI_CAPTURE==='1')for(const theme of ['light','dark']){
    await page.evaluate(value=>window.CRS.theme.apply(value,true),theme);
    const bounds=await page.locator('.access-card').boundingBox();await page.mouse.move(bounds.x+150,bounds.y+150);
    await captureUi(page,'magic-card-'+theme);
  }
  for(const fontSize of [16,20]) {
    await page.evaluate(size=>document.documentElement.style.fontSize=size+'px',fontSize);
    await page.locator('#access-state').evaluate((node,size)=>node.scrollTo({top:size===16?0:120,behavior:'instant'}),fontSize);
    const card=page.locator('.access-card'),bounds=await card.boundingBox();
    const pointer={x:bounds.x+140,y:Math.max(100,bounds.y+140)};
    await page.mouse.move(pointer.x,pointer.y);
    await expect(card).toHaveAttribute('data-magic-card-active','true');
    await expect.poll(()=>card.evaluate(node=>getComputedStyle(node,'::after').opacity)).toBe('0.25');
    const distance=()=>card.evaluate((node,point)=>{
      const r=node.getBoundingClientRect(),s=getComputedStyle(node),x=parseFloat(s.getPropertyValue('--magic-x')),y=parseFloat(s.getPropertyValue('--magic-y'));
      return Math.hypot(r.left+x*r.width/node.offsetWidth-point.x,r.top+y*r.height/node.offsetHeight-point.y);
    },pointer);
    await expect.poll(distance,{message:'Magic Card spotlight must match actual pointer coordinates'}).toBeLessThan(2);
    await page.locator('#access-state').evaluate(node=>node.scrollTop+=40);
    await expect.poll(distance,{message:'Scroll must realign the spotlight without another mouse move'}).toBeLessThan(2);
  }
  for(const theme of ['light','dark']){
    await page.evaluate(value=>window.CRS.theme.apply(value,true),theme);
    const contrast=await page.evaluate(()=>{
      const s=getComputedStyle(document.documentElement),rgb=name=>[1,3,5].map(i=>parseInt(s.getPropertyValue('--crs-'+name).trim().slice(i,i+2),16));
      const luminance=channels=>channels.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const background=rgb('surface').map((v,i)=>v*.75+rgb('pink-soft')[i]*.25),b=luminance(background);
      return Math.min(...['ink','heading','label','muted'].map(name=>{const f=luminance(rgb(name));return (Math.max(f,b)+.05)/(Math.min(f,b)+.05);}));
    });
    expect(contrast,'Magic Card maximum spotlight '+theme).toBeGreaterThanOrEqual(4.5);
  }
  await page.locator('.login-layout').evaluate(node=>{node.style.transform='scale(.9)';node.style.transformOrigin='top left';});
  const scaled=await page.locator('.access-card').boundingBox(),point={x:scaled.x+140,y:Math.max(100,scaled.y+140)};
  await page.mouse.move(point.x,point.y);
  await expect.poll(()=>page.locator('.access-card').evaluate((node,p)=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return Math.hypot(r.left+parseFloat(s.getPropertyValue('--magic-x'))*r.width/node.offsetWidth-p.x,r.top+parseFloat(s.getPropertyValue('--magic-y'))*r.height/node.offsetHeight-p.y);},point)).toBeLessThan(2);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await expect(page.locator('.access-card')).not.toHaveAttribute('data-magic-card-active','true');
  const removed=await page.locator('.access-card').elementHandle();await page.locator('.access-card').evaluate(node=>node.remove());
  await expect.poll(()=>removed.evaluate(node=>node.classList.contains('magic-card'))).toBe(false);
  expect(await removed.evaluate(node=>node.style.getPropertyValue('--magic-x'))).toBe('');await removed.dispose();
});

test('Guest is signed-out home; separate Login moves the logo to brand marks and removes duplicate card actions',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('.guest-showcase')).toBeVisible();
  await expect(page.locator('#access-state')).toBeHidden();
  await expect(page.locator('#app-shell')).toBeHidden();
  await expect(page.locator('#guest-equipment .brand-mark img')).toBeVisible();
  expect(calls.filter(call=>call.method==='listPublicEquipment')).toHaveLength(1);
  expect(calls.some(call=>['getAppBootstrap','listEquipment','getEquipmentDetail','getEquipmentImage','createBorrowRequest'].includes(call.method))).toBe(false);
  await openLogin(page);
  await expect(page.locator('.guest-showcase')).toBeHidden();
  await expect(page.locator('.login-logo')).toHaveCount(0);
  await expect(page.locator('.login-brand .brand-mark img')).toBeVisible();
  await expect(page.locator('.access-card [data-experience-action="guest"],.access-card [data-experience-action="login"],.access-card [data-experience-action="guide"]')).toHaveCount(0);
  await page.locator('#login-password').fill('Fixture secret cleared on home!');
  await page.locator('.entry-navigation [data-experience-action="home"]').click();
  await expect(page.locator('.guest-showcase')).toBeVisible();
  await expect(page.locator('#login-password')).toHaveValue('');
  await expect(page.locator('#access-state')).toBeHidden();
  expect(calls.filter(call=>call.method==='listPublicEquipment')).toHaveLength(1);
  await expectNoOverflow(page);
});

test('Login hints translate with real language and pill hover is scoped, readable and reduced-motion safe',async({page})=>{
  await mock(page,{signedOut:true});await page.goto('/',{waitUntil:'domcontentloaded'});await openLogin(page);
  await expect(page.locator('#login-email')).toHaveAttribute('placeholder','กรอกอีเมลของคุณ');
  await expect(page.locator('#login-password')).toHaveAttribute('placeholder','กรอกรหัสผ่านของคุณ');
  await page.locator('.login-controls [data-experience-action="language"]').click();
  await expect(page.locator('#login-email')).toHaveAttribute('placeholder','Enter your email');
  await expect(page.locator('#login-password')).toHaveAttribute('placeholder','Enter your password');
  const submit=page.locator('#password-login-submit'),google=page.locator('#google-signin-button');
  for(const theme of ['light','dark']) {
    await page.evaluate(theme=>window.CRS.theme.apply(theme,true),theme);
    expect(await submit.evaluate(node=>getComputedStyle(node).borderRadius)).toBe(await page.locator('#google-signin-button').evaluate(node=>getComputedStyle(node).borderRadius));
    await submit.hover();await expect(submit).toHaveCSS('background-color','rgb(35, 196, 131)');
    await expect(submit).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, -7)');
    const contrast=await submit.evaluate(node=>{
      const s=getComputedStyle(node),rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
      const lum=channels=>channels.map(value=>value/255).map(value=>value<=.04045?value/12.92:((value+.055)/1.055)**2.4).reduce((sum,value,index)=>sum+value*[.2126,.7152,.0722][index],0);
      const [hi,lo]=[lum(rgb(s.color)),lum(rgb(s.backgroundColor))].sort((a,b)=>b-a);return(hi+.05)/(lo+.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await google.hover();await expect(google).not.toHaveCSS('background-color','rgb(35, 196, 131)');
  }
  await page.emulateMedia({reducedMotion:'reduce'});await submit.hover();
  await expect(submit).toHaveCSS('transform','none');
  expect(await submit.evaluate(node=>parseFloat(getComputedStyle(node).transitionDuration))).toBeLessThanOrEqual(.001);
  await submit.evaluate(node=>node.disabled=true);await expect(submit).toBeDisabled();
});

test('a delayed public response cannot reopen Guest after the user selects Login',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});let release;
  const delayed=new Promise(resolve=>release=resolve);
  await page.route('**/api/rpc',async route=>{
    if(route.request().postDataJSON().method!=='listPublicEquipment')return route.fallback();
    await delayed;await route.fulfill({json:{ok:true,data:{items:[],page:1,total:0,totalPages:1}}});
  });
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('[data-guest-content]')).toHaveAttribute('aria-busy','true');
  await openLogin(page);
  const completed=page.waitForResponse(response=>response.url().endsWith('/api/rpc')&&response.request().postDataJSON().method==='listPublicEquipment');
  release();await completed;
  await expect(page.locator('#access-state')).toBeVisible();await expect(page.locator('.guest-showcase')).toBeHidden();
  await expect(page.locator('.guest-glass-scene')).toHaveCount(0);
  expect(calls.some(call=>['listEquipment','getEquipmentDetail','createBorrowRequest'].includes(call.method))).toBe(false);
});

test('public home stays responsive in both themes/languages; signing out returns to Guest',async({page})=>{
  await mock(page,{signedOut:true});
  await page.goto('/',{waitUntil:'domcontentloaded'});
  await expect(page.locator('[data-guest-borrow]')).toBeVisible();
  for(const width of [320,390,768,1440])for(const theme of ['light','dark'])for(const language of ['th','en']){
    await page.setViewportSize({width,height:844});
    await page.evaluate(({theme,language})=>{window.CRS.theme.apply(theme,true);window.CRS.language.set(language);},{theme,language});
    await expect(page.locator('#guest-title')).toHaveText(language==='th'?'อุปกรณ์สาธารณะ':'Public equipment');
    await expect(page.locator('.guest-controls [data-experience-action="language"]')).toHaveText(language==='th'?'TH':'EN');
    await expect(page.locator('.guest-controls [data-experience-action="login"]')).toBeInViewport();
    await expectNoOverflow(page);
    if(width===390||width===1440)await captureUi(page,'guest-'+theme+'-'+language+'-'+width);
  }
  await openLogin(page);
  await page.locator('#login-email').fill('admin@example.test');await page.locator('#login-password').fill('Fixture passphrase only!');
  await page.locator('#password-login-submit').click();await expect(page.locator('#dashboard-content')).toBeVisible();
  await page.evaluate(()=>window.CRS.auth.signOut());
  await expect(page.locator('.guest-showcase')).toBeVisible();await expect(page.locator('#app-shell')).toBeHidden();
  await expect(page.locator('#access-state')).toBeHidden();await expect(page.locator('#login-password')).toHaveValue('');
});

test('glass login is responsive, keyboard accessible and offers linked Password and Google sign-in',async({page})=>{
  // No cloud request or authentication bypass; the signed-out shell needs no identity.
  for (const viewport of [{width:1440,height:960},{width:768,height:720},{width:390,height:844},{width:320,height:600}]) {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await openLogin(page);
    await expect(page.locator('#access-state')).toBeVisible();
    await expect(page.locator('.login-layout')).toBeVisible();
    await expect(page.locator('#access-state-title')).toHaveText('เข้าสู่ระบบ');
    await expect(page.locator('#google-signin-button')).toBeEnabled();
    await expect(page.locator('#oauth-handoff-panel')).toBeHidden();
    await expect(page.locator('.login-security-note')).toContainText('ช่วยป้องกันสแปมด้วย reCAPTCHA ของ Google');
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
    await expect(page.locator('.login-brand .brand-mark img')).toBeInViewport();
    await expect(page.locator('#theme-toggle-login')).toBeInViewport();
    const top=await page.locator('.login-layout').evaluate(element=>element.getBoundingClientRect().top);
    expect(top).toBeGreaterThanOrEqual(0);
    if(viewport.width===1440||viewport.width===390) await captureUi(page,'login-light-'+viewport.width);
  }
  await page.setViewportSize({width:1440,height:960});
  await page.evaluate(()=>localStorage.setItem('crs-theme','dark'));
  await page.reload();
  await openLogin(page);
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
  await openLogin(page);
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
  await page.goto('/');await openLogin(page);await expect(page.locator('#password-login-form')).toBeVisible();
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
  await expect(page.locator('#guest-equipment')).toBeVisible();
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
  await openLogin(page);
  await expect(page.locator('.liquid-glass-cursor')).toBeHidden();await expect(page.locator('.login-foil')).toHaveCount(0);
  const location=await page.locator('#theme-toggle-login').evaluate(node=>{const style=getComputedStyle(node.querySelector('i'));return{inside:!!node.closest('.access-card'),align:style.alignItems,justify:style.justifyContent};});expect(location.inside).toBe(true);expect(location.align).toBe('center');expect(location.justify).toBe('center');
  await page.locator('.access-card [data-experience-action="language"]').click();await expect(page.locator('#access-state-title')).toHaveText('Sign in');await expect(page.locator('label[for="login-email"]')).toHaveText('Email');
  await page.evaluate(()=>window.CRS.theme.apply('dark',true));
  await expect(page.locator('html')).toHaveAttribute('data-bs-theme','dark');
  await page.locator('#access-state').evaluate(element=>element.scrollTo({top:0,behavior:'instant'}));
  await expect(page.locator('.login-brand .brand-mark img')).toBeInViewport();await expectNoOverflow(page);
  await captureUi(page,'login-dark-en-mobile-top');
  await page.locator('.login-footer').scrollIntoViewIfNeeded();
  await captureUi(page,'login-dark-en-mobile-bottom');
  await mock(page);await page.goto('/?view=equipment');await expect(page.locator('#equipment-search')).toBeVisible();
  for(const theme of ['light','dark']){await page.evaluate(theme=>window.CRS.theme.apply(theme,true),theme);const radii=await page.locator('#equipment-search').evaluate(node=>{const s=getComputedStyle(node);return [s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius];});expect(new Set(radii).size).toBe(1);}
});

for(const theme of ['light','dark']) {
  test(`borrow search keeps four equal corners and its filtering workflow in ${theme}`,async({page})=>{
    const {calls,record}=await mock(page);
    await page.emulateMedia({reducedMotion:'reduce'});
    for(const width of [1440,1024,390,320]) {
      await page.setViewportSize({width,height:900});await page.goto('/?view=my-borrow');
      await expect(page.locator('#my-borrow-search')).toBeVisible();
      await page.evaluate(theme=>window.CRS.theme.apply(theme,true),theme);
      const geometry=await page.locator('#my-borrow-search').evaluate(node=>{
        const s=getComputedStyle(node),icon=node.parentElement.querySelector('.input-group-text').getBoundingClientRect(),box=node.getBoundingClientRect();
        return{radii:[s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius],padding:parseFloat(s.paddingLeft),iconRight:icon.right-box.left,margin:s.marginLeft};
      });
      expect(new Set(geometry.radii).size).toBe(1);expect(parseFloat(geometry.radii[0])).toBeGreaterThan(0);
      expect(geometry.margin).toBe('0px');expect(geometry.padding).toBeGreaterThan(geometry.iconRight);
      await page.locator('#my-borrow-search').fill(record.asset_id);
      await page.locator('#form-my-borrow-filter [type="submit"]').click();
      await expect.poll(()=>calls.filter(call=>call.method==='listMyBorrowing'&&call.args[0]?.search===record.asset_id).length).toBeGreaterThan(0);
      await expect(page.locator('#my-borrow-search')).toHaveValue(record.asset_id);await expectNoOverflow(page);
      if(width===1440||width===390)await captureUi(page,`rounded-borrow-${theme}-${width}`);
    }
  });

  test(`account and sidebar nested corners remain concentric, keyboard-accessible and responsive in ${theme}`,async({page})=>{
    await mock(page);await page.emulateMedia({reducedMotion:'reduce'});
    for(const width of [1440,1024,390,320]) {
      await page.setViewportSize({width,height:900});await page.goto('/?view=dashboard');
      await expect(page.locator('#dashboard-content')).toBeVisible();
      await page.evaluate(theme=>window.CRS.theme.apply(theme,true),theme);
      const desktop=width>=992;
      if(!desktop) {
        // Mobile intentionally keeps the Account route, not a new popover entry.
        const account=page.locator('#mobile-nav [data-route="account"]');await account.focus();await account.press('Enter');
        await expect(page.locator('#account-heading')).toBeVisible();await expect(page.locator('#account-menu-panel')).toBeHidden();
        for(const [selector,radius]of[['#account-menu-panel','16px'],['#account-menu-header','12px']]) {
          const corners=await page.locator(selector).evaluate(node=>{const s=getComputedStyle(node);return[s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius];});
          expect(corners).toEqual([radius,radius,radius,radius]);
        }
        await expectNoOverflow(page);if(width===390)await captureUi(page,`rounded-account-${theme}-mobile`);continue;
      }
      const toggle=page.locator('#desktop-sidebar-toggle');
      // Sidebar preference persists across route reloads and viewport changes.
      if(desktop&&await toggle.getAttribute('aria-pressed')==='true') {await toggle.focus();await toggle.press('Enter');await expect(page.locator('#app-shell')).not.toHaveClass(/is-sidebar-collapsed/);}
      for(const collapsed of desktop?[false,true]:[false]) {
        if(collapsed) {await toggle.focus();await toggle.press('Enter');await expect(page.locator('#app-shell')).toHaveClass(/is-sidebar-collapsed/);}
        const trigger=page.locator(desktop?'#desktop-sidebar .account-summary':'#mobile-nav [data-route="account"]');
        await trigger.focus();await trigger.press('Enter');
        await expect(page.locator('#account-menu-panel')).toBeVisible();
        await expect(page.locator('#account-menu-header')).toBeFocused();
        const geometry=await page.evaluate(()=>{
          const corners=node=>{const s=getComputedStyle(node);return[s.borderTopLeftRadius,s.borderTopRightRadius,s.borderBottomLeftRadius,s.borderBottomRightRadius].map(parseFloat);};
          const panel=document.getElementById('account-menu-panel'),profile=document.getElementById('account-menu-header'),s=getComputedStyle(panel);
          const sidebar=document.getElementById('desktop-sidebar'),footer=sidebar.querySelector('.sidebar-footer');
          const focus=getComputedStyle(profile);
          return{outer:corners(panel),inner:corners(profile),inset:parseFloat(s.paddingLeft)+parseFloat(s.borderLeftWidth),sidebar:corners(sidebar),header:corners(sidebar.querySelector('.sidebar-header')),footer:corners(footer),summary:corners(footer.querySelector('.account-summary')),footerInset:parseFloat(getComputedStyle(footer).paddingLeft),sidebarBorder:parseFloat(getComputedStyle(sidebar).borderLeftWidth),focusOutline:focus.outlineWidth,focusExtent:parseFloat(focus.outlineWidth)+parseFloat(focus.outlineOffset),panelPadding:parseFloat(s.paddingLeft)};
        });
        expect(geometry.outer).toEqual([16,16,16,16]);expect(geometry.inner).toEqual([12,12,12,12]);expect(geometry.inset).toBe(4);
        expect(geometry.outer[0]-geometry.inner[0]).toBe(geometry.inset);expect(parseFloat(geometry.focusOutline)).toBeGreaterThan(0);
        expect(geometry.focusExtent).toBeLessThanOrEqual(geometry.panelPadding);
        if(desktop) {
          expect(new Set(geometry.header).size).toBe(1);expect(geometry.footer).toEqual(geometry.header);
          expect(geometry.header[0]).toBe(geometry.sidebar[0]-geometry.sidebarBorder);
          expect(new Set(geometry.summary).size).toBe(1);expect(geometry.summary[0]+geometry.footerInset).toBeCloseTo(geometry.footer[0],2);
          await expect(trigger).toHaveClass(/is-active/);await expect(trigger).toBeInViewport();
        }
        await expectNoOverflow(page);await expect(page.locator('#account-menu-panel')).toBeInViewport();
        if(width===1440||width===390)await captureUi(page,`rounded-account-${theme}-${width}-${collapsed?'collapsed':'expanded'}`);
        await page.locator('#account-menu-header').press('ArrowRight');await expect(page.locator('#account-identity-menu')).toBeVisible();
        await page.locator('#account-identity-menu [role="menuitem"]').first().press('Escape');await expect(page.locator('#account-menu-header')).toBeFocused();
        await page.locator('#account-menu-header').press('Escape');await expect(page.locator('#account-menu-panel')).toBeHidden();await expect(trigger).toBeFocused();
      }
    }
  });
}

test('forgot password modal clears secrets after OTP-verified matching reset; footer links use approved Google policies',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});
  await page.route('**/api/experience',route=>route.fulfill({json:{privacyUrl:'https://policies.google.com/privacy',termsUrl:'https://policies.google.com/terms'}}));
  await page.goto('/');await openLogin(page);await expect(page.locator('.login-footer a')).toHaveCount(2);
  await expect(page.locator('.login-footer [data-experience-action="privacy"]')).toHaveAttribute('href','https://policies.google.com/privacy');
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

test('Login controls use Thai by default, synchronize saved language, center pairs and order actions before theme',async({page})=>{
  await mock(page,{signedOut:true});
  await page.addInitScript(()=>Object.defineProperty(navigator,'language',{value:'en-US',configurable:true}));
  for(const width of [320,390,768,1440])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:900});await page.goto('/');await openLogin(page);
    await page.evaluate(value=>window.CRS.theme.apply(value,true),theme);
    await expect(page.locator('html')).toHaveAttribute('lang','th');
    await expect(page.locator('.login-controls [data-experience-action="language"]')).toHaveText('TH');
    await expect(page.locator('.login-story-footer,.login-foil')).toHaveCount(0);
    await expect(page.locator('#google-signin-button .bi-google')).toHaveCount(0);
    const colors=await page.locator('.google-brand-icon path').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('fill')));
    expect(colors.sort()).toEqual(['#4285F4','#34A853','#FBBC05','#EA4335'].sort());
    const geometry=await page.evaluate(()=>{
      const center=node=>{const b=node.getBoundingClientRect();return b.y+b.height/2;};
      const check=document.querySelector('#remember-session'),label=document.querySelector('[for="remember-session"]'),note=document.querySelector('.login-security-note');
      const control=document.querySelector('.login-controls'),reset=document.querySelector('[data-experience-action="reset-password"]');
      return {remember:Math.abs(center(check)-center(label)),security:Math.abs(center(note.querySelector('i'))-center(note.querySelector('span'))),
        resetRight:Math.abs(reset.getBoundingClientRect().right-document.querySelector('#password-login-form').getBoundingClientRect().right),
        last:control.lastElementChild.id,actionsBefore:control.querySelector('.experience-actions').nextElementSibling.id};
    });
    expect(geometry.remember).toBeLessThan(1);expect(geometry.security).toBeLessThan(1);expect(geometry.resetRight).toBeLessThan(1);
    expect(geometry.last).toBe('theme-toggle-login');expect(geometry.actionsBefore).toBe('theme-toggle-login');await expectNoOverflow(page);
  }
  const language=page.locator('.login-controls [data-experience-action="language"]');
  await language.click();await expect(language).toHaveText('EN');await expect(page.locator('html')).toHaveAttribute('lang','en');
  await page.reload();await openLogin(page);await expect(language).toHaveText('EN');
  await language.click();await expect(language).toHaveText('TH');
  for(const [key,target]of[['privacy','https://policies.google.com/privacy'],['terms','https://policies.google.com/terms']]){
    const link=page.locator('.login-footer [data-experience-action="'+key+'"]');await expect(link).toHaveAttribute('href',target);await expect(link).toHaveAttribute('rel','noopener noreferrer');
  }
});

test('animated remember checkbox preserves native label, keyboard, saved preference and translated name',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});await page.goto('/');await openLogin(page);
  const checkbox=page.locator('#remember-session'),label=page.locator('label[for="remember-session"]'),drawing=page.locator('.remember-session-control .check');
  await expect(page.getByRole('checkbox',{name:'จดจำการเข้าสู่ระบบในอุปกรณ์นี้',exact:true})).toHaveCount(1);
  await expect(checkbox).not.toBeChecked();await expect(drawing).toHaveAttribute('aria-hidden','true');
  await expect(drawing.locator('svg')).toHaveAttribute('focusable','false');
  expect(await checkbox.evaluate(node=>node.labels.length)).toBe(1);
  // Sample both boxes in the same layout/frame while the finite entry animates.
  const {target,art}=await checkbox.evaluate(node=>({target:node.getBoundingClientRect().toJSON(),art:node.parentElement.querySelector('.check').getBoundingClientRect().toJSON()}));
  expect(target.width).toBe(44);expect(target.height).toBe(44);expect(art.width).toBe(18);expect(art.height).toBe(18);
  expect(Math.abs(target.x+target.width/2-art.x-art.width/2)).toBeLessThan(1);
  expect(Math.abs(target.y+target.height/2-art.y-art.height/2)).toBeLessThan(1);
  await label.click();await expect(checkbox).toBeChecked();
  expect(await page.evaluate(()=>localStorage.getItem('crs.auth.remember.v1'))).toBe('true');
  await page.reload();await openLogin(page);await expect(checkbox).toBeChecked();
  await checkbox.focus();await page.keyboard.press('Space');await expect(checkbox).not.toBeChecked();
  await expect(drawing).toHaveCSS('outline-style','solid');await expect(drawing).toHaveCSS('outline-width','3px');
  expect(await page.evaluate(()=>localStorage.getItem('crs.auth.remember.v1'))).toBe('false');
  // The decorative SVG lives outside the label replaced by TH/EN textContent.
  await page.locator('.login-controls [data-experience-action="language"]').click();
  await expect(page.getByRole('checkbox',{name:'Remember sign-in on this device',exact:true})).toHaveCount(1);
  await expect(drawing.locator('svg')).toHaveCount(1);await label.click();await expect(checkbox).toBeChecked();
  await checkbox.evaluate(node=>node.disabled=true);await expect(checkbox).toBeDisabled();
  // Bypass Playwright's disabled-label actionability gate to deliver a real
  // pointer click; the browser itself must refuse native checkbox activation.
  await label.click({force:true});await expect(checkbox).toBeChecked();await expect(drawing).toHaveCSS('opacity','0.5');
  await checkbox.evaluate(node=>node.disabled=false);await checkbox.uncheck();
  await page.reload();await openLogin(page);await expect(checkbox).not.toBeChecked();
  expect(calls.every(call=>['getAppBootstrap','listPublicEquipment'].includes(call.method))).toBe(true);
});

test('remember drawing animates the supplied dash states with theme contrast, reduced motion and native high-contrast fallback',async({page})=>{
  await mock(page,{signedOut:true});await page.goto('/');await openLogin(page);
  const checkbox=page.locator('#remember-session'),drawing=page.locator('.remember-session-control .check'),svg=drawing.locator('svg');
  for(const theme of ['light','dark']) {
    await page.evaluate(value=>window.CRS.theme.apply(value,true),theme);
    await page.emulateMedia({reducedMotion:'no-preference'});
    for(const checked of [false,true]) {
      await checkbox.setChecked(checked);await page.mouse.move(0,0);
      await expect(svg).toHaveCSS('stroke',checked?(theme==='dark'?'rgb(0, 255, 0)':'rgb(24, 122, 32)'):(theme==='dark'?'rgb(194, 204, 216)':'rgb(88, 102, 119)'));
      await expect(svg.locator('path')).toHaveCSS('stroke-dashoffset',checked?'60px':'0px');
      await expect(svg.locator('polyline')).toHaveCSS('stroke-dasharray','22px');
      await expect(svg.locator('polyline')).toHaveCSS('stroke-dashoffset',checked?'42px':'66px');
      const contrast=await svg.evaluate(node=>{
        const style=getComputedStyle(document.documentElement),token=name=>style.getPropertyValue('--crs-'+name).trim();
        const rgb=hex=>[1,3,5].map(index=>parseInt(hex.slice(index,index+2),16));
        const luminance=channels=>channels.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
        const foreground=getComputedStyle(node).stroke.match(/[\d.]+/g).map(Number),glass=token('glass-bg').match(/[\d.]+/g).map(Number);
        return Math.min(...['canvas','blue-mist','pink-mist'].map(name=>{
          const background=rgb(token(name)).map((v,i)=>v*(1-glass[3])+glass[i]*glass[3]);
          const [high,low]=[luminance(foreground),luminance(background)].sort((a,b)=>b-a);return(high+.05)/(low+.05);
        }));
      });
      expect(contrast,theme+' '+checked).toBeGreaterThanOrEqual(3);
      await captureUi(page,'remember-'+theme+'-'+(checked?'checked':'unchecked'));
    }
    await expect(svg.locator('path')).toHaveCSS('transition-duration','0.3s');
    await expect(svg.locator('polyline')).toHaveCSS('transition-delay','0.15s');
    await checkbox.hover();await expect.poll(()=>drawing.evaluate(node=>getComputedStyle(node,'::before').opacity)).toBe('1');
    await page.mouse.move(0,0);await checkbox.blur();
    await expect.poll(()=>drawing.evaluate(node=>getComputedStyle(node,'::before').opacity)).toBe('0');
    await page.emulateMedia({reducedMotion:'reduce'});await checkbox.uncheck();
    await expect(svg.locator('polyline')).toHaveCSS('transition-duration','0s');
    await expect(svg.locator('polyline')).toHaveCSS('transition-delay','0s');
    await expect(svg.locator('polyline')).toHaveCSS('stroke-dashoffset','66px');
    await checkbox.check();await expect(svg.locator('polyline')).toHaveCSS('stroke-dashoffset','42px');
  }
  await page.emulateMedia({forcedColors:'active'});await expect(drawing).toBeHidden();
  await expect(checkbox).toHaveCSS('opacity','1');await expect(checkbox).toHaveCSS('appearance','auto');
  await checkbox.focus();await page.keyboard.press('Space');await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toHaveCSS('outline-width','3px');
});

test('hold-only password reveal masks on outside release, cancellation, blur and hidden tab; click never toggles',async({page})=>{
  await mock(page,{signedOut:true});await page.goto('/');await openLogin(page);const input=page.locator('#login-password'),eye=page.locator('[data-reveal-for="login-password"]');
  // Suppress the browser's native toggle on ALL passwords, including the
  // confirmation field which has no custom reveal button/wrapper.
  expect(await (await page.request.get('/crs/experience.css')).text()).toMatch(/input::-ms-reveal,\.password-field input::-ms-clear\s*\{\s*display:none;/);
  await input.fill('Fixture hold-only passphrase!');await expect(eye).toHaveCount(1);
  const hold=async()=>{await eye.scrollIntoViewIfNeeded();const box=await eye.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await expect(input).toHaveAttribute('type','text');};
  await hold();await page.mouse.move(0,0);await page.mouse.up();await expect(input).toHaveAttribute('type','password');
  for(const action of ['cancel','blur','hidden','focusout','lost']){
    await hold();
    await page.evaluate(action=>{
      if(action==='blur')window.dispatchEvent(new Event('blur'));
      else if(action==='hidden'){Object.defineProperty(document,'hidden',{value:true,configurable:true});document.dispatchEvent(new Event('visibilitychange'));delete document.hidden;}
      else if(action==='focusout')document.querySelector('#login-password').dispatchEvent(new FocusEvent('focusout',{bubbles:true}));
      else document.querySelector('[data-reveal-for="login-password"]').dispatchEvent(new PointerEvent(action==='lost'?'lostpointercapture':'pointercancel',{bubbles:true}));
    },action);
    await expect(input).toHaveAttribute('type','password');await expect(eye).toHaveAttribute('aria-pressed','false');await page.mouse.up();
  }
  await eye.click();await expect(input).toHaveAttribute('type','password');
  await eye.focus();await page.keyboard.down('Space');await expect(input).toHaveAttribute('type','text');await page.keyboard.press('Tab');await expect(input).toHaveAttribute('type','password');await page.keyboard.up('Space');
});

test('Guest auto-loads the public projection only, fallback is accessible and language does not refetch',async({page})=>{
  const {calls,record}=await mock(page,{signedOut:true});
  await page.addInitScript(()=>{Element.prototype.animate=undefined;});
  await page.goto('/');await expect(page.locator('#guest-equipment [data-guest-borrow]')).toBeVisible();
  await expect(page.locator('.guest-showcase')).toHaveAttribute('data-renderer','svg');
  expect(await page.locator('.magic-grid-pattern').evaluate(node=>node.getAnimations({subtree:true}).length)).toBe(0);
  expect(calls.filter(c=>c.method==='listPublicEquipment')).toHaveLength(1);
  expect(calls.some(c=>['listEquipment','getEquipmentDetail','getEquipmentImage'].includes(c.method))).toBe(false);
  const language=page.locator('.guest-controls [data-experience-action="language"]');
  await language.focus();await page.keyboard.press('Enter');await expect(page.locator('[data-guest-borrow]')).toHaveText('Borrow');
  await expect(language).toBeFocused();
  expect(calls.filter(c=>c.method==='listPublicEquipment')).toHaveLength(1);
  const borrow=page.locator('[data-guest-borrow]');await borrow.focus();await page.keyboard.press('Enter');await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('#confirm-modal [data-confirm-accept]').click();await expect(page.locator('#login-email')).toBeFocused();
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('crs.guest.borrow-intent.v1')).assetId)).toBe(record.asset_id);
  expect(calls.some(c=>c.method==='createBorrowRequest')).toBe(false);await expect(page.locator('.guest-glass-scene')).toHaveCount(0);
});

test('Guest Animated Grid uses bounded static SVG on mobile/reduced motion and never allocates a canvas',async({page})=>{
  await mock(page,{signedOut:true});await page.setViewportSize({width:390,height:844});await page.goto('/');
  await expect(page.locator('.guest-glass-scene')).toHaveCount(0);
  await expect(page.locator('.magic-grid-pattern')).toHaveAttribute('aria-hidden','true');
  await expect(page.locator('.magic-grid-square')).toHaveCount(16);
  expect(await page.locator('.magic-grid-pattern').evaluate(node=>node.getAnimations({subtree:true}).length)).toBe(0);
  await expect(page.locator('[data-guest-borrow]')).toBeVisible();
  await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await expect(page.locator('.guest-showcase')).toHaveAttribute('data-renderer','svg');
  await expectNoOverflow(page);await page.locator('#guest-equipment').scrollIntoViewIfNeeded();await captureUi(page,'guest-reduced-motion-mobile');
});

test('Guest public API errors stay visible and cannot fall back to private RPCs',async({page})=>{
  await mock(page,{signedOut:true});await page.route('**/api/rpc',async(route)=>{
    const input=route.request().postDataJSON();
    expect(['getAppBootstrap','listPublicEquipment']).toContain(input.method);
    await route.fulfill({json:{ok:false,error:{code:input.method==='listPublicEquipment'?'BUSY':'UNAUTHENTICATED',message:input.method==='listPublicEquipment'?'Fixture public API unavailable':'Sign in required'}}});
  });
  await page.goto('/');await expect(page.locator('.guest-status')).toHaveText('Fixture public API unavailable');
  await expect(page.locator('[data-guest-content]')).toHaveAttribute('aria-busy','false');await expect(page.locator('[data-guest-borrow]')).toHaveCount(0);
});

test('Animated Grid owns finite opacity animations, pauses hidden tabs and disposes on Login/retranslation',async({page})=>{
  await mock(page,{signedOut:true});
  await page.setViewportSize({width:1440,height:900});await page.goto('/');
  const grid=page.locator('.magic-grid-pattern');await expect(grid).toHaveAttribute('data-motion','active');
  expect(await grid.evaluate(node=>node.getAnimations({subtree:true}).length)).toBe(16);
  expect(await grid.evaluate(node=>node.getAnimations({subtree:true}).every(a=>a.effect.getTiming().iterations===1))).toBe(true);
  const old=await grid.elementHandle();
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(grid).toHaveAttribute('data-motion','paused');expect(await grid.evaluate(node=>node.getAnimations({subtree:true}).every(a=>a.playState==='paused'))).toBe(true);
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});await expect(grid).toHaveAttribute('data-motion','active');
  await page.locator('.guest-controls [data-experience-action="language"]').click();await expect(grid).toHaveCount(1);
  expect(await old.evaluate(node=>node.isConnected)).toBe(false);expect(await old.evaluate(node=>node.getAnimations({subtree:true}).length)).toBe(0);await old.dispose();
  await expect(page.locator('[data-guest-borrow]')).toBeVisible();await captureUi(page,'guest-animated-grid-desktop');
  await openLogin(page);await expect(grid).toHaveCount(0);
  expect((await page.request.get('/crs/guest-scene.js')).status()).toBe(404);
});

test('Login tilt and layer depth interpolate smoothly on both entry and exit; Ripple pauses outside visible desktop Login',async({page})=>{
  await mock(page,{signedOut:true});await page.setViewportSize({width:1440,height:1000});await page.goto('/');await openLogin(page);
  const art=page.locator('.login-art'),rings=page.locator('.magic-ripple-ring');await expect(rings).toHaveCount(6);
  await expect(page.locator('.magic-ripple')).toHaveAttribute('data-motion','active');
  await expect(rings.first()).toHaveCSS('animation-play-state','running');
  const stage=await page.locator('.login-art-stage').boundingBox();
  const depth=async()=>page.locator('.login-art-card').evaluate(node=>{
    const animation=node.getAnimations().find(a=>a.transitionProperty==='translate');
    if(!animation)return null;animation.pause();animation.currentTime=225;
    return {duration:animation.effect.getTiming().duration,translate:getComputedStyle(node).translate,style:getComputedStyle(node.parentElement).transformStyle};
  });
  await page.locator('.login-story').dispatchEvent('pointermove',{pointerType:'mouse',clientX:stage.x+stage.width*.75,clientY:stage.y+stage.height*.75});
  await expect(art).toHaveClass(/is-parallax-active/);let sample;
  await expect.poll(async()=>{sample=await depth();return sample!==null;}).toBe(true);
  expect(sample.duration).toBe(450);expect(sample.style).toBe('preserve-3d');expect(parseFloat(sample.translate)).toBeGreaterThan(0);expect(parseFloat(sample.translate)).toBeLessThan(4);
  await page.evaluate(()=>document.querySelector('.login-art-card').getAnimations().filter(a=>a.transitionProperty==='translate').forEach(a=>a.finish()));
  await page.locator('.login-story').dispatchEvent('pointerleave');await expect(art).not.toHaveClass(/is-parallax-active/);
  await expect.poll(async()=>{sample=await depth();return sample!==null;}).toBe(true);
  expect(sample.duration).toBe(450);expect(sample.style).toBe('preserve-3d');expect(parseFloat(sample.translate)).toBeGreaterThan(0);expect(parseFloat(sample.translate)).toBeLessThan(4);
  await page.evaluate(()=>document.querySelector('.login-art-card').getAnimations().filter(a=>a.transitionProperty==='translate').forEach(a=>a.finish()));
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(rings.first()).toHaveCSS('animation-play-state','paused');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await page.emulateMedia({reducedMotion:'reduce'});await expect(rings.first()).toHaveCSS('animation-name','none');
  await page.setViewportSize({width:390,height:844});await expect(art).toBeHidden();
});

test('controlled theme reveal preserves effective state, storage, keyboard focus and reduced-motion fallback',async({page})=>{
  await mock(page,{signedOut:true});await page.goto('/');await openLogin(page);
  const native=await page.evaluate(()=>{
    window.fixtureThemeReveal=[];const root=document.documentElement,animate=root.animate.bind(root);
    root.animate=(frames,options)=>{if(options?.pseudoElement)window.fixtureThemeReveal.push({frames,options});return animate(frames,options);};
    return typeof document.startViewTransition==='function';
  });
  const button=page.locator('#theme-toggle-login');await page.evaluate(()=>window.CRS.theme.apply('light',true));
  await button.focus();await page.keyboard.press('Enter');await expect(page.locator('html')).toHaveAttribute('data-bs-theme','dark');
  await expect.poll(()=>page.evaluate(()=>document.documentElement.dataset.magicuiThemeVt||'')).toBe('');
  if(native){const reveal=await page.evaluate(()=>window.fixtureThemeReveal);expect(reveal).toHaveLength(1);expect(reveal[0].frames.clipPath[0]).toMatch(/^circle\(0% at [\d.]+% [\d.]+%\)$/);}
  await expect(button).toBeFocused();expect(await page.evaluate(()=>localStorage.getItem('crs-theme'))).toBe('dark');
  await page.emulateMedia({reducedMotion:'reduce'});await page.keyboard.press('Enter');await expect(page.locator('html')).toHaveAttribute('data-bs-theme','light');
  expect(await page.evaluate(()=>document.documentElement.dataset.magicuiThemeVt||'')).toBe('');await expect(button).toBeFocused();
  await page.evaluate(()=>document.startViewTransition=undefined);await button.click();await expect(page.locator('html')).toHaveAttribute('data-bs-theme','dark');
});

test('Progressive Blur is a bounded pointer-transparent scroll cue, avoids focused controls and mobile navigation, and disposes',async({page})=>{
  await mock(page,{signedOut:true});await page.setViewportSize({width:1440,height:700});await page.goto('/');
  const section=page.locator('#guest-equipment'),blur=section.locator('.magic-progressive-blur');
  await section.evaluate(node=>{const filler=document.createElement('div');filler.style.height='1500px';filler.dataset.blurFixture='';node.append(filler);});
  await expect(blur).toBeVisible();await expect(blur).toHaveAttribute('aria-hidden','true');await expect(blur).toHaveCSS('pointer-events','none');await expect(blur.locator('span')).toHaveCount(4);
  const bounds=await blur.boundingBox();expect(bounds.height).toBe(28);expect(bounds.y+bounds.height).toBeCloseTo(700,0);
  await blur.locator('span').evaluateAll(nodes=>nodes.forEach(node=>{node.style.backdropFilter='none';node.style.webkitBackdropFilter='none';}));
  expect(await blur.evaluate(node=>getComputedStyle(node).backgroundImage)).toContain('linear-gradient');await expect(blur).toBeVisible();
  await section.evaluate(node=>{const button=document.createElement('button');button.textContent='Fixture focus';button.dataset.blurFocus='';Object.assign(button.style,{position:'fixed',bottom:'0',left:'100px'});node.append(button);button.focus();});
  await expect(blur).toBeHidden();await page.locator('[data-blur-focus]').evaluate(node=>node.remove());
  await page.evaluate(()=>window.dispatchEvent(new Event('resize')));await expect(blur).toBeVisible();
  await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await expect(blur).toBeHidden();
  const old=await blur.elementHandle();await openLogin(page);expect(await old.evaluate(node=>node.isConnected)).toBe(false);await old.dispose();
  await page.locator('.entry-navigation [data-experience-action="home"]').click();await expect(section.locator('.magic-progressive-blur')).toHaveCount(1);
  await section.evaluate(node=>{const filler=document.createElement('div');filler.style.height='1500px';node.append(filler);});
  await page.emulateMedia({forcedColors:'active'});await expect(section.locator('.magic-progressive-blur')).toBeHidden();
});

test('signed-in main receives Progressive Blur without changing navigation or covering the mobile bottom bar',async({page})=>{
  await mock(page);await page.setViewportSize({width:390,height:844});await page.goto('/');
  await expect(page.locator('#app-shell')).toBeVisible();
  await page.locator('.app-main').focus();
  await page.locator('.app-main').evaluate(node=>{const filler=document.createElement('div');filler.style.height='1500px';node.append(filler);});
  const blur=page.locator('.app-main .magic-progressive-blur');await expect(blur).toBeVisible();
  const b=await blur.boundingBox(),nav=await page.locator('.mobile-bottom-nav').boundingBox();expect(b.y+b.height).toBeCloseTo(nav.y,0);
  await captureUi(page,'main-progressive-blur-mobile');
  await page.locator('.mobile-bottom-nav [data-route="equipment"]').click();await expect(page.locator('#page-equipment')).toBeVisible();
  await expect(blur).toHaveCSS('pointer-events','none');await expectNoOverflow(page);
});

test('blocked Magic UI module keeps static artwork/public catalog and both sign-in controls functional',async({page})=>{
  const {calls}=await mock(page,{signedOut:true}),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/crs/magic-ui.js',route=>route.abort());await page.goto('/');await expect(page.locator('[data-guest-borrow]')).toBeVisible();
  await expect(page.locator('.magic-grid-pattern')).toHaveCount(0);await openLogin(page);
  await expect(page.locator('.magic-ripple-ring')).toHaveCount(6);await expect(page.locator('.magic-ripple-ring').first()).toHaveCSS('animation-play-state','paused');
  await expect(page.locator('#password-login-submit')).toBeVisible();await expect(page.locator('#google-signin-button')).toBeVisible();
  await page.emulateMedia({reducedMotion:'reduce'});await page.locator('#theme-toggle-login').click();await expect(page.locator('.access-card')).not.toHaveClass(/magic-card/);
  expect(calls.filter(call=>call.method==='listPublicEquipment').length).toBe(1);expect(calls.some(call=>['listEquipment','getEquipmentDetail','createBorrowRequest'].includes(call.method))).toBe(false);expect(errors).toEqual([]);
});

test.describe('touch login',()=>{
  test.use({hasTouch:true,viewport:{width:390,height:844}});
  test('restored Login story keeps its illustration responsive and never loads a Login WebGL scene on touch',async({page})=>{
    await mock(page,{signedOut:true});
    await page.goto('/');await openLogin(page);
    for(const width of [320,390,1024]){
      await page.setViewportSize({width,height:900});await expect(page.locator('.login-story .login-kicker')).toBeVisible();
      await expect(page.locator('.login-art canvas')).toHaveCount(0);expect(await page.evaluate(()=>typeof window.CRSLoginScene)).toBe('undefined');
      await page.locator('.login-story').dispatchEvent('pointermove',{pointerType:'touch',clientX:200,clientY:300});
      await expect(page.locator('.login-art')).not.toHaveClass(/is-parallax-active/);
      await expect(page.locator('.login-art')).toHaveCSS('transform','none');
      if(width>=768)await expect(page.locator('.login-art-card')).toBeVisible();else await expect(page.locator('.login-art-card')).toBeHidden();
      await expectNoOverflow(page);
    }
    await page.locator('.entry-navigation [data-experience-action="home"]').tap();await expect(page.locator('.login-glass-scene')).toHaveCount(0);
  });
  test('remember target and label toggle natively on mobile without overflow or extra focus stops',async({page})=>{
    await mock(page,{signedOut:true});await page.goto('/');await openLogin(page);
    const checkbox=page.locator('#remember-session'),label=page.locator('label[for="remember-session"]');
    for(const width of [320,390])for(const theme of ['light','dark']) {
      await page.setViewportSize({width,height:844});await page.evaluate(value=>window.CRS.theme.apply(value,true),theme);
      await checkbox.tap();await expect(checkbox).toBeChecked();await label.tap();await expect(checkbox).not.toBeChecked();
      await expectNoOverflow(page);
      expect(await checkbox.evaluate(node=>{const rect=node.getBoundingClientRect();return Math.min(rect.width,rect.height);})).toBe(44);
    }
    await checkbox.focus();await page.keyboard.press('Tab');await expect(page.locator('.login-footer [data-experience-action="privacy"]')).toBeFocused();
  });
  test('native touch hold reveals only until release/cancel, and Guest cards remain operable',async({page})=>{
    await mock(page,{signedOut:true});await page.goto('/');
    await openLogin(page);
    const input=page.locator('#login-password'),eye=page.locator('[data-reveal-for="login-password"]');
    await input.fill('Fixture touch hold passphrase!');await eye.scrollIntoViewIfNeeded();
    const box=await eye.boundingBox(),touch=await page.context().newCDPSession(page);
    for(const end of ['touchEnd','touchCancel']){
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
      await expect(input).toHaveAttribute('type','text');
      await touch.send('Input.dispatchTouchEvent',{type:end,touchPoints:[]});await expect(input).toHaveAttribute('type','password');
    }
    await expect(page.locator('.liquid-glass-cursor')).toBeHidden();await expect(page.locator('[data-guest-borrow]')).toBeHidden();
    await page.locator('.entry-navigation [data-experience-action="home"]').tap();
    await expect(page.locator('[data-guest-borrow]')).toBeVisible();
    await expectNoOverflow(page);await touch.detach();
  });
});
