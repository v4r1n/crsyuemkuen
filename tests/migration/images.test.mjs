import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fields } from '../../server/schema.mjs';
import { createDomain,digest } from '../../server/domain.mjs';
import { installImageRecovery } from '../../server/image-recovery.mjs';
import { cleanupImages } from '../../server/images.mjs';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const require=createRequire(import.meta.url);
const {bootstrappedHarness,createEquipment}=require('../backend/test-helpers.cjs');
const runtimeConfig={WEB_APP_URL:'https://example.test',DRIVE_FOLDER_ID:'private-bucket',IMAGE_SHARING:'DOMAIN_WITH_LINK',GOOGLE_OAUTH_CLIENT_ID:'test-client',ALLOWED_DOMAINS:['example.com'],MAX_IMAGE_BYTES:4194304,TIMEZONE:'Asia/Bangkok',MAX_PAGE_SIZE:100,DEFAULT_PAGE_SIZE:24};
function setup() {
  const legacy=bootstrappedHarness(),asset=createEquipment(legacy);
  const records=Object.fromEntries(Object.keys(fields).map(name=>[name,legacy.records(name)]));
  const actor=records.Users.find(row=>row.role==='ADMIN');
  const images={},session={userId:actor.user_id,email:actor.email,clientId:'test-client',expiresAt:Date.now()/1000+600};
  const domain=createDomain(records,{session,images,runtimeConfig});
  return {domain,images,actor,asset};
}
function stage(state,command,version=1,resourceId='storage-file-001') {
  const bytes=Buffer.from([137,80,78,71,13,10,26,10]),c=state.domain.context;
  const payload={assetId:state.asset.asset_id,expectedVersion:version,mimeType:'image/png',byteLength:bytes.length,digest:digest(bytes),folderId:'private-bucket',sharingMode:'DOMAIN_WITH_LINK'};
  let operation=c.startOperationLocked_(c.operationSpec_(command,'UPLOAD_ASSET_IMAGE','EQUIPMENT',state.asset.asset_id,payload,state.actor),c.findRecordById_('Equipment','asset_id',state.asset.asset_id));
  operation=c.replaceOperationResourceLocked_(operation,resourceId);
  state.images[resourceId]={id:resourceId,available:true,bytes,digest:payload.digest,mime_type:'image/png',byte_length:bytes.length,folder_id:payload.folderId,owner_user_id:state.actor.user_id,operation_id:command,asset_id:state.asset.asset_id,name:state.asset.asset_id+'-'+command+'.png',state:'STAGED'};
  return {payload,operation,resourceId,bytes};
}
function upload(state,staged){
  const c=state.domain.context;
  return c.uploadEquipmentImage_({asset_id:state.asset.asset_id,command_id:staged.operation.operation_id,expected_version:staged.payload.expectedVersion,mime_type:'image/png',base64_data:staged.bytes.toString('base64')},state.actor);
}
test('interrupted-after-object-create pins one resource; retry commits one image and one History',()=>{
  const state=setup(),staged=stage(state,'migration-upload-001');
  assert.equal(state.domain.context.findRecordById_('Equipment','asset_id',state.asset.asset_id).image_file_id,'');
  const result=upload(state,staged);
  assert.equal(result.image_file_id,staged.resourceId);assert.equal(result.imageAvailable,true);
  assert.deepEqual(JSON.parse(JSON.stringify(upload(state,staged))),JSON.parse(JSON.stringify(result)));
  assert.equal(Object.keys(state.images).length,1);
  assert.equal(state.domain.records.History.filter(row=>row.operation_id===staged.operation.operation_id).length,1);
  assert.equal(state.domain.context.findRecordById_('Operations','operation_id',staged.operation.operation_id).status,'COMPLETED');
});
test('replacement commits new reference and completion before old cleanup is scheduled',()=>{
  const state=setup(),first=stage(state,'migration-upload-first');upload(state,first);
  const second=stage(state,'migration-upload-second',2,'storage-file-002');
  const result=upload(state,second);
  assert.equal(result.image_file_id,'storage-file-002');
  assert.equal(state.domain.context.findRecordById_('Operations','operation_id',second.operation.operation_id).status,'COMPLETED');
  assert.equal(state.domain.cleanup.has('storage-file-001'),true);
  assert.equal(state.images['storage-file-001'].state,'STAGED','No external deletion before commit');
});
test('recovery fails closed for a mismatched asset, digest, MIME, bytes, owner or version',()=>{
  for(const patch of [{asset_id:'AST-999999'},{digest:'bad'},{mime_type:'image/gif'},{byte_length:99},{owner_user_id:'USR-999999'},{name:'unmanaged.png'}]) {
    const state=setup(),staged=stage(state,'migration-evidence-001');Object.assign(state.images[staged.resourceId],patch);
    assert.throws(()=>upload(state,staged),error=>error.code==='STATE_CONFLICT');
    assert.equal(state.domain.context.findRecordById_('Equipment','asset_id',state.asset.asset_id).image_file_id,'');
  }
  const state=setup(),staged=stage(state,'migration-version-001');
  state.domain.context.updateRecordById_('Equipment','asset_id',state.asset.asset_id,{row_version:2});
  assert.throws(()=>upload(state,staged),error=>error.code==='STATE_CONFLICT');
});
test('deleted and trashed object plus stale Drive URL render unavailable state',()=>{
  const state=setup(),staged=stage(state,'migration-deleted-001');upload(state,staged);
  state.images[staged.resourceId].available=false;
  let detail=state.domain.context.getEquipmentDetail_(state.asset.asset_id,state.actor);
  assert.equal(detail.imageAvailable,false);assert.equal(detail.image_url,'');
  state.images[staged.resourceId].state='TRASHED';
  detail=state.domain.context.getEquipmentDetail_(state.asset.asset_id,state.actor);
  assert.equal(detail.imageAvailable,false);assert.equal(detail.image_url,'');
});

