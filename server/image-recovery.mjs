import { fail } from './errors.mjs';

export function installImageRecovery(domain,images) {
  const c=domain.context,verified=new Set();
  c.reconcileImageOperationForAdmin_=(id,actor)=>{
    c.assertAdminActor_(actor);
    const op=c.findRecordById_('Operations','operation_id',id);
    if(!op || op.action!=='UPLOAD_ASSET_IMAGE' || op.status!=='STARTED') fail('STATE_CONFLICT','ไม่พบ operation ภาพที่กู้คืนได้');
    const payload=c.operationPayload_(op),before=c.operationBeforeState_(op);
    c.assertImageOperationIdentity_(op,payload,before);
    const file=c.getImageFileIfPresent_(op.resource_id),resource=images[op.resource_id];
    if(!file) {
      const record=c.findRecordById_('Equipment','asset_id',op.asset_id);
      if(!resource || !['MISSING','TRASHED'].includes(resource.inspection) ||
        !c.equipmentImageSourceMatches_(record,before) || c.findHistoryByOperationLocked_(id)) {
        fail('IMAGE_FILE_UNAVAILABLE','ยังยืนยันสถานะไฟล์ไม่ได้ กรุณาตรวจสอบก่อนยกเลิก',true);
      }
      if(resource.asset_id!==op.asset_id || resource.operation_id!==id || resource.digest!==payload.digest ||
        resource.byte_length!==payload.byteLength || resource.mime_type!==payload.mimeType || resource.folder_id!==payload.folderId ||
        (resource.owner_user_id!==op.actor_user_id && resource.original?.verified_import!==true)) fail('STATE_CONFLICT','หลักฐาน resource ไม่ตรงกับ operation');
      c.abortOperationLocked_(op,{aborted:true,reason:'Storage object missing before commit',aborted_by:actor.email});
      domain.cleanup.add(op.resource_id);return {aborted:true};
    }
    if(!resource.bytes) fail('IMAGE_FILE_UNAVAILABLE','ต้องตรวจเนื้อหาไฟล์ก่อนกู้คืน',true);
    c.assertRecoverableImageEvidence_(file,op,payload);
    const result=c.uploadEquipmentImage_({asset_id:op.asset_id,command_id:id,expected_version:payload.expectedVersion,
      mime_type:payload.mimeType,base64_data:resource.bytes.toString('base64')},actor);
    verified.add(resource.id);return result;
  };
  c.repairImageIntegrity_=(input,actor)=>{
    c.assertAdminActor_(actor);
    if(input?.confirm!==true) fail('VALIDATION_FAILED','กรุณายืนยันการซ่อมรายการภาพ');
    if(input.kind==='STARTED_UPLOAD') return c.reconcileOperationForAdmin_(input.operation_id,actor);
    const image=images[input.file_id];
    if(input.kind!=='ORPHAN_FILE' || !image) fail('NOT_FOUND','ไม่พบไฟล์ภาพ');
    const state=c.imageIntegrityState_(),file=c.getImageFileIfPresent_(input.file_id);
    const op=c.findRecordById_('Operations','operation_id',image.operation_id);
    if(!file || !op || op.action!=='UPLOAD_ASSET_IMAGE' || !c.imageIntegrityManagedFile_(file)) fail('STATE_CONFLICT','ไฟล์ไม่มีหลักฐานว่าเป็นภาพของระบบ');
    c.assertRecoverableImageEvidence_(file,op,c.operationPayload_(op));
    if(state.referenced[input.file_id] || state.protectedResources[input.file_id] || state.protectedNames[image.name]) fail('STATE_CONFLICT','ไฟล์ยังถูกใช้งานอยู่');
    domain.cleanup.add(input.file_id);return {file_id:input.file_id,status:'CLEANUP_QUEUED'};
  };
  return verified;
}
