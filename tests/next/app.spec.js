const {test,expect}=require('@playwright/test');
const {mkdirSync}=require('node:fs');
const {installOfflineAssets}=require('./offline-assets.cjs');
const {bootstrappedHarness,createEquipment}=require('../backend/test-helpers.cjs');
const canonical='https://example.test';
test('disabled Push explains availability and loading uses one rotating logo',async({page})=>{
  await mock(page);
  await page.route('**/api/rpc',async route=>{
    if(route.request().postDataJSON().method!=='getNotificationPreferences')return route.fallback();
    return route.fulfill({json:{ok:true,data:{items:[{event:'DUE_SOON',inApp:true,channel:null,version:0},{event:'OVERDUE',inApp:true,channel:null,version:0}],channels:{push:false,email:false},pushTestAvailable:false,dueRemindersAvailable:true}}});
  });
  await page.goto('/');await expect(page.locator('#app-shell')).toBeVisible();
  for(const width of [320,768,1440]){
    await page.setViewportSize({width,height:1000});
    expect(await page.locator('#app-shell').evaluate(node=>node.getBoundingClientRect().height>=innerHeight&&node.getBoundingClientRect().width>=innerWidth)).toBe(true);
    expect(await page.locator('body').evaluate(node=>getComputedStyle(node).backgroundAttachment.split(',').every(value=>value.trim()==='fixed'))).toBe(true);
  }
  await page.evaluate(()=>CRS.navigate('settings',{section:'notifications'}));
  await expect(page.locator('[data-push-availability]')).toContainText('การส่งภายนอกยังปิดอยู่');
  await expect(page.locator('.settings-security-root')).not.toContainText('สถานะ Email / Push');
  await expect(page.locator('.settings-security-root')).not.toContainText('บังคับส่ง ปิดไม่ได้');
  await expect(page.locator('.settings-security-root')).toContainText('ก่อนครบกำหนด 1 วัน');
  await page.evaluate(()=>{window.loadingLease=CRSSessionLoading.begin();CRSSessionLoading.start();});
  await expect(page.locator('#session-loading .loading-logo')).toBeVisible();
  await expect(page.locator('#session-loading .spinner-border,#app-splash .spinner-border')).toHaveCount(0);
  expect(await page.locator('#session-loading .loading-logo').evaluate(node=>getComputedStyle(node).animationName)).toBe('crs-logo-spin');
  await page.emulateMedia({reducedMotion:'reduce'});
  expect(await page.locator('#session-loading .loading-logo').evaluate(node=>getComputedStyle(node).animationName)).toBe('none');
  await page.evaluate(()=>window.loadingLease.finish());
});

for(const language of ['th','en'])for(const theme of ['light','dark'])test('Account-only Push diagnostic is explicit, one-shot and independent of preferences '+language+' '+theme,async({page})=>{
  const {calls}=await mock(page);let sends=0;
  await page.addInitScript(({language,theme})=>{localStorage.setItem('crs-ui-language',language);localStorage.setItem('crs-theme',theme);},{language,theme});
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();
    if(input.method==='sendTestPush'){sends++;return route.fulfill({json:{ok:true,data:{status:'ACCEPTED',deviceReceiptConfirmed:false}}});}
    if(input.method!=='getNotificationPreferences')return route.fallback();
    return route.fulfill({json:{ok:true,data:{items:[{event:'APPROVE',inApp:true,channel:null,version:0}],channels:{inApp:true,push:false,email:false},pushRegistered:false,pushPublicKey:'fixture',pushTestAvailable:true}}});
  });
  await page.goto('/?view=dashboard');await expect(page.locator('#app-shell')).toBeVisible();
  await page.evaluate(()=>{window.CRSPush={supported:()=>true,enable:async()=>true};CRS.navigate('settings',{section:'notifications'});});
  const panel=page.locator('[data-push-test]'),register=panel.locator('[data-push-test-register]'),send=panel.locator('[data-push-test-send]');
  await expect(panel).toBeVisible();await expect(send).toBeDisabled();expect(sends).toBe(0);
  await register.click();await expect(send).toBeEnabled();expect(sends).toBe(0);
  await send.focus();await page.keyboard.press('Enter');await expect(panel.locator('[role="status"]')).toContainText(language==='en'?'Provider accepted':'Provider รับแล้ว');
  await expect(send).toBeDisabled();await expect(register).toBeDisabled();expect(sends).toBe(1);
  expect(calls.filter(call=>call.method==='saveNotificationPreference')).toHaveLength(0);
  for(const width of [320,1440]){await page.setViewportSize({width,height:900});await expectNoOverflow(page);await captureUi(page,'push-test-'+language+'-'+theme+'-'+width,{staticView:true});}
  await page.evaluate(()=>CRS.navigate('dashboard'));await expect(page.locator('[data-push-test]')).toHaveCount(0);
});

test('Push diagnostic permission failure does not send; non-test owner has no diagnostic UI',async({page})=>{
  await mock(page);let available=true,sends=0;
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();if(input.method==='sendTestPush')sends++;
    if(input.method!=='getNotificationPreferences')return route.fallback();
    return route.fulfill({json:{ok:true,data:{items:[],channels:{inApp:true,push:false,email:false},pushRegistered:false,pushPublicKey:available?'fixture':null,pushTestAvailable:available}}});
  });
  await page.goto('/?view=dashboard');await expect(page.locator('#app-shell')).toBeVisible();
  await page.evaluate(()=>{window.CRSPush={supported:()=>true,enable:async()=>{throw new Error('Fixture permission denied');}};CRS.navigate('settings',{section:'notifications'});});
  await page.locator('[data-push-test-register]').click();await expect(page.locator('[data-push-test] [role="status"]')).toHaveText('Fixture permission denied');await expect(page.locator('[data-push-test-send]')).toBeDisabled();expect(sends).toBe(0);
  available=false;await page.evaluate(()=>CRS.navigate('dashboard'));await page.evaluate(()=>CRS.navigate('settings',{section:'notifications'}));await expect(page.locator('.settings-security-root')).toBeVisible();await expect(page.locator('[data-push-test]')).toHaveCount(0);
});

test('Notification delivery worker denies absent/fake credentials without exposing configuration',async({request})=>{
  for(const authorization of ['', 'Bearer synthetic-invalid-worker-secret']){
    const response=await request.get('/api/notifications/process',{headers:{authorization}});
    expect(response.status()).toBe(403);expect(response.headers()['cache-control']).toBe('no-store');expect(await response.json()).toEqual({});
  }
  const foreign=await request.post('/api/rpc',{headers:{origin:'https://evil.test'},data:{method:'registerPushSubscription',args:[{}]}});
  expect(foreign.status()).toBe(403);
});

test('Notification delivery popover fallback, outside dismissal and permission denial retain saved state',async({page})=>{
  const {calls}=await mock(page);await page.setViewportSize({width:320,height:1000});
  await page.addInitScript(()=>Object.defineProperty(HTMLElement.prototype,'showPopover',{value:undefined,configurable:true}));
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();if(input.method!=='getNotificationPreferences')return route.fallback();
    return route.fulfill({json:{ok:true,data:{items:[{event:'APPROVE',inApp:true,channel:null,version:0}],channels:{inApp:true,push:true,email:true},pushRegistered:false,pushPublicKey:'fixture'}}});
  });
  await page.goto('/?view=dashboard');await expect(page.locator('#app-shell')).toBeVisible();
  await page.evaluate(()=>{window.CRSPush={supported:()=>true,enable:async()=>{throw new Error('Fixture permission denied');}};CRS.navigate('settings',{section:'notifications'});});
  const picker=page.locator('.settings-channel-picker').first(),summary=picker.locator('summary');await summary.click();
  await expect(picker.locator('[role="menu"]')).toBeVisible();await picker.locator('[data-channel="PUSH"]').click();
  await expect(page.locator('.settings-security-root > [role="status"]')).toHaveText('Fixture permission denied');
  await expect(summary).toContainText('เลือกช่องทาง');expect(calls.filter(call=>call.method==='saveNotificationPreference')).toHaveLength(0);
  await summary.click();await page.locator('#settings-heading').click();await expect(picker).not.toHaveAttribute('open','');await expectNoOverflow(page);
});

for(const language of ['th','en'])for(const theme of ['light','dark'])test('Notification delivery single-select popover '+language+' '+theme,async({page})=>{
  await mock(page);let version=0,channel=null;const changes=[];
  await page.addInitScript(({language,theme})=>{localStorage.setItem('crs-ui-language',language);localStorage.setItem('crs-theme',theme);},{language,theme});
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();
    if(!['getNotificationPreferences','saveNotificationPreference'].includes(input.method))return route.fallback();
    if(input.method==='saveNotificationPreference'){changes.push(input.args[0]);channel=input.args[0].channel;version++;}
    return route.fulfill({json:{ok:true,data:{items:[{event:'APPROVE',inApp:true,channel,version},{event:'ADMIN_BORROW_REQUEST',inApp:true,channel:null,version:0}],channels:{inApp:true,push:true,email:true},pushRegistered:false,pushPublicKey:'fixture-only'}}});
  });
  await page.goto('/?view=dashboard');await expect(page.locator('#app-shell')).toBeVisible();
  await page.evaluate(()=>{window.CRSPush={supported:()=>true,enable:async()=>true};CRS.navigate('settings',{section:'notifications'});});
  for(const width of [320,1440]) {
    await page.setViewportSize({width,height:900});
    const picker=page.locator('.settings-channel-picker').first(),summary=picker.locator('summary');
    await summary.click();const choices=picker.getByRole('menuitemradio');await expect(choices).toHaveCount(2);
    await expect(choices.first()).toHaveAttribute('aria-checked',String(channel==='PUSH'));
    await picker.locator('[data-channel="EMAIL"]').click();await expect(summary).toHaveText(language==='en'?'Email ▾':'อีเมล ▾');
    await expect(picker).not.toHaveAttribute('open','');
    await summary.focus();await page.keyboard.press('ArrowDown');await expect(choices.first()).toBeFocused();
    await expect(picker.locator('[data-channel="EMAIL"]')).toHaveAttribute('aria-checked','true');
    expect(await picker.locator('[data-channel="EMAIL"] .bi-check-lg').evaluate(node=>getComputedStyle(node).visibility)).toBe('visible');
    const box=await picker.locator('[role="menu"]').boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
    await captureUi(page,'delivery-'+language+'-'+theme+'-'+width,{staticView:true});
    await page.keyboard.press('Enter');await expect(summary).toHaveText(language==='en'?'Push ▾':'พุช ▾');
    await expect(page.locator('[data-in-app],.settings-in-app')).toHaveCount(0);
    await summary.click();await page.keyboard.press('Escape');await expect(summary).toBeFocused();await expect(picker).not.toHaveAttribute('open','');
    await picker.locator('..').locator('[data-delivery-off]').click();await expect(summary).toContainText(language==='en'?'Choose channel':'เลือกช่องทาง');
    await expectNoOverflow(page);
  }
  expect(changes.map(item=>item.channel)).toEqual(['EMAIL','PUSH',null,'EMAIL','PUSH',null]);
  await page.evaluate(()=>CRS.navigate('dashboard'));await expect(page.locator('.settings-channel-menu')).toHaveCount(0);
});

for(const language of ['th','en'])test('Notification delivery Account restore label follows language without changing shortcut behaviour '+language,async({page})=>{
  const {calls}=await mock(page);
  await page.addInitScript(language=>localStorage.setItem('crs-ui-language',language),language);
  await page.goto('/?view=dashboard');await expect(page.locator('#app-shell')).toBeVisible();
  await page.evaluate(()=>{
    CRS.sidebarShortcut.setEnabled(false);
    CRS.sidebarShortcut.setBinding({ctrl:true,shift:false,alt:true,meta:false,code:'KeyK'});
    CRS.accountMenu.openShortcuts(document.querySelector('[data-action="account-menu-toggle"]'));
  });
  const restore=page.locator('[data-account-shortcuts-restore]');
  await expect(restore).toHaveText(language==='th'?'คืนค่าเริ่มต้น':'Restore defaults');
  const before=calls.length;await restore.click();
  await expect(page.locator('#sidebar-shortcut-enabled')).toHaveAttribute('aria-checked','true');
  await expect(page.locator('[data-shortcut-key="sidebar"]')).toHaveText('Ctrl + Shift + S');
  expect(calls.length).toBe(before);
  await page.locator('[data-account-shortcuts-close]').click();
  await page.evaluate(()=>CRS.navigate('settings',{section:'keyboard'}));
  await expect(page.locator('[data-settings-shortcut-restore]')).toHaveText(language==='th'?'คืนค่าเริ่มต้น':'Restore defaults');
});

