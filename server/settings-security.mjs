import { randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { digest, loadDomain, saveDomain } from './domain.mjs';
import { fail } from './errors.mjs';
import {deliveryConfiguration,pushTestConfiguration} from './notification-config.mjs';
import {assertWritable} from './images.mjs';
import {selectedChannels} from './notification-channels.mjs';

export const preferenceEvents = Object.freeze(['BORROW_REQUEST','APPROVE','REJECT','CHECKOUT','REQUEST_RETURN','RETURN','ADMIN_BORROW_REQUEST','ADMIN_REQUEST_RETURN','DUE_SOON','OVERDUE']);
const adminEvents = new Set(['ADMIN_BORROW_REQUEST','ADMIN_REQUEST_RETURN']);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const historyActions = ['LOGIN_GOOGLE','LOGIN_PASSWORD','LOGOUT','REVOKE_SESSION','REVOKE_OTHER_SESSIONS','CHANGE_PASSWORD','ISSUE_TEMPORARY_PASSWORD'];

// Caller holds the existing transaction lock and has reauthorized current User.
export async function appendSecurityHistory(db,user,action,operationId,changedFields) {
  if (!historyActions.includes(action)) fail('VALIDATION_FAILED');
  const domain = await loadDomain(db);
  const prior = domain.records.History.find(row=>row.operation_id===operationId);
  if (prior) {
    if(prior.action!==action || prior.entity_id!==user.user_id || prior.actor_user_id!==user.user_id) fail('STATE_CONFLICT');
    return;
  }
  domain.context.appendHistoryLocked_({entityType:'USER',entityId:user.user_id,action,operationId,changedFields,
    note:'Account security event. No credentials, session identifiers or device metadata retained.'},user);
  await saveDomain(db,domain);
}

async function activeSessions(db,user,currentHash) {
  const cfg=config();
  const credential=(await db.query('SELECT * FROM crs.password_credentials WHERE user_id=$1',[user.user_id])).rows[0];
  const rows=(await db.query(`SELECT id,data,expires_at FROM crs.sessions
    WHERE data->>'userId'=$1 AND expires_at>now() ORDER BY expires_at DESC,id`,[user.user_id])).rows;
  const items=[];
  for(const row of rows) {
    const s=row.data;
    if(s.email!==user.email || s.clientId!==cfg.GOOGLE_OAUTH_CLIENT_ID || s.expiresAt<=Date.now()/1000 ||
      !cfg.ALLOWED_DOMAINS.includes(s.email?.split('@')[1]) ||
      (s.method==='PASSWORD' && (!credential || credential.email!==s.email || Number(credential.generation)!==s.credentialGeneration))) continue;
    if(!uuid.test(s.publicId || '')) {
      s.publicId=randomUUID();
      await db.query(`UPDATE crs.sessions SET data=data || jsonb_build_object('publicId',$2::text) WHERE id=$1`,[row.id,s.publicId]);
    }
    // Never serialize the stored row, hash, email, subject or client ID.
    items.push({publicId:s.publicId,current:row.id===currentHash,
      browser:['Microsoft Edge','Firefox','Chrome','Safari'].includes(s.browser)?s.browser:null,
      os:['iPhone','iPad','Android','Windows','macOS','Linux'].includes(s.os)?s.os:null,
      createdAt:validInstant(s.createdAt),lastActiveAt:validInstant(s.lastActiveAt),expiresAt:s.expiresAt});
  }
  return items;
}
function validInstant(value) {return typeof value==='string' && Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;}
export async function settingsOverview(db,user,token,domain) {
  const dto=(domain || await loadDomain(db)).context.getSessionDto_(user);
  const credential=(await db.query('SELECT email,must_change FROM crs.password_credentials WHERE user_id=$1',[user.user_id])).rows[0];
  const sessions=await activeSessions(db,user,digest(token));
  return {email:dto.email,name:dto.name,department:dto.department || '',role:dto.role,
    googleAvailable:config().ALLOWED_DOMAINS.includes(user.email.split('@')[1]),
    passwordConfigured:credential?.email===user.email,mustChangePassword:Boolean(credential?.must_change),
    activeSessionCount:sessions.length,sessionTtlSeconds:config().AUTH_SESSION_TTL_SECONDS};
}
export async function listSessions(db,user,token) {
  const items=await activeSessions(db,user,digest(token));return {items,count:items.length};
}
export async function revokeSessions(db,user,token,input={}) {
  if(!input || typeof input!=='object' || !uuid.test(input.commandId || '') || (input.allOthers!==true && !uuid.test(input.publicId || ''))) fail('VALIDATION_FAILED');
  const action=input.allOthers===true?'REVOKE_OTHER_SESSIONS':'REVOKE_SESSION';
  const operationId='security:'+digest('revoke:'+user.user_id+':'+input.commandId);
  const requestDigest=digest(JSON.stringify({allOthers:input.allOthers===true,publicId:input.allOthers===true?null:input.publicId}));
  const prior=(await db.query("SELECT data FROM crs.history WHERE data->>'operation_id'=$1",[operationId])).rows[0]?.data;
  if(prior) {
    if(prior.actor_user_id!==user.user_id || prior.entity_id!==user.user_id || prior.action!==action ||
      JSON.parse(prior.changed_fields_json || '{}').requestDigest!==requestDigest) fail('STATE_CONFLICT');
    return {revoked:0,alreadyRevoked:true};
  }
  const currentHash=digest(token),items=await activeSessions(db,user,currentHash);
  if(input.allOthers!==true && items.some(item=>item.current && item.publicId===input.publicId)) fail('VALIDATION_FAILED','ใช้ปุ่มออกจากระบบสำหรับเซสชันปัจจุบัน');
  // Owner condition is mandatory even though public handles are unpredictable.
  const deleted=input.allOthers===true
    ? await db.query(`DELETE FROM crs.sessions WHERE data->>'userId'=$1 AND id<>$2 RETURNING id`,[user.user_id,currentHash])
    : await db.query(`DELETE FROM crs.sessions WHERE data->>'userId'=$1 AND data->>'publicId'=$2 AND id<>$3 RETURNING id`,[user.user_id,input.publicId,currentHash]);
  // Record even a no-op, so retrying revoke-all cannot revoke sessions created
  // after the original command. The projection exposes none of these digests.
  await appendSecurityHistory(db,user,action,operationId,{requestDigest,revokedCount:deleted.rows.length});
  return {revoked:deleted.rows.length,alreadyRevoked:deleted.rows.length===0};
}
export async function securityActivity(db,user) {
  const rows=await db.query(`SELECT data->>'log_id' AS id,data->>'action' AS action,data->>'timestamp' AS timestamp,
    data->>'changed_fields_json' AS changed_fields_json
    FROM crs.history WHERE data->>'entity_type'='USER' AND data->>'entity_id'=$1 AND data->>'action'=ANY($2::text[])
    ORDER BY data->>'timestamp' DESC,id DESC LIMIT 50`,[user.user_id,historyActions]);
  return {items:rows.rows.map(row=>{
    let outcome='COMPLETED';
    if(['REVOKE_SESSION','REVOKE_OTHER_SESSIONS'].includes(row.action)) {
      try {if(JSON.parse(row.changed_fields_json || '{}').revokedCount===0)outcome='NO_OP';}catch{/* Old audit copy has no inferred outcome. */}
    }
    return {id:row.id,action:row.action,timestamp:row.timestamp,outcome};
  })};
}
export async function notificationPreferences(db,user,input,token) {
  const channels=deliveryConfiguration(),test=pushTestConfiguration(user),origin=config().WEB_APP_URL;
  const pushRegistered=Boolean((channels.push||test.available) && token && (await db.query(
    'SELECT id FROM crs.push_subscriptions WHERE user_id=$1 AND session_hash=$2 AND origin=$3 AND expires_at>now()',
    [user.user_id,digest(token),origin])).rows.length);
  if(input!==undefined) {
    if(!input || typeof input!=='object' || !preferenceEvents.includes(input.event) || (adminEvents.has(input.event) && user.role!=='ADMIN') ||
      Object.hasOwn(input,'inApp') ||
      (input.channel!==undefined && ![null,'PUSH','EMAIL','PUSH_EMAIL'].includes(input.channel)) ||
      input.channel===undefined || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion<0) fail('VALIDATION_FAILED');
    assertWritable();
    const prior=(await db.query('SELECT external_channel,row_version FROM crs.notification_preferences WHERE user_id=$1 AND event=$2',[user.user_id,input.event])).rows[0];
    if(Number(prior?.row_version || 0)!==input.expectedVersion) fail('STATE_CONFLICT','ข้อมูลเปลี่ยนไป กรุณาโหลดใหม่');
    // Removing a choice must remain possible after capability/configuration loss.
    const added=selectedChannels(input.channel).filter(channel=>!selectedChannels(prior?.external_channel).includes(channel));
    if(added.includes('EMAIL')&&!channels.email || added.includes('PUSH')&&(!channels.push || !pushRegistered))
      fail('NOTIFICATION_UNAVAILABLE','กรุณาเปิดใช้งานช่องทางแจ้งเตือนก่อน');
    await db.query(`INSERT INTO crs.notification_preferences(user_id,event,in_app,external_channel) VALUES($1,$2,true,$3)
      ON CONFLICT(user_id,event) DO UPDATE SET in_app=true,external_channel=$3,
      row_version=crs.notification_preferences.row_version+1,updated_at=now()`,[user.user_id,input.event,input.channel]);
  }
  const saved=(await db.query('SELECT * FROM crs.notification_preferences WHERE user_id=$1',[user.user_id])).rows;
  return {items:preferenceEvents.filter(event=>!adminEvents.has(event)||user.role==='ADMIN').map(event=>{
    const row=saved.find(item=>item.event===event);return {event,inApp:true,channel:row?.external_channel??null,version:Number(row?.row_version||0)};
  }),channels:{inApp:true,push:channels.push,email:channels.email},pushPublicKey:channels.publicKey||test.publicKey,pushRegistered,pushTestAvailable:test.available,
    deliveryEnabled:channels.enabled,dueRemindersAvailable:process.env.DUE_REMINDERS_ENABLED==='true',securityEmailRequired:true};
}
