import sharp from 'sharp';
import {transaction} from './db.mjs';
import {authorizedUser} from './password-auth.mjs';
import {saveDomain,digest} from './domain.mjs';
import {rateLimit} from './auth.mjs';
import {privateStorage,validateImage,storageMissing} from './storage.mjs';
import {assertWritable} from './images.mjs';
import {fail} from './errors.mjs';

const formats={'image/jpeg':'jpeg','image/png':'png','image/webp':'webp'};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function exact(input,keys) {
  if(!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).some(key=>!keys.includes(key)))fail('VALIDATION_FAILED','ข้อมูลโปรไฟล์ไม่ถูกต้อง');
}
function command(input){if(!uuid.test(input.commandId||''))fail('VALIDATION_FAILED','รหัสคำขอไม่ถูกต้อง');}
const currentAvatar=async(db,id)=>(await db.query("SELECT * FROM crs.profile_resources WHERE owner_user_id=$1 AND state='READY'",[id])).rows[0];
const sameResource=(a,b)=>Boolean(a&&b&&['id','owner_user_id','operation_id','object_key','mime_type','byte_length','digest','previous_id'].every(key=>a[key]===b[key]));
function dto(domain,user,avatar) {
  return {name:domain.context.getSessionDto_(user).name,nameVersion:Number(user.row_version),avatarId:avatar?.id||null};
}
function operation(domain,user,input,action,payload) {
  const c=domain.context,avatar=action==='EDIT_OWN_AVATAR';
  // Like CREATE_USER, the staged avatar has an actor/resource binding but no
  // User entity reservation until commit. Failed uploads cannot lock Users.
  const spec=c.operationSpec_(input.commandId,action,'USER',avatar?'':user.user_id,payload,user),previous=c.findOperationLocked_(spec);
  if(previous && previous.actor_user_id!==user.user_id)fail('FORBIDDEN');
  return {c,spec,previous};
}
export async function validateAvatar(bytes,mime) {
  if(!Object.hasOwn(formats,mime) || !bytes?.length || bytes.length>1048576)fail('VALIDATION_FAILED','ใช้ JPEG, PNG หรือ WebP ไม่เกิน 1 MiB');
  const hash=validateImage(bytes,mime,1048576);
  try {
    const image=sharp(bytes,{limitInputPixels:512*512,failOn:'warning',animated:true}),meta=await image.metadata();
    if(meta.format!==formats[mime] || (meta.pages||1)!==1 || meta.width!==meta.height || meta.width<1 || meta.width>512)throw new Error('Invalid dimensions');
    await image.raw().toBuffer();
  }catch{fail('VALIDATION_FAILED','รูปต้องเป็นสี่เหลี่ยมจัตุรัส 1:1 ไม่เกิน 512×512 และไม่ใช่ภาพเคลื่อนไหว');}
  return hash;
}
export function profileService({transact=transaction,storageFor=privateStorage}={}) {
  async function quota(token,kind,limit) {
    const allowed=await transact(async db=>{const {user}=await authorizedUser(db,token);return rateLimit(db,'profile:'+kind+':'+digest(user.user_id),limit,3600);});
    if(!allowed)fail('RATE_LIMITED','กรุณารอสักครู่ก่อนแก้ไขโปรไฟล์อีกครั้ง');
  }
  async function get(token,input={}) {
    exact(input,[]);
    return transact(async db=>{const {user,domain}=await authorizedUser(db,token);return dto(domain,user,await currentAvatar(db,user.user_id));});
  }
  async function rename(token,input) {
    assertWritable();exact(input,['commandId','name','expectedVersion']);command(input);
    if(typeof input.name!=='string' || input.name.length>64 || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion<1)fail('VALIDATION_FAILED','ชื่อต้องมี 1–64 ตัวอักษร');
    await quota(token,'name',120);
    return transact(async db=>{
      const {user,domain}=await authorizedUser(db,token),name=domain.context.requireText_(input.name,'name','ชื่อ',64);
      const {c,spec,previous}=operation(domain,user,input,'EDIT_OWN_NAME',{name,expectedVersion:input.expectedVersion});
      if(previous?.status==='COMPLETED')return dto(domain,user,await currentAvatar(db,user.user_id));
      c.assertExpectedVersion_(user,input.expectedVersion);
      const before={...user};
      const op=previous||c.startOperationLocked_(spec,user);
      const updated=c.updateRecordById_('Users','user_id',user.user_id,{name,updated_at:op.started_at,updated_by:user.email,row_version:Number(user.row_version)+1});
      c.ensureOperationHistoryLocked_({entityType:'USER',entityId:user.user_id,action:'EDIT_OWN_NAME',operationId:input.commandId,
        oldStatus:before.status,newStatus:updated.status,changedFields:c.changedFields_(before,updated,['name','updated_at','updated_by','row_version']),note:'Owner updated their own name.'},user);
      const result=dto(domain,updated,await currentAvatar(db,user.user_id));c.finalizeOperationLocked_(op,user.user_id,{...result,status:updated.status});
      await saveDomain(db,domain);return result;
    });
  }
  async function prepare(token,input) {
    assertWritable();exact(input,['commandId','mimeType','byteLength','digest','previousId']);command(input);
    if(!Object.hasOwn(formats,input.mimeType) || !Number.isInteger(input.byteLength) || input.byteLength<1 || input.byteLength>1048576 ||
      !/^[A-Za-z0-9_-]{43}$/.test(input.digest||'') || !(input.previousId===null || uuid.test(input.previousId||'')))fail('VALIDATION_FAILED','ข้อมูลรูปโปรไฟล์ไม่ถูกต้อง');
    await quota(token,'avatar',20);const storage=await storageFor();
    const reservation=await transact(async db=>{
      const {user,domain}=await authorizedUser(db,token),{c,spec,previous}=operation(domain,user,input,'EDIT_OWN_AVATAR',input);
      if(previous?.status==='COMPLETED')return {completed:true};
      const current=await currentAvatar(db,user.user_id);
      if((current?.id||null)!==input.previousId)fail('STATE_CONFLICT','รูปโปรไฟล์เปลี่ยนแล้ว กรุณาโหลดใหม่');
      const op=previous||c.startOperationLocked_(spec,{avatarId:input.previousId,status:user.status});
      let resource=(await db.query('SELECT * FROM crs.profile_resources WHERE operation_id=$1',[input.commandId])).rows[0];
      if(!resource){const id=input.commandId;resource=(await db.query(`INSERT INTO crs.profile_resources(id,owner_user_id,operation_id,object_key,mime_type,byte_length,digest,previous_id,state)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'STAGED') RETURNING *`,[id,user.user_id,input.commandId,'avatars/'+user.user_id+'/'+id+'.'+formats[input.mimeType],input.mimeType,input.byteLength,input.digest,input.previousId])).rows[0];}
      c.setOperationResourceLocked_(op,resource.id);await saveDomain(db,domain);return {resource};
    });
    if(reservation.completed)return {completed:true};
    const {resource}=reservation,info=await storage.info(resource.object_key);
    if(!info.error)return {resourceId:resource.id};
    if(!storageMissing(info.error))fail('RESOURCE_UNAVAILABLE','ไม่สามารถตรวจสอบไฟล์ได้');
    const signed=await storage.createSignedUploadUrl(resource.object_key,{upsert:false});
    if(signed.error || !signed.data?.signedUrl)fail('RESOURCE_UNAVAILABLE','ไม่สามารถอัปโหลดไฟล์ได้');
    return {resourceId:resource.id,uploadUrl:signed.data.signedUrl};
  }
  async function verified(storage,resource) {
    const downloaded=await storage.download(resource.object_key);
    if(downloaded.error || !downloaded.data || downloaded.data.type!==resource.mime_type || downloaded.data.size!==resource.byte_length)fail('RESOURCE_UNAVAILABLE','ไม่สามารถตรวจสอบรูปโปรไฟล์ได้');
    const bytes=Buffer.from(await downloaded.data.arrayBuffer());
    if(await validateAvatar(bytes,resource.mime_type)!==resource.digest)fail('STATE_CONFLICT','ไฟล์ไม่ตรงกับคำขอ');
  }
  async function finalize(token,input) {
    assertWritable();exact(input,['commandId','resourceId']);command(input);
    if(!uuid.test(input.resourceId||''))fail('VALIDATION_FAILED');
    await quota(token,'finalize',60);
    const resource=await transact(async db=>{
      const {user}=await authorizedUser(db,token);
      const row=(await db.query('SELECT * FROM crs.profile_resources WHERE id=$1 AND owner_user_id=$2 AND operation_id=$3',[input.resourceId,user.user_id,input.commandId])).rows[0];
      if(!row)fail('NOT_FOUND');return row;
    });
    const storage=await storageFor();await verified(storage,resource);
    return transact(async db=>{
      const {user,domain}=await authorizedUser(db,token),c=domain.context;
      const op=c.findRecordById_('Operations','operation_id',input.commandId);
      if(!op || op.action!=='EDIT_OWN_AVATAR' || op.entity_type!=='USER' || op.actor_user_id!==user.user_id || (op.entity_id&&op.entity_id!==user.user_id) || op.resource_id!==resource.id)fail('STATE_CONFLICT');
      if(op.status==='COMPLETED')return dto(domain,user,await currentAvatar(db,user.user_id));
      if(op.status!=='STARTED')fail('STATE_CONFLICT');
      const current=await currentAvatar(db,user.user_id);
      if((current?.id||null)!==resource.previous_id)fail('STATE_CONFLICT','รูปโปรไฟล์เปลี่ยนแล้ว กรุณาโหลดใหม่');
      const latest=(await db.query('SELECT * FROM crs.profile_resources WHERE id=$1',[resource.id])).rows[0];
      const payload=c.operationPayload_(op);
      if(latest?.state!=='STAGED' || !sameResource(latest,resource) || payload.digest!==resource.digest || payload.mimeType!==resource.mime_type || payload.byteLength!==resource.byte_length || payload.previousId!==resource.previous_id)fail('STATE_CONFLICT');
      if(current)await db.query("UPDATE crs.profile_resources SET state='RETIRED' WHERE id=$1",[current.id]);
      await db.query("UPDATE crs.profile_resources SET state='READY',verified_at=now() WHERE id=$1",[resource.id]);
      c.ensureOperationHistoryLocked_({entityType:'USER',entityId:user.user_id,action:'EDIT_OWN_AVATAR',operationId:input.commandId,
        oldStatus:c.operationBeforeState_(op).status,newStatus:user.status,changedFields:{avatar:{oldValue:resource.previous_id,newValue:resource.id}},note:'Owner updated their private avatar.'},user);
      const result=dto(domain,user,resource);c.finalizeOperationLocked_(op,user.user_id,{...result,status:user.status});await saveDomain(db,domain);return result;
    });
  }
  async function avatar(token,input={}) {
    exact(input,[]);await quota(token,'read',240);
    const resource=await transact(async db=>{const {user}=await authorizedUser(db,token);return currentAvatar(db,user.user_id);});
    if(!resource)return {signedUrl:null};
    const storage=await storageFor();await verified(storage,resource);
    return transact(async db=>{
      const {user}=await authorizedUser(db,token),current=await currentAvatar(db,user.user_id);
      if(!sameResource(current,resource))fail('STATE_CONFLICT');
      const signed=await storage.createSignedUrl(resource.object_key,60);
      if(signed.error || !signed.data?.signedUrl)fail('RESOURCE_UNAVAILABLE');
      return {signedUrl:signed.data.signedUrl,mimeType:resource.mime_type,byteLength:resource.byte_length};
    });
  }
  return {get,rename,prepare,finalize,avatar};
}