for(const theme of ['light','dark'])for(const language of ['th','en'])test('Admin refinement disclosures, queue refresh and profile symmetry '+theme+' '+language,async({page})=>{
  const {calls}=await mock(page);let queued=false;
  await page.addInitScript(({theme,language})=>{localStorage.setItem('crs-theme',theme);localStorage.setItem('crs-ui-language',language);},{theme,language});
  await page.route('**/api/rpc',async route=>{
    const {method}=route.request().postDataJSON();
    if(method==='adminRepairImageIntegrity'){queued=true;return route.fulfill({json:{ok:true,data:{status:'CLEANUP_QUEUED'}}});}
    if(method!=='adminPreviewImageIntegrity')return route.fallback();
    return route.fulfill({json:{ok:true,data:{generated_at:'2026-10-15T00:00:00Z',summary:{total_issues:1,counts:{orphan_files:queued?0:1,cleanup_queued:queued?1:0}},issues:[{kind:queued?'CLEANUP_QUEUED':'ORPHAN_FILE',file_id:'synthetic-orphan',file_name:'Synthetic old image.png',can_repair:!queued}]}}});
  });
  for(const width of [320,1440]){
    await page.setViewportSize({width,height:1000});
    for(const view of ['dashboard','equipment','scan','admin']){
      await page.goto('/?view='+view);await expect(page.locator('#app-shell')).toBeVisible();
      await expect(page.locator('#view-root .eyebrow')).toHaveCount(0);
    }
    await page.locator('#admin-system-tab').click();await page.locator('#admin-run-integrity').click();
    const toggle=page.locator('[data-audit-result="admin-integrity-result"]');
    await expect(toggle).toHaveAttribute('aria-expanded','true');await expect(page.locator('#admin-integrity-result')).toBeVisible();
    const reads=calls.filter(call=>call.method==='adminRunIntegrityAudit').length;
    await toggle.focus();await page.keyboard.press('Enter');await expect(page.locator('#admin-integrity-result')).toBeHidden();await page.keyboard.press('Space');await expect(page.locator('#admin-integrity-result')).toBeVisible();
    expect(calls.filter(call=>call.method==='adminRunIntegrityAudit')).toHaveLength(reads);
    await page.locator('#admin-preview-image-integrity').click();
    if(!queued){await page.locator('[data-action="repair-image-integrity"]').click();await expect(page.locator('#confirm-modal')).toContainText(language==='en'?'safety delay':'ผ่านช่วงรอ');await page.locator('[data-confirm-accept]').click();}
    const result=page.locator('#admin-image-integrity-result');await expect(result).toContainText(language==='en'?'Cleanup queued':'เข้าคิวล้างแล้ว');await expect(result.locator('[data-action="repair-image-integrity"]')).toHaveCount(0);
    await page.reload();await page.locator('#admin-system-tab').click();await page.locator('#admin-preview-image-integrity').click();await expect(result).toContainText(language==='en'?'Cleanup queued':'เข้าคิวล้างแล้ว');
    const imageToggle=page.locator('[data-audit-result="admin-image-integrity-result"]');await imageToggle.click();await expect(result).toBeHidden();await imageToggle.click();await expect(result).toBeVisible();await expectNoOverflow(page);
    await page.goto('/?view=account');const field=page.locator('.profile-name-input'),save=page.locator('.profile-name-editor button');await expect(field).toBeEditable();
    expect(await page.locator('.profile-name-editor label').evaluate(node=>node.textContent)).toBe('');await expect(field).toHaveAccessibleName(language==='en'?'Name':'ชื่อที่แสดง');
    async function symmetric(){const boxes=await page.locator('.profile-name-editor').evaluate(form=>{const a=form.querySelector('input').getBoundingClientRect(),b=form.querySelector('button').getBoundingClientRect();return {height:Math.abs(a.height-b.height),y:Math.abs(a.y-b.y)};});expect(boxes.height).toBeLessThan(1);expect(boxes.y).toBeLessThan(1);await expectNoOverflow(page);}
    await symmetric();await captureUi(page,'refinement-profile-'+width+'-'+theme+'-'+language,{staticView:true});
    await page.evaluate(()=>CRS.navigate('settings',{section:'account'}));await expect(field).toBeEditable();await symmetric();
  }
});

for(const width of [320,1440])for(const language of ['th','en'])for(const theme of ['light','dark'])test('Profile presentation '+width+' '+language+' '+theme,async({page})=>{
  await page.setViewportSize({width,height:900});await mock(page);await page.addInitScript(({language,theme})=>{localStorage.setItem('crs-ui-language',language);localStorage.setItem('crs-theme',theme);},{language,theme});
  await page.goto('/?view=account');const field=page.locator('.profile-name-input');await expect(field).toBeEditable();await field.focus();await expect(field).toBeFocused();
  await expect(page.locator('.profile-avatar')).toHaveAccessibleName(language==='en'?'Change profile photo':'เปลี่ยนรูปโปรไฟล์');
  await expectNoOverflow(page);await captureUi(page,'profile-'+width+'-'+language+'-'+theme,{staticView:true});
  await page.evaluate(()=>CRS.navigate('settings',{section:'appearance'}));const option=page.locator('[data-settings-theme="dark"]');await option.focus();await expect(option).toBeFocused();await option.click();await expect(option).toHaveAttribute('aria-pressed','true');await expectNoOverflow(page);
  await page.evaluate(()=>CRS.navigate('settings',{section:'security'}));await expect(page.locator('#settings-heading')).toHaveText(language==='en'?'Security and login':'ความปลอดภัยและการลงชื่อเข้าใช้');
});

test('Profile navigation opens Account only; Storage disappears, legacy link falls back and Restore follows TH/EN',async({page})=>{
  await mock(page);await page.goto('/');await expect(page.locator('#app-shell')).toBeVisible();
  await page.evaluate(()=>CRS.navigate('settings'));
  const link=page.locator('.settings-profile-link');await expect(link).toHaveAttribute('href',canonical+'/#account?view=account');await expect(link.locator('.bi-arrow-up-right')).toHaveCount(1);
  await expect(page.locator('[data-settings-section="storage"]')).toHaveCount(0);
  await page.locator('#settings-nav-search').fill('ไม่พบอะไร');await expect(link).toBeHidden();await page.locator('#settings-nav-search').fill('');await link.click();
  await expect(page.locator('#account-heading')).toBeVisible();await expect(page.locator('.profile-name-input')).toBeEditable();
  await page.evaluate(()=>CRS.navigate('settings',{section:'storage'}));await expect(page.locator('#settings-heading')).toHaveText('การตั้งค่าทั่วไป');
  await page.evaluate(()=>CRS.navigate('settings',{section:'keyboard'}));await expect(page.locator('[data-settings-shortcut-restore]')).toHaveText('คืนค่าเริ่มต้น');
  await page.evaluate(()=>CRS.language.set('en'));await page.reload();await expect(page.locator('[data-settings-shortcut-restore]')).toHaveText('Restore defaults');
});
test('Profile inline name autosaves latest draft, updates current UI and Settings but leaves email/role readonly',async({page})=>{
  const {calls}=await mock(page);await page.goto('/?view=account');const input=page.locator('.profile-name-input');await expect(input).toBeEditable();
  await input.fill('Draft');await input.fill('New fixture name');await expect(page.locator('.profile-save-status')).toHaveText('บันทึกแล้ว');
  expect(calls.filter(call=>call.method==='saveOwnName')).toHaveLength(1);await expect(page.locator('[data-session-name]').first()).toHaveText('New fixture name');
  await input.fill('Cancelled draft');await input.press('Escape');await expect(input).toHaveValue('New fixture name');
  await page.evaluate(()=>CRS.navigate('settings',{section:'account'}));await expect(page.locator('.profile-name-input')).toHaveValue('New fixture name');
  await expect(page.locator('.settings-account-fields input')).toHaveCount(1);await expect(page.locator('.settings-account-fields dt').nth(1)).toHaveText('อีเมล');
  await input.fill('Enter saved');await input.press('Enter');await expect(page.locator('.profile-save-status')).toHaveText('บันทึกแล้ว');
  expect(calls.filter(call=>call.method==='saveOwnName')).toHaveLength(2);
});
test('Profile name save retains command on lost response, and pending debounce is disposed on navigation',async({page})=>{
  await mock(page);const commands=[];
  await page.route('**/api/rpc',async route=>{const input=route.request().postDataJSON();if(input.method!=='saveOwnName')return route.fallback();commands.push(input.args[0]);if(commands.length===1)return route.abort('failed');await route.fulfill({json:{ok:true,data:{name:input.args[0].name,nameVersion:2,avatarId:null}}});});
  await page.goto('/?view=account');const field=page.locator('.profile-name-input');await expect(field).toBeEditable();await field.fill('Retried name');await field.press('Enter');
  await expect(page.locator('.profile-name-editor button')).toBeEnabled();await expect.poll(()=>commands.length).toBe(1);
  await page.locator('.profile-name-editor button').click();await expect(page.locator('.profile-save-status')).toHaveText('บันทึกแล้ว');expect(commands[1]).toEqual(commands[0]);
  await field.fill('Never sent draft');await page.evaluate(()=>CRS.navigate('dashboard'));await expect(page.locator('.dashboard-equipment-wall')).toBeVisible();
  await page.evaluate(()=>CRS.navigate('account'));await expect(page.locator('.profile-name-input')).toBeEditable();expect(commands).toHaveLength(2);
});
test('Profile load failure offers retry, keeps edits disabled and preserves old names over the new edit limit',async({page})=>{
  await mock(page);let attempts=0;
  const oldName='Legacy name '.repeat(8);
  await page.route('**/api/rpc',async route=>{const input=route.request().postDataJSON();if(input.method!=='getOwnProfile')return route.fallback();attempts++;await route.fulfill({json:attempts===1?{ok:false,error:{code:'RESOURCE_UNAVAILABLE',message:'Fixture unavailable'}}:{ok:true,data:{name:oldName,nameVersion:1,avatarId:null}}});});
  await page.goto('/?view=account');await expect(page.locator('.profile-name-editor button')).toHaveText('ลองอีกครั้ง');await expect(page.locator('.profile-name-input')).not.toBeEditable();await expect(page.locator('.profile-avatar')).toBeDisabled();
  await page.locator('.profile-name-editor button').click();await expect(page.locator('.profile-name-input')).toBeEditable();await expect(page.locator('.profile-name-input')).toHaveValue(oldName);await expect(page.locator('.profile-avatar')).toBeEnabled();
});
test('Profile avatar rejects non-square/oversize before upload and successful commit pulses once with private bytes',async({page})=>{
  await mock(page);const seen=[];
  await page.addInitScript(()=>{window.createImageBitmap=async file=>({width:file.name==='wide.png'?32:16,height:16,close(){}});});
  const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a2l8AAAAASUVORK5CYII=','base64');
  await page.route('https://avatar.supabase.co/**',route=>route.fulfill({status:200,contentType:'image/png',body:image}));
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();if(!['prepareOwnAvatar','finalizeOwnAvatar','getOwnAvatar'].includes(input.method))return route.fallback();seen.push(input);
    const data=input.method==='prepareOwnAvatar'?{resourceId:input.args[0].commandId,uploadUrl:'https://avatar.supabase.co/storage/v1/object/upload/sign/private/avatar'}:input.method==='finalizeOwnAvatar'?{name:'Fixture',nameVersion:1,avatarId:input.args[0].resourceId}:{signedUrl:seen.some(item=>item.method==='finalizeOwnAvatar')?'https://avatar.supabase.co/storage/v1/object/sign/private/avatar':null,mimeType:'image/png',byteLength:image.length};await route.fulfill({json:{ok:true,data}});
  });
  await page.goto('/?view=account');await expect(page.locator('.profile-name-input')).toBeEditable();
  const picker=page.locator('#view-root input[type="file"]');
  await picker.setInputFiles({name:'wide.png',mimeType:'image/png',buffer:image});await expect(page.locator('.profile-save-status')).toContainText('1:1');expect(seen.some(item=>item.method==='prepareOwnAvatar')).toBe(false);
  await picker.setInputFiles({name:'large.png',mimeType:'image/png',buffer:Buffer.alloc(1048577)});await expect(page.locator('.profile-save-status')).toContainText('1 MiB');
  await picker.setInputFiles({name:'square.png',mimeType:'image/png',buffer:image});await expect(page.locator('.profile-avatar')).toHaveClass(/is-profile-saved/);await expect(page.locator('.profile-avatar img')).toHaveAttribute('src',/^blob:/);
  expect(seen.filter(item=>item.method==='finalizeOwnAvatar')).toHaveLength(1);expect(await page.locator('.profile-avatar').evaluate(node=>getComputedStyle(node).animationIterationCount)).toBe('1');
  await page.emulateMedia({reducedMotion:'reduce'});expect(await page.locator('.profile-avatar').evaluate(node=>getComputedStyle(node).animationName)).toBe('none');
});

