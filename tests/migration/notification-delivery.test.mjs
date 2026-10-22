import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createECDH,createHash} from 'node:crypto';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import webpush from 'web-push';
import {fields,tables} from '../../server/schema.mjs';
import {digest,secret,loadDomain,saveDomain} from '../../server/domain.mjs';
import {notificationPreferences} from '../../server/settings-security.mjs';
import {deliveryConfiguration,validateSubscription,ownPushSubscription,deliveryProcessor} from '../../server/notification-delivery.mjs';
import {snapshotTables,reserveRestore,commitRestore} from '../../tools/restore-records.mjs';
import {pushTestConfiguration} from '../../server/notification-config.mjs';
import {pushTestService} from '../../server/push-test.mjs';
import {projectDueReminders,reminderCurrent,bangkokDate} from '../../server/due-reminders.mjs';
import {notificationInbox} from '../../server/experience.mjs';
const require=createRequire(import.meta.url),{bootstrappedHarness,createEquipment,createUser}=require('../backend/test-helpers.cjs');
const keys=webpush.generateVAPIDKeys();
test('expired Production diagnostic reproduces disabled Push independently of browser or OS',()=>{
  const user={status:'ACTIVE',email:'diagnostic@example.test'},now=Date.parse('2026-10-22T00:00:00.000Z');
  const env={NOTIFICATION_DELIVERY_ENABLED:'false',WRITE_FREEZE:'false',VERCEL_ENV:'production',WEB_APP_URL:'https://crsyuemkuen.vercel.app',
    PUSH_TEST_USER_SHA256:createHash('sha256').update(user.email).digest('hex'),PUSH_TEST_EXPIRES_AT:'2026-10-16T22:00:00.000Z',
    WEB_PUSH_SUBJECT:'mailto:fixture@example.test',WEB_PUSH_PUBLIC_KEY:keys.publicKey,WEB_PUSH_PRIVATE_KEY:keys.privateKey};
  assert.equal(deliveryConfiguration(env).push,false);
  assert.equal(pushTestConfiguration(user,env,now).available,false);
  assert.equal(pushTestConfiguration(user,{...env,PUSH_TEST_EXPIRES_AT:'2026-10-22T12:00:00.000Z'},now).available,true);
  assert.equal(deliveryConfiguration(env).push,false,'diagnostic renewal must not activate global dispatch');
});
Object.assign(process.env,{WEB_APP_URL:'https://delivery.example.test',GOOGLE_OAUTH_CLIENT_ID:'delivery-fixture.apps.googleusercontent.com',
  ALLOWED_DOMAINS:'example.com,gmail.com',WRITE_FREEZE:'false',NOTIFICATION_DELIVERY_ENABLED:'true',
  SMTP_HOST:'smtp.example.test',SMTP_PORT:'587',SMTP_USER:'fixture',SMTP_PASSWORD:'synthetic-only-password',SMTP_FROM:'fixture@example.com',
  WEB_PUSH_SUBJECT:'mailto:fixture@example.com',WEB_PUSH_PUBLIC_KEY:keys.publicKey,WEB_PUSH_PRIVATE_KEY:keys.privateKey});