test('Admin recovery distinguishes absent objects from access/network/digest uncertainty',()=>{
  for(const inspection of ['UNKNOWN','MISMATCH','MISSING','TRASHED']) {
    const state=setup(),staged=stage(state,'migration-admin-recovery');
    Object.assign(state.images[staged.resourceId],{available:false,inspection});
    const verified=installImageRecovery(state.domain,state.images);
    if(['UNKNOWN','MISMATCH'].includes(inspection)) {
      assert.throws(()=>state.domain.context.reconcileImageOperationForAdmin_(staged.operation.operation_id,state.actor),error=>error.code==='IMAGE_FILE_UNAVAILABLE');
      assert.equal(state.domain.records.Operations.at(-1).status,'STARTED');assert.equal(state.domain.cleanup.size,0);
    }else{
      state.domain.context.reconcileImageOperationForAdmin_(staged.operation.operation_id,state.actor);
      assert.equal(state.domain.records.Operations.at(-1).status,'ABORTED');assert.equal(state.domain.cleanup.has(staged.resourceId),true);
    }
    assert.equal(verified.size,0,'Missing or unverified files never become READY');
  }
  const state=setup(),staged=stage(state,'migration-admin-verified');
  const verified=installImageRecovery(state.domain,state.images);
  state.domain.context.reconcileImageOperationForAdmin_(staged.operation.operation_id,state.actor);
  assert.equal(verified.has(staged.resourceId),true);
});

test('Admin orphan repair confirms managed evidence and protects references/STARTED operations',()=>{
  const state=setup(),first=stage(state,'migration-orphan-first');upload(state,first);
  const second=stage(state,'migration-orphan-second',2,'storage-file-002');
  installImageRecovery(state.domain,state.images);
  const repair=id=>state.domain.context.repairImageIntegrity_({kind:'ORPHAN_FILE',file_id:id,confirm:true},state.actor);
  assert.throws(()=>repair(first.resourceId),error=>error.code==='STATE_CONFLICT');
  assert.throws(()=>repair(second.resourceId),error=>error.code==='STATE_CONFLICT');
  upload(state,second);state.domain.cleanup.clear();
  assert.equal(repair(first.resourceId).status,'CLEANUP_QUEUED');
  state.images[first.resourceId].owner_user_id='USR-999999';
  assert.throws(()=>repair(first.resourceId),error=>error.code==='STATE_CONFLICT');
});

test('queued Storage cleanup is delayed, retryable, and never removes referenced/pinned files',async()=>{
  const db=new PGlite();await db.exec(readFileSync(new URL('../../supabase/migrations/202610050001_crs.sql',import.meta.url),'utf8'));
  const state=setup();
  await db.exec('BEGIN');
  for(const name of ['Categories','Users','Equipment']) for(const row of state.domain.records[name]) {
    const table={Categories:'categories',Users:'users',Equipment:'equipment'}[name];
    await db.query(`INSERT INTO crs.${table}(data) VALUES($1)`,[JSON.stringify(row)]);
  }
  await db.exec('COMMIT');
  const staged=stage(state,'migration-cleanup-pin',1,'pinned-file');
  await db.query('INSERT INTO crs.operations(data) VALUES($1)',[JSON.stringify(staged.operation)]);
  for(const id of ['referenced-file','pinned-file','young-file','orphan-file','network-file']) {
    await db.query(`INSERT INTO crs.image_resources(id,object_key,operation_id,asset_id,mime_type,byte_length,digest,name,folder_id,owner_user_id,state,created_at)
      VALUES($1,$1,$1,$2,'image/png',8,$3,$1,'private-bucket',$4,'READY',now()-interval '3 hours')`,[id,state.asset.asset_id,digest(staged.bytes),state.actor.user_id]);
    await db.query('INSERT INTO crs.cleanup_jobs(id) VALUES($1)',[id]);
  }
  await db.query("UPDATE crs.equipment SET data=jsonb_set(data,'{image_file_id}','\"referenced-file\"')");
  await db.query("UPDATE crs.image_resources SET created_at=now() WHERE id='young-file'");
  const removed=[];const storage={remove:async paths=>{removed.push(...paths);return paths[0]==='network-file'?{error:new Error('network')}:{data:[]};}};
  await cleanupImages(db,storage);
  assert.deepEqual(removed.sort(),['network-file','orphan-file']);
  assert.equal((await db.query("SELECT state FROM crs.image_resources WHERE id='orphan-file'")).rows[0].state,'TRASHED');
  assert.equal((await db.query("SELECT state FROM crs.image_resources WHERE id='network-file'")).rows[0].state,'READY');
  await cleanupImages(db,storage);assert.equal(removed.filter(id=>id==='orphan-file').length,1);
  await db.close();
});