test('session revoke retry retains its command after a lost response and prevents duplicate confirmation',async({page})=>{
  await mock(page);
  const commands=[];
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();
    if(input.method!=='revokeOtherSessions'){await route.fallback();return;}
    commands.push(input.args[0].commandId);
    if(commands.length===1){await route.abort('failed');return;}
    await route.fulfill({json:{ok:true,data:{revoked:0,alreadyRevoked:true}}});
  });
  await page.goto('/');await expect(page.locator('#app-shell')).toBeVisible();
  await page.evaluate(()=>CRS.navigate('settings',{section:'security',subview:'sessions'}));
  const all=page.locator('[data-security-revoke-all]');await all.click();
  await expect(all).toBeDisabled();await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('[data-confirm-accept]').click();await expect(all).toBeEnabled();
  expect(commands).toHaveLength(1);
  await all.click();await page.locator('[data-confirm-accept]').click();
  await expect.poll(()=>commands.length).toBe(2);expect(commands[1]).toBe(commands[0]);
});
test('Settings Remember moves the existing session without changing expiry or starting another login',async({page})=>{
  const {calls}=await mock(page);await page.goto('/');await expect(page.locator('#app-shell')).toBeVisible();
  const original=await page.evaluate(()=>JSON.parse(sessionStorage.getItem('crs.auth.session.v1')));
  await page.evaluate(()=>CRS.navigate('settings',{section:'security'}));
  const remember=page.locator('[data-settings-remember]');await remember.check();
  expect(await page.evaluate(()=>JSON.parse(localStorage.getItem('crs.auth.session.v1')))).toEqual(original);
  await remember.uncheck();expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('crs.auth.session.v1')))).toEqual(original);
  expect(await page.evaluate(()=>localStorage.getItem('crs.auth.session.v1'))).toBeNull();
  expect(calls.some(call=>['passwordSignIn','beginOAuthSignIn','completeOAuthSignIn','logoutSession'].includes(call.method))).toBe(false);
});
test('stale notification preference refreshes its owner-scoped version without an optimistic overwrite',async({page})=>{
  await mock(page);let reads=0;const versions=[];
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();
    if(input.method==='getNotificationPreferences') {
      reads++;await route.fulfill({json:{ok:true,data:{items:[{event:'APPROVE',inApp:true,channel:'EMAIL',version:reads===1?0:2}],channels:{inApp:true,push:false,email:false}}}});return;
    }
    if(input.method==='saveNotificationPreference') {
      versions.push(input.args[0].expectedVersion);
      await route.fulfill({json:versions.length===1?{ok:false,error:{code:'STATE_CONFLICT',message:'Fixture state changed'}}:{ok:true,data:{items:[{event:'APPROVE',inApp:true,channel:null,version:3}]}}});return;
    }
    await route.fallback();
  });
  await page.goto('/');await expect(page.locator('#app-shell')).toBeVisible();await page.evaluate(()=>CRS.navigate('settings',{section:'notifications'}));
  const picker=page.locator('.settings-channel-picker').first();await picker.locator('summary').click();
  const control=picker.locator('..').locator('[data-delivery-off]');await control.click();await expect(control).toBeEnabled();
  expect(reads).toBe(2);await expect(page.locator('[data-in-app]')).toHaveCount(0);
  await control.click();await expect(control).toBeHidden();expect(versions).toEqual([0,2]);
});

