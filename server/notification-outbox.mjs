import {createHash} from 'node:crypto';
import {config} from './config.mjs';
import {deliveryConfiguration} from './notification-config.mjs';
import {selectedChannels} from './notification-channels.mjs';
const digest=value=>createHash('sha256').update(value).digest('base64url');

// Called ONLY for a newly inserted authoritative notice, inside its transaction.
// No dependency on domain/auth/transport: event projection cannot create cycles.
export async function enqueueDelivery(db,noticeId,userId,event) {
  if(!deliveryConfiguration().enabled || process.env.WRITE_FREEZE==='true')return;
  const pref=(await db.query('SELECT external_channel,row_version FROM crs.notification_preferences WHERE user_id=$1 AND event=$2',[userId,event])).rows[0];
  if(!pref?.external_channel)return;
  const origin=config().WEB_APP_URL,user=(await db.query('SELECT data FROM crs.users WHERE id=$1',[userId])).rows[0]?.data;
  if(!user)return;
  for(const channel of selectedChannels(pref.external_channel)) {
    const devices=channel==='EMAIL'?[{id:null}]:(await db.query('SELECT id FROM crs.push_subscriptions WHERE user_id=$1 AND origin=$2 AND expires_at>now()',[userId,origin])).rows;
    for(const device of devices)await db.query(`INSERT INTO crs.notification_delivery
    (id,notification_id,user_id,origin,event,channel,subscription_id,recipient_digest,preference_version)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
    [digest(noticeId+':'+origin+':'+channel+':'+(device.id||'')),noticeId,userId,origin,event,channel,device.id,digest(user.email),pref.row_version]);
  }
}
