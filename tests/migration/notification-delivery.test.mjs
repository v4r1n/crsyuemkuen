import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {createECDH} from 'node:crypto';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import webpush from 'web-push';
import {fields,tables} from '../../server/schema.mjs';
import {digest,secret,loadDomain,saveDomain} from '../../server/domain.mjs';
import {notificationPreferences} from '../../server/settings-security.mjs';
import {deliveryConfiguration,validateSubscription,ownPushSubscription,deliveryProcessor} from '../../server/notification-delivery.mjs';
import {snapshotTables,reserveRestore,commitRestore} from '../../tools/restore-records.mjs';
const require=createRequire(import.meta.url),{bootstrappedHarness,createEquipment,createUser}=require('../backend/test-helpers.cjs');
const keys=webpush.generateVAPIDKeys();
Object.assign(process.env,{WEB_APP_URL:'https://delivery.example.test',GOOGLE_OAUTH_CLIENT_ID:'delivery-fixture.apps.googleusercontent.com',
  ALLOWED_DOMAINS:'example.com,gmail.com',WRITE_FREEZE:'false',NOTIFICATION_DELIVERY_ENABLED:'true',
  SMTP_HOST:'smtp.example.test',SMTP_PORT:'587',SMTP_USER:'fixture',SMTP_PASSWORD:'synthetic-only-password',SMTP_FROM:'fixture@example.com',
  WEB_PUSH_SUBJECT:'mailto:fixture@example.com',WEB_PUSH_PUBLIC_KEY:keys.publicKey,WEB_PUSH_PRIVATE_KEY:keys.privateKey});
const migrations=['202610050001_crs','202610070002_identity_experience','20261014054612_settings_security','20261015064806_owner_profile','20261016023629_notification_delivery'];
function subscription(suffix='fixture') {
  const curve=createECDH('prime256v1');curve.generateKeys();
  return {endpoint:'https://fcm.googleapis.com/fcm/send/'+suffix,keys:{p256dh:curve.getPublicKey().toString('base64url'),auth:Buffer.alloc(16,7).toString('base64url')}};
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
  async function borrow(){return transact(async db=>{const domain=await loadDomain(db,{session});const result=domain.invoke('createBorrowRequest',[token,request]);assert.equal(result.ok,true,JSON.stringify(result.error));await saveDomain(db,domain);return result.data;});}
  const rows=async()=>(await db.query('SELECT * FROM crs.notification_delivery ORDER BY id')).rows;
  return {db,user,admin,token,transact,borrow,rows,outside:()=>assert.equal(inTransaction,false)};
}

test('delivery configuration fails closed; subscription validates capability host/key without arbitrary network',()=>{
  assert.equal(deliveryConfiguration().push,true);assert.equal(deliveryConfiguration().email,true);
  assert.equal(deliveryConfiguration({...process.env,NOTIFICATION_DELIVERY_ENABLED:'false'}).push,false);
  assert.equal(deliveryConfiguration({...process.env,WEB_PUSH_PRIVATE_KEY:keys.publicKey}).push,false);
  const sub=subscription();assert.equal(validateSubscription(sub),sub);
  for(const endpoint of ['http://fcm.googleapis.com/x','https://127.0.0.1/x','https://fcm.googleapis.com.evil.test/x','https://fcm.googleapis.com:444/x','https://user@fcm.googleapis.com/x','https://fcm.googleapis.com/x#secret','https://fcm.googleapis.com/../x','https://fcm.googleapis.com/\nfoo'])
    assert.throws(()=>validateSubscription({...sub,endpoint}),error=>error.code==='VALIDATION_FAILED');
  assert.throws(()=>validateSubscription({...sub,keys:{...sub.keys,auth:'bad'}}));
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