for(const width of [320,390,768,1440])for(const language of ['th','en'])for(const theme of ['light','dark']) {
  test('Settings security '+width+' '+language+' '+theme,async({page})=>{
    await page.setViewportSize({width,height:850});await mock(page);
    await page.addInitScript(({language,theme})=>{localStorage.setItem('crs-ui-language',language);localStorage.setItem('crs-theme',theme);},{language,theme});
    await page.goto('/');await expect(page.locator('#app-shell')).toBeVisible();
    await page.evaluate(()=>CRS.navigate('settings',{section:'security'}));
    const sessions=page.locator('[data-security-sessions]');await expect(sessions).toContainText('2');await sessions.click();
    await expect(page.locator('.settings-session-row')).toHaveCount(2);
    await expect(page.locator('.settings-session-row').first()).toContainText('Microsoft Edge');
    await expect(page.locator('.settings-session-row').last()).toContainText(language==='en'?'Unknown browser':'ไม่ทราบเบราว์เซอร์');
    await page.locator('[data-security-back]').click();await expect(page.locator('[data-security-sessions]')).toBeVisible();
    await page.goBack();await expect(page.locator('.settings-session-row')).toHaveCount(2);
    await page.evaluate(()=>CRS.navigate('settings',{section:'account'}));
    await expect(page.locator('.settings-account-fields')).toBeVisible();await expect(page.locator('.settings-account-fields input')).toHaveCount(1);await expect(page.locator('.settings-account-fields [name="name"]')).toBeEditable();await expect(page.locator('.settings-account-fields [type="email"]')).toHaveCount(0);
    await page.evaluate(()=>CRS.navigate('settings',{section:'notifications'}));
    const picker=page.locator('.settings-channel-picker').first();await picker.locator('summary').click();
    await expect(picker.locator('[role="menuitemradio"]:disabled')).toHaveCount(2);
    await expect(page.locator('[data-in-app],.settings-in-app')).toHaveCount(0);
    await expect(picker).toHaveAttribute('open','');
    await expect(picker.locator('summary')).toContainText(language==='en'?'Choose channel':'เลือกช่องทาง');
    await picker.locator('summary').focus();await page.keyboard.press('Escape');await expect(picker).not.toHaveAttribute('open','');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}
for(const width of [320,1440])for(const fallback of [false,true])test('OAuth handoff popover '+width+' '+(fallback?'fallback':'native'),async({page})=>{
  await page.setViewportSize({width,height:740});await mock(page,{signedOut:true});let ended=false;const attempts=[];
  await page.addInitScript(({fallback,width})=>{
    localStorage.setItem('crs-ui-language',width===320?'en':'th');localStorage.setItem('crs-theme',width===320?'dark':'light');
    if(fallback)Object.defineProperty(HTMLElement.prototype,'showPopover',{value:undefined,configurable:true});
    const popup={closed:false,document:{title:'',body:{}},location:{replace(){}},close(){this.closed=true;}};
    window.open=()=>popup;
  },{fallback,width});
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();
    if(input.method==='beginOAuthSignIn')return route.fulfill({json:{ok:true,data:{flowId:'flow1_'+'a'.repeat(43),authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=fixture-only',expiresAt:Math.floor(Date.now()/1000)+120}}});
    if(input.method==='completeOAuthSignIn'){
      const otp=input.args[2];if(otp)attempts.push(otp);
      return route.fulfill({json:ended?{ok:false,error:{code:'UNAUTHENTICATED',message:'Fixture attempt ended'}}:otp?{ok:false,error:{code:'OTP_INVALID',message:'Fixture invalid OTP'}}:{ok:true,data:{status:'AWAITING_CONFIRMATION',closePopup:true}}});
    }
    return route.fallback();
  });
  await page.goto('/');await openLogin(page);await page.emulateMedia({reducedMotion:'reduce'});
  const panel=page.locator('#oauth-handoff-panel');await expect(panel).toBeHidden();
  await page.locator('#google-signin-button').click();await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-handoff-open','true');await expect(panel).toHaveAttribute('role','dialog');
  if(!fallback)expect(await panel.evaluate(node=>node.matches(':popover-open'))).toBe(true);
  await expect(panel.locator('[data-otp-digit]').first()).toBeFocused();
  const height=await page.locator('.login-layout').evaluate(node=>node.getBoundingClientRect().height);
  await expect(page.locator('.login-story')).toBeVisible();
  const box=await panel.boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);expect(box.y).toBeGreaterThanOrEqual(0);expect(box.y+box.height).toBeLessThanOrEqual(740);
  await expect(panel.locator('#oauth-handoff-submit')).toBeDisabled();
  await panel.locator('[data-otp-digit]').first().evaluate(node=>{const event=new Event('paste',{bubbles:true,cancelable:true});Object.defineProperty(event,'clipboardData',{value:{getData:()=> '１２ ３-４５６'}});node.dispatchEvent(event);});
  expect(await panel.locator('[data-otp-digit]').evaluateAll(nodes=>nodes.map(n=>n.value).join(''))).toBe('123456');
  await panel.locator('#oauth-handoff-submit').click();await expect(panel.locator('#oauth-handoff-error')).toHaveText('Fixture invalid OTP');expect(attempts).toEqual(['123456']);
  // Submission clears the old code through the preserved auth module. A new,
  // unsubmitted edit must survive presentation dismissal instead of cancellation.
  await panel.locator('[data-otp-digit]').first().fill('9');
  await page.keyboard.press('Escape');await expect(panel).toBeHidden();await expect(page.locator('[data-handoff-reopen]')).toBeFocused();
  expect(Math.abs(await page.locator('.login-layout').evaluate(node=>node.getBoundingClientRect().height)-height)).toBeLessThan(1);
  expect(await panel.evaluate(node=>node.hidden)).toBe(false); // Closing presentation must not cancel auth.
  await page.locator('[data-handoff-reopen]').click();await expect(panel).toBeVisible();
  expect(await panel.locator('[data-otp-digit]').evaluateAll(nodes=>nodes.map(n=>n.value).join(''))).toBe('9');
  await panel.locator('[data-handoff-close]').click();await expect(panel).toBeHidden();await page.locator('[data-handoff-reopen]').click();
  ended=true;await expect(panel).toBeHidden();await expect(page.locator('[data-handoff-reopen]')).toBeHidden();
  expect(await panel.locator('[data-otp-digit]').evaluateAll(nodes=>nodes.every(n=>!n.value))).toBe(true);
  await expect(page.locator('#google-signin-button')).toBeEnabled();await expectNoOverflow(page);
});

test('OAuth handoff presentation disposes and remounts without changing the auth hidden flag',async({page})=>{
  await mock(page,{signedOut:true});await page.goto('/');await openLogin(page);
  const panel=page.locator('#oauth-handoff-panel');await panel.evaluate(node=>node.hidden=false);await expect(panel).toBeVisible();
  await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
  await expect(page.locator('[data-handoff-close],[data-handoff-reopen]')).toHaveCount(0);
  await expect(page.locator('.access-card > #oauth-handoff-panel')).toHaveCount(1);
  expect(await panel.evaluate(node=>node.hidden)).toBe(false);
  await page.evaluate(()=>{const dispose=CRSOAuthHandoff.mount(document.querySelector('#oauth-handoff-panel'));dispose();dispose();CRSOAuthHandoff.mount(document.querySelector('#oauth-handoff-panel'));});
  await expect(page.locator('[data-handoff-close]')).toHaveCount(1);await expect(page.locator('[data-handoff-reopen]')).toHaveCount(1);
  await expect(panel).toBeVisible();await panel.evaluate(node=>node.hidden=true);await expect(panel).toBeHidden();await expect(page.locator('[data-handoff-reopen]')).toBeHidden();
});

test('blocked handoff enhancement keeps the existing inline OTP inputs usable',async({page})=>{
  await mock(page,{signedOut:true});await page.route('**/crs/oauth-handoff.js',route=>route.abort());
  await page.goto('/');await openLogin(page);const panel=page.locator('#oauth-handoff-panel');
  await panel.evaluate(node=>node.hidden=false);await expect(panel).toBeVisible();
  await expect(panel).not.toHaveAttribute('popover');await expect(page.locator('[data-handoff-close]')).toHaveCount(0);
  await panel.locator('[data-otp-digit]').first().fill('123456');await expect(panel.locator('#oauth-handoff-submit')).toBeEnabled();
  await expect(page.locator('#password-login-form')).toBeVisible();await expect(page.locator('#google-signin-button')).toBeEnabled();
});

test.beforeEach(async({page})=>{
  await installOfflineAssets(page);
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
async function mock(page,{signedOut=false,restricted=false,preserveSession=false}={}){
  const harness=bootstrappedHarness();const record=createEquipment(harness);
  const session=harness.records('Users').find(row=>row.role==='ADMIN');
  const calls=[];
  if(!signedOut)await page.addInitScript(preserve=>{if(preserve&&sessionStorage.getItem('crs.auth.session.v1'))return;sessionStorage.setItem('crs.auth.session.v1',JSON.stringify({version:1,token:'session1_'+'a'.repeat(43),expiresAt:Math.floor(Date.now()/1000)+600}));},preserveSession);
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();calls.push(input);
    let response;
    if(input.method==='passwordSignIn') response={ok:true,data:{status:'COMPLETE',expiresAt:Math.floor(Date.now()/1000)+600}};
    else if(input.method==='listPublicEquipment') response={ok:true,data:{items:[{asset_id:record.asset_id,name:record.name,brand:'Fixture',model:'Public',category_name:'Public',status:'AVAILABLE',can_borrow:true,imageAvailable:false}],page:1,total:1,totalPages:1}};
    else if(input.method==='adminGetEquipmentVisibility') response={ok:true,data:{isPublic:false}};
    else if(input.method==='adminSetEquipmentPublic') response={ok:true,data:{updated:true}};
    else if(input.method==='adminIssueTemporaryPassword') response={ok:true,data:{deliveryStatus:'SENT',activated:true,mustChangePassword:true}};
    else if(input.method==='listNotifications') response={ok:true,data:{items:[{id:'n'.repeat(43),borrow_id:'BR-000001',action:'APPROVE',created_at:new Date().toISOString(),read_at:null}],unread:1}};
    else if(input.method==='getSettingsSecurity') response={ok:true,data:{email:session.email,name:session.name,department:session.department,role:session.role,googleAvailable:true,passwordConfigured:true,activeSessionCount:2,sessionTtlSeconds:21600}};
    else if(input.method==='getOwnProfile')response={ok:true,data:{name:session.name,nameVersion:Number(session.row_version),avatarId:null}};
    else if(input.method==='saveOwnName'){session.name=input.args[0].name;session.row_version=Number(session.row_version)+1;response={ok:true,data:{name:session.name,nameVersion:session.row_version,avatarId:null}};}
    else if(input.method==='getOwnAvatar')response={ok:true,data:{signedUrl:null}};
    else if(input.method==='listActiveSessions') response={ok:true,data:{count:2,items:[{publicId:'11111111-1111-4111-8111-111111111111',current:true,browser:'Microsoft Edge',os:'Windows',lastActiveAt:new Date().toISOString()},{publicId:'22222222-2222-4222-8222-222222222222',current:false,browser:null,os:null,lastActiveAt:null}]}};
    else if(input.method==='listSecurityActivity') response={ok:true,data:{items:[]}};
    else if(input.method==='getNotificationPreferences'||input.method==='saveNotificationPreference') response={ok:true,data:{items:['BORROW_REQUEST','APPROVE','REJECT','CHECKOUT','REQUEST_RETURN','RETURN','ADMIN_BORROW_REQUEST','ADMIN_REQUEST_RETURN'].map(event=>({event,inApp:input.method==='saveNotificationPreference'&&event===input.args[0].event?input.args[0].inApp:true,version:input.method==='saveNotificationPreference'?1:0})),channels:{inApp:true,push:false,email:false},securityEmailRequired:true,dueRemindersAvailable:false}};
    else if(input.method==='revokeOtherSessions') response={ok:true,data:{revoked:1,alreadyRevoked:false}};
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

test('Sidebar routes replace duplicate borrow tabs while retaining history search, pagination and Back navigation',async({page})=>{
  const {calls}=await mock(page);const historyCalls=[];
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.route('**/api/rpc',async route=>{
    const input=route.request().postDataJSON();if(input.method!=='listMyHistory')return route.fallback();historyCalls.push(input.args[0]);
    await route.fulfill({json:{ok:true,data:{items:[{action:'RETURN',asset_id:'AST-000001',note:'Fixture history',timestamp:'2026-10-01T00:00:00Z'}],page:input.args[0].page,pageSize:20,total:21,totalPages:2}}});
  });
  await page.goto('/?view=history');await expect(page.locator('#my-borrow-history-pane')).toBeVisible();
  await expect(page.locator('#my-borrow-list-pane')).toBeHidden();await expect(page.locator('#my-borrow-tabs,[role="tabpanel"]')).toHaveCount(0);
  expect(calls.some(call=>call.method==='listMyBorrowing')).toBe(false);await expect.poll(()=>historyCalls.length).toBe(1);
  await page.locator('#my-history-search').fill('Fixture');await page.locator('#form-my-history-filter [type="submit"]').click();
  await expect.poll(()=>historyCalls.some(query=>query.search==='Fixture'&&query.page===1)).toBe(true);
  await page.locator('#pagination-my-history [data-page="2"]').first().click();await expect.poll(()=>historyCalls.some(query=>query.page===2&&query.search==='Fixture')).toBe(true);
  await page.locator('.sidebar-link[data-route="my-borrow"]').click();await expect(page.locator('#my-borrow-list-pane')).toBeVisible();await expect(page.locator('#my-borrow-history-pane')).toBeHidden();
  await page.locator('#my-borrow-status-filter').selectOption('RETURNED');await page.locator('#my-borrow-sort-direction').selectOption('asc');
  await page.locator('#form-my-borrow-filter [type="submit"]').click();await expect.poll(()=>calls.some(call=>call.method==='listMyBorrowing'&&call.args[0].status==='RETURNED'&&call.args[0].sortDirection==='asc')).toBe(true);
  await page.goBack();await expect(page.locator('#my-borrow-history-pane')).toBeVisible();await expect(page.locator('.sidebar-link[data-route="history"]')).toHaveClass(/active/);
  await page.goForward();await expect(page.locator('#my-borrow-list-pane')).toBeVisible();
  expect(calls.some(call=>['requestReturn','createBorrowRequest'].includes(call.method))).toBe(false);
});

test('borrow/history route composition works without the optional experience adapter and leaves no dangling tab labels',async({page})=>{
  await mock(page);await page.route('**/crs/experience.js',route=>route.abort());
  for(const view of ['my-borrow','history']){
    await page.goto('/?view='+view);await expect(page.locator(view==='history'?'#my-borrow-history-pane':'#my-borrow-list-pane')).toBeVisible();
    await expect(page.locator('#my-borrow-tabs,#my-borrow-history-tab,#my-borrow-list-tab')).toHaveCount(0);
    expect(await page.locator('#page-my-borrow [aria-labelledby],#page-my-borrow[aria-labelledby]').evaluateAll(nodes=>nodes.every(node=>node.getAttribute('aria-labelledby').split(/\s+/).every(id=>document.getElementById(id))))).toBe(true);
  }
});

for(const theme of ['light','dark']){
  test('requested controls share the search radius without changing filter or Asset ID behavior in '+theme,async({page})=>{
    const {calls,record}=await mock(page);await page.emulateMedia({reducedMotion:'reduce'});
    for(const width of [320,768,1440]){
      await page.setViewportSize({width,height:900});await page.goto('/?view=equipment');await expect(page.locator('#equipment-search')).toBeVisible();await page.evaluate(value=>CRS.theme.apply(value,true),theme);
      const radius=await page.locator('#equipment-search').evaluate(node=>getComputedStyle(node).borderTopLeftRadius);
      async function matching(selectors){for(const selector of selectors){const node=page.locator(selector);await expect(node).toBeVisible();const corners=await node.evaluate(node=>{const style=getComputedStyle(node);return [style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius];});expect(corners).toEqual([radius,radius,radius,radius]);}}
      await matching(['#equipment-category-filter','#equipment-status-filter','#equipment-sort-direction','#equipment-sort-by','#equipment-department-filter','#equipment-location-filter','#form-equipment-filter [type="submit"]']);
      await page.locator('#equipment-status-filter').selectOption('AVAILABLE');await page.locator('#equipment-sort-by').selectOption('asset_id');await page.locator('#equipment-sort-direction').selectOption('desc');await page.locator('#form-equipment-filter [type="submit"]').click();
      await expect.poll(()=>calls.some(call=>call.method==='listEquipment'&&call.args[0].status==='AVAILABLE'&&call.args[0].sortBy==='asset_id'&&call.args[0].sortDirection==='desc')).toBe(true);
      await page.goto('/?view=my-borrow');await matching(['#my-borrow-status-filter','#my-borrow-sort-direction','#form-my-borrow-filter [type="submit"]']);
      await page.goto('/?view=history');await matching(['#my-history-search','#form-my-history-filter [type="submit"]']);
      await page.goto('/?view=scan');await matching(['#asset-id-entry','#asset-id-entry-form [type="submit"]']);await expectNoOverflow(page);
      await page.locator('#asset-id-entry').fill(record.asset_id);await page.locator('#asset-id-entry-form [type="submit"]').click();await expect(page.locator('#page-equipment-detail')).toBeVisible();
      await page.goto('/?view=account');await matching(['#view-root .btn-outline-secondary[data-route="settings"]','#view-root .btn-outline-danger[data-action="sign-out"]']);await expectNoOverflow(page);
    }
  });

  test('specification keeps all literal text with an eight-line keyboard-scroll region only on overflow in '+theme,async({page})=>{
    const {record}=await mock(page);let content=Array.from({length:18},(_,i)=>'Line '+(i+1)+' · ข้อมูลอุปกรณ์').join('\n')+'\n<script>window.fixtureInjected=true</script>';
    await page.emulateMedia({reducedMotion:'reduce'});
    await page.route('**/api/rpc',async route=>{if(route.request().postDataJSON().method!=='getEquipmentDetail')return route.fallback();await route.fulfill({json:{ok:true,data:{...record,specification:content,imageAvailable:false,included_items:[]}}});});
    for(const width of [320,1440]){
      await page.setViewportSize({width,height:900});await page.goto('/?view=equipment-detail&id='+record.asset_id);await page.evaluate(value=>CRS.theme.apply(value,true),theme);
      const node=page.locator('#equipment-detail-specification');await expect(node).toHaveAttribute('tabindex','0');await expect(node).toHaveAttribute('aria-labelledby','equipment-specification-title');
      expect(await node.textContent()).toBe(content);expect(await page.evaluate(()=>window.fixtureInjected)).toBeUndefined();
      const size=await node.evaluate(node=>{const style=getComputedStyle(node);return {height:node.clientHeight,scroll:node.scrollHeight,cap:8*parseFloat(style.lineHeight),padding:parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)};});expect(size.padding).toBe(0);expect(size.height).toBeLessThanOrEqual(size.cap+1);expect(size.scroll).toBeGreaterThan(size.height);
      await node.focus();await page.keyboard.press('PageDown');await expect.poll(()=>node.evaluate(node=>node.scrollTop)).toBeGreaterThan(0);
      await node.evaluate(node=>{const range=document.createRange();range.selectNodeContents(node);getSelection().removeAllRanges();getSelection().addRange(range);});expect(await page.evaluate(()=>getSelection().toString())).toBe(content);await expectNoOverflow(page);
    }
    content='Short specification';await page.goto('/?view=equipment-detail&id='+record.asset_id);await expect(page.locator('#equipment-detail-specification')).toHaveText(content);await expect(page.locator('#equipment-detail-specification')).not.toHaveAttribute('tabindex');
    content=Array(120).fill('รายละเอียด').join(' ');await page.goto('/?view=equipment-detail&id='+record.asset_id);await page.setViewportSize({width:320,height:900});await expect(page.locator('#equipment-detail-specification')).toHaveAttribute('tabindex','0');await expectNoOverflow(page);
  });

  test('Settings language fills its list with selected-check-only styling and symmetric security cards in '+theme,async({page})=>{
    await mock(page);await page.emulateMedia({reducedMotion:'reduce'});
    for(const width of [320,1440])for(const language of ['th','en']){
      await page.setViewportSize({width,height:900});await page.addInitScript(value=>localStorage.setItem('crs-ui-language',value),language);await page.goto('/?view=settings');await page.evaluate(value=>CRS.theme.apply(value,true),theme);
      const trigger=page.locator('#language-trigger');await trigger.click();const list=page.locator('#language-list'),selected=list.locator('[aria-selected="true"]'),other=list.locator('[aria-selected="false"]');await expect(list.locator('[role="option"]')).toHaveCount(2);
      await page.mouse.move(0,0);await expect(selected).toHaveCSS('background-color','rgba(0, 0, 0, 0)');await expect(selected.locator('.bi-check-lg')).toBeVisible();
      await selected.hover();await expect(selected.locator('.bi-check-lg')).toBeVisible();await other.hover();await expect(other.locator('.bi-check-lg')).toBeHidden();
      const dimensions=await list.evaluate(node=>({client:node.clientHeight,scroll:node.scrollHeight,gutter:getComputedStyle(node).scrollbarGutter,width:node.clientWidth,option:node.firstElementChild.getBoundingClientRect().width}));expect(dimensions.scroll).toBe(dimensions.client);expect(dimensions.gutter).toBe('auto');expect(Math.abs(dimensions.option-dimensions.width)).toBeLessThan(1);
      const corners=await trigger.evaluate(node=>{const s=getComputedStyle(node);return[s.borderTopLeftRadius,s.borderBottomRightRadius,s.height];});expect(corners[0]).toBe(corners[1]);expect(parseFloat(corners[2])).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('ArrowDown');await expect(list.locator('[role="option"]').first()).toBeFocused();await page.keyboard.press('Escape');await expect(trigger).toBeFocused();
      for(const section of ['security','account','notifications']){
        await page.evaluate(section=>CRS.navigate('settings',{section}),section);const root=page.locator('.settings-security-root');await expect(root.locator('> .settings-card').first()).toBeVisible();
        const geometry=await root.evaluate(node=>{const cards=[...node.querySelectorAll(':scope > .settings-card')];const box=node.getBoundingClientRect();return{top:cards[0].getBoundingClientRect().top-box.top,widths:cards.map(n=>n.getBoundingClientRect().width),lefts:cards.map(n=>n.getBoundingClientRect().left),padding:cards.map(n=>parseFloat(getComputedStyle(n).paddingLeft))};});expect(geometry.top).toBeLessThan(1);expect(Math.max(...geometry.widths)-Math.min(...geometry.widths)).toBeLessThan(1);expect(new Set(geometry.lefts).size).toBe(1);expect(geometry.padding.every(value=>value>=16)).toBe(true);await expectNoOverflow(page);
      }
      for(const subview of ['sessions','activity']){await page.evaluate(subview=>CRS.navigate('settings',{section:'security',subview}),subview);await expect(page.locator('[data-security-back]')).toBeVisible();await expectNoOverflow(page);}
    }
  });
}

test('post-login loader covers pending bootstrap and first view without blocking sign-in or inventing requests',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});
  let bootstrapEntered=false,viewEntered=false,catalogEntered=false,releaseBootstrap,releaseView,releaseCatalog;
  const bootstrapGate=new Promise(resolve=>{releaseBootstrap=resolve;}),viewGate=new Promise(resolve=>{releaseView=resolve;}),catalogGate=new Promise(resolve=>{releaseCatalog=resolve;});
  await page.route('**/api/rpc',async route=>{
    const method=route.request().postDataJSON().method;
    if(method==='getAppBootstrap'){bootstrapEntered=true;await bootstrapGate;}
    if(method==='getDashboard'){viewEntered=true;await viewGate;}
    if(method==='listEquipment'){catalogEntered=true;await catalogGate;}
    await route.fallback();
  });
  try{
    await page.goto('/');await openLogin(page);
    const loader=page.locator('#app-splash:visible,#global-loading:visible,#session-loading:visible');
    await expect(loader).toHaveCount(0);
    await page.locator('#login-email').fill('admin@example.test');await page.locator('#login-password').fill('Fixture passphrase only!');
    await page.locator('#password-login-submit').click();await expect.poll(()=>bootstrapEntered).toBe(true);
    await expect(loader).toHaveCount(1);await expect(page.locator('#session-loading')).toContainText('ข้อมูลผู้ใช้');
    const layers=await page.evaluate(()=>({loader:Number(getComputedStyle(document.querySelector('#session-loading')).zIndex),login:Number(getComputedStyle(document.querySelector('#access-state')).zIndex)}));
    expect(layers.loader).toBeGreaterThan(layers.login);
    for(const width of [390,1440])for(const theme of ['light','dark'])for(const language of ['th','en']){
      await page.setViewportSize({width,height:844});await page.evaluate(({theme,language})=>{CRS.theme.apply(theme,true);CRS.language.set(language);},{theme,language});
      await expect(page.locator('#session-loading')).toContainText(language==='th'?'ข้อมูลผู้ใช้':'user data');
      await expect(page.locator('#session-loading .session-loading-card')).toBeInViewport({ratio:1});
      expect(await page.locator('#session-loading').evaluate(node=>getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
      await expectNoOverflow(page);await captureUi(page,'session-loading-'+width+'-'+theme+'-'+language);
    }
    await page.evaluate(()=>CRS.language.set('th'));
    releaseBootstrap();await expect.poll(()=>viewEntered).toBe(true);
    await expect(loader).toHaveCount(1);await expect(page.locator('#session-loading')).toContainText('หน้าแรก');
    releaseView();await expect(page.locator('#dashboard-content')).toBeVisible();await expect.poll(()=>catalogEntered).toBe(true);await expect(loader).toHaveCount(1);
    releaseCatalog();await expect(page.locator('[data-dashboard-wall] [data-wall-asset]').first()).toBeAttached();await expect(loader).toHaveCount(0);
    expect(calls.filter(call=>call.method==='getAppBootstrap')).toHaveLength(1);expect(calls.filter(call=>call.method==='passwordSignIn')).toHaveLength(1);
    await expect(page.locator('#login-password')).toHaveValue('');
    expect(await page.locator('#app-shell').evaluate(node=>node.inert)).toBe(false);
    expect(calls.filter(call=>call.method==='listEquipment')).toHaveLength(1);
  }finally{releaseBootstrap();releaseView();releaseCatalog();}
});

for(const failure of ['bootstrap-identity','bootstrap-transport','view-domain','catalog-domain'])test('session loader releases on '+failure+' failure',async({page})=>{
  await mock(page,{signedOut:true});let entered=false,release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/rpc',async route=>{
    const method=route.request().postDataJSON().method;
    const failedMethod=failure==='catalog-domain'?'listEquipment':failure==='view-domain'?'getDashboard':'getAppBootstrap';
    if(method!==failedMethod)return route.fallback();
    entered=true;await gate;
    if(failure==='bootstrap-transport')return route.abort();
    await route.fulfill({json:{ok:false,error:{code:failure==='bootstrap-identity'?'UNAUTHENTICATED':'SERVICE_UNAVAILABLE',message:'Fixture unavailable'}}});
  });
  try{
    await page.goto('/');await openLogin(page);await page.locator('#login-email').fill('admin@example.test');await page.locator('#login-password').fill('Fixture passphrase only!');
    await page.locator('#password-login-submit').click();await expect.poll(()=>entered).toBe(true);
    await expect(page.locator('#session-loading')).toBeVisible();release();await expect(page.locator('#session-loading')).toBeHidden();
    expect(await page.locator('#app-shell').evaluate(node=>node.inert)).toBe(false);
    if(failure==='bootstrap-identity')await expect(page.locator('#password-login-form')).toBeVisible();
    if(failure==='bootstrap-transport')await expect(page.locator('[data-access-message]')).toContainText('เชื่อมต่อระบบไม่สำเร็จ');
    if(failure==='view-domain')await expect(page.locator('#view-root')).toContainText('Fixture unavailable');
    if(failure==='catalog-domain')await expect(page.locator('#dashboard-catalog-status')).toContainText('Fixture unavailable');
  }finally{release();}
});

test('restored-session loading uses the same first-view boundary and missing decorative module leaves authentication intact',async({page})=>{
  const {calls}=await mock(page);let entered=false,release;const gate=new Promise(resolve=>{release=resolve;});
  await page.route('**/api/rpc',async route=>{if(route.request().postDataJSON().method==='getDashboard'){entered=true;await gate;}await route.fallback();});
  try{
    await page.goto('/');await expect.poll(()=>entered).toBe(true);await expect(page.locator('#session-loading')).toBeVisible();release();
    await expect(page.locator('#dashboard-content')).toBeVisible();await expect(page.locator('#session-loading')).toBeHidden();
    expect(calls.some(call=>['passwordSignIn','beginOAuthSignIn','completeOAuthSignIn'].includes(call.method))).toBe(false);
    await page.route('**/crs/session-loading.js',route=>route.abort());await page.reload();await expect(page.locator('#dashboard-content')).toBeVisible();
  }finally{release();}
});

test('session loading leases do not dismiss a newer cycle or change existing mutation-loading counters',async({page})=>{
  await mock(page);await page.goto('/');await expect(page.locator('#dashboard-content')).toBeVisible();
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>{
    CRS.setLoading(true,'Fixture mutation');const first=CRSSessionLoading.begin();CRSSessionLoading.start();
    const latest=CRSSessionLoading.begin();CRSSessionLoading.start();first.finish();window.fixtureLoadingLease=latest;
  });
  await expect(page.locator('#session-loading')).toBeVisible();await expect(page.locator('#global-loading')).toBeVisible();
  expect(await page.locator('#session-loading .loading-logo').evaluate(node=>getComputedStyle(node).animationName)).toBe('none');
  await page.evaluate(()=>{window.fixtureLoadingLease.finish();delete window.fixtureLoadingLease;});
  await expect(page.locator('#session-loading')).toBeHidden();await expect(page.locator('#global-loading')).toBeVisible();
  await page.evaluate(()=>{CRS.setLoading(false);CRSSessionLoading.begin();CRSSessionLoading.start();window.dispatchEvent(new Event('pagehide'));});
  await expect(page.locator('#session-loading')).toBeHidden();await expect(page.locator('#global-loading')).toBeHidden();
  expect(await page.locator('#app-shell').evaluate(node=>node.inert)).toBe(false);
});

test('inspected return keeps header/footer visible while only the long modal body scrolls',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});
  // Modal layout uses local fallbacks; remote font availability is not its contract.
  await page.route('https://fonts.googleapis.com/**',route=>route.abort());
  await page.route('https://fonts.gstatic.com/**',route=>route.abort());
  await mock(page);await page.goto('/?view=admin');await expect(page.locator('#form-admin-borrow-filter')).toBeVisible();
  await page.evaluate(()=>{
    const list=document.querySelector('#admin-return-item-checklist');
    for(let i=0;i<24;i++){
      const card=document.createElement('article');card.className='card card-body';
      card.innerHTML='<label class="form-label" for="scroll-fixture-'+i+'">Accessory '+(i+1)+'</label><input class="form-control" id="scroll-fixture-'+i+'" type="text">';list.append(card);
    }
    bootstrap.Modal.getOrCreateInstance(document.querySelector('#modal-admin-return')).show();
  });
  const modal=page.locator('#modal-admin-return'),body=modal.locator('.modal-body');
  for(const viewport of [{width:1440,height:900},{width:390,height:650}])for(const theme of ['light','dark']){
    await page.setViewportSize(viewport);await expect(modal).toBeVisible();
    await page.evaluate(theme=>CRS.theme.apply(theme,true),theme);
    await expect(modal.locator('.modal-header')).toBeInViewport({ratio:1});await expect(modal.locator('.modal-footer')).toBeInViewport({ratio:1});
    const dimensions=await body.evaluate(node=>({scroll:node.scrollHeight,client:node.clientHeight,overflow:getComputedStyle(node).overflowY}));
    expect(dimensions.scroll).toBeGreaterThan(dimensions.client);expect(dimensions.overflow).toBe('auto');
    await body.evaluate(node=>node.scrollTop=node.scrollHeight);await expect(modal.locator('#admin-return-note')).toBeInViewport();
    await expect(modal.locator('.modal-header')).toBeInViewport({ratio:1});await expect(modal.locator('.modal-footer')).toBeInViewport({ratio:1});
    await expectNoOverflow(page);await captureUi(page,'inspected-return-'+viewport.width+'-'+theme,{staticView:true});
    await body.evaluate(node=>node.scrollTop=0);
  }
});