const migrations=['202610050001_crs','202610070002_identity_experience','20261014054612_settings_security','20261015064806_owner_profile','20261016023629_notification_delivery','20261022091806_due_reminders'];
function subscription(suffix='fixture') {
  const curve=createECDH('prime256v1');curve.generateKeys();
  return {endpoint:'https://fcm.googleapis.com/fcm/send/'+suffix,keys:{p256dh:curve.getPublicKey().toString('base64url'),auth:Buffer.alloc(16,7).toString('base64url')}};
}
function testEnvironment(email) {
  return {...process.env,VERCEL_ENV:'production',WEB_APP_URL:'https://crsyuemkuen.vercel.app',WRITE_FREEZE:'false',
    NOTIFICATION_DELIVERY_ENABLED:'false',PUSH_TEST_USER_SHA256:createHash('sha256').update(email).digest('hex'),
    PUSH_TEST_EXPIRES_AT:new Date(Date.now()+3600000).toISOString()};
}
async function withPushTest(email,work){
  const next=testEnvironment(email),names=['VERCEL_ENV','WEB_APP_URL','WRITE_FREEZE','NOTIFICATION_DELIVERY_ENABLED','PUSH_TEST_USER_SHA256','PUSH_TEST_EXPIRES_AT'];
  const before=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  try{for(const k of names)process.env[k]=next[k];return await work();}
  finally{for(const k of names){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k];}}
}
async function fixture() {
  const legacy=bootstrappedHarness(),asset=createEquipment(legacy),user=createUser(legacy,{suffix:'delivery'});
  const records=Object.fromEntries(Object.keys(fields).map(name=>[name,legacy.records(name)])),admin=records.Users.find(row=>row.role==='ADMIN');
  const db=new PGlite();for(const file of migrations)await db.exec(readFileSync(new URL('../../supabase/migrations/'+file+'.sql',import.meta.url),'utf8'));
  await db.exec('BEGIN');
  for(const [name,rows] of Object.entries(records))for(const value of rows)await db.query('INSERT INTO crs.'+tables[name]+'(data) VALUES($1)',[JSON.stringify(Object.fromEntries(fields[name].map(field=>[field,value[field]??''])))]);
  await db.exec('COMMIT');
  const token=secret('session1_'),session={userId:user.user_id,email:user.email,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+3600};
  await db.query('INSERT INTO crs.sessions(id,data,expires_at) VALUES($1,$2,to_timestamp($3))',[digest(token),session,session.expiresAt]);
  let inTransaction=false;
  const transact=async work=>{assert.equal(inTransaction,false);await db.exec('BEGIN');inTransaction=true;try{const result=await work(db);await db.exec('COMMIT');return result;}catch(error){await db.exec('ROLLBACK');throw error;}finally{inTransaction=false;}};
  const request={command_id:'delivery-borrow-fixture',asset_id:asset.asset_id,borrow_date:'2026-10-16',due_date:'2026-10-17',purpose:'Fixture'};
  async function borrow(overrides={}){return transact(async db=>{const domain=await loadDomain(db,{session});const result=domain.invoke('createBorrowRequest',[token,{...request,...overrides}]);assert.equal(result.ok,true,JSON.stringify(result.error));await saveDomain(db,domain);return result.data;});}
  const rows=async()=>(await db.query('SELECT * FROM crs.notification_delivery ORDER BY id')).rows;
  return {db,user,admin,token,transact,borrow,rows,outside:()=>assert.equal(inTransaction,false)};
}

test('Bangkok reminder boundaries preserve custody states and invalidate stale dates',()=>{
  const now=Date.parse('2026-10-22T17:00:00Z');assert.equal(bangkokDate(now),'2026-10-23');
  const notice={action:'DUE_SOON',reminder_day:'2026-10-23',reminder_due_date:'2026-10-24'};
  const borrow={status:'CHECKED_OUT',due_date:'2026-10-24'};
  assert.equal(reminderCurrent(notice,borrow,now),true);
  assert.equal(reminderCurrent(notice,{...borrow,status:'RETURN_REQUESTED'},now),true);
  for(const status of ['RETURNED','APPROVED','PENDING_APPROVAL','REJECTED'])assert.equal(reminderCurrent(notice,{...borrow,status},now),false);
  assert.equal(reminderCurrent(notice,{...borrow,due_date:'2026-10-25'},now),false);
  assert.equal(reminderCurrent(notice,borrow,now+86400000),false);
  assert.equal(reminderCurrent({...notice,action:'OVERDUE',reminder_due_date:'2026-10-22'},{...borrow,due_date:'2026-10-22'},now),true);
  assert.equal(reminderCurrent({...notice,action:'OVERDUE'},borrow,now),false);
});

