import { randomUUID } from 'node:crypto';
import { transaction } from './db.mjs';
import { sessionFor } from './auth.mjs';
import { loadDomain, saveDomain } from './domain.mjs';
import { config } from './config.mjs';
import { fail } from './errors.mjs';
import { privateStorage, inspectResources, verifiedResource,storageMissing } from './storage.mjs';

export function assertWritable() {
  if(process.env.WRITE_FREEZE==='true') fail('WRITE_FROZEN','ระบบกำลังย้ายข้อมูล กรุณาลองใหม่ภายหลัง',true);
}
export async function prepareImage(token,input) {
  assertWritable();
  const storage=await privateStorage();
  const stage=await transaction(async db=>{
    const images=await inspectResources(db,{storage});
    const domain=await loadDomain(db,{session:await sessionFor(db,token),images}),c=domain.context;
    const actor=c.requireAdmin_(token),cfg=config();
    const id=c.requireAssetId_(input.asset_id),command=c.requireCommandId_(input.command_id);
    const mime=String(input.mime_type||'').toLowerCase();
    if(!c.IMAGE_MIME_TYPES[mime] || !/^[A-Za-z0-9_-]{43}$/.test(input.digest||'') ||
      !Number.isSafeInteger(input.byte_length) || input.byte_length<=0 || input.byte_length>10485760) fail('VALIDATION_FAILED','ชนิด ขนาด หรือ hash ของภาพไม่ถูกต้อง');
    const current=c.findRecordById_('Equipment','asset_id',id);
    if(!current) fail('NOT_FOUND','ไม่พบอุปกรณ์');
    const existing=c.findRecordById_('Operations','operation_id',command);
    if(!existing && input.byte_length>cfg.MAX_IMAGE_BYTES) fail('VALIDATION_FAILED','ขนาดไฟล์เกินกว่าที่ระบบกำหนด');
    const oldPayload=existing?c.operationPayload_(existing):null;
    const payload={assetId:id,expectedVersion:Number(input.expected_version),mimeType:mime,byteLength:input.byte_length,digest:input.digest,
      folderId:oldPayload?.folderId||cfg.DRIVE_FOLDER_ID,sharingMode:oldPayload?.sharingMode||cfg.IMAGE_SHARING};
    const spec=c.operationSpec_(command,'UPLOAD_ASSET_IMAGE','EQUIPMENT',id,payload,actor);
    let op=c.findOperationLocked_(spec);
    if(op?.status==='COMPLETED') {
      const result=c.operationResult_(op);
      return {completed:true,result:{...result,...c.equipmentImageState_(result.image_file_id)}};
    }
    if(!op) {
      c.assertEquipmentNotDeleted_(current); c.assertExpectedVersion_(current,input.expected_version);
      op=c.startOperationLocked_(spec,current);
    }
    c.assertImageOperationIdentity_(op,c.operationPayload_(op),c.operationBeforeState_(op));
    if(!c.equipmentImageSourceMatches_(current,c.operationBeforeState_(op))) fail('STATE_CONFLICT','ข้อมูลอุปกรณ์เปลี่ยนแปลงแล้ว กรุณาโหลดใหม่');
    let resource=(await db.query('SELECT * FROM crs.image_resources WHERE operation_id=$1',[command])).rows[0];
    if(!resource) {
      if(op.resource_id) fail('STATE_CONFLICT','Operation เดิมมี resource ที่ยังไม่ได้ย้าย กรุณาตรวจสอบ');
      const resourceId=randomUUID(),name=`${id}-${command}.${c.IMAGE_MIME_TYPES[mime]}`;
      resource=(await db.query(`INSERT INTO crs.image_resources(id,object_key,operation_id,asset_id,mime_type,byte_length,digest,name,folder_id,owner_user_id,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'STAGED') RETURNING *`,[resourceId,`assets/${id}/${resourceId}.${c.IMAGE_MIME_TYPES[mime]}`,command,id,mime,input.byte_length,input.digest,name,payload.folderId,op.actor_user_id])).rows[0];
      c.replaceOperationResourceLocked_(op,resourceId);
    }
    if(resource.state==='TRASHED') fail('OPERATION_ABORTED','ไฟล์ของคำสั่งเดิมถูกยกเลิกแล้ว กรุณาใช้คำสั่งใหม่');
    await saveDomain(db,domain); return resource;
  });
  if(stage.completed) return stage;
  const existing=await storage.info(stage.object_key);
  if(!existing.error && existing.data) return {resourceId:stage.id,uploaded:true};
  if(!storageMissing(existing.error)) fail('UPLOAD_UNAVAILABLE','ยังยืนยันสถานะไฟล์ไม่ได้ กรุณาลองคำสั่งเดิมอีกครั้ง',true);
  // Immutable path, upsert=false: a replay cannot overwrite a committed image.
  const signed=await storage.createSignedUploadUrl(stage.object_key,{upsert:false});
  if(signed.error) fail('UPLOAD_UNAVAILABLE','ไม่สามารถเตรียมการอัปโหลดได้ กรุณาลองคำสั่งเดิมอีกครั้ง',true);
  return {resourceId:stage.id,uploadUrl:signed.data.signedUrl};
}
export async function finalizeImage(token,input) {
  assertWritable();
  const storage=await privateStorage();
  // Two transactions: authorize + verify the pinned object, then re-read the
  // authoritative identity/version/operation/reference inside the commit.
  let resource;
  await transaction(async db=>{
    const session=await sessionFor(db,token),domain=await loadDomain(db,{session});
    domain.context.requireAdmin_(token);
    const op=domain.context.findRecordById_('Operations','operation_id',input.command_id);
    if(!op || op.action!=='UPLOAD_ASSET_IMAGE' || op.resource_id!==input.resource_id) fail('STATE_CONFLICT','Operation และไฟล์ภาพไม่ตรงกัน');
    resource=await verifiedResource(db,op.resource_id,storage);
  });
  return transaction(async db=>{
    const session=await sessionFor(db,token);
    const images=await inspectResources(db,{storage}); images[resource.id]=resource;
    const domain=await loadDomain(db,{session,images}),c=domain.context;
    const actor=c.requireAdmin_(token),op=c.findRecordById_('Operations','operation_id',input.command_id);
    const latest=(await db.query('SELECT * FROM crs.image_resources WHERE id=$1',[resource.id])).rows[0];
    if(!latest || latest.state==='TRASHED' || latest.object_key!==resource.object_key || latest.digest!==resource.digest) fail('STATE_CONFLICT','สถานะไฟล์เปลี่ยนแปลงแล้ว');
    if(!op || op.resource_id!==resource.id || op.asset_id!==resource.asset_id) fail('STATE_CONFLICT','Operation และไฟล์ภาพไม่ตรงกัน');
    c.assertRecoverableImageEvidence_(c.getImageFileIfPresent_(resource.id),op,c.operationPayload_(op));
    const payload=c.operationPayload_(op);
    const result=c.uploadEquipmentImage_({asset_id:op.asset_id,command_id:op.operation_id,expected_version:payload.expectedVersion,
      mime_type:resource.mime_type,base64_data:resource.bytes.toString('base64')},actor);
    await db.query("UPDATE crs.image_resources SET state='READY',verified_at=now() WHERE id=$1 AND state<>'TRASHED'",[resource.id]);
    await saveDomain(db,domain); return result;
  });
}
export async function imageCapability(token,assetId,expectedVersion) {
  const storage=await privateStorage();
  return transaction(async db=>{
    const domain=await loadDomain(db,{session:await sessionFor(db,token)}),c=domain.context,user=c.requireUser_(token);
    const record=c.findRecordById_('Equipment','asset_id',c.requireAssetId_(assetId));
    if(!record || (record.status==='DELETED' && user.role!=='ADMIN')) fail('NOT_FOUND','ไม่พบอุปกรณ์');
    if(Number(record.row_version)!==Number(expectedVersion)) return {available:false,reason:'STALE_VERSION'};
    if(!record.image_file_id) return {available:false,reason:'IMAGE_UNAVAILABLE'};
    let resource;
    try { resource=await verifiedResource(db,record.image_file_id,storage); }
    catch { return {available:false,reason:'IMAGE_UNAVAILABLE'}; }
    const signed=await storage.createSignedUrl(resource.object_key,60);
    if(signed.error) return {available:false,reason:'IMAGE_UNAVAILABLE'};
    return {available:true,mime_type:resource.mime_type,row_version:Number(record.row_version),signed_url:signed.data.signedUrl};
  });
}
export async function cleanupImages(db,storage) {
  storage ||= await privateStorage();
  const jobs=(await db.query('SELECT j.*,r.object_key,r.created_at FROM crs.cleanup_jobs j JOIN crs.image_resources r ON r.id=j.id WHERE j.not_before<=now()')).rows;
  for(const job of jobs) {
    const references=await db.query(`SELECT id FROM crs.equipment WHERE data->>'image_file_id'=$1
      UNION ALL SELECT id FROM crs.operations WHERE status='STARTED' AND data->>'resource_id'=$1`,[job.id]);
    if(references.rowCount) continue;
    // Signed uploads live 2h. Retain a margin so a late upload cannot resurrect
    // a just-deleted path. Cleanup is soft-marked + storage deletion, retryable.
    if(Date.now()-new Date(job.created_at).getTime()<7500000) continue;
    const removed=await storage.remove([job.object_key]);
    if(removed.error) continue;
    await db.query("UPDATE crs.image_resources SET state='TRASHED' WHERE id=$1",[job.id]);
    await db.query('DELETE FROM crs.cleanup_jobs WHERE id=$1',[job.id]);
  }
}