test('Guest wall controls live beneath the search box on the right without the obsolete instruction paragraph',async({page})=>{
  await mock(page,{signedOut:true});await page.goto('/');
  const form=page.locator('[data-guest-search]'),mode=form.locator('[data-wall-mode]');
  await expect(mode).toBeVisible();await expect(page.locator('.drift-controls p.small.mb-0')).toHaveCount(0);
  expect(await mode.getAttribute('type')).toBe('button');
  for(const width of [390,1440]){
    await page.setViewportSize({width,height:900});
    const input=await form.locator('input').boundingBox(),button=await mode.boundingBox();
    expect(button.y).toBeGreaterThanOrEqual(input.y+input.height);expect(Math.abs(button.x+button.width-input.x-input.width)).toBeLessThan(2);
  }
  await mode.click();await expect(page.locator('.drift-wall')).toHaveAttribute('data-static','true');
  await form.locator('input').fill('Fixture');await expect(mode).toHaveCount(0);
  await form.locator('input').fill('');await expect(form.locator('[data-wall-mode]')).toHaveCount(1);
  await expectNoOverflow(page);
});

test('Guest wall displays only the approved thumbnail endpoint and retains placeholders on failure',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=','base64');
  await page.route('**/api/public-equipment/*/thumbnail',route=>route.fulfill(route.request().url().includes('000002')?{status:404,body:''}:{status:200,contentType:'image/png',body:png}));
  await page.route('**/api/rpc',async route=>{if(route.request().postDataJSON().method!=='listPublicEquipment')return route.fallback();await route.fulfill({json:{ok:true,data:{items:[1,2,3].map(i=>({asset_id:'AST-00000'+i,name:'Thumbnail '+i,status:'AVAILABLE',can_borrow:true,imageAvailable:false,thumbnail_url:i===3?'https://private.invalid/original':'/api/public-equipment/AST-00000'+i+'/thumbnail'})),page:1,total:3,totalPages:1}}});});
  await page.goto('/');await page.locator('[data-wall-mode]').click();
  const first=page.locator('[data-wall-asset="AST-000001"]:not([data-wall-copy])');
  await expect(first.locator('img')).toBeVisible();await expect(first.locator('.drift-image-fallback')).toBeHidden();
  await expect(page.locator('[data-wall-asset="AST-000002"]:not([data-wall-copy]) .drift-image-fallback')).toBeVisible();
  await expect(page.locator('[data-wall-asset="AST-000003"]:not([data-wall-copy]) img')).toHaveCount(0);
  expect(calls.some(call=>['getEquipmentImage','getEquipmentDetail','listEquipment'].includes(call.method))).toBe(false);
  await page.locator('#guest-search').fill('Thumbnail 1');await expect(page.locator('[data-layout="gallery"] img')).toBeVisible();
  await page.locator('#guest-search').fill('');await page.locator('[data-wall-mode]').click();
  for(const width of [390,1440])for(const theme of ['light','dark']){await page.setViewportSize({width,height:900});await page.evaluate(theme=>CRS.theme.apply(theme,true),theme);await expectNoOverflow(page);await captureUi(page,'public-thumbnail-'+width+'-'+theme);}
});

test('the real thumbnail HTTP boundary denies file identifiers, query overrides and image-optimizer cache bypass',async({request})=>{
  for(const path of ['/api/public-equipment/private-resource/thumbnail','/api/public-equipment/AST-000001/thumbnail?file=private-resource']){
    const result=await request.get(path);expect(result.status()).toBe(404);expect(result.headers()['cache-control']).toContain('no-store');expect((await result.body()).length).toBe(0);
  }
  expect((await request.get('/_next/image?url=%2Fapi%2Fpublic-equipment%2FAST-000001%2Fthumbnail&w=256&q=75')).status()).toBe(400);
});

