import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fields,tables } from '../../server/schema.mjs';
import { loadDomain,saveDomain } from '../../server/domain.mjs';
import { publicEquipment,setVisibility,notificationInbox,publicLinks } from '../../server/experience.mjs';
import { applyAdditiveMigrations } from '../../server/migrations.mjs';
const {bootstrappedHarness,createEquipment,createUser}=createRequire(import.meta.url)('../backend/test-helpers.cjs');
process.env.WEB_APP_URL='https://fixture.example.test';
process.env.GOOGLE_OAUTH_CLIENT_ID='experience-fixture.apps.googleusercontent.com';
process.env.ALLOWED_DOMAINS='example.com';
async function setup(){
  const legacy=bootstrappedHarness(),asset=createEquipment(legacy),borrower=createUser(legacy,{suffix:'public'});
  const db=new PGlite();await db.exec(readFileSync(new URL('../../supabase/migrations/202610050001_crs.sql',import.meta.url),'utf8'));
  // pg's no-parameter query uses the simple protocol (multiple trusted SQL statements).
  // PGlite query always prepares; adapt its exec to the same client interface.
  const client={query:(sql,args)=>args?db.query(sql,args):db.exec(sql).then(results=>results.at(-1))};
  const transact=async work=>{await db.exec('BEGIN');try{const result=await work(client);await db.exec('COMMIT');return result;}catch(error){await db.exec('ROLLBACK');throw error;}};
  await applyAdditiveMigrations(transact);
  await transact(async()=>{
    for(const [name,table] of Object.entries(tables))for(const raw of legacy.records(name))await db.query(`INSERT INTO crs.${table}(data) VALUES($1)`,[JSON.stringify(Object.fromEntries(fields[name].map(field=>[field,raw[field]??''])))]);
  });
  const admin=legacy.records('Users').find(row=>row.role==='ADMIN');
  const session={userId:admin.user_id,email:admin.email,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+3600};
  return {db,transact,asset,admin,borrower,session};
}
test('additive schema is idempotent/checksummed and private with no client policies',async()=>{
  const f=await setup();try{
    await applyAdditiveMigrations(f.transact);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.runtime_migrations')).rows[0].n,1);
    const result=await f.db.query("SELECT relname,relrowsecurity FROM pg_class JOIN pg_namespace n ON n.oid=relnamespace WHERE n.nspname='crs' AND relname IN ('password_credentials','password_challenges','security_mail','notifications','equipment_visibility')");
    assert.equal(result.rows.length,5);assert.ok(result.rows.every(row=>row.relrowsecurity));
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='crs'")).rows[0].n,0);
    await f.db.query("UPDATE crs.runtime_migrations SET sha256='changed'");await assert.rejects(applyAdditiveMigrations(f.transact),/source changed/);
  }finally{await f.db.close();}
});
test('Guest sees no assets by default; explicit publication projects allowlisted fields and current deletion removes it',async()=>{
  const f=await setup();try{
    assert.equal((await publicEquipment(f.db)).items.length,0);
    const payload={assetId:f.asset.asset_id,isPublic:true,expectedVersion:f.asset.row_version,commandId:'public-fixture-publish'};
    await f.transact(async db=>{const domain=await loadDomain(db,{session:f.session});await setVisibility(db,domain,f.admin,payload);await saveDomain(db,domain);});
    const result=await publicEquipment(f.db);assert.equal(result.items.length,1);
    assert.deepEqual(Object.keys(result.items[0]).sort(),['asset_id','name','brand','model','category_name','status','can_borrow','imageAvailable','detail_url'].sort());
    assert.equal(result.items[0].status,'AVAILABLE');
    assert.match(result.items[0].detail_url,/^https:\/\/fixture\.example\.test/);assert.equal(result.items[0].imageAvailable,false);
    await f.transact(async db=>{const domain=await loadDomain(db,{session:f.session});await setVisibility(db,domain,f.admin,payload);await saveDomain(db,domain);});
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.history WHERE data->>\'operation_id\'=$1',[payload.commandId])).rows[0].n,1);
    await assert.rejects(setVisibility(f.db,await loadDomain(f.db),f.borrower,payload),e=>e.code==='FORBIDDEN');
    await f.db.query("UPDATE crs.equipment SET data=jsonb_set(data,'{status}','\"DELETED\"') WHERE id=$1",[f.asset.asset_id]);
    assert.equal((await publicEquipment(f.db)).items.length,0);
    await assert.rejects(publicEquipment(f.db,{assetId:f.asset.asset_id}),e=>e.code==='NOT_FOUND');
  }finally{await f.db.close();}
});
test('public catalog pages/status remain narrow; private, deleted, retired, lost and inactive-category records never enter the wall',async()=>{
  const f=await setup();try{
    const base=(await f.db.query('SELECT data FROM crs.equipment WHERE id=$1',[f.asset.asset_id])).rows[0].data;
    for(let i=1;i<=30;i++){
      const id='AST-'+String(i+10).padStart(6,'0'),status=i===28?'LOST':i===29?'RETIRED':i===30?'DELETED':i%2?'MAINTENANCE':'AVAILABLE';
      await f.db.query('INSERT INTO crs.equipment(data) VALUES($1)',[JSON.stringify({...base,asset_id:id,status,sku:'PUBLIC-'+i,serial_number:'PUBLIC-SERIAL-'+i,image_file_id:'private-resource',image_url:'https://private.invalid/image',note:'internal-private',active_borrow_id:'',name:'Public '+String(i).padStart(2,'0')})]);
      await f.db.query('INSERT INTO crs.equipment_visibility(asset_id,is_public,updated_by) VALUES($1,true,$2)',[id,f.admin.user_id]);
    }
    const first=await publicEquipment(f.db),second=await publicEquipment(f.db,{page:2});
    assert.equal(first.items.length,24);assert.equal(second.items.length,3);assert.equal(first.total,27);assert.equal(first.totalPages,2);
    const all=[...first.items,...second.items];assert.equal(new Set(all.map(item=>item.asset_id)).size,27);
    for(const item of all){assert.equal(item.can_borrow,item.status==='AVAILABLE');assert.equal(item.imageAvailable,false);assert.ok(['AVAILABLE','MAINTENANCE'].includes(item.status));for(const field of ['note','serial_number','image_file_id','image_url','active_borrow_id','row_version'])assert.ok(!Object.hasOwn(item,field));}
    assert.ok(!all.some(item=>item.asset_id===f.asset.asset_id));
    await f.db.query("UPDATE crs.categories SET data=jsonb_set(data,'{status}','\"INACTIVE\"') WHERE id=$1",[base.category_id]);
    assert.equal((await publicEquipment(f.db)).items.length,0);
  }finally{await f.db.close();}
});