test('current custody reminders dedupe today, never invent History, suppress stale delivery and respect freeze',async()=>{
  const f=await fixture(),beforeFlag=process.env.DUE_REMINDERS_ENABLED;
  try {
    process.env.DUE_REMINDERS_ENABLED='true';
    let borrow=await f.borrow();
    async function invoke(method,input){return f.transact(async db=>{const domain=await loadDomain(db,{session:{userId:f.admin.user_id,email:f.admin.email,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+3600}});const result=domain.invoke(method,['fixture-admin-session',input]);assert.equal(result.ok,true,JSON.stringify(result.error));await saveDomain(db,domain);return result.data;});}
    borrow=await invoke('adminApproveBorrow',{command_id:'reminder-approve',borrow_id:borrow.borrow_id,expected_version:borrow.row_version});
    borrow=await invoke('adminCheckoutBorrow',{command_id:'reminder-checkout',borrow_id:borrow.borrow_id,expected_version:borrow.row_version});
    await notificationPreferences(f.db,f.user,{event:'DUE_SOON',channel:'EMAIL',expectedVersion:0},f.token);
    const history=JSON.stringify((await f.db.query('SELECT * FROM crs.history ORDER BY id')).rows);
    const now=Date.parse('2026-10-16T05:00:00Z');
    assert.equal((await f.transact(db=>projectDueReminders(db,{now,userId:f.admin.user_id}))).created,0);
    assert.equal((await f.transact(db=>projectDueReminders(db,{now}))).created,1);
    assert.equal((await f.transact(db=>projectDueReminders(db,{now}))).created,0);
    const notices=(await f.db.query("SELECT * FROM crs.notifications WHERE action='DUE_SOON'")).rows;
    assert.equal(notices.length,1);assert.equal(notices[0].history_id,null);assert.equal(notices[0].user_id,f.user.user_id);
    assert.equal(JSON.stringify((await f.db.query('SELECT * FROM crs.history ORDER BY id')).rows),history);
    assert.equal((await f.rows()).length,1);
    let sent=0;await deliveryProcessor({transact:f.transact,email:async()=>{sent++;return 'ACCEPTED';}})();
    assert.equal(sent,0,'old-day reminder must not dispatch');
    assert.equal((await f.rows())[0].status,'CANCELLED');
    process.env.WRITE_FREEZE='true';assert.equal((await projectDueReminders(f.db,{now:now+2*86400000})).created,0);process.env.WRITE_FREEZE='false';
    assert.equal((await f.transact(db=>projectDueReminders(db,{now:now+2*86400000}))).created,1);
    assert.equal((await f.transact(db=>projectDueReminders(db,{now:now+3*86400000}))).created,1,'only the current day, no gap backfill');
    const count=(await f.db.query("SELECT count(*)::int n FROM crs.notifications WHERE action='OVERDUE'")).rows[0].n;assert.equal(count,2);
    process.env.DUE_REMINDERS_ENABLED='false';assert.equal((await projectDueReminders(f.db,{now:now+4*86400000})).created,0);
  }finally{process.env.WRITE_FREEZE='false';if(beforeFlag===undefined)delete process.env.DUE_REMINDERS_ENABLED;else process.env.DUE_REMINDERS_ENABLED=beforeFlag;await f.db.close();}
});