test('Guest thumbnail loads stay bounded while all current images render and queued work is disposed',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});let active=0,peak=0,requests=0;
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=','base64');
  await page.route('**/api/public-equipment/*/thumbnail',async route=>{
    active++;peak=Math.max(peak,active);requests++;const saturated=active>2;
    await new Promise(resolve=>setTimeout(resolve,250));active--;
    await route.fulfill(saturated?{status:503,body:''}:{status:200,contentType:'image/png',body:png}).catch(()=>{});
  });
  await page.route('**/api/rpc',async route=>{if(route.request().postDataJSON().method!=='listPublicEquipment')return route.fallback();await route.fulfill({json:{ok:true,data:{items:[1,2,3].map(i=>({asset_id:'AST-00000'+i,name:'Bounded '+i,status:'AVAILABLE',can_borrow:true,imageAvailable:false,thumbnail_url:'/api/public-equipment/AST-00000'+i+'/thumbnail'})),page:1,total:3,totalPages:1}}});});
  await page.goto('/');await page.locator('[data-wall-mode]').click();
  for(const id of [1,2,3])await expect(page.locator('[data-wall-asset="AST-00000'+id+'"]:not([data-wall-copy]) img')).toBeVisible();
  expect(peak).toBeLessThanOrEqual(2);expect(requests).toBe(3);
  await expect(page.locator('[data-wall-copy] canvas').first()).toHaveCount(1);
  await page.locator('#guest-search').fill('Bounded');await page.locator('#guest-search').fill('no matching asset');
  await expect(page.locator('[data-wall-asset]')).toHaveCount(0);
  await page.waitForTimeout(600);const settled=requests;await page.waitForTimeout(300);expect(requests).toBe(settled);
  await page.locator('#guest-search').fill('');for(const id of [1,2,3])await expect(page.locator('[data-wall-asset="AST-00000'+id+'"]:not([data-wall-copy]) img')).toBeVisible();
  expect(calls.some(call=>call.method==='getEquipmentImage')).toBe(false);
});

test('Guest live search filters the complete public snapshot into a gallery without submit, private calls or lost focus',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});
  await page.route('**/api/rpc',async route=>{const input=route.request().postDataJSON();if(input.method!=='listPublicEquipment')return route.fallback();calls.push(input);await route.fulfill({json:{ok:true,data:{items:[
    {asset_id:'AST-000001',name:'Portable notebook',brand:'ASUS',model:'Zenbook',category_name:'Computer',status:'AVAILABLE',can_borrow:true,imageAvailable:false},
    {asset_id:'AST-000002',name:'Canon camera',brand:'Canon',model:'R50',category_name:'Camera',status:'RESERVED',can_borrow:false,imageAvailable:false},
    {asset_id:'AST-000003',name:'Lenovo notebook',brand:'Lenovo',model:'Thinkpad',category_name:'Computer',status:'AVAILABLE',can_borrow:true,imageAvailable:false}
  ],page:1,total:3,totalPages:1}}});});
  await page.goto('/');await expect(page.locator('.drift-wall__tile:not([data-wall-copy])')).toHaveCount(3);
  const input=page.locator('#guest-search');await input.fill(' ＡＳＵＳ ');
  await expect(page.locator('[data-layout="gallery"] .drift-wall__tile')).toHaveCount(1);await expect(page.locator('.drift-name')).toHaveText('Portable notebook');await expect(input).toBeFocused();
  await expect(page.locator('.guest-status')).toContainText('1');expect(await page.evaluate(()=>document.getAnimations().filter(a=>a.effect?.target?.closest('.equipment-wall')).length)).toBe(0);
  await input.fill('camera');await expect(page.locator('.drift-name')).toHaveText('Canon camera');await page.locator('.drift-wall__tile').click();await expect(page.locator('.experience-dialog')).toContainText('จองแล้ว');await page.keyboard.press('Escape');
  await input.fill('no-match');await expect(page.locator('.guest-status')).toContainText('ไม่พบอุปกรณ์');await expect(page.locator('.equipment-wall')).toHaveCount(0);
  await page.evaluate(()=>CRS.language.set('en'));await expect(page.locator('#guest-search')).toHaveValue('no-match');await expect(page.locator('.guest-status')).toContainText('No equipment matches');
  await page.locator('#guest-search').fill('');await expect(page.locator('.drift-wall__tile:not([data-wall-copy])')).toHaveCount(3);await expect(page.locator('.equipment-wall')).toHaveAttribute('data-layout','wall');
  expect(calls.filter(call=>call.method==='listPublicEquipment')).toHaveLength(1);expect(calls.some(call=>['listEquipment','getEquipmentDetail','getEquipmentImage','createBorrowRequest'].includes(call.method))).toBe(false);
  await page.locator('#guest-search').fill('asus');
  for(const theme of ['light','dark']){await page.evaluate(theme=>CRS.theme.apply(theme,true),theme);await page.setViewportSize({width:1440,height:900});await expectNoOverflow(page);await captureUi(page,'catalog-live-gallery-desktop-'+theme);await page.setViewportSize({width:390,height:844});await expectNoOverflow(page);await captureUi(page,'catalog-live-gallery-mobile-'+theme);}
});

test('an empty Guest projection explains publication instead of claiming the database is empty, and submit refreshes only public data',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});let loads=0;
  await page.route('**/api/rpc',async route=>{const input=route.request().postDataJSON();if(input.method!=='listPublicEquipment')return route.fallback();calls.push(input);loads++;await route.fulfill({json:{ok:true,data:{items:loads===1?[]:[{asset_id:'AST-000001',name:'Asus published fixture',brand:'ASUS',status:'AVAILABLE',can_borrow:true,imageAvailable:false}],page:1,total:loads===1?0:1,totalPages:1}}});});
  await page.goto('/');await expect(page.locator('.guest-status')).toContainText('ยังไม่มีอุปกรณ์สาธารณะ');await expect(page.locator('.guest-status')).toContainText('เข้าสู่ระบบ');
  await page.locator('#guest-search').fill('asus');await expect(page.locator('.guest-status')).toContainText('ยังไม่มีอุปกรณ์สาธารณะ');
  await page.locator('.guest-showcase form button[type="submit"]').click();await expect(page.locator('[data-layout="gallery"] .drift-name')).toHaveText('Asus published fixture');
  expect(loads).toBe(2);expect(calls.some(call=>['listEquipment','getEquipmentDetail','getEquipmentImage'].includes(call.method))).toBe(false);
});

test('Dashboard live search includes authorized description/specification and clearing restores all guarded assets',async({page})=>{
  const {calls,record}=await mock(page);
  await page.route('**/api/rpc',async route=>{const input=route.request().postDataJSON();if(input.method!=='listEquipment')return route.fallback();calls.push(input);await route.fulfill({json:{ok:true,data:{items:[{...record,description:'Ultrabook for creative projects',imageAvailable:false},{...record,asset_id:'AST-000002',name:'Second asset',description:'Standard notebook',specification:'ASUS OLED display',imageAvailable:false}],page:1,total:2,totalPages:1}}});});
  await page.goto('/');await expect(page.locator('.dashboard-equipment-wall .drift-wall__tile:not([data-wall-copy])')).toHaveCount(2);
  const input=page.locator('#dashboard-equipment-search');await input.fill('ultrabook');await expect(page.locator('[data-layout="gallery"] .drift-name')).toHaveText(record.name);await expect(input).toBeFocused();
  await input.fill('asus');await expect(page.locator('[data-layout="gallery"] .drift-name')).toHaveText('Second asset');
  await page.evaluate(()=>CRS.language.set('en'));await expect(page.locator('#dashboard-equipment-search')).toHaveValue('asus');await expect(page.locator('[data-layout="gallery"] .drift-wall__tile')).toHaveCount(1);
  await page.locator('#dashboard-equipment-search').fill('');await expect(page.locator('.dashboard-equipment-wall .drift-wall__tile:not([data-wall-copy])')).toHaveCount(2);
  expect(calls.filter(call=>call.method==='listEquipment')).toHaveLength(1);expect(calls.some(call=>call.method==='createBorrowRequest')).toBe(false);
  await page.locator('#dashboard-equipment-search').fill('asus');
  for(const theme of ['light','dark']){await page.evaluate(theme=>CRS.theme.apply(theme,true),theme);await page.setViewportSize({width:1440,height:900});await page.locator('#dashboard-equipment-search').scrollIntoViewIfNeeded();await expectNoOverflow(page);await captureUi(page,'catalog-dashboard-gallery-desktop-'+theme);await page.setViewportSize({width:390,height:844});await page.locator('#dashboard-equipment-search').scrollIntoViewIfNeeded();await expectNoOverflow(page);await captureUi(page,'catalog-dashboard-gallery-mobile-'+theme);}
});

test('typing before auto-pagination completes uses the latest keyword and never displays unrelated or stale search results',async({page})=>{
  await mock(page,{signedOut:true});let release;const gate=new Promise(resolve=>release=resolve);
  const items=Array.from({length:26},(_,i)=>({asset_id:'AST-'+String(i+1).padStart(6,'0'),name:i===25?'ASUS notebook':'Camera '+i,status:'AVAILABLE',can_borrow:true,imageAvailable:false}));
  await page.route('**/api/rpc',async route=>{const input=route.request().postDataJSON();if(input.method!=='listPublicEquipment')return route.fallback();const number=input.args[0].page;if(number===1)await gate;await route.fulfill({json:{ok:true,data:{items:items.slice((number-1)*24,number*24),page:number,total:26,totalPages:2}}});});
  await page.goto('/');await page.locator('#guest-search').fill('asus');release();await expect(page.locator('[data-layout="gallery"] .drift-wall__tile')).toHaveCount(1);await expect(page.locator('.drift-name')).toHaveText('ASUS notebook');await expect(page.locator('#guest-search')).toBeFocused();
});

test('Drift Wall auto-loads every published page only, exposes status overlays and keeps the Guest borrow handoff',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});const publicCalls=[];
  const items=Array.from({length:29},(_,i)=>({asset_id:'AST-'+String(i+1).padStart(6,'0'),name:'Public item '+(i+1),category_name:'Public',brand:'Fixture',model:'Wall',status:i%2?'MAINTENANCE':'AVAILABLE',can_borrow:i%2===0,imageAvailable:false}));
  await page.route('**/api/rpc',async route=>{const input=route.request().postDataJSON();if(input.method!=='listPublicEquipment')return route.fallback();publicCalls.push(input);const number=input.args[0].page;await route.fulfill({json:{ok:true,data:{items:items.slice((number-1)*24,number*24),page:number,total:29,totalPages:2}}});});
  await page.goto('/');await expect(page.locator('.drift-wall__tile:not([data-wall-copy])')).toHaveCount(29);
  expect(publicCalls.map(value=>value.args[0].page)).toEqual([1,2]);
  await page.locator('[data-wall-mode]').click();
  const unavailable=page.locator('[data-wall-asset="AST-000002"]:not([data-wall-copy])');await unavailable.click();
  await expect(page.locator('.experience-dialog')).toContainText('ซ่อมบำรุง');await expect(page.locator('.experience-dialog')).toContainText('ยังไม่พร้อมให้ยืม');
  await page.keyboard.press('Escape');await expect(unavailable).toBeFocused();
  await page.locator('[data-guest-borrow="AST-000001"]').click();await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('#confirm-modal [data-confirm-accept]').click();await expect(page.locator('#login-email')).toBeVisible();
  expect(calls.some(call=>['listEquipment','getEquipmentImage','createBorrowRequest'].includes(call.method))).toBe(false);
  expect(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('crs.guest.borrow-intent.v1')).assetId)).toBe('AST-000001');
  expect(await page.evaluate(()=>document.getAnimations().filter(a=>a.effect?.target?.closest('.equipment-wall')).length)).toBe(0);
});

test('Drift Wall pauses offscreen/hidden, provides unique keyboard controls and static responsive TH/EN Light/Dark fallbacks',async({page})=>{
  await mock(page,{signedOut:true});await page.goto('/');await expect(page.locator('.equipment-wall')).toHaveAttribute('data-motion','running');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.locator('.equipment-wall')).toHaveAttribute('data-motion','paused');
  await page.evaluate(()=>{Object.defineProperty(document,'hidden',{configurable:true,value:false});document.dispatchEvent(new Event('visibilitychange'));});
  await expect(page.locator('.equipment-wall')).toHaveAttribute('data-motion','running');
  await page.locator('[data-guest-borrow]').focus();await expect(page.locator('.drift-wall')).toHaveAttribute('data-static','true');
  for(const width of [320,390,1024,1440])for(const theme of ['light','dark'])for(const language of ['th','en']){
    await page.setViewportSize({width,height:900});await page.evaluate(({theme,language})=>{CRS.theme.apply(theme,true);CRS.language.set(language);},{theme,language});
    await expect(page.locator('.drift-wall__tile:not([data-wall-copy])')).toHaveCount(1);
    await expect(page.locator('[data-guest-borrow] .drift-status')).toHaveText(language==='th'?'พร้อมยืม':'Available');await expectNoOverflow(page);
  }
  await page.emulateMedia({reducedMotion:'reduce'});await expect(page.locator('.drift-wall')).toHaveAttribute('data-static','true');await expect(page.locator('.equipment-wall')).toHaveAttribute('data-motion','paused');
  await captureUi(page,'drift-wall-reduced-desktop-dark');await page.setViewportSize({width:390,height:844});await captureUi(page,'drift-wall-mobile-dark');
});

