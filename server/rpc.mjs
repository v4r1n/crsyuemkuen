import { transaction } from './db.mjs';
import { sessionFor, beginSignIn, completeSignIn, logout, acknowledgeCopy } from './auth.mjs';
import { loadDomain, saveDomain } from './domain.mjs';
import { inspectResources, privateStorage, verifiedResource } from './storage.mjs';
import { prepareImage, finalizeImage, imageCapability, assertWritable, cleanupImages } from './images.mjs';
import { envelope, fail } from './errors.mjs';
import { installImageRecovery } from './image-recovery.mjs';
import { passwordAuth, authorizedUser } from './password-auth.mjs';
import { publicEquipment, notificationInbox, unreadNotifications, setVisibility } from './experience.mjs';
import { rateLimit } from './auth.mjs';
import { digest } from './domain.mjs';
const passwords=passwordAuth();

export const endpoints = Object.freeze([
  'getAppBootstrap','getDashboard','listEquipment','getEquipmentDetail','listCategories',
  'createBorrowRequest','listMyBorrowing','getBorrowDetail','requestReturn','listMyHistory',
  'adminGetDashboard','adminListBorrowing','adminApproveBorrow','adminRejectBorrow','adminCheckoutBorrow','adminCompleteReturn',
  'adminCreateEquipment','adminUpdateEquipment','adminDeleteEquipment','adminChangeEquipmentStatus',
  'adminListUsers','adminAuditLegacyUsers','adminRepairLegacyUser','adminCreateUser','adminUpdateUser',
  'adminListCategories','adminCreateCategory','adminUpdateCategory','adminListHistory','adminRunIntegrityAudit',
  'adminPreviewImageIntegrity','adminRepairImageIntegrity','adminListOperations','adminGetOperationDetail','adminReconcileOperation','adminAbortOperation'
]);
const readOnly = new Set(['getAppBootstrap','getDashboard','listEquipment','getEquipmentDetail','listCategories','listMyBorrowing','getBorrowDetail','listMyHistory',
  'adminGetDashboard','adminListBorrowing','adminListUsers','adminAuditLegacyUsers','adminListCategories','adminListHistory','adminRunIntegrityAudit',
  'adminPreviewImageIntegrity','adminListOperations','adminGetOperationDetail','adminListArchive','adminGetImageResource']);
export async function rpc(method,args,token,requestKey='') {
  return envelope(async()=>{
    if(!Array.isArray(args) || args.length>5) fail('VALIDATION_FAILED','รูปแบบคำขอไม่ถูกต้อง');
    if(method==='beginOAuthSignIn') return beginSignIn(args[0],requestKey);
    if(method==='completeOAuthSignIn') return completeSignIn(...args);
    if(method==='logoutSession') return logout(args[0]);
    if(method==='acknowledgeOAuthCopy') return acknowledgeCopy(...args);
    if(method==='passwordSignIn') return passwords.signIn(args[0],requestKey);
    if(method==='requestPasswordOtp') return passwords.requestOtp(args[0],token,requestKey);
    if(method==='verifyPasswordOtp') return passwords.verifyOtp(args[0],token);
    if(method==='changePassword') return passwords.changePassword(args[0],token,requestKey);
    if(method==='adminIssueTemporaryPassword') return passwords.issueTemporary(args[0],token);
    if(method==='listPublicEquipment') {
      const result=await transaction(async db=>{
        if(!await rateLimit(db,'guest:'+digest(requestKey),120,60)) return {limited:true};
        return publicEquipment(db,args[0]);
      });
      if(result.limited) fail('RATE_LIMITED','กรุณารอสักครู่');
      return result;
    }
    if(method==='listNotifications') return transaction(async db=>{
      const {user}=await authorizedUser(db,token);
      return notificationInbox(db,user,args[0]);
    });
    if(['adminSetEquipmentPublic','adminGetEquipmentVisibility'].includes(method)) {
      if(method==='adminSetEquipmentPublic') assertWritable();
      return transaction(async db=>{
        const {user,domain}=await authorizedUser(db,token); domain.context.requireAdmin_(token);
        if(method==='adminGetEquipmentVisibility') {
          if(!/^AST-\d{6}$/.test(args[0]?.assetId || '')) fail('VALIDATION_FAILED');
          return {isPublic:Boolean((await db.query('SELECT is_public FROM crs.equipment_visibility WHERE asset_id=$1',[args[0].assetId])).rows[0]?.is_public)};
        }
        const result=await setVisibility(db,domain,user,args[0]);await saveDomain(db,domain);return result;
      });
    }
    if(method==='prepareEquipmentImage') return prepareImage(token,args[0]);
    if(method==='finalizeEquipmentImage') return finalizeImage(token,args[0]);
    if(method==='getEquipmentImage') return imageCapability(token,...args);
    if(!endpoints.includes(method) && !['adminListArchive','adminCleanupImages','adminGetImageResource'].includes(method)) fail('NOT_FOUND','ไม่พบคำสั่งที่ต้องการ');
    if(!readOnly.has(method)) assertWritable();
    return transaction(async db=>{
      const session=await sessionFor(db,token,{allowRestricted:method==='getAppBootstrap'});
      const storage=await privateStorage();
      const images=await inspectResources(db,{storage,bytes:['adminReconcileOperation','adminRepairImageIntegrity','adminAbortOperation'].includes(method)});
      const domain=await loadDomain(db,{session,images}),c=domain.context;
      if(method==='adminGetImageResource') {
        c.requireAdmin_(token);
        const resource=await verifiedResource(db,args[0],storage);
        const signed=await storage.createSignedUrl(resource.object_key,60);
        if(signed.error) fail('IMAGE_FILE_UNAVAILABLE','ไม่สามารถอ่านภาพได้');
        return {signed_url:signed.data.signedUrl};
      }
      if(method==='adminListArchive') {
        c.requireAdmin_(token);
        const page=Math.max(1,Math.trunc(Number(args[0]?.page)||1));
        const result=await db.query('SELECT sheet,row_number,reason,raw FROM crs.archive ORDER BY source_hash,sheet,row_number LIMIT 100 OFFSET $1',[(page-1)*100]);
        const count=await db.query('SELECT count(*)::integer AS total FROM crs.archive');
        return {items:result.rows,page,total:count.rows[0].total};
      }
      if(method==='adminCleanupImages') {
        c.requireAdmin_(token); await cleanupImages(db,storage); return {processed:true};
      }
      const verified=installImageRecovery(domain,images);
      const result=domain.invoke(method,[token,...args]);
      if(!result.ok) {
        const error=result.error; fail(error.code,error.message,error.retryable,error.fieldErrors);
      }
      await saveDomain(db,domain);
      // Reconciliation commits READY in the same transaction as the reference.
      for(const id of verified) await db.query("UPDATE crs.image_resources SET state='READY',verified_at=now() WHERE id=$1 AND state='STAGED'",[id]);
      if(method==='getAppBootstrap') {
        result.data.session.mustChangePassword=Boolean(session.mustChangePassword);
        result.data.session.unreadNotifications=session.mustChangePassword ? 0 : await unreadNotifications(db,session.userId);
      }
      return result.data;
    });
  });
}
