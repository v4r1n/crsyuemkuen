import {createECDH,createHash} from 'node:crypto';
import {mailOptions} from './mail.mjs';

export function deliveryConfiguration(env=process.env) {
  const enabled=env.NOTIFICATION_DELIVERY_ENABLED==='true';
  let email=false,push=false;
  if(enabled) {
    try{mailOptions(env);email=true;}catch{/* Unconfigured channels stay unavailable. */}
    try {
      if(!/^mailto:[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.WEB_PUSH_SUBJECT||''))throw new Error('subject');
      if(!/^[A-Za-z0-9_-]{43}$/.test(env.WEB_PUSH_PRIVATE_KEY||'') || !/^[A-Za-z0-9_-]{87}$/.test(env.WEB_PUSH_PUBLIC_KEY||''))throw new Error('key');
      const curve=createECDH('prime256v1');curve.setPrivateKey(Buffer.from(env.WEB_PUSH_PRIVATE_KEY,'base64url'));
      push=curve.getPublicKey().toString('base64url')===env.WEB_PUSH_PUBLIC_KEY;
    }catch{/* Invalid or mismatched VAPID keys stay server-side and unavailable. */}
  }
  return {enabled,email,push,publicKey:push?env.WEB_PUSH_PUBLIC_KEY:null};
}

// Separate diagnostic capability: never enables the authoritative outbox.
// Only a current server-authenticated User may be supplied by callers.
export function pushTestConfiguration(user,env=process.env,now=Date.now()) {
  const until=Date.parse(env.PUSH_TEST_EXPIRES_AT||'');
  const available=env.NOTIFICATION_DELIVERY_ENABLED==='false' && env.WRITE_FREEZE==='false' &&
    env.VERCEL_ENV==='production' && env.WEB_APP_URL==='https://crsyuemkuen.vercel.app' &&
    /^[a-f0-9]{64}$/.test(env.PUSH_TEST_USER_SHA256||'') &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(env.PUSH_TEST_EXPIRES_AT||'') &&
    Number.isFinite(until) && new Date(until).toISOString()===env.PUSH_TEST_EXPIRES_AT && until>now && until-now<=86400000 &&
    user?.status==='ACTIVE' && typeof user.email==='string' &&
    createHash('sha256').update(user.email).digest('hex')===env.PUSH_TEST_USER_SHA256;
  const cfg=available?deliveryConfiguration({...env,NOTIFICATION_DELIVERY_ENABLED:'true'}):null;
  return {available:Boolean(available&&cfg.push),publicKey:available&&cfg.push?cfg.publicKey:null};
}
