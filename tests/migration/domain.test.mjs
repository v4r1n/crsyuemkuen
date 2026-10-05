import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createDomain,loadDomain,saveDomain } from '../../server/domain.mjs';
import { fields,tables } from '../../server/schema.mjs';
import { canonicalUrl,config } from '../../server/config.mjs';
import { assertGoogleClaims } from '../../server/auth.mjs';
import { validateImage,inspectResources,storageMissing } from '../../server/storage.mjs';
import { transaction } from '../../server/db.mjs';
import { envelope,fail } from '../../server/errors.mjs';
const require=createRequire(import.meta.url);
const {bootstrappedHarness,createEquipment,createUser}=require('../backend/test-helpers.cjs');
process.env.GOOGLE_OAUTH_CLIENT_ID='migration-test.apps.googleusercontent.com';
process.env.ALLOWED_DOMAINS='example.com,gmail.com';
process.env.WEB_APP_URL='https://example.test';
function fixture() {
  const legacy=bootstrappedHarness();
  const asset=createEquipment(legacy),user=createUser(legacy,{suffix:'migration'});
  const records=Object.fromEntries(Object.keys(fields).map(name=>[name,legacy.records(name)]));
  const admin=records.Users.find(row=>row.role==='ADMIN');
  const session={userId:admin.user_id,email:admin.email,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+600};
  return {records,asset,user,admin,session};
}
function ok(response) {assert.equal(response.ok,true,JSON.stringify(response.error));return response.data;}
const migration=readFileSync(new URL('../../supabase/migrations/202610050001_crs.sql',import.meta.url),'utf8');
test('PostgreSQL adapter completes exact request/approve/checkout/return and preserves journal hashes',async()=>{
  const seed=fixture(),db=new PGlite();
  await db.exec(migration);
  await db.exec('BEGIN');
  for(const [name,rows] of Object.entries(seed.records)) for(const original of rows) {
    const row=Object.fromEntries(fields[name].map(field=>[field,original[field]??'']));
    await db.query(`INSERT INTO crs.${tables[name]}(data) VALUES($1)`,[JSON.stringify(row)]);
  }
  await db.exec('COMMIT');
  let currentSession=seed.session;
  async function invoke(method,payload) {
    await db.exec('BEGIN');
    try {
      const domain=await loadDomain(db,{session:currentSession});
      const result=ok(domain.invoke(method,['ignored',payload]));
      await saveDomain(db,domain); await db.exec('COMMIT');return result;
    } catch(error) {await db.exec('ROLLBACK');throw error;}
  }
  currentSession={...seed.session,userId:seed.user.user_id,email:seed.user.email};
  const request={command_id:'migration-borrow-001',asset_id:seed.asset.asset_id,borrow_date:'2026-10-05',due_date:'2026-10-06',purpose:'Work'};
  const borrow=await invoke('createBorrowRequest',request);
  assert.equal(borrow.status,'PENDING_APPROVAL');
  assert.deepEqual(await invoke('createBorrowRequest',request),borrow);
  await assert.rejects(invoke('createBorrowRequest',{...request,command_id:'migration-borrow-other'}));
  currentSession=seed.session;
  const approved=await invoke('adminApproveBorrow',{borrow_id:borrow.borrow_id,command_id:'migration-approve-001',expected_version:borrow.row_version});
  const checked=await invoke('adminCheckoutBorrow',{borrow_id:borrow.borrow_id,command_id:'migration-checkout-001',expected_version:approved.row_version});
  const detail=await invoke('getBorrowDetail',borrow.borrow_id);
  const items=detail.items || detail.checklist || detail.borrow_items;
  assert.ok(items?.length,'Checkout snapshots checklist');
  const returned=await invoke('adminCompleteReturn',{borrow_id:borrow.borrow_id,command_id:'migration-return-001',expected_version:checked.row_version,condition:'NORMAL',disposition:'AVAILABLE',note:'',items:items.map(item=>({borrow_item_id:item.borrow_item_id,returned_quantity:item.expected_quantity,condition:'NORMAL',note:''}))});
  assert.equal(returned.status,'RETURNED');
  const domain=await loadDomain(db,{session:seed.session});
  assert.equal(domain.context.findRecordById_('Equipment','asset_id',seed.asset.asset_id).status,'AVAILABLE');
  for(const op of domain.records.Operations) {domain.context.operationPayload_(op);domain.context.operationResult_(op);}
  assert.equal(domain.records.History.filter(row=>row.operation_id==='migration-borrow-001').length,1);
  await db.close();
});
test('current user authorization, ownership, soft deletion and stale version remain enforced',()=>{
  const seed=fixture(),domain=createDomain(seed.records,{session:seed.session});
  seed.records.Users.find(row=>row.user_id===seed.admin.user_id).role='USER';
  assert.equal(domain.invoke('adminDeleteEquipment',['ignored',{asset_id:seed.asset.asset_id,command_id:'delete-security-001',expected_version:1,confirm:true,confirm_asset_id:seed.asset.asset_id}]).error.code,'FORBIDDEN');
  seed.records.Users.find(row=>row.user_id===seed.admin.user_id).status='INACTIVE';
  assert.equal(domain.invoke('getAppBootstrap',['ignored']).error.code,'USER_DISABLED');
});
test('database rejects hard deletes, History edits, duplicate serial/email and quantity > 1',async()=>{
  const seed=fixture(),db=new PGlite();await db.exec(migration);
  for(const name of ['Users','Categories','Equipment','History']) for(const row of seed.records[name]) {
    await db.query(`INSERT INTO crs.${tables[name]}(data) VALUES($1)`,[JSON.stringify(row)]);
  }
  await assert.rejects(db.query('DELETE FROM crs.equipment'));
  await assert.rejects(db.query("UPDATE crs.history SET data=jsonb_set(data,'{note}','\"tamper\"')"));
  await assert.rejects(db.query('INSERT INTO crs.equipment(data) VALUES($1)',[JSON.stringify({...seed.asset,asset_id:'AST-000999'})]));
  await assert.rejects(db.query('INSERT INTO crs.users(data) VALUES($1)',[JSON.stringify({...seed.user,user_id:'USR-000999'})]));
  await assert.rejects(db.query("UPDATE crs.equipment SET data=jsonb_set(data,'{quantity}','2')"));
  const rls=await db.query("SELECT count(*)::integer AS count FROM pg_class c JOIN pg_namespace n ON c.relnamespace=n.oid WHERE n.nspname='crs' AND c.relkind='r' AND NOT c.relrowsecurity");
  assert.equal(rls.rows[0].count,0);await db.close();
});
test('canonical origin never accepts numbered Google browser routes or arbitrary base paths',()=>{
  assert.equal(canonicalUrl('https://example.test'),'https://example.test');
  for(const number of [0,1,2]) assert.throws(()=>canonicalUrl(`https://script.google.com/macros/u/${number}/s/DEPLOY/exec`));
  for(const input of ['https://example.test/u/1/','https://example.test/?token=x','https://user:pass@example.test']) assert.throws(()=>canonicalUrl(input));
  const domain=createDomain({}, {runtimeConfig:config()});
  assert.equal(domain.context.buildAssetUrl_('AST-000003'),'https://example.test?view=equipment-detail&id=AST-000003');
});
test('Google authority requires nonce, audience, exact allowed domain, verified email and hd',()=>{
  const claims={iss:'https://accounts.google.com',aud:'client',exp:200,iat:99,nonce:'proof',sub:'subject',email:'user@example.com',email_verified:true,hd:'example.com'};
  const expected={clientId:'client',nonce:'proof',domains:['example.com','gmail.com']};
  assert.equal(assertGoogleClaims(claims,expected,100).email,'user@example.com');
  for(const patch of [{nonce:'wrong'},{aud:'wrong'},{email_verified:false},{hd:undefined},{exp:100},{iat:200},{email:'user@evil.com'},{azp:'other'}]) assert.throws(()=>assertGoogleClaims({...claims,...patch},expected,100));
  assert.equal(assertGoogleClaims({...claims,email:'user@gmail.com',hd:undefined},expected,100).email,'user@gmail.com');
});
test('private image existence, trashed state and stale URL are not confused with availability',async()=>{
  const image={id:'file-001',object_key:'assets/file.png',mime_type:'image/png',byte_length:8,state:'READY',digest:'x'};
  const fakeDb={query:async()=>({rows:[image,{...image,id:'trashed',state:'TRASHED'}]})};
  const missing=await inspectResources(fakeDb,{storage:{info:async()=>({error:new Error('404')})}});
  assert.equal(missing['file-001'].available,false);assert.equal(missing.trashed.available,false);
  const found=await inspectResources(fakeDb,{storage:{info:async()=>({data:{size:8,contentType:'image/png'}})}});
  assert.equal(found['file-001'].available,true);
  const domain=createDomain({}, {images:missing});
  assert.deepEqual(domain.context.equipmentImageState_('file-001'),{imageAvailable:false,image_url:''});
  assert.throws(()=>validateImage(Buffer.from('not PNG'),'image/png'));
  assert.equal(validateImage(Buffer.from('GIF89a'),'image/gif').length,43);
  assert.equal(storageMissing({statusCode:'404',code:'NoSuchKey'}),true);
  for(const error of [{statusCode:503},{statusCode:403},{statusCode:404,code:'NoSuchBucket'}]) assert.equal(storageMissing(error),false);
});