test('authenticated Dashboard Wall uses the guarded catalog and selection enters the unchanged borrow workflow',async({page})=>{
  const {calls,record}=await mock(page);await page.goto('/');await expect(page.locator('.dashboard-equipment-wall .drift-wall')).toBeVisible();
  const item=page.locator('.dashboard-equipment-wall .drift-wall__tile:not([data-wall-copy])');await item.focus();await item.click();
  await expect(page.locator('#page-borrow')).toBeVisible();
  expect(calls.some(call=>call.method==='listEquipment'&&call.args[0].pageSize===100)).toBe(true);
  expect(calls.some(call=>call.method==='getEquipmentDetail'&&call.args[0]===record.asset_id)).toBe(true);
  expect(calls.some(call=>call.method==='createBorrowRequest')).toBe(false);
  expect(await page.evaluate(()=>document.getAnimations().filter(a=>a.effect?.target?.closest('.equipment-wall')).length)).toBe(0);
});

test('Wall retains private image delivery/fallback and unavailable authenticated selection cannot submit a borrow',async({page})=>{
  const {calls,record}=await mock(page);
  await page.route('https://test.supabase.co/**',route=>route.fulfill({status:404,body:''}));
  await page.route('**/api/rpc',async route=>{const input=route.request().postDataJSON();if(input.method!=='listEquipment')return route.fallback();await route.fulfill({json:{ok:true,data:{items:[{...record,status:'DAMAGED',can_borrow:false,imageAvailable:true,image_url:'/api/image-placeholder'}],page:1,total:1,totalPages:1}}});});
  await page.goto('/');const item=page.locator('.dashboard-equipment-wall [data-wall-asset]:not([data-wall-copy])');await item.focus();
  await expect(item.locator('.drift-image-fallback')).toBeVisible();await expect.poll(()=>calls.filter(c=>c.method==='getEquipmentImage').length).toBe(1);
  await item.click();await expect(page.locator('.experience-dialog')).toContainText('ชำรุด');await page.keyboard.press('Escape');await expect(item).toBeFocused();
  expect(calls.some(c=>c.method==='createBorrowRequest')).toBe(false);expect(await item.locator('img').getAttribute('src')).toBeNull();
  await page.evaluate(()=>CRS.theme.apply('dark',true));await captureUi(page,'drift-dashboard-dark-placeholder');
});

test('incomplete/changing public pagination fails visibly without private fallbacks or stale wall insertion',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});let requests=0;
  await page.route('**/api/rpc',async route=>{const input=route.request().postDataJSON();if(input.method!=='listPublicEquipment')return route.fallback();requests++;await route.fulfill({json:{ok:true,data:{items:[],page:input.args[0].page,total:requests===1?25:26,totalPages:2}}});});
  await page.goto('/');await expect(page.locator('.guest-status')).toContainText('รายการอุปกรณ์เปลี่ยนแปลง');await expect(page.locator('.equipment-wall')).toHaveCount(0);expect(requests).toBe(2);expect(calls.some(c=>c.method==='listEquipment')).toBe(false);
});

async function holdKey(page,control,key=' '){await control.focus();await page.keyboard.down(key);await expect(page.locator('#equipment-delete-modal')).toBeVisible({timeout:4000});await page.keyboard.up(key);}
test('Hold Button covers detail and final delete, requires exact typed ID, blocks click/Enter-submit, and sends one guarded mutation',async({page})=>{
  // Keep this workflow fixture stationary. The separate cancellation regression
  // exercises real scroll/blur; a focus-induced smooth scroll must cancel holds.
  await page.emulateMedia({reducedMotion:'reduce'});
  const {calls,record}=await mock(page);await page.goto('/?view=equipment-detail&id='+record.asset_id);
  const entry=page.locator('#page-equipment-detail [data-action="delete-equipment"]');await expect(entry).toHaveClass(/hold-button/);
  await entry.click();await expect(page.locator('#equipment-delete-modal')).toBeHidden();await holdKey(page,entry);
  await expect(page.locator('#equipment-delete-modal')).toBeVisible();const submit=page.locator('#equipment-delete-form [data-submit]');await expect(submit).toBeDisabled();
  await page.locator('#equipment-delete-confirm').fill('wrong');await expect(submit).toBeDisabled();
  await page.locator('#equipment-delete-confirm').fill(record.asset_id);await expect(submit).toBeEnabled();
  await submit.click();await page.locator('#equipment-delete-confirm').press('Enter');
  expect(calls.filter(call=>call.method==='adminDeleteEquipment')).toHaveLength(0);
  await submit.focus();await page.keyboard.down('Enter');await expect(page.locator('#equipment-delete-modal')).toBeHidden({timeout:5000});await page.keyboard.up('Enter');
  const requests=calls.filter(call=>call.method==='adminDeleteEquipment');expect(requests).toHaveLength(1);
  expect(requests[0].args[0]).toMatchObject({asset_id:record.asset_id,confirm:true,confirm_asset_id:record.asset_id,expected_version:record.row_version});
  await expect(page.locator('#page-equipment')).toBeVisible();
});

test('Hold Button cancels release, pointer escape/cancel, focus loss, tab hiding, disabled transitions and repeated keys',async({page})=>{
  const {calls,record}=await mock(page);await page.goto('/?view=equipment-detail&id='+record.asset_id);
  const button=page.locator('#page-equipment-detail [data-action="delete-equipment"]');await expect(button).toHaveClass(/hold-button/);
  const box=await button.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await expect(button).toHaveAttribute('data-phase','holding');await page.mouse.up();await expect(button).toHaveAttribute('data-phase','idle');
  await page.mouse.down();await page.mouse.move(box.x-20,box.y);await expect(button).toHaveAttribute('data-phase','idle');await page.mouse.up();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.evaluate(()=>document.querySelector('#page-equipment-detail [data-action="delete-equipment"]').dispatchEvent(new PointerEvent('pointercancel',{pointerId:1,bubbles:true})));await expect(button).toHaveAttribute('data-phase','idle');await page.mouse.up();
  for(const cancellation of ['blur','hidden','disable','cancel','focus','scroll','resize']){
    await button.focus();await page.keyboard.down(' ');await expect(button).toHaveAttribute('data-phase','holding');
    await page.evaluate(kind=>{const b=document.querySelector('#page-equipment-detail [data-action="delete-equipment"]');if(kind==='blur')window.dispatchEvent(new Event('blur'));if(kind==='hidden'){Object.defineProperty(document,'hidden',{configurable:true,value:true});document.dispatchEvent(new Event('visibilitychange'));}if(kind==='disable')b.disabled=true;if(kind==='cancel')b.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));if(kind==='focus')document.querySelector('[data-route="equipment"]').focus();if(kind==='scroll')window.dispatchEvent(new Event('scroll'));if(kind==='resize')window.dispatchEvent(new Event('resize'));},cancellation);
    await expect(button).toHaveAttribute('data-phase','idle');await page.keyboard.up(' ');
    await page.evaluate(()=>{document.querySelector('#page-equipment-detail [data-action="delete-equipment"]').disabled=false;Object.defineProperty(document,'hidden',{configurable:true,value:false});});
  }
  expect(calls.some(call=>call.method==='adminDeleteEquipment')).toBe(false);await expect(page.locator('#equipment-delete-modal')).toBeHidden();
  await button.focus();await page.keyboard.down(' ');await page.keyboard.down(' ');await page.keyboard.press('Escape');await page.keyboard.up(' ');await expect(button).toHaveAttribute('data-phase','idle');
});

test('Hold Button is applied in cards/table and protected controls remain fail-closed if its optional module fails',async({page})=>{
  const {calls}=await mock(page);await page.goto('/?view=equipment');
  await expect(page.locator('#page-equipment [data-action="delete-equipment"]:visible')).toHaveClass(/hold-button/);
  await page.locator('[data-action="set-equipment-view"][data-view-mode="table"]').click();await expect(page.locator('#page-equipment [data-action="delete-equipment"]:visible')).toHaveClass(/hold-button/);
  await page.route('**/crs/react-bits.js',route=>route.abort());await page.reload();
  await page.locator('#page-equipment [data-action="delete-equipment"]:visible').click();await expect(page.locator('#equipment-delete-modal')).toBeHidden();
  expect(calls.some(call=>call.method==='adminDeleteEquipment')).toBe(false);
});

test('moving Wall pointer selection does not rearrange the pressed tile; optional-adapter fallback stays public-only',async({page})=>{
  const {calls}=await mock(page,{signedOut:true});await page.goto('/');await expect(page.locator('.equipment-wall')).toHaveAttribute('data-motion','running');
  // Actual pointer path, not actionability waiting for an infinite animation.
  const box=await page.locator('.drift-wall__tile[data-wall-copy]').first().boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await expect(page.locator('.equipment-wall')).toHaveAttribute('data-motion','paused');await expect(page.locator('.drift-wall')).toHaveAttribute('data-static','false');await page.mouse.up();
  await expect(page.locator('#confirm-modal')).toBeVisible();await page.locator('[data-confirm-cancel]').click();
  await page.route('**/crs/react-bits.js',route=>route.abort());await page.reload();await expect(page.locator('.guest-grid [data-guest-borrow]')).toBeVisible();
  expect(calls.some(c=>['listEquipment','getEquipmentImage','createBorrowRequest'].includes(c.method))).toBe(false);
});

test('native touch hold opens only the guarded delete dialog and release before completion cancels',async({page})=>{
  await page.setViewportSize({width:390,height:844});const {calls,record}=await mock(page);await page.goto('/?view=equipment-detail&id='+record.asset_id);
  const button=page.locator('#page-equipment-detail [data-action="delete-equipment"]');await button.scrollIntoViewIfNeeded();await expect(button).toHaveClass(/hold-button/);
  const cdp=await page.context().newCDPSession(page);await cdp.send('Emulation.setTouchEmulationEnabled',{enabled:true});const box=await button.boundingBox(),point={x:box.x+box.width/2,y:box.y+box.height/2};
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await expect(button).toHaveAttribute('data-phase','holding');await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await expect(button).toHaveAttribute('data-phase','idle');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await expect(page.locator('#equipment-delete-modal')).toBeVisible({timeout:4000});await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await expect(page.locator('#equipment-delete-form [data-submit]')).toBeDisabled();expect(calls.some(c=>c.method==='adminDeleteEquipment')).toBe(false);
});

test('Drift/Hold presentation captures use only synthetic catalog data across themes and mobile',async({page})=>{
  const {record}=await mock(page,{signedOut:true});
  await page.route('**/api/rpc',async route=>{const input=route.request().postDataJSON();if(input.method!=='listPublicEquipment')return route.fallback();await route.fulfill({json:{ok:true,data:{items:Array.from({length:10},(_,i)=>({asset_id:'AST-'+String(i+1).padStart(6,'0'),name:'Equipment '+(i+1),status:i%2?'RESERVED':'AVAILABLE',can_borrow:i%2===0,imageAvailable:false})),page:1,total:10,totalPages:1}}});});
  await page.goto('/');for(const theme of ['light','dark']){await page.evaluate(theme=>CRS.theme.apply(theme,true),theme);await expect(page.locator('.drift-wall')).toBeVisible();await captureUi(page,'drift-wall-desktop-'+theme);}
  await page.setViewportSize({width:390,height:844});await expect(page.locator('.drift-wall')).toHaveAttribute('data-static','true');await captureUi(page,'drift-wall-mobile-catalog');
  await page.unroute('**/api/rpc');await mock(page);await page.goto('/?view=equipment-detail&id='+record.asset_id);const entry=page.locator('#page-equipment-detail [data-action="delete-equipment"]');await holdKey(page,entry);await page.locator('#equipment-delete-confirm').fill(record.asset_id);
  for(const theme of ['light','dark']){await page.evaluate(theme=>CRS.theme.apply(theme,true),theme);await captureUi(page,'hold-delete-dialog-mobile-'+theme);}await expectNoOverflow(page);
});
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

async function captureUi(page, name, {staticView=false}={}) {
  // Opt-in local artifacts use only isolated synthetic fixtures, never live sessions.
  if (process.env.CRS_UI_CAPTURE !== '1') return;
  mkdirSync('test-results/ui', { recursive: true });
  if(!staticView)await page.evaluate(async()=>{
    await document.fonts.ready;
    await Promise.all(document.getAnimations().filter(animation=>animation.effect.getTiming().iterations!==Infinity&&!animation.effect.target?.closest('.magic-grid-pattern')).map(animation=>animation.finished.catch(()=>{})));
  });
  // Modal layout captures freeze presentation with Playwright, without
  // awaiting background transitions that do not own the modal's readiness.
  await page.screenshot({ path: 'test-results/ui/' + name + '.png', fullPage: true, ...(staticView?{animations:'disabled'}:{}) });
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
  await page.evaluate(()=>CRS.language.set('en'));
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
  await page.locator('[data-guest-borrow]').focus();await page.locator('[data-guest-borrow]').click();await expect(page.locator('#confirm-modal')).toBeVisible();
  await page.locator('#confirm-modal [data-confirm-accept]').click();await expect(page.locator('#password-login-form')).toBeVisible();
  await page.locator('#login-email').fill('admin@example.test');await page.locator('#login-password').fill('Fixture passphrase only!');await page.locator('#password-login-submit').click();
  await expect(page.locator('#form-borrow-request')).toBeVisible();
  await expect(page.locator('#borrow-equipment-asset-id')).toHaveText(record.asset_id);
  expect(calls.filter(call=>call.method==='createBorrowRequest')).toHaveLength(0);
  expect(await page.evaluate(()=>sessionStorage.getItem('crs.guest.borrow-intent.v1'))).toBeNull();
});

