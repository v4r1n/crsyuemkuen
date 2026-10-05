const {test,expect}=require('@playwright/test');
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
