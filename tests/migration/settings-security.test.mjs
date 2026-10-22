import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {digest,secret} from '../../server/domain.mjs';
import {settingsOverview,listSessions,revokeSessions,securityActivity,notificationPreferences} from '../../server/settings-security.mjs';
import {newSessionMetadata,deviceLabels,touchSession} from '../../server/session-metadata.mjs';
import {authorizedUser} from '../../server/password-auth.mjs';
import {snapshotTables,normalizeSnapshot,reserveRestore,commitRestore} from '../../tools/restore-records.mjs';
process.env.WEB_APP_URL='https://settings.example.test';
process.env.GOOGLE_OAUTH_CLIENT_ID='settings-fixture.apps.googleusercontent.com';
process.env.ALLOWED_DOMAINS='example.test';
async function fixture() {
  const db=new PGlite();
  for(const filename of ['202610050001_crs','202610070002_identity_experience','20261014054612_settings_security','20261015064806_owner_profile','20261016023629_notification_delivery','20261022091806_due_reminders'])await db.exec(readFileSync(new URL('../../supabase/migrations/'+filename+'.sql',import.meta.url),'utf8'));
  await db.query('INSERT INTO crs.sequences(data) VALUES($1)',[JSON.stringify({sequence_name:'LOG',prefix:'LOG-',padding:6,next_value:1,updated_at:new Date().toISOString()})]);
  const user={user_id:'USR-000001',email:'owner@example.test',name:'Owner',department:'Source department',role:'USER',status:'ACTIVE',row_version:1};
  const other={...user,user_id:'USR-000002',email:'other@example.test',role:'ADMIN'};
  for(const data of [user,other])await db.query('INSERT INTO crs.users(data) VALUES($1)',[JSON.stringify(data)]);
  async function session(owner=user,extra={}) {
    const token=secret('session1_'),data={userId:owner.user_id,email:owner.email,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+3600,...extra};
    await db.query('INSERT INTO crs.sessions(id,data,expires_at) VALUES($1,$2,to_timestamp($3))',[digest(token),JSON.stringify(data),data.expiresAt]);return {token,data};
  }
  const current=await session(user,newSessionMetadata('Mozilla Windows Edg/120.0'));
  const transact=async work=>{await db.exec('BEGIN');try{const result=await work(db);await db.exec('COMMIT');return result;}catch(error){await db.exec('ROLLBACK');throw error;}};
  return {db,user,other,current,session,transact};
}
test('session DTO hides tokens/hashes/identity; legacy metadata stays unknown; expiry never slides',async()=>{
  const f=await fixture();try{
    await f.session();await f.session(f.other);await f.session(f.user,{expiresAt:Math.floor(Date.now()/1000)-1});
    const list=await listSessions(f.db,f.user,f.current.token);assert.equal(list.count,2);assert.equal(list.items.filter(item=>item.current).length,1);
    assert.ok(list.items.every(item=>!('id' in item)&&!('email' in item)&&!('subject' in item)));assert.ok(!JSON.stringify(list).includes(digest(f.current.token)));
    assert.equal(list.items.find(item=>!item.current).createdAt,null);assert.equal(list.items.find(item=>!item.current).browser,null);
    const before=(await f.db.query('SELECT expires_at FROM crs.sessions WHERE id=$1',[digest(f.current.token)])).rows[0];
    await touchSession(f.db,digest(f.current.token),{...f.current.data,lastActiveAt:null});
    assert.deepEqual((await f.db.query('SELECT expires_at FROM crs.sessions WHERE id=$1',[digest(f.current.token)])).rows[0],before);
    const overview=await settingsOverview(f.db,f.user,f.current.token);assert.equal(overview.department,f.user.department);assert.equal(overview.activeSessionCount,2);
  }finally{await f.db.close();}
});
test('owner-only revocation is atomic/current-safe and replay cannot revoke a later session',async()=>{
  const f=await fixture();try{
    const foreign=await f.session(f.other,newSessionMetadata()),old=await f.session(f.user,newSessionMetadata());
    const command={allOthers:true,commandId:randomUUID()};
    await assert.rejects(revokeSessions(f.db,f.user,f.current.token,{publicId:f.current.data.publicId,commandId:randomUUID()}));
    const result=await f.transact(db=>revokeSessions(db,f.user,f.current.token,command));assert.equal(result.revoked,1);
    assert.equal((await f.db.query('SELECT id FROM crs.sessions WHERE id=$1',[digest(old.token)])).rows.length,0);
    assert.equal((await f.db.query('SELECT id FROM crs.sessions WHERE id=$1',[digest(foreign.token)])).rows.length,1);
    const later=await f.session(f.user,newSessionMetadata());assert.equal((await f.transact(db=>revokeSessions(db,f.user,f.current.token,command))).alreadyRevoked,true);
    assert.equal((await f.db.query('SELECT id FROM crs.sessions WHERE id=$1',[digest(later.token)])).rows.length,1);
    assert.equal((await securityActivity(f.db,f.user)).items.length,1);assert.equal((await securityActivity(f.db,f.other)).items.length,0);
    assert.ok((await authorizedUser(f.db,f.current.token)).user);await assert.rejects(authorizedUser(f.db,old.token));
  }finally{await f.db.close();}
});
test('preferences enforce owner/version/ADMIN, unavailable channels cannot be enabled, RLS is private',async()=>{
  const f=await fixture();try{
    assert.equal((await notificationPreferences(f.db,f.user)).items.length,8);
    const input={event:'APPROVE',inApp:false,expectedVersion:0,user_id:f.other.user_id,role:'ADMIN'};
    const saved=await notificationPreferences(f.db,f.user,input);assert.equal(saved.items.find(item=>item.event==='APPROVE').inApp,false);assert.equal(saved.channels.push,false);assert.equal(saved.securityEmailRequired,true);
    assert.equal((await notificationPreferences(f.db,f.other)).items.find(item=>item.event==='APPROVE').inApp,true);
    await assert.rejects(notificationPreferences(f.db,f.user,input));
    await assert.rejects(notificationPreferences(f.db,f.user,{event:'ADMIN_BORROW_REQUEST',inApp:false,expectedVersion:0}));
    assert.equal((await notificationPreferences(f.db,f.user,{event:'DUE_SOON',inApp:true,expectedVersion:0})).items.find(item=>item.event==='DUE_SOON').inApp,true);
    assert.equal((await f.db.query("SELECT relrowsecurity FROM pg_class WHERE oid='crs.notification_preferences'::regclass")).rows[0].relrowsecurity,true);
    assert.equal((await f.db.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='crs' AND tablename='notification_preferences'")).rows[0].n,0);
  }finally{await f.db.close();}
});
test('single-session revocation cannot select another owner; no-op audit and retry stay truthful',async()=>{
  const f=await fixture();try{
    const foreign=await f.session(f.other,newSessionMetadata());
    const input={publicId:foreign.data.publicId,commandId:randomUUID(),user_id:f.other.user_id};
    assert.deepEqual(await f.transact(db=>revokeSessions(db,f.user,f.current.token,input)),{revoked:0,alreadyRevoked:true});
    assert.equal((await f.db.query('SELECT id FROM crs.sessions WHERE id=$1',[digest(foreign.token)])).rows.length,1);
    const activity=await securityActivity(f.db,f.user);assert.equal(activity.items[0].outcome,'NO_OP');
    assert.ok(!JSON.stringify(activity).includes(foreign.data.publicId));assert.ok(!JSON.stringify(activity).includes('requestDigest'));
    await assert.rejects(f.transact(db=>revokeSessions(db,f.user,f.current.token,{...input,allOthers:true})),error=>error.code==='STATE_CONFLICT');
    assert.equal((await securityActivity(f.db,f.user)).items.length,1);
  }finally{await f.db.close();}
});
test('session counts exclude obsolete client/email/generation and Account uses the existing text DTO',async()=>{
  const f=await fixture();try{
    await f.db.query('INSERT INTO crs.password_credentials(user_id,email,password_hash,generation) VALUES($1,$2,$3,$4)',[f.user.user_id,f.user.email,'scrypt$synthetic-fixture',2]);
    await f.session(f.user,{method:'PASSWORD',credentialGeneration:1});
    await f.session(f.user,{clientId:'obsolete-client.apps.googleusercontent.com'});
    await f.session(f.user,{email:'changed@example.test'});
    assert.equal((await listSessions(f.db,f.user,f.current.token)).count,1);
    const data=await settingsOverview(f.db,{...f.user,department:"'=Source",name:"'+Name"},f.current.token);
    assert.equal(data.department,'=Source');assert.equal(data.name,'+Name');
    await f.db.query("UPDATE crs.users SET data=jsonb_set(data,'{status}','\"INACTIVE\"') WHERE id=$1",[f.user.user_id]);
    await assert.rejects(authorizedUser(f.db,f.current.token),error=>error.code==='USER_DISABLED');
  }finally{await f.db.close();}
});
test('restore format 3 retains preferences and never restores session/device proofs; format 2 upgrades empty',async()=>{
  const f=await fixture();try{
    await notificationPreferences(f.db,f.user,{event:'RETURN',inApp:false,expectedVersion:0});
    const snapshot={format:4,tables:{}};for(const table of snapshotTables)snapshot.tables[table]=(await f.db.query('SELECT * FROM crs.'+table)).rows;
    const old={format:2,tables:{...snapshot.tables}};delete old.tables.notification_preferences;delete old.tables.profile_resources;assert.deepEqual(normalizeSnapshot(old).tables.notification_preferences,[]);
      // Use a new empty database, not deletion of protected canonical records.
      const clean=new PGlite();try{
        for(const filename of ['202610050001_crs','202610070002_identity_experience','20261014054612_settings_security','20261015064806_owner_profile','20261016023629_notification_delivery','20261022091806_due_reminders'])await clean.exec(readFileSync(new URL('../../supabase/migrations/'+filename+'.sql',import.meta.url),'utf8'));
        const transact=async work=>{await clean.exec('BEGIN');try{const result=await work(clean);await clean.exec('COMMIT');return result;}catch(error){await clean.exec('ROLLBACK');throw error;}};
        await reserveRestore(snapshot,transact);await commitRestore(snapshot,transact);
        assert.equal((await clean.query('SELECT in_app FROM crs.notification_preferences')).rows[0].in_app,false);
        assert.equal((await clean.query('SELECT count(*)::int AS n FROM crs.sessions')).rows[0].n,0);
      }finally{await clean.close();}
  }finally{await f.db.close();}
});
test('UA hints are bounded allowlisted labels, never raw metadata or a trusted device',()=>{
  assert.deepEqual(deviceLabels('unrecognized attacker input'),{browser:null,os:null});
  assert.deepEqual(deviceLabels('iPhone Version/17.0 Safari/605.1'),{browser:'Safari',os:'iPhone'});
  assert.ok(!('trusted' in newSessionMetadata('Windows Edg/123')));
});