test('new committed Borrow History projects per-recipient notifications exactly once; inbox/read ownership remains private',async()=>{
  const f=await setup();try{
    const invoke=async(method,input,actor)=>f.transact(async db=>{const domain=await loadDomain(db,{session:{...f.session,userId:actor.user_id,email:actor.email}});const response=domain.invoke(method,['fixture-session',input]);assert.equal(response.ok,true,JSON.stringify(response.error));await saveDomain(db,domain);return response.data;});
    const input={command_id:'notify-fixture-request',asset_id:f.asset.asset_id,borrow_date:'2026-10-07',due_date:'2026-10-08',purpose:'Notification fixture'};
    const borrow=await invoke('createBorrowRequest',input,f.borrower);await invoke('createBorrowRequest',input,f.borrower);
    let inbox=await notificationInbox(f.db,f.borrower);assert.equal(inbox.items.length,1);assert.equal(inbox.unread,1);
    const adminInbox=await notificationInbox(f.db,f.admin);assert.equal(adminInbox.items.length,1);
    await notificationInbox(f.db,f.borrower,{readId:adminInbox.items[0].id});assert.equal((await notificationInbox(f.db,f.admin)).unread,1);
    const approval={command_id:'notify-fixture-approve',borrow_id:borrow.borrow_id,expected_version:borrow.row_version};
    await invoke('adminApproveBorrow',approval,f.admin);await invoke('adminApproveBorrow',approval,f.admin);
    inbox=await notificationInbox(f.db,f.borrower);assert.equal(inbox.items.length,2);assert.equal(inbox.items[0].action,'APPROVE');
    await notificationInbox(f.db,f.borrower,{readId:inbox.items[0].id});assert.equal((await notificationInbox(f.db,f.borrower)).unread,1);
    await assert.rejects(f.transact(async db=>{const domain=await loadDomain(db,{session:f.session});domain.context.appendHistoryLocked_({action:'CHECKOUT',borrowId:'BR-999999',operationId:'invalid-fixture-history'},f.admin);await saveDomain(db,domain);}));
    assert.equal((await notificationInbox(f.db,f.borrower)).items.length,2);
  }finally{await f.db.close();}
});

