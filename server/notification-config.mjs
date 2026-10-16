import {createECDH} from 'node:crypto';
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
