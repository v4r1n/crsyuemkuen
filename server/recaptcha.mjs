import {config} from './config.mjs';
import {fail} from './errors.mjs';

// Abuse proof is not identity. No token/cache/database state is retained here.
const unavailable=()=>fail('RECAPTCHA_UNAVAILABLE','ไม่สามารถตรวจสอบความปลอดภัยได้ กรุณาลองใหม่ หรือเข้าสู่ระบบด้วย Google',true);
const denied=()=>fail('RECAPTCHA_FAILED','การตรวจสอบความปลอดภัยไม่ผ่าน กรุณาลองใหม่ หรือเข้าสู่ระบบด้วย Google',true);
export function recaptchaConfig(env=process.env){
  const siteKey=env.RECAPTCHA_SITE_KEY,secret=env.RECAPTCHA_SECRET_KEY;
  const hostname=new URL(config(env).WEB_APP_URL).hostname;
  const actions={login:env.RECAPTCHA_LOGIN_ACTION||'password_login',reset:env.RECAPTCHA_RESET_ACTION||'password_reset'};
  const minScore=env.RECAPTCHA_MIN_SCORE===undefined||env.RECAPTCHA_MIN_SCORE==='' ? .5 : Number(env.RECAPTCHA_MIN_SCORE);
  if(!/^[A-Za-z0-9_-]{20,200}$/.test(siteKey||'')||!/^[A-Za-z0-9_-]{20,200}$/.test(secret||'')||
    !Number.isFinite(minScore)||minScore<=0||minScore>1||actions.login===actions.reset||
    Object.values(actions).some(value=>!/^[A-Za-z0-9_/]{1,100}$/.test(value))||
    (env.RECAPTCHA_HOSTNAME&&env.RECAPTCHA_HOSTNAME!==hostname))unavailable();
  return {siteKey,secret,hostname,actions,minScore};
}
export function publicRecaptcha(env=process.env){
  const {siteKey,actions}=recaptchaConfig(env);
  return {siteKey,actions}; // Explicit allowlist; never serialize the server policy.
}
export async function verifyRecaptcha(token,purpose,{env=process.env,fetcher=fetch,clock=Date.now}={}){
  let policy;try{policy=recaptchaConfig(env);}catch{unavailable();}
  const action=['login','reset'].includes(purpose)?policy.actions[purpose]:null;
  if(!action||typeof token!=='string'||!token.length||token.length>8192||token.trim()!==token||/[\u0000-\u0020\u007f]/.test(token))denied();
  let data;
  try{
    const response=await fetcher('https://www.google.com/recaptcha/api/siteverify',{
      method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(8000),
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({secret:policy.secret,response:token})
    });
    if(!response.ok)unavailable();
    // Bound even an unexpected provider response; keep errors/payloads private.
    const reader=response.body.getReader();let size=0,chunks=[];
    try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>16384){await reader.cancel();unavailable();}chunks.push(Buffer.from(value));}}
    finally{reader.releaseLock();}
    data=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }catch{unavailable();}
  const timestamp=typeof data?.challenge_ts==='string'?Date.parse(data.challenge_ts):NaN,age=clock()-timestamp;
  if(data?.success!==true||data.action!==action||data.hostname!==policy.hostname||
    typeof data.score!=='number'||!Number.isFinite(data.score)||data.score<policy.minScore||data.score>1||
    !Number.isFinite(age)||age< -10000||age>120000||
    (data['error-codes']!==undefined&&(!Array.isArray(data['error-codes'])||data['error-codes'].length)))denied();
}
