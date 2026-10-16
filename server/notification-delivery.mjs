import {createECDH} from 'node:crypto';
import nodemailer from 'nodemailer';
import webpush from 'web-push';
import {config} from './config.mjs';
import {mailOptions} from './mail.mjs';
import {transaction} from './db.mjs';
import {digest} from './domain.mjs';
import {authorizedUser} from './password-auth.mjs';
import {rateLimit} from './auth.mjs';
import {assertWritable} from './images.mjs';
import {fail} from './errors.mjs';
import {deliveryConfiguration} from './notification-config.mjs';
export {deliveryConfiguration} from './notification-config.mjs';

export function validateSubscription(input) {
  if(!input || typeof input!=='object' || Object.keys(input).some(key=>!['endpoint','keys'].includes(key)) ||
    typeof input.endpoint!=='string' || input.endpoint.length>2048 || !input.keys ||
    Object.keys(input.keys).sort().join()!=='auth,p256dh')fail('VALIDATION_FAILED');
  let url;
  try{url=new URL(input.endpoint);}catch{fail('VALIDATION_FAILED');}
  const host=url.hostname;
  // Never fetch arbitrary user URLs (SSRF), follow redirects or use a proxy.
  if(url.href!==input.endpoint || url.protocol!=='https:' || url.port || url.username || url.password || url.hash ||
    !(['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com'].includes(host) ||
      /^[a-z0-9-]+\.notify\.windows\.com$/.test(host)))fail('VALIDATION_FAILED');
  for(const [name,length] of [['p256dh',65],['auth',16]]) {
    const value=input.keys[name];
    if(typeof value!=='string' || !/^[A-Za-z0-9_-]+$/.test(value) || Buffer.from(value,'base64url').length!==length ||
      Buffer.from(value,'base64url').toString('base64url')!==value)fail('VALIDATION_FAILED');
  }
  try{const curve=createECDH('prime256v1');curve.generateKeys();curve.computeSecret(Buffer.from(input.keys.p256dh,'base64url'));}catch{fail('VALIDATION_FAILED');}
  return input;
}

export async function ownPushSubscription(db,user,token,input) {
  assertWritable();
  if(!deliveryConfiguration().push)fail('NOTIFICATION_UNAVAILABLE','การแจ้งเตือนพุชยังไม่พร้อมใช้งาน');
  if(!await rateLimit(db,'push-register:'+user.user_id,10,600))return {limited:true};
  if(input?.remove===true && Object.keys(input).length===1) {
    await db.query('DELETE FROM crs.push_subscriptions WHERE user_id=$1 AND session_hash=$2 AND origin=$3',
      [user.user_id,digest(token),config().WEB_APP_URL]);return {registered:false};
  }
  const sub=validateSubscription(input),origin=config().WEB_APP_URL,id=digest(origin+':'+sub.endpoint);
  const prior=(await db.query('SELECT user_id FROM crs.push_subscriptions WHERE id=$1',[id])).rows[0];
  if(prior && prior.user_id!==user.user_id)fail('STATE_CONFLICT','อุปกรณ์นี้ผูกกับบัญชีอื่น กรุณายกเลิกการสมัครพุชก่อน');
  const session=(await db.query('SELECT expires_at FROM crs.sessions WHERE id=$1',[digest(token)])).rows[0];
  const count=(await db.query('SELECT count(*)::int AS n FROM crs.push_subscriptions WHERE user_id=$1 AND origin=$2 AND expires_at>now()',[user.user_id,origin])).rows[0].n;
  if(!prior && count>=5)fail('RATE_LIMITED','ลงทะเบียนได้ไม่เกิน 5 อุปกรณ์');
  await db.query(`INSERT INTO crs.push_subscriptions(id,user_id,origin,session_hash,endpoint,p256dh,auth,expires_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(id) DO UPDATE SET session_hash=excluded.session_hash,
    p256dh=excluded.p256dh,auth=excluded.auth,expires_at=excluded.expires_at,updated_at=now()`,
    [id,user.user_id,origin,digest(token),sub.endpoint,sub.keys.p256dh,sub.keys.auth,session.expires_at]);
  return {registered:true};
}

async function sendEmail(job) {
  const sender=nodemailer.createTransport(mailOptions());
  try {
    const result=await sender.sendMail({from:process.env.SMTP_FROM,to:job.email,
      subject:'CRS Yuem-Kuen: การแจ้งเตือนใหม่ / New notification',
      text:'มีกิจกรรมยืม–คืนใหม่ กรุณาลงชื่อเข้าใช้เพื่อตรวจสอบ\nNew borrowing activity. Sign in to review.\n'+job.origin,
      messageId:'<notice-'+job.id+'@crs.local>',disableFileAccess:true,disableUrlAccess:true});
    return Array.isArray(result.accepted)&&result.accepted.some(address=>address.toLowerCase()===job.email.toLowerCase())?'ACCEPTED':'UNCERTAIN';
  }catch{return 'UNCERTAIN';}finally{sender.close();}
}
async function sendPush(job) {
  try {
    await webpush.sendNotification({endpoint:job.subscription.endpoint,keys:{p256dh:job.subscription.p256dh,auth:job.subscription.auth}},
      JSON.stringify({id:job.notification_id}),{TTL:300,timeout:10000,urgency:'normal',vapidDetails:{
        subject:process.env.WEB_PUSH_SUBJECT,publicKey:process.env.WEB_PUSH_PUBLIC_KEY,privateKey:process.env.WEB_PUSH_PRIVATE_KEY}});
    return 'ACCEPTED';
  }catch(error) {
    if([404,410].includes(error.statusCode))return 'EXPIRED';
    if([429,500,502,503,504].includes(error.statusCode))return 'RETRY';
    return error.statusCode?'FAILED':'UNCERTAIN';
  }
}