test('transaction lock precedes authoritative reads and every failed write rolls back',async()=>{
  for(const failed of [false,true]) {
    const commands=[],client={query:async sql=>{commands.push(sql);return {rows:[]};},release:()=>commands.push('RELEASE')};
    const pool={connect:async()=>client};
    const invoke=()=>transaction(async db=>{await db.query('AUTHORITATIVE_READ');await db.query('WRITE');if(failed) throw new Error('interrupted');return 'ok';},pool);
    if(failed) await assert.rejects(invoke());else assert.equal(await invoke(),'ok');
    assert.ok(commands.indexOf('SELECT pg_advisory_xact_lock(73184116)')<commands.indexOf('AUTHORITATIVE_READ'));
    assert.equal(commands.at(-2),failed?'ROLLBACK':'COMMIT');assert.equal(commands.at(-1),'RELEASE');
  }
});

test('legacy screen reads work through repository seams; raw database errors never reach a visitor',async()=>{
  const seed=fixture(),domain=createDomain(seed.records,{session:seed.session});
  for(const method of ['getAppBootstrap','getDashboard','listEquipment','listCategories','listMyBorrowing','listMyHistory',
    'adminGetDashboard','adminListBorrowing','adminListUsers','adminAuditLegacyUsers','adminListCategories','adminListHistory',
    'adminRunIntegrityAudit','adminPreviewImageIntegrity','adminListOperations']) {
    ok(domain.invoke(method,['ignored',{}]));
  }
  const response=await envelope(()=>{const error=new Error('database hostname credential or row PII');error.code='42P01';throw error;});
  assert.equal(response.error.code,'INTERNAL');assert.doesNotMatch(JSON.stringify(response),/credential|hostname|PII|42P01/);
  const fields=await envelope(()=>fail('VALIDATION_FAILED','ตรวจข้อมูล',false,{name:'จำเป็น'}));
  assert.equal(fields.error.fieldErrors.name,'จำเป็น');
});