test('today reminder reaches owner inbox and opt-in provider once; inspected return invalidates it',async()=>{
  const f=await fixture(),prior=process.env.DUE_REMINDERS_ENABLED;
  try{
    process.env.DUE_REMINDERS_ENABLED='true';
    let borrow=await f.borrow({borrow_date:bangkokDate(),due_date:bangkokDate(Date.now()+86400000)});
    const invoke=(method,input)=>f.transact(async db=>{const domain=await loadDomain(db,{session:{userId:f.admin.user_id,email:f.admin.email,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+3600}});const result=domain.invoke(method,['fixture-admin-session',input]);assert.equal(result.ok,true,JSON.stringify(result.error));await saveDomain(db,domain);return result.data;});
    borrow=await invoke('adminApproveBorrow',{command_id:'today-reminder-approve',borrow_id:borrow.borrow_id,expected_version:borrow.row_version});
    borrow=await invoke('adminCheckoutBorrow',{command_id:'today-reminder-checkout',borrow_id:borrow.borrow_id,expected_version:borrow.row_version});
    await notificationPreferences(f.db,f.user,{event:'DUE_SOON',channel:'EMAIL',expectedVersion:0},f.token);
    await f.transact(db=>projectDueReminders(db));
    assert.equal((await notificationInbox(f.db,f.user)).items.filter(item=>item.action==='DUE_SOON').length,1);
    assert.equal((await notificationInbox(f.db,f.admin)).items.filter(item=>item.action==='DUE_SOON').length,0,'admin does not get borrower reminder');
    let sent=0;const worker=deliveryProcessor({transact:f.transact,email:async job=>{f.outside();assert.equal(job.event,'DUE_SOON');sent++;return 'ACCEPTED';}});
    await worker();await worker();assert.equal(sent,1);
    const items=(await loadDomain(f.db)).records.BorrowItems.filter(item=>item.borrow_id===borrow.borrow_id).map(item=>({borrow_item_id:item.borrow_item_id,returned_quantity:1,note:''}));
    await invoke('adminCompleteReturn',{command_id:'today-reminder-return',borrow_id:borrow.borrow_id,expected_version:borrow.row_version,condition:'NORMAL',disposition:'AVAILABLE',items});
    assert.equal((await notificationInbox(f.db,f.user)).items.filter(item=>item.action==='DUE_SOON').length,0);
    assert.equal((await projectDueReminders(f.db)).created,0);
  }finally{if(prior===undefined)delete process.env.DUE_REMINDERS_ENABLED;else process.env.DUE_REMINDERS_ENABLED=prior;await f.db.close();}
});