// Provider I/O never holds the workflow lock. A durable SENDING reservation
// prevents concurrent workers/replay from submitting the same attempt twice.
export function deliveryProcessor({transact=transaction,email=sendEmail,push=sendPush}={}) {
  return async function processDelivery() {
    const cfg=deliveryConfiguration();
    if(!cfg.enabled || process.env.WRITE_FREEZE==='true')return {processed:0};
    const jobs=await transact(async db=>{
      const origin=config().WEB_APP_URL;
      await db.query("UPDATE crs.notification_delivery SET status='UNCERTAIN',updated_at=now() WHERE origin=$1 AND status='SENDING' AND started_at<now()-interval '2 minutes'",[origin]);
      const due=(await db.query("SELECT * FROM crs.notification_delivery WHERE origin=$1 AND status='PENDING' AND available_at<=now() ORDER BY available_at,id LIMIT 4",[origin])).rows;
      const ready=[];
      for(const job of due) {
        const pref=(await db.query('SELECT external_channel,row_version FROM crs.notification_preferences WHERE user_id=$1 AND event=$2',[job.user_id,job.event])).rows[0];
        const user=(await db.query('SELECT data FROM crs.users WHERE id=$1',[job.user_id])).rows[0]?.data;
        const notice=(await db.query(`SELECT n.id FROM crs.notifications n JOIN crs.borrow b ON b.id=n.borrow_id
          WHERE n.id=$1 AND n.user_id=$2 AND ($3::boolean OR b.data->>'user_id'=$2)`,[job.notification_id,job.user_id,user?.role==='ADMIN'])).rows[0];
        let subscription=null,valid=true;
        if(job.channel==='PUSH') {
          subscription=(await db.query('SELECT * FROM crs.push_subscriptions WHERE id=$1 AND user_id=$2 AND origin=$3 AND expires_at>now()',[job.subscription_id,job.user_id,origin])).rows[0];
          const session=subscription&&(await db.query('SELECT data FROM crs.sessions WHERE id=$1 AND expires_at>now()',[subscription.session_hash])).rows[0]?.data;
          valid=Boolean(session && session.userId===job.user_id && session.email===user?.email && session.clientId===config().GOOGLE_OAUTH_CLIENT_ID && session.expiresAt>Date.now()/1000 && !session.mustChangePassword);
          if(valid) {
            const credential=(await db.query('SELECT email,generation,must_change FROM crs.password_credentials WHERE user_id=$1',[job.user_id])).rows[0];
            if(credential?.email===user.email && credential.must_change)valid=false;
            if(session.method==='PASSWORD')valid=Boolean(valid && credential && credential.email===user.email && Number(credential.generation)===session.credentialGeneration);
          }
        }
        const allowed=Boolean(user && user.status==='ACTIVE' && config().ALLOWED_DOMAINS.includes(user.email?.split('@')[1]) &&
          digest(user.email)===job.recipient_digest && notice && valid && pref?.external_channel===job.channel &&
          Number(pref.row_version)===job.preference_version && (!job.event.startsWith('ADMIN_') || user.role==='ADMIN') &&
          Date.now()-new Date(job.created_at).getTime()<86400000 && job.attempts<3);
        if(!allowed) {await db.query("UPDATE crs.notification_delivery SET status='CANCELLED',updated_at=now() WHERE id=$1",[job.id]);continue;}
        if(job.channel==='EMAIL'?!cfg.email:!cfg.push)continue;
        await db.query("UPDATE crs.notification_delivery SET status='SENDING',attempts=attempts+1,started_at=now(),updated_at=now() WHERE id=$1",[job.id]);
        ready.push({...job,email:user.email,subscription});
      }
      return ready;
    });
    await Promise.all(jobs.map(async job=>{
      let status;
      try{status=await (job.channel==='EMAIL'?email:push)(job);}catch{status='UNCERTAIN';}
      if(!['ACCEPTED','UNCERTAIN','FAILED','EXPIRED','RETRY'].includes(status))status='UNCERTAIN';
      await transact(async db=>{
        // Never log provider responses, device capabilities, recipient or keys.
        if(status==='EXPIRED')await db.query('DELETE FROM crs.push_subscriptions WHERE id=$1 AND user_id=$2',[job.subscription_id,job.user_id]);
        const next=status==='RETRY'?(job.attempts<2?'PENDING':'FAILED'):status==='EXPIRED'?'CANCELLED':status;
        await db.query(`UPDATE crs.notification_delivery SET status=$2,available_at=now()+interval '5 minutes',updated_at=now()
          WHERE id=$1 AND status='SENDING'`,[job.id,next]);
      });
    }));
    return {processed:jobs.length};
  };
}

export async function registerPush(token,input) {
  const result=await transaction(async db=>{
    const {user}=await authorizedUser(db,token);return ownPushSubscription(db,user,token,input);
  });
  if(result.limited)fail('RATE_LIMITED','กรุณารอก่อนลงทะเบียนอุปกรณ์อีกครั้ง');return result;
}
