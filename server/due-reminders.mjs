import {createHash} from 'node:crypto';
import {config} from './config.mjs';
import {enqueueDelivery} from './notification-outbox.mjs';

export function bangkokDate(now=Date.now()) {
  return new Date(now+7*3600000).toISOString().slice(0,10);
}
export function reminderCurrent(notice,borrow,now=Date.now()) {
  if(!['DUE_SOON','OVERDUE'].includes(notice.action))return true;
  const today=bangkokDate(now),due=borrow?.due_date;
  const date=value=>value instanceof Date?value.toISOString().slice(0,10):String(value||'').slice(0,10);
  return ['CHECKED_OUT','RETURN_REQUESTED'].includes(borrow?.status) && date(notice.reminder_day)===today && date(notice.reminder_due_date)===due &&
    (notice.action==='OVERDUE'?due<today:due===bangkokDate(now+86400000));
}
// Caller owns the ordinary transaction/advisory lock. Only today's current
// custody state is considered; no historical replay or business History write.
export async function projectDueReminders(db,{now=Date.now(),userId=null}={}) {
  if(process.env.DUE_REMINDERS_ENABLED!=='true'||process.env.WRITE_FREEZE==='true')return {created:0};
  const today=bangkokDate(now),tomorrow=bangkokDate(now+86400000);
  const rows=(await db.query(`SELECT b.id,b.data,u.id AS user_id,u.data->>'email' AS email FROM crs.borrow b
    JOIN crs.users u ON u.id=b.data->>'user_id' AND u.status='ACTIVE'
    WHERE b.status IN ('CHECKED_OUT','RETURN_REQUESTED') AND ($3::text IS NULL OR u.id=$3)
    AND split_part(u.data->>'email','@',2)=ANY($4::text[])
    AND (b.data->>'due_date'=$2 OR b.data->>'due_date'<$1)
    AND NOT EXISTS (SELECT 1 FROM crs.notifications n WHERE n.user_id=u.id AND n.borrow_id=b.id
      AND n.reminder_day=$1::date AND n.reminder_due_date=(b.data->>'due_date')::date
      AND n.action=CASE WHEN b.data->>'due_date'=$2 THEN 'DUE_SOON' ELSE 'OVERDUE' END)
    ORDER BY b.data->>'due_date',b.id LIMIT 100`,[today,tomorrow,userId,config().ALLOWED_DOMAINS])).rows;
  let created=0;
  for(const row of rows) {
    const action=row.data.due_date===tomorrow?'DUE_SOON':'OVERDUE';
    const id=createHash('sha256').update(['reminder',row.user_id,row.id,action,row.data.due_date,today].join(':')).digest('base64url');
    const inserted=await db.query(`INSERT INTO crs.notifications(id,user_id,history_id,borrow_id,action,created_at,reminder_due_date,reminder_day)
      VALUES($1,$2,NULL,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING id`,[id,row.user_id,row.id,action,new Date(now).toISOString(),row.data.due_date,today]);
    if(inserted.rows.length){created++;await enqueueDelivery(db,id,row.user_id,action);}
  }
  return {created};
}