test('delivery configuration fails closed; subscription validates capability host/key without arbitrary network',()=>{
  assert.equal(deliveryConfiguration().push,true);assert.equal(deliveryConfiguration().email,true);
  assert.equal(deliveryConfiguration({...process.env,NOTIFICATION_DELIVERY_ENABLED:'false'}).push,false);
  assert.equal(deliveryConfiguration({...process.env,WEB_PUSH_PRIVATE_KEY:keys.publicKey}).push,false);
  const sub=subscription();assert.equal(validateSubscription(sub),sub);
  for(const endpoint of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.test/x','https://fcm.googleapis.com:444/x','https://user@fcm.googleapis.com/x','https://fcm.googleapis.com/x#secret','https://fcm.googleapis.com/../x','https://fcm.googleapis.com/\nfoo'])
    assert.throws(()=>validateSubscription({...sub,endpoint}),error=>error.code==='VALIDATION_FAILED');
  assert.throws(()=>validateSubscription({...sub,keys:{...sub.keys,auth:'bad'}}));
});

test('account-only diagnostic is exact-owner, canonical Production, expiring and never global delivery',()=>{
  const user={status:'ACTIVE',email:'push-test@example.com'},env=testEnvironment(user.email),now=Date.now();
  assert.equal(pushTestConfiguration(user,env,now).available,true);
  assert.equal(deliveryConfiguration(env).enabled,false);assert.equal(deliveryConfiguration(env).push,false);
  for(const change of [{VERCEL_ENV:'preview'},{WEB_APP_URL:'https://crsyuemkuen-preview.vercel.app'},{WRITE_FREEZE:'true'},
    {NOTIFICATION_DELIVERY_ENABLED:'true'},{PUSH_TEST_USER_SHA256:''},{PUSH_TEST_USER_SHA256:'a'.repeat(64)},
    {PUSH_TEST_EXPIRES_AT:new Date(now-1).toISOString()},{PUSH_TEST_EXPIRES_AT:new Date(now+86400001).toISOString()},
    {PUSH_TEST_EXPIRES_AT:'2030-01-01'},{WEB_PUSH_PRIVATE_KEY:'invalid'}])
    assert.equal(pushTestConfiguration(user,{...env,...change},now).available,false,JSON.stringify(Object.keys(change)));
  for(const owner of [undefined,{...user,status:'INACTIVE'},{...user,email:'other@example.com'},{...user,email:'PUSH-TEST@example.com'}])
    assert.equal(pushTestConfiguration(owner,env,now).available,false);
});

test('diagnostic permits only opted-in current-session device; reserves before I/O without business/outbox/history mutation',async()=>{
  const f=await fixture();try{await withPushTest(f.user.email,async()=>{
    const before=await notificationPreferences(f.db,f.user,undefined,f.token);
    assert.equal(before.pushTestAvailable,true);assert.equal(before.channels.push,false);assert.equal(before.channels.email,false);
    assert.equal(before.pushPublicKey,keys.publicKey);assert.equal(before.pushRegistered,false);
    const history=(await f.db.query('SELECT count(*)::int n FROM crs.history')).rows[0].n;
    let sends=0;const send=pushTestService({transact:f.transact,push:async job=>{
      f.outside();sends++;assert.equal(job.test,true);assert.match(job.notification_id,/^[A-Za-z0-9_-]{43}$/);
      assert.equal(job.subscription.user_id,f.user.user_id);return 'ACCEPTED';
    }});
    await assert.rejects(send(f.token,{}),e=>e.code==='NOTIFICATION_UNAVAILABLE');
    await ownPushSubscription(f.db,f.user,f.token,subscription());
    assert.equal((await notificationPreferences(f.db,f.user,undefined,f.token)).pushRegistered,true);
    assert.equal((await send(f.token,{})).status,'ACCEPTED');
    await assert.rejects(send(f.token,{}),e=>e.code==='RATE_LIMITED');assert.equal(sends,1);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM crs.history')).rows[0].n,history);
    assert.equal((await f.rows()).length,0);assert.equal((await f.db.query('SELECT count(*)::int n FROM crs.notifications')).rows[0].n,0);
    assert.equal((await f.db.query('SELECT count(*)::int n FROM crs.notification_preferences')).rows[0].n,0);
    assert.equal(pushTestConfiguration(f.admin).available,false);
    const other=await notificationPreferences(f.db,f.admin);assert.equal(other.pushTestAvailable,false);assert.equal(other.pushPublicKey,null);
    await assert.rejects(ownPushSubscription(f.db,f.admin,f.token,subscription('other')),e=>e.code==='NOTIFICATION_UNAVAILABLE');
    await assert.rejects(send(f.token,{email:f.admin.email}),e=>e.code==='VALIDATION_FAILED');
    process.env.WRITE_FREEZE='true';await assert.rejects(send(f.token,{}),e=>e.code==='WRITE_FROZEN');
  });}finally{await f.db.close();}
});

test('diagnostic ambiguity cannot resend, revoked/expired proof cannot dispatch',async()=>{
  const f=await fixture();try{await withPushTest(f.user.email,async()=>{
    await ownPushSubscription(f.db,f.user,f.token,subscription());let calls=0;
    const send=pushTestService({transact:f.transact,push:async()=>{calls++;throw Error('provider payload must not escape');}});
    await assert.rejects(send('invalid-session',{}),e=>e.code==='UNAUTHENTICATED');assert.equal(calls,0);
    const result=await send(f.token,{});assert.deepEqual(result,{status:'UNCERTAIN',deviceReceiptConfirmed:false});
    await assert.rejects(send(f.token,{}),e=>e.code==='RATE_LIMITED');assert.equal(calls,1);
    process.env.PUSH_TEST_EXPIRES_AT=new Date(Date.now()-1).toISOString();await assert.rejects(send(f.token,{}),e=>e.code==='NOTIFICATION_UNAVAILABLE');
    await f.db.query('DELETE FROM crs.sessions WHERE id=$1',[digest(f.token)]);
    await assert.rejects(send(f.token,{}),e=>e.code==='UNAUTHENTICATED');assert.equal(calls,1);
  });}finally{await f.db.close();}
});

test('external opt-in is owner/version/admin guarded; Push requires this session device, channels are single-select',async()=>{
  const f=await fixture();try {
    const before=await notificationPreferences(f.db,f.user,undefined,f.token);assert.equal(before.items[0].channel,null);
    await assert.rejects(notificationPreferences(f.db,f.user,{event:'BORROW_REQUEST',channel:'PUSH',expectedVersion:0},f.token));
    await ownPushSubscription(f.db,f.user,f.token,subscription());
    const result=await notificationPreferences(f.db,f.user,{event:'BORROW_REQUEST',channel:'PUSH',expectedVersion:0},f.token);
    assert.equal(result.items[0].channel,'PUSH');assert.equal(result.items[0].inApp,true);assert.equal(result.pushRegistered,true);
    const email=await notificationPreferences(f.db,f.user,{event:'BORROW_REQUEST',channel:'EMAIL',expectedVersion:1},f.token);
    assert.equal(email.items[0].channel,'EMAIL');
    await assert.rejects(notificationPreferences(f.db,f.user,{event:'BORROW_REQUEST',channel:'PUSH',expectedVersion:1},f.token),error=>error.code==='STATE_CONFLICT');
    await assert.rejects(notificationPreferences(f.db,f.user,{event:'ADMIN_BORROW_REQUEST',channel:'EMAIL',expectedVersion:0},f.token));
    await assert.rejects(ownPushSubscription(f.db,f.admin,f.token,subscription()),error=>error.code==='STATE_CONFLICT');
    const dto=JSON.stringify(email);assert.ok(!dto.includes(keys.privateKey));assert.ok(!dto.includes('fcm.googleapis.com'));assert.ok(!dto.includes(digest(f.token)));
    for(const table of ['push_subscriptions','notification_delivery']) {
      assert.equal((await f.db.query('SELECT relrowsecurity FROM pg_class WHERE oid=$1::regclass',['crs.'+table])).rows[0].relrowsecurity,true);
      assert.equal((await f.db.query('SELECT count(*)::int AS n FROM pg_policies WHERE schemaname=$1 AND tablename=$2',['crs',table])).rows[0].n,0);
    }
  }finally{await f.db.close();}
});

test('authoritative events enqueue once, retries do not duplicate; provider I/O follows commit and uncertain email never auto-replays',async()=>{
  const f=await fixture();try {
    await notificationPreferences(f.db,f.user,{event:'BORROW_REQUEST',channel:'EMAIL',expectedVersion:0},f.token);
    await notificationPreferences(f.db,f.admin,{event:'ADMIN_BORROW_REQUEST',channel:'EMAIL',expectedVersion:0});
    await f.borrow();await f.borrow();assert.equal((await f.rows()).length,2);
    let sent=0;const process=deliveryProcessor({transact:f.transact,email:async()=>{f.outside();sent++;return 'UNCERTAIN';}});
    await process();await process();assert.equal(sent,2);assert.ok((await f.rows()).every(row=>row.status==='UNCERTAIN'));
  }finally{await f.db.close();}
});

test('Push retries explicit rejection only, expired endpoint is removed, in-app state remains independent',async()=>{
  const f=await fixture();try {
    await ownPushSubscription(f.db,f.user,f.token,subscription());
    await notificationPreferences(f.db,f.user,{event:'BORROW_REQUEST',channel:'PUSH',inApp:false,expectedVersion:0},f.token);
    await f.borrow();let sent=0;
    const process=deliveryProcessor({transact:f.transact,push:async()=>{f.outside();return ++sent===1?'RETRY':'EXPIRED';}});
    await process();assert.equal((await f.rows())[0].status,'PENDING');
    await f.db.query("UPDATE crs.notification_delivery SET available_at=now()-interval '1 minute'");await process();
    assert.equal((await f.rows())[0].status,'CANCELLED');assert.equal((await f.db.query('SELECT id FROM crs.push_subscriptions')).rows.length,0);
    assert.equal((await notificationPreferences(f.db,f.user)).items[0].inApp,false);
  }finally{await f.db.close();}
});

test('worker rechecks preference, current access, origin and freeze; stale SENDING is uncertain, not resubmitted',async()=>{
  const f=await fixture();try {
    await notificationPreferences(f.db,f.user,{event:'BORROW_REQUEST',channel:'EMAIL',expectedVersion:0},f.token);await f.borrow();
    let sent=0;const worker=deliveryProcessor({transact:f.transact,email:async()=>{sent++;return 'ACCEPTED';}});
    process.env.WRITE_FREEZE='true';await worker();assert.equal(sent,0);process.env.WRITE_FREEZE='false';
    const origin=process.env.WEB_APP_URL;process.env.WEB_APP_URL='https://preview.example.test';await worker();assert.equal(sent,0);process.env.WEB_APP_URL=origin;
    await notificationPreferences(f.db,f.user,{event:'BORROW_REQUEST',channel:null,expectedVersion:1},f.token);await worker();assert.equal(sent,0);assert.equal((await f.rows())[0].status,'CANCELLED');
    await f.db.query("UPDATE crs.notification_delivery SET status='SENDING',started_at=now()-interval '3 minutes'");await worker();assert.equal((await f.rows())[0].status,'UNCERTAIN');assert.equal(sent,0);
  }finally{process.env.WRITE_FREEZE='false';await f.db.close();}
});

test('revoked sessions cannot receive Push, changed recipient email cancels queued mail, accepted work never repeats',async()=>{
  const f=await fixture();try {
    await ownPushSubscription(f.db,f.user,f.token,subscription());
    await notificationPreferences(f.db,f.user,{event:'BORROW_REQUEST',channel:'PUSH',expectedVersion:0},f.token);
    await notificationPreferences(f.db,f.admin,{event:'ADMIN_BORROW_REQUEST',channel:'EMAIL',expectedVersion:0});await f.borrow();
    await f.db.query('DELETE FROM crs.sessions WHERE id=$1',[digest(f.token)]);
    let sent=0;const worker=deliveryProcessor({transact:f.transact,push:async()=>{assert.fail('revoked device');},email:async()=>{sent++;return 'ACCEPTED';}});
    await worker();await worker();assert.equal(sent,1);
    assert.deepEqual((await f.rows()).map(row=>row.status).sort(),['ACCEPTED','CANCELLED']);
  }finally{await f.db.close();}
  const other=await fixture();try {
    await notificationPreferences(other.db,other.user,{event:'BORROW_REQUEST',channel:'EMAIL',expectedVersion:0},other.token);await other.borrow();
    await other.db.query("UPDATE crs.users SET data=jsonb_set(data,'{email}','\"changed@example.com\"') WHERE id=$1",[other.user.user_id]);
    await deliveryProcessor({transact:other.transact,email:async()=>assert.fail('changed recipient')})();assert.equal((await other.rows())[0].status,'CANCELLED');
  }finally{await other.db.close();}
});

test('worker authority is current: a demoted admin cannot receive another owner notice',async()=>{
  const f=await fixture();try {
    await notificationPreferences(f.db,f.admin,{event:'ADMIN_BORROW_REQUEST',channel:'EMAIL',expectedVersion:0});await f.borrow();
    await f.db.query("UPDATE crs.users SET data=jsonb_set(data,'{role}','\"USER\"') WHERE id=$1",[f.admin.user_id]);
    await deliveryProcessor({transact:f.transact,email:async()=>assert.fail('demoted admin')})();assert.equal((await f.rows())[0].status,'CANCELLED');
  }finally{await f.db.close();}
});

test('format-4 preferences survive empty-target restore but capabilities/attempts never replay historical delivery',async()=>{
  const f=await fixture();let target;try {
    await ownPushSubscription(f.db,f.user,f.token,subscription());
    await notificationPreferences(f.db,f.user,{event:'BORROW_REQUEST',channel:'PUSH',expectedVersion:0},f.token);await f.borrow();
    assert.equal((await f.rows()).length,1);
    const snapshot={format:4,tables:{}};for(const table of snapshotTables)snapshot.tables[table]=(await f.db.query('SELECT * FROM crs.'+table)).rows;
    assert.ok(!snapshotTables.includes('notification_delivery'));assert.ok(!snapshotTables.includes('push_subscriptions'));
    target=new PGlite();for(const file of migrations)await target.exec(readFileSync(new URL('../../supabase/migrations/'+file+'.sql',import.meta.url),'utf8'));
    const transact=async work=>{await target.exec('BEGIN');try{const result=await work(target);await target.exec('COMMIT');return result;}catch(error){await target.exec('ROLLBACK');throw error;}};
    await reserveRestore(snapshot,transact);await commitRestore(snapshot,transact);
    assert.equal((await target.query('SELECT external_channel FROM crs.notification_preferences')).rows[0].external_channel,'PUSH');
    assert.equal((await target.query('SELECT count(*)::int AS n FROM crs.sessions')).rows[0].n,0);
    assert.equal((await target.query('SELECT count(*)::int AS n FROM crs.push_subscriptions')).rows[0].n,0);
    assert.equal((await target.query('SELECT count(*)::int AS n FROM crs.notification_delivery')).rows[0].n,0);
    assert.equal((await deliveryProcessor({transact,push:async()=>assert.fail('restored history')})()).processed,0);
  }finally{await f.db.close();await target?.close();}
});

test('browser Push asks permission explicitly, posts only subscription evidence and cancels a detached view',async()=>{
  const source=readFileSync(new URL('../../web/push-client.js',import.meta.url),'utf8'),events=[];
  const sub=subscription(),browserSub={toJSON:()=>({...sub,expirationTime:null}),unsubscribe:async()=>events.push('unsubscribe')};
  const browser={isSecureContext:true,PushManager:class {},Notification:{requestPermission:async()=>{events.push('permission');return 'granted';}},
    navigator:{serviceWorker:{register:async()=>{events.push('worker');return {active:{},pushManager:{getSubscription:async()=>null,subscribe:async()=>browserSub}};}}}};
  vm.runInNewContext(source,{window:browser,navigator:browser.navigator,Notification:browser.Notification,Uint8Array,atob,setTimeout,clearTimeout});
  const pending=browser.CRSPush.enable(keys.publicKey,async(method,input)=>{events.push(method);assert.deepEqual(JSON.parse(JSON.stringify(input)),sub);},()=>true);
  assert.equal(events[0],'permission');assert.equal(await pending,true);assert.deepEqual(events,['permission','worker','registerPushSubscription']);
  events.length=0;await browser.CRSPush.enable(keys.publicKey,async()=>assert.fail('detached request'),()=>false);assert.deepEqual(events,['permission']);
  browser.Notification.requestPermission=async()=> 'denied';await assert.rejects(browser.CRSPush.enable(keys.publicKey,async()=>assert.fail('denied request'),()=>true),/permission/);
});

test('notification worker handles generic tags and canonical clicks only; malformed pushes have no side effect',async()=>{
  const listeners={},seen=[];
  const scope={location:{origin:'https://delivery.example.test'},addEventListener:(name,handler)=>listeners[name]=handler,
    registration:{showNotification:async(title,options)=>seen.push({title,options})},clients:{openWindow:async url=>seen.push(url)}};
  vm.runInNewContext(readFileSync(new URL('../../public/notification-worker.js',import.meta.url),'utf8'),{self:scope,URL});
  const pending=[];listeners.push({data:{json:()=>({id:'a'.repeat(43),url:'https://evil.test'})},waitUntil:value=>pending.push(value)});await Promise.all(pending);
  assert.equal(seen.length,1);assert.equal(seen[0].options.tag,'crs-'+'a'.repeat(43));assert.ok(!JSON.stringify(seen).includes('evil'));
  listeners.push({data:{json:()=>({id:'bad'})},waitUntil:()=>assert.fail('malformed push')});assert.equal(seen.length,1);
  listeners.notificationclick({notification:{close(){}},waitUntil:value=>pending.push(value)});await Promise.all(pending);
  assert.equal(seen[1],'https://delivery.example.test/');assert.deepEqual(Object.keys(listeners).sort(),['notificationclick','push']);
  listeners.push({data:{json:()=>({id:'b'.repeat(43),test:true,url:'https://evil.test'})},waitUntil:value=>pending.push(value)});await Promise.all(pending);
  assert.match(seen[2].options.body,/Push delivery test/);assert.ok(!JSON.stringify(seen).includes('evil'));
});

test('a second worker cannot reserve a provider request already in flight',async()=>{
  const f=await fixture();try {
    await notificationPreferences(f.db,f.user,{event:'BORROW_REQUEST',channel:'EMAIL',expectedVersion:0},f.token);await f.borrow();
    let entered,release,sent=0;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
    const worker=deliveryProcessor({transact:f.transact,email:async()=>{sent++;entered();await gate;return 'ACCEPTED';}});
    const first=worker();await started;assert.equal((await worker()).processed,0);release();await first;
    assert.equal(sent,1);assert.equal((await f.rows())[0].status,'ACCEPTED');
  }finally{await f.db.close();}
});