test('security settings verify email OTP before revealing matching-policy password controls',async({page})=>{
  const {calls}=await mock(page);await page.goto('/?view=settings&section=profile');
  await expect(page.locator('#account-heading')).toBeVisible();await page.locator('#view-root [data-route="settings"]').click();await page.locator('[data-settings-section="security"]').click();
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

test('topbar follows Settings language without a quick language button; theme retains its two states',async({page})=>{
  await mock(page,{preserveSession:true});await page.goto('/?view=settings&section=appearance');
  await expect(page.locator('.settings-global-actions')).toHaveCount(0);
  await page.locator('[data-settings-theme="system"]').click();await expect(page.locator('html')).toHaveAttribute('data-theme-preference','system');
  await page.goto('/?view=equipment');
  await expect(page.locator('.topbar-actions [data-experience-action="language"]')).toHaveCount(0);
  await page.goto('/?view=settings');await page.locator('#language-trigger').click();await page.locator('[data-language-code="en"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang','en');await page.goto('/?view=dashboard');
  await expect(page.locator('.topbar-actions [data-experience-action="guide"]')).toHaveText('Guide');
  await expect(page.locator('.notification-bell')).toHaveAttribute('aria-label',/Notifications/);
  await page.goto('/?view=settings');await page.locator('#language-trigger').click();await page.locator('[data-language-code="th"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang','th');await page.goto('/?view=dashboard');
  await expect(page.locator('.topbar-actions [data-experience-action="guide"]')).toHaveText('คู่มือ');
  await expect(page.locator('.topbar-actions [data-experience-action="language"]')).toHaveCount(0);
  await page.locator('.topbar-actions [data-action="theme-toggle"]').click();await expect(page.locator('html')).not.toHaveAttribute('data-theme-preference','system');
  await page.locator('.topbar-actions [data-action="theme-toggle"]').click();await expect(page.locator('html')).not.toHaveAttribute('data-theme-preference','system');
  await page.goto('/?view=dashboard');await page.locator('[data-experience-action="notifications"]').click();await expect(page.locator('.notification-popover .notification-item')).toContainText('อนุมัติ');
});

test('Settings has only Thai/English and selecting a language reloads the same route and session',async({page})=>{
  const {calls}=await mock(page,{preserveSession:true});await page.goto('/?view=settings');
  await expect(page.locator('.settings-global-actions')).toHaveCount(0);
  await page.locator('#language-trigger').click();
  await expect(page.locator('#language-list [data-language-code]')).toHaveCount(2);
  await expect(page.locator('#language-list [data-language-code="auto"]')).toHaveCount(0);
  const token=await page.evaluate(()=>sessionStorage.getItem('crs.auth.session.v1'));
  await page.evaluate(()=>window.fixtureDocumentMarker='before-language-selection');
  await page.locator('#language-list [data-language-code="en"]').click();
  await expect.poll(()=>page.evaluate(()=>window.fixtureDocumentMarker||null)).toBeNull();
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(page.locator('#language-trigger')).toContainText('English');
  await expect(page.locator('#settings-heading')).toHaveText('General settings');
  await expect(page.locator('.settings-nav-heading').first()).toHaveText('Personal');
  await expect(page.locator('.settings-workspace h2')).toHaveText('General settings');
  expect(await page.evaluate(()=>sessionStorage.getItem('crs.auth.session.v1'))).toBe(token);
  expect(calls.filter(call=>call.method==='passwordSignIn'||call.method==='beginOAuthSignIn')).toHaveLength(0);
  await page.goto('/?view=equipment');await expect(page.locator('#equipment-title')).toHaveText('Choose the right equipment');
  await page.goto('/?view=settings');await page.locator('#language-trigger').click();
  await page.locator('[data-language-code="th"]').click();await expect(page.locator('html')).toHaveAttribute('lang','th');
  await expect(page.locator('#settings-heading')).toHaveText('การตั้งค่าทั่วไป');
  await expect(page.locator('.settings-nav-heading').first()).toHaveText('ส่วนตัว');
  await page.goto('/?view=equipment');await expect(page.locator('#equipment-title')).toHaveText('เลือกอุปกรณ์ที่ใช่');
});

for(const preference of ['auto','de','zh','invalid'])test('obsolete language '+preference+' safely falls back to Thai',async({page})=>{
  await page.addInitScript(saved=>localStorage.setItem('crs-ui-language',saved),preference);
  await mock(page);await page.goto('/?view=settings');
  await expect(page.locator('html')).toHaveAttribute('lang','th');
  expect(await page.evaluate(()=>CRS.language.options.map(item=>item.code))).toEqual(['th','en']);
  await expect(page.locator('#language-trigger')).toContainText('ไทย');
});

for(const width of [390,1440])test('Settings toggle alignment and action removal at '+width,async({page})=>{
  await mock(page);await page.setViewportSize({width,height:844});await page.goto('/?view=settings&section=appearance');
  if(width<768)await page.locator('#settings-mobile-toggle').click();
  await expect(page.locator('#settings-sidebar-toggle')).toHaveAttribute('aria-expanded','true');
  const expanded=await page.locator('#settings-sidebar-toggle').evaluate(node=>{
    const button=node.getBoundingClientRect(),header=node.parentElement.getBoundingClientRect();return {offset:button.left-header.left,justify:getComputedStyle(node.parentElement).justifyContent};
  });expect(expanded.justify).toBe('flex-start');expect(expanded.offset).toBeLessThan(20);
  await expect(page.locator('.settings-workspace .settings-global-actions')).toHaveCount(0);
  if(width>=768){await page.locator('#settings-sidebar-toggle').click();await expect(page.locator('#settings-sidebar-toggle')).toHaveAttribute('aria-expanded','false');
    const centered=await page.locator('#settings-sidebar-toggle').evaluate(node=>{const a=node.getBoundingClientRect(),b=node.parentElement.getBoundingClientRect();return Math.abs((a.left+a.width/2)-(b.left+b.width/2));});expect(centered).toBeLessThan(1);
  }
  if(process.env.CRS_UI_CAPTURE==='1'){
    mkdirSync('test-results/ui',{recursive:true});
    for(const [theme,language] of [['light','th'],['dark','en']]){
      await page.evaluate(([theme,language])=>{CRS.theme.apply(theme,true);CRS.language.set(language);},[theme,language]);await page.reload();
      await expect(page.locator('html')).toHaveAttribute('lang',language);
      if(width<768)await page.locator('#settings-mobile-toggle').click();
      await page.screenshot({path:'test-results/ui/settings-'+width+'-'+theme+'-'+language+'.png',animations:'disabled'});
    }
  }
});

test('English localizes source UI but never equipment record text or stored enums',async({page})=>{
  const {record}=await mock(page);await page.addInitScript(()=>localStorage.setItem('crs-ui-language','en'));
  await page.route('**/api/rpc',async route=>{const input=route.request().postDataJSON();if(input.method!=='listEquipment')return route.fallback();await route.fulfill({json:{ok:true,data:{items:[{...record,name:'ชื่ออุปกรณ์',description:'รายละเอียด อุปกรณ์',status:'AVAILABLE'}],page:1,total:1,totalPages:1}}});});
  await page.goto('/?view=equipment');await expect(page.locator('#equipment-title')).toHaveText('Choose the right equipment');
  await expect(page.locator('#equipment-results')).toContainText('ชื่ออุปกรณ์');
  await expect(page.locator('#equipment-results')).toContainText('Available');
  expect(record.status).toBe('AVAILABLE');
});

test('Settings language reload uses a tab-local fallback when persistent writes fail',async({page})=>{
  await mock(page,{preserveSession:true});await page.addInitScript(()=>{const original=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(this===window.localStorage)throw new DOMException('Fixture quota exceeded','QuotaExceededError');return original.call(this,key,value);};});
  await page.goto('/?view=settings');await page.locator('#language-trigger').click();await page.locator('[data-language-code="en"]').click();
  await expect(page.locator('html')).toHaveAttribute('lang','en');
  await expect(page.locator('#settings-heading')).toHaveText('General settings');
  expect(await page.evaluate(()=>sessionStorage.getItem('crs-ui-language-fallback'))).toBe('en');
  await page.reload();await expect(page.locator('html')).toHaveAttribute('lang','en');
});

test('blocked localization asset preserves the original guarded bootstrap and Settings',async({page})=>{
  await mock(page);await page.route('**/crs/i18n.js',route=>route.abort());
  await page.goto('/?view=equipment');await expect(page.locator('#equipment-results')).toBeVisible();
  expect(await page.evaluate(()=>CRS.auth.hasSession())).toBe(true);
  await page.goto('/?view=settings');await page.locator('#language-trigger').click();
  await expect(page.locator('[data-language-code]')).toHaveCount(2);
  await expect(page.locator('.settings-global-actions')).toHaveCount(0);
});

test('Login effects and icon/search geometry respect reduced motion, touch, theme and viewport',async({page})=>{
  await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:390,height:844});await page.goto('/');
  await openLogin(page);
  await expect(page.locator('.liquid-glass-cursor')).toBeHidden();await expect(page.locator('.login-foil')).toHaveCount(0);
  const location=await page.locator('#theme-toggle-login').evaluate(node=>{const style=getComputedStyle(node.querySelector('i'));return{inside:!!node.closest('.access-card'),align:style.alignItems,justify:style.justifyContent};});expect(location.inside).toBe(true);expect(location.align).toBe('center');expect(location.justify).toBe('center');
  await expect(page.locator('.access-card [data-experience-action="language"]')).toHaveCount(0);
  await page.evaluate(()=>CRS.language.set('en'));await expect(page.locator('#access-state-title')).toHaveText('Sign in');await expect(page.locator('label[for="login-email"]')).toHaveText('Email');
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
  // This fixture tests guarded commands, not Bootstrap's opening transition.
  await page.emulateMedia({reducedMotion:'reduce'});
  const {calls,record}=await mock(page);await page.goto('/?view=equipment-detail&id='+record.asset_id);
  const publish=page.locator('[data-equipment-public]');await expect(publish).toHaveText('เปิดให้ Guest ดู');await expect(publish).toBeEnabled();await publish.click();
  await page.locator('#confirm-modal [data-confirm-accept]').click();await expect(publish).toHaveText('ปิดการแสดงต่อ Guest');
  const input=calls.find(call=>call.method==='adminSetEquipmentPublic').args[0];expect(input).toMatchObject({assetId:record.asset_id,isPublic:true,expectedVersion:1});
  await page.goto('/?view=admin&tab=users');const temporary=page.locator('[data-temporary-user]').last();await expect(temporary).toBeVisible();await temporary.click();
  await page.locator('#confirm-modal [data-confirm-accept]').click();await expect.poll(()=>calls.filter(call=>call.method==='adminIssueTemporaryPassword').length).toBe(1);
  expect(Object.keys(calls.find(call=>call.method==='adminIssueTemporaryPassword').args[0]).sort()).toEqual(['commandId','userId']);
  await expect(page.locator('.toast').last()).toContainText('ส่งและเปิดใช้รหัสชั่วคราวแล้ว');
});

test('Login uses saved language without a quick toggle, keeps its centered pairs and home inside story',async({page})=>{
  await mock(page,{signedOut:true});
  await page.addInitScript(()=>Object.defineProperty(navigator,'language',{value:'en-US',configurable:true}));
  for(const width of [320,390,768,1440])for(const theme of ['light','dark']){
    await page.setViewportSize({width,height:900});await page.goto('/');await openLogin(page);
    await page.evaluate(value=>window.CRS.theme.apply(value,true),theme);
    await expect(page.locator('html')).toHaveAttribute('lang','th');
    await expect(page.locator('#access-state [data-experience-action="language"]')).toHaveCount(0);
    await expect(page.locator('.login-story > .entry-navigation [data-experience-action="home"]')).toBeVisible();
    await expect(page.locator('#access-state > .entry-navigation')).toHaveCount(0);
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
        last:control.lastElementChild.id,controls:control.children.length,navInside:document.querySelector('.login-story').contains(document.querySelector('.entry-navigation'))};
    });
    expect(geometry.remember).toBeLessThan(1);expect(geometry.security).toBeLessThan(1);expect(geometry.resetRight).toBeLessThan(1);
    expect(geometry.last).toBe('theme-toggle-login');expect(geometry.controls).toBe(1);expect(geometry.navInside).toBe(true);await expectNoOverflow(page);
  }
  await page.locator('.entry-navigation [data-experience-action="home"]').click();
  await page.locator('.guest-controls [data-experience-action="language"]').click();await openLogin(page);await expect(page.locator('html')).toHaveAttribute('lang','en');
  await page.reload();await openLogin(page);await expect(page.locator('#access-state-title')).toHaveText('Sign in');
  await expect(page.locator('#access-state [data-experience-action="language"]')).toHaveCount(0);
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
  await page.evaluate(()=>CRS.language.set('en'));
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
  await language.focus();await page.keyboard.press('Enter');await expect(page.locator('[data-guest-borrow] .drift-action')).toHaveText('Borrow');
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
