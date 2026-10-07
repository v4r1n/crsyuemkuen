import { config } from './config.mjs';
import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';
const actions = new Set(['BORROW_REQUEST','APPROVE','REJECT','CHECKOUT','REQUEST_RETURN','RETURN']);
const digest=value=>createHash('sha256').update(value).digest('base64url');

export function publicLinks(env=process.env) {
  const safe=value=>{try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password ? url.href : '';}catch{return '';}};
  // Deliberate two-field allowlist; never serialize config/environment wholesale.
  return {privacyUrl:safe(env.PRIVACY_POLICY_URL),termsUrl:safe(env.TERMS_OF_SERVICE_URL)};
}
export async function unreadNotifications(db,userId) {
  return (await db.query('SELECT count(*)::integer AS count FROM crs.notifications WHERE user_id=$1 AND read_at IS NULL',[userId])).rows[0].count;
}

// New History only; event and recipient keys make projection retry/replay safe.
export async function projectNotifications(db, domain, changes) {
  for (const change of changes.filter(row => row.table === 'History' && row.isNew && actions.has(row.data.action))) {
    const event = change.data, borrow = domain.records.Borrow.find(row => row.borrow_id === event.borrow_id);
    if (!borrow) fail('STATE_CONFLICT','ไม่พบรายการยืมสำหรับการแจ้งเตือน');
    const recipients = new Set([borrow.user_id]);
    if (['BORROW_REQUEST','REQUEST_RETURN'].includes(event.action)) {
      for (const user of domain.records.Users.filter(row => row.role === 'ADMIN' && row.status === 'ACTIVE')) recipients.add(user.user_id);
    }
    for (const userId of recipients) await db.query(`INSERT INTO crs.notifications(id,user_id,history_id,borrow_id,action,created_at)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(user_id,history_id) DO NOTHING`,
      [digest(event.log_id + ':' + userId),userId,event.log_id,borrow.borrow_id,event.action,event.timestamp]);
  }
}
export async function notificationInbox(db,user,input = {}) {
  if (input.readId !== undefined) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(input.readId)) fail('VALIDATION_FAILED');
    await db.query('UPDATE crs.notifications SET read_at=COALESCE(read_at,now()) WHERE id=$1 AND user_id=$2',[input.readId,user.user_id]);
  }
  const rows = await db.query(`SELECT n.id,n.borrow_id,n.action,n.created_at,n.read_at FROM crs.notifications n
    WHERE n.user_id=$1 ORDER BY n.created_at DESC,n.id LIMIT 50`,[user.user_id]);
  const unread = await unreadNotifications(db,user.user_id);
  return {items:rows.rows,unread};
}
function publicDto(data,category) {
  // Never return a domain DTO or raw JSON. Images remain authenticated/private.
  return {asset_id:data.asset_id,name:data.name,brand:data.brand || '',model:data.model || '',
    category_name:category || '',can_borrow:data.status === 'AVAILABLE',
    imageAvailable:false,detail_url:config().WEB_APP_URL + '?view=equipment-detail&id=' + encodeURIComponent(data.asset_id)};
}
export async function publicEquipment(db,input = {}) {
  const search = typeof input.search === 'string' ? input.search.trim().slice(0,100).toLowerCase() : '';
  const page = Math.max(1,Math.min(10000,Math.trunc(Number(input.page)||1)));
  const id = input.assetId;
  if (id !== undefined && !/^AST-\d{6}$/.test(id)) fail('NOT_FOUND','ไม่พบอุปกรณ์สาธารณะ');
  const rows = await db.query(`SELECT e.data,c.data->>'category_name' AS category FROM crs.equipment e
    JOIN crs.equipment_visibility v ON v.asset_id=e.id AND v.is_public=true
    JOIN crs.categories c ON c.id=e.category_id
    WHERE e.status NOT IN ('DELETED','RETIRED','LOST') AND c.status='ACTIVE'
    ORDER BY lower(e.data->>'name'),e.id`);
  const filtered = rows.rows.filter(row => (!id || row.data.asset_id === id) &&
    [row.data.name,row.data.brand,row.data.model,row.category].some(value => String(value || '').toLowerCase().includes(search)));
  if (id && filtered.length !== 1) fail('NOT_FOUND','ไม่พบอุปกรณ์สาธารณะ');
  const items = filtered.slice((page-1)*24,page*24).map(row => publicDto(row.data,row.category));
  return {items,total:filtered.length,page,totalPages:Math.max(1,Math.ceil(filtered.length/24))};
}
export async function setVisibility(db,domain,user,input) {
  if (user.role !== 'ADMIN') fail('FORBIDDEN');
  if (!/^AST-\d{6}$/.test(input?.assetId || '') || typeof input.isPublic !== 'boolean' ||
    !/^[A-Za-z0-9_-]{8,100}$/.test(input.commandId || '')) fail('VALIDATION_FAILED');
  const existing = domain.records.History.find(row => row.operation_id === input.commandId);
  if (existing) {
    if (existing.action !== (input.isPublic ? 'PUBLISH_ASSET' : 'UNPUBLISH_ASSET') || existing.asset_id !== input.assetId || existing.actor_user_id !== user.user_id) fail('STATE_CONFLICT');
    return {updated:true};
  }
  const record = domain.records.Equipment.find(row => row.asset_id === input.assetId);
  if (!record || ['DELETED','RETIRED','LOST'].includes(record.status)) fail('NOT_FOUND');
  if (Number(record.row_version) !== Number(input.expectedVersion)) fail('STATE_CONFLICT','ข้อมูลอุปกรณ์เปลี่ยนไป กรุณาโหลดใหม่');
  await db.query(`INSERT INTO crs.equipment_visibility(asset_id,is_public,updated_by) VALUES($1,$2,$3)
    ON CONFLICT(asset_id) DO UPDATE SET is_public=excluded.is_public,updated_by=excluded.updated_by,updated_at=now()`,[record.asset_id,input.isPublic,user.user_id]);
  domain.context.appendHistoryLocked_({entityType:'ASSET',entityId:record.asset_id,assetId:record.asset_id,
    action:input.isPublic ? 'PUBLISH_ASSET' : 'UNPUBLISH_ASSET',operationId:input.commandId,note:'Public catalog projection only; no private image or internal fields'},user);
  return {updated:true};
}
