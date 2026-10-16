import {randomBytes} from 'node:crypto';
import {transaction} from './db.mjs';
import {authorizedUser} from './password-auth.mjs';
import {rateLimit} from './auth.mjs';
import {digest} from './domain.mjs';
import {config} from './config.mjs';
import {assertWritable} from './images.mjs';
import {fail} from './errors.mjs';
import {pushTestConfiguration} from './notification-config.mjs';
import {sendPush} from './notification-delivery.mjs';

export function pushTestService({transact=transaction,push=sendPush}={}) {
  return async function sendTestPush(token,input) {
    if(input!==undefined && (!input || typeof input!=='object' || Array.isArray(input) || Object.keys(input).length))fail('VALIDATION_FAILED');
    const job=await transact(async db=>{
      const {user}=await authorizedUser(db,token);assertWritable();
      if(!pushTestConfiguration(user).available)fail('NOTIFICATION_UNAVAILABLE');
      const origin=config().WEB_APP_URL;
      const subscription=(await db.query(`SELECT * FROM crs.push_subscriptions
        WHERE user_id=$1 AND session_hash=$2 AND origin=$3 AND expires_at>now()
        ORDER BY updated_at DESC,id LIMIT 1`,[user.user_id,digest(token),origin])).rows[0];
      if(!subscription)fail('NOTIFICATION_UNAVAILABLE','กรุณาลงทะเบียนพุชบนอุปกรณ์นี้ก่อน');
      // Commit a durable reservation BEFORE external I/O, including on ambiguity.
      // Retries cannot resend; no fabricated notice/History/outbox is created.
      if(!await rateLimit(db,'push-test:'+digest(origin+':'+user.user_id),1,600))return null;
      return {subscription,notification_id:randomBytes(32).toString('base64url'),test:true};
    });
    if(!job)fail('RATE_LIMITED','ส่งทดสอบได้หนึ่งครั้งทุก 10 นาที / One test per 10 minutes');
    const status=await push(job).catch(()=> 'UNCERTAIN');
    return {status:['ACCEPTED','EXPIRED','FAILED','UNCERTAIN','RETRY'].includes(status)?status:'UNCERTAIN',deviceReceiptConfirmed:false};
  };
}
