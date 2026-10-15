import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import sharp from 'sharp';
import {profileService,validateAvatar} from '../../server/profile.mjs';
import {digest,secret,loadDomain} from '../../server/domain.mjs';
import {snapshotTables,reserveRestore,commitRestore,normalizeSnapshot} from '../../tools/restore-records.mjs';
process.env.WEB_APP_URL='https://profile.example.test';process.env.GOOGLE_OAUTH_CLIENT_ID='profile-fixture.apps.googleusercontent.com';process.env.ALLOWED_DOMAINS='example.test';process.env.WRITE_FREEZE='false';
async function fixture() {
  const db=new PGlite();
  for(const file of ['202610050001_crs','202610070002_identity_experience','20261014054612_settings_security','20261015064806_owner_profile'])await db.exec(readFileSync(new URL('../../supabase/migrations/'+file+'.sql',import.meta.url),'utf8'));
  await db.query('INSERT INTO crs.sequences(data) VALUES($1)',[JSON.stringify({sequence_name:'LOG',prefix:'LOG-',padding:6,next_value:1,updated_at:new Date().toISOString()})]);
  const user={user_id:'USR-000001',email:'owner@example.test',name:'Owner',role:'USER',status:'ACTIVE',row_version:1},other={...user,user_id:'USR-000002',email:'other@example.test',role:'ADMIN'};
  for(const value of [user,other])await db.query('INSERT INTO crs.users(data) VALUES($1)',[JSON.stringify(value)]);
  async function session(owner=user,extra={}){const token=secret('session1_'),data={userId:owner.user_id,email:owner.email,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+3600,...extra};await db.query('INSERT INTO crs.sessions(id,data,expires_at) VALUES($1,$2,to_timestamp($3))',[digest(token),JSON.stringify(data),data.expiresAt]);return token;}
  const token=await session(),otherToken=await session(other),objects=new Map();
  const transact=async work=>{await db.exec('BEGIN');try{const result=await work(db);await db.exec('COMMIT');return result;}catch(error){await db.exec('ROLLBACK');throw error;}};
  const storage={info:async key=>objects.has(key)?{data:{}}:{error:{statusCode:404,message:'not found'}},createSignedUploadUrl:async key=>({data:{signedUrl:'https://fixture.supabase.co/storage/v1/object/upload/sign/'+key}}),download:async key=>objects.has(key)?{data:new Blob([objects.get(key).bytes],{type:objects.get(key).mime})}:{error:{statusCode:404}},createSignedUrl:async key=>({data:{signedUrl:'https://fixture.supabase.co/storage/v1/object/sign/'+key}})};
  const service=profileService({transact,storageFor:async()=>storage});
  const bytes=await sharp({create:{width:32,height:32,channels:3,background:'#014d8b'}}).png().toBuffer();
  async function upload(previousId=null){const input={commandId:randomUUID(),mimeType:'image/png',byteLength:bytes.length,digest:digest(bytes),previousId},prepared=await service.prepare(token,input);const row=(await db.query('SELECT * FROM crs.profile_resources WHERE id=$1',[prepared.resourceId])).rows[0];objects.set(row.object_key,{bytes,mime:'image/png'});return {input,prepared,row};}
  return {db,token,otherToken,session,transact,service,user,other,objects,storage,bytes,upload};
}
test('self name is versioned/atomic/idempotent; identity, other Users, historical snapshots and session TTL are unchanged',async()=>{
 const f=await fixture();try{
  const before=(await f.db.query('SELECT * FROM crs.sessions ORDER BY id')).rows;
  const input={commandId:randomUUID(),name:'New owner',expectedVersion:1};
  assert.equal((await f.service.rename(f.token,input)).name,'New owner');assert.equal((await f.service.rename(f.token,input)).nameVersion,2);
  const users=(await f.db.query('SELECT data FROM crs.users ORDER BY id')).rows;assert.equal(users[0].data.email,f.user.email);assert.equal(users[0].data.role,'USER');assert.equal(users[1].data.name,'Owner');
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.history')).rows[0].n,1);
  assert.deepEqual(JSON.parse((await f.db.query('SELECT data FROM crs.history')).rows[0].data.changed_fields_json).name,{oldValue:'Owner',newValue:'New owner'});
  assert.deepEqual((await f.db.query('SELECT id,expires_at FROM crs.sessions ORDER BY id')).rows,before.map(({id,expires_at})=>({id,expires_at})));
  await assert.rejects(f.service.rename(f.token,{...input,name:'Changed replay'}));
  await assert.rejects(f.service.rename(f.token,{...input,commandId:randomUUID()}),e=>e.code==='STATE_CONFLICT'&&e.details.currentVersion===2);
  await assert.rejects(f.service.rename(f.otherToken,input));
  await assert.rejects(f.service.rename(f.token,{...input,user_id:f.other.user_id}));
  for(const name of ['', 'a'.repeat(65)])await assert.rejects(f.service.rename(f.token,{...input,name,commandId:randomUUID(),expectedVersion:2}));
 }finally{await f.db.close();}
});
test('avatar reservation/retry and replacement commit exactly once; owner-only bytes and retired resources remain private',async()=>{
 const f=await fixture();try{
  const a=await f.upload();assert.equal((await f.service.prepare(f.token,a.input)).resourceId,a.row.id);
  await assert.rejects(f.service.finalize(f.otherToken,{commandId:a.input.commandId,resourceId:a.row.id}));
  const result=await f.service.finalize(f.token,{commandId:a.input.commandId,resourceId:a.row.id});assert.equal(result.avatarId,a.row.id);
  assert.deepEqual(await f.service.finalize(f.token,{commandId:a.input.commandId,resourceId:a.row.id}),result);
  assert.ok((await f.service.avatar(f.token)).signedUrl);assert.deepEqual(await f.service.avatar(f.otherToken),{signedUrl:null});
  const b=await f.upload(a.row.id);await f.service.finalize(f.token,{commandId:b.input.commandId,resourceId:b.row.id});
  assert.equal((await f.db.query('SELECT state FROM crs.profile_resources WHERE id=$1',[a.row.id])).rows[0].state,'RETIRED');assert.equal(f.objects.size,2);
  assert.equal((await f.service.prepare(f.token,a.input)).completed,true);assert.equal((await f.service.get(f.token)).avatarId,b.row.id);
  assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.history')).rows[0].n,2);
  assert.equal((await f.db.query("SELECT relrowsecurity FROM pg_class WHERE oid='crs.profile_resources'::regclass")).rows[0].relrowsecurity,true);
  assert.equal((await f.db.query("SELECT count(*)::int AS n FROM pg_policies WHERE schemaname='crs' AND tablename='profile_resources'")).rows[0].n,0);
  const domain=await loadDomain(f.db),c=domain.context,state={issues:[],total:0,errors:0,warnings:0};
  for(const op of domain.records.Operations){c.auditOperationValues_(state,op);c.auditOperationEntityReference_(state,op,{Users:{[f.user.user_id]:f.user}});const history=domain.records.History.find(row=>row.operation_id===op.operation_id);assert.equal(history.entity_type,op.entity_type);assert.equal(history.entity_id,op.entity_id);assert.equal(history.timestamp,op.started_at);assert.equal(history.old_status,JSON.parse(op.before_json).status);assert.equal(history.new_status,JSON.parse(op.result_json).status);}
  assert.equal(state.errors,0,JSON.stringify(state.issues));
 }finally{await f.db.close();}
});
test('image decoder rejects spoof/oversize/non-square/animated input; invalid staged upload never changes current avatar or blocks rename',async()=>{
 const f=await fixture();try{
  for(const [bytes,mime] of [[Buffer.from('<svg/>'),'image/svg+xml'],[Buffer.alloc(1048577),'image/png'],[Buffer.from('invalid'),'image/png'],[await sharp({create:{width:32,height:16,channels:3,background:'red'}}).png().toBuffer(),'image/png'],[await sharp({create:{width:513,height:513,channels:3,background:'red'}}).png().toBuffer(),'image/png'],[f.bytes,'image/jpeg']])await assert.rejects(validateAvatar(bytes,mime));
  const a=await f.upload();f.objects.set(a.row.object_key,{bytes:Buffer.alloc(f.bytes.length),mime:'image/png'});
  await assert.rejects(f.service.finalize(f.token,{commandId:a.input.commandId,resourceId:a.row.id}));assert.equal((await f.service.get(f.token)).avatarId,null);
  assert.equal((await f.service.rename(f.token,{commandId:randomUUID(),name:'Still editable',expectedVersion:1})).name,'Still editable');
  const b=await f.upload();assert.ok(b.prepared.uploadUrl);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.history')).rows[0].n,1);
 }finally{await f.db.close();}
});
test('current inactive/expired/wrong-client sessions and write freeze deny profile operations',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.service.get('session1_'+'x'.repeat(43)));
  await assert.rejects(f.service.get(await f.session(f.user,{expiresAt:1})));
  await assert.rejects(f.service.get(await f.session(f.user,{clientId:'other-client'})));
  process.env.WRITE_FREEZE='true';await assert.rejects(f.service.rename(f.token,{commandId:randomUUID(),name:'No write',expectedVersion:1}),e=>e.code==='WRITE_FROZEN');process.env.WRITE_FREEZE='false';
  await f.db.query("UPDATE crs.users SET data=jsonb_set(data,'{status}','\"INACTIVE\"') WHERE id=$1",[f.user.user_id]);await assert.rejects(f.service.get(f.token),e=>e.code==='USER_DISABLED');
 }finally{process.env.WRITE_FREEZE='false';await f.db.close();}
});
test('legacy long names remain exact; new formula-like names are escaped at rest and old History stays unchanged',async()=>{
 const f=await fixture();try{
  const oldName='Legacy name '.repeat(8);await f.db.query("UPDATE crs.users SET data=jsonb_set(data,'{name}',$2::jsonb) WHERE id=$1",[f.user.user_id,JSON.stringify(oldName)]);
  assert.equal((await f.service.get(f.token)).name,oldName);
  const first=await f.service.rename(f.token,{commandId:randomUUID(),name:'+Formula name',expectedVersion:1});assert.equal(first.name,'+Formula name');
  const stored=(await f.db.query('SELECT data FROM crs.users WHERE id=$1',[f.user.user_id])).rows[0].data;assert.equal(stored.name,"'+Formula name");
  const history=(await f.db.query('SELECT data FROM crs.history')).rows;
  await f.service.rename(f.token,{commandId:randomUUID(),name:'Second name',expectedVersion:2});assert.deepEqual((await f.db.query('SELECT data FROM crs.history ORDER BY id LIMIT 1')).rows,history);
 }finally{await f.db.close();}
});
test('format 4 reserves private avatar metadata before bytes; interrupted restore retains ownership and current reference',async()=>{
 const f=await fixture();try{
  const a=await f.upload();await f.service.finalize(f.token,{commandId:a.input.commandId,resourceId:a.row.id});const b=await f.upload(a.row.id);await f.service.finalize(f.token,{commandId:b.input.commandId,resourceId:b.row.id});
  const snapshot={format:4,tables:{}};for(const table of snapshotTables)snapshot.tables[table]=(await f.db.query('SELECT * FROM crs.'+table)).rows;
  // Fresh empty target; never delete canonical rows to make a destination empty.
  const target=new PGlite();try{
   for(const file of ['202610050001_crs','202610070002_identity_experience','20261014054612_settings_security','20261015064806_owner_profile'])await target.exec(readFileSync(new URL('../../supabase/migrations/'+file+'.sql',import.meta.url),'utf8'));
   const tx=async work=>{await target.exec('BEGIN');try{const result=await work(target);await target.exec('COMMIT');return result;}catch(error){await target.exec('ROLLBACK');throw error;}};
   const serialized=JSON.parse(JSON.stringify(snapshot));
   await reserveRestore(serialized,tx);await reserveRestore(serialized,tx);assert.equal((await target.query("SELECT count(*)::int AS n FROM crs.profile_resources WHERE state='READY'")).rows[0].n,0);
   await commitRestore(serialized,tx);assert.equal((await target.query("SELECT id FROM crs.profile_resources WHERE state='READY'")).rows[0].id,b.row.id);
  }finally{await target.close();}
  const old={format:3,tables:{...snapshot.tables}};delete old.tables.profile_resources;assert.equal(normalizeSnapshot(old).format,4);assert.deepEqual(normalizeSnapshot(old).tables.profile_resources,[]);
 }finally{await f.db.close();}
});

test('profile reauthorizes after Storage I/O, persists quotas on rejected bytes and rolls back an audit failure',async()=>{
 const f=await fixture();try{
  const input={commandId:randomUUID(),name:'Atomic name',expectedVersion:1};
  await f.db.query("UPDATE crs.sequences SET data=jsonb_set(data,'{next_value}','1000000') WHERE id='LOG'");
  await assert.rejects(f.service.rename(f.token,input));assert.equal((await f.service.get(f.token)).name,'Owner');assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.operations')).rows[0].n,0);
  const a=await f.upload(),download=f.storage.download;
  f.storage.download=async key=>{const result=await download(key);await f.db.query("UPDATE crs.users SET data=jsonb_set(data,'{status}','\"INACTIVE\"') WHERE id=$1",[f.user.user_id]);return result;};
  await assert.rejects(f.service.finalize(f.token,{commandId:a.input.commandId,resourceId:a.row.id}),error=>error.code==='USER_DISABLED');
  assert.equal((await f.db.query('SELECT state FROM crs.profile_resources')).rows[0].state,'STAGED');assert.ok((await f.db.query('SELECT count(*)::int AS n FROM crs.rate_limits')).rows[0].n>0);
 }finally{await f.db.close();}
});