test('checkout, return-request, inspected return and rejection events are authoritative and replay-deduplicated',async()=>{
  const f=await setup();try{
    const invoke=async(method,input,actor)=>f.transact(async db=>{const domain=await loadDomain(db,{session:{...f.session,userId:actor.user_id,email:actor.email}});const response=domain.invoke(method,['fixture-session',input]);assert.equal(response.ok,true,JSON.stringify(response.error));await saveDomain(db,domain);return response.data;});
    const input={command_id:'all-events-request',asset_id:f.asset.asset_id,borrow_date:'2026-10-07',due_date:'2026-10-08',purpose:'Lifecycle event fixture'};
    let borrow=await invoke('createBorrowRequest',input,f.borrower);
    const approve={command_id:'all-events-approve',borrow_id:borrow.borrow_id,expected_version:borrow.row_version};
    borrow=await invoke('adminApproveBorrow',approve,f.admin);
    const checkout={command_id:'all-events-checkout',borrow_id:borrow.borrow_id,expected_version:borrow.row_version};
    borrow=await invoke('adminCheckoutBorrow',checkout,f.admin);await invoke('adminCheckoutBorrow',checkout,f.admin);
    const returning={command_id:'all-events-return-request',borrow_id:borrow.borrow_id,expected_version:borrow.row_version};
    borrow=await invoke('requestReturn',returning,f.borrower);await invoke('requestReturn',returning,f.borrower);
    const items=(await loadDomain(f.db)).records.BorrowItems.filter(item=>item.borrow_id===borrow.borrow_id).map(item=>({borrow_item_id:item.borrow_item_id,returned_quantity:1,note:''}));
    const returned={command_id:'all-events-return',borrow_id:borrow.borrow_id,expected_version:borrow.row_version,condition:'NORMAL',disposition:'AVAILABLE',items};
    await invoke('adminCompleteReturn',returned,f.admin);await invoke('adminCompleteReturn',returned,f.admin);
    borrow=await invoke('createBorrowRequest',{...input,command_id:'all-events-next-request'},f.borrower);
    const rejected={command_id:'all-events-reject',borrow_id:borrow.borrow_id,expected_version:borrow.row_version,reason:'Synthetic rejection'};
    await invoke('adminRejectBorrow',rejected,f.admin);await invoke('adminRejectBorrow',rejected,f.admin);
    const inbox=await notificationInbox(f.db,f.borrower);assert.equal(inbox.items.length,7);
    assert.deepEqual(inbox.items.map(item=>item.action).sort(),['BORROW_REQUEST','APPROVE','CHECKOUT','REQUEST_RETURN','RETURN','BORROW_REQUEST','REJECT'].sort());
    assert.equal((await notificationInbox(f.db,f.admin)).items.length,3); // Two requests and one return request.
  }finally{await f.db.close();}
});

test('public footer metadata returns only the operator-approved Google policy destinations, never environment values',()=>{
  const approved={privacyUrl:'https://policies.google.com/privacy',termsUrl:'https://policies.google.com/terms'};
  assert.deepEqual(publicLinks(),approved);
  assert.deepEqual(publicLinks({SMTP_PASSWORD:'synthetic-secret',PRIVACY_POLICY_URL:'javascript:alert(1)',TERMS_OF_SERVICE_URL:'https://user:pass@example.test'}),approved);
  assert.deepEqual(publicLinks({PRIVACY_POLICY_URL:'https://example.test/privacy',TERMS_OF_SERVICE_URL:'https://example.test/terms'}),approved);
});
