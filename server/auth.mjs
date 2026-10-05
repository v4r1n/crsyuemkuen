import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { transaction } from './db.mjs';
import { config } from './config.mjs';
import { digest, secret, loadDomain, saveDomain } from './domain.mjs';
import { fail } from './errors.mjs';
import { createAuthDiagnostics } from './auth-diagnostics.mjs';
const googleKeys = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));
const now = () => Math.floor(Date.now()/1000);
const equal = (left,right) => typeof left==='string' && typeof right==='string' && Buffer.byteLength(left)===Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left),Buffer.from(right));
const tokenPattern = /^session1_[A-Za-z0-9_-]{43}$/;
export function otpDigest(flowHash,otp) {
  const key=process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if(!key) fail('CONFIG_ERROR','กรุณาตั้งค่า Google OAuth ฝั่ง server');
  return createHmac('sha256',key).update('crs:otp:v1|'+flowHash+'|'+otp).digest('base64url');
}
const rejectAuth = () => fail('UNAUTHENTICATED','คำขอลงชื่อเข้าใช้หมดอายุหรือไม่ถูกต้อง กรุณาเริ่มใหม่');

export function assertGoogleClaims(claims, expected, current=now()) {
  const email=String(claims.email||'').trim().toLowerCase();
  const domain=email.split('@')[1];
  const audiences=Array.isArray(claims.aud)?claims.aud:[claims.aud];
  if (!['accounts.google.com','https://accounts.google.com'].includes(claims.iss) ||
    !audiences.includes(expected.clientId) || (claims.azp && claims.azp!==expected.clientId) ||
    (audiences.length>1 && claims.azp!==expected.clientId) ||
    !Number.isInteger(claims.exp) || claims.exp<=current || !Number.isInteger(claims.iat) ||
    claims.iat>current+60 || (claims.nbf && claims.nbf>current) ||
    !equal(claims.nonce,expected.nonce) || !claims.sub || String(claims.sub).length>255 ||
    claims.email_verified!==true || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !expected.domains.includes(domain) || (domain!=='gmail.com' && claims.hd!==domain)) rejectAuth();
  return {email,subject:claims.sub};
}
export async function sessionFor(client,token) {
  if (!tokenPattern.test(String(token||''))) rejectAuth();
  const found=await client.query('SELECT data FROM crs.sessions WHERE id=$1 AND expires_at > now()',[digest(token)]);
  const session=found.rows[0]?.data, cfg=config();
  if (!session || session.expiresAt<=now() || session.clientId!==cfg.GOOGLE_OAUTH_CLIENT_ID ||
    !cfg.ALLOWED_DOMAINS.includes(session.email?.split('@')[1])) rejectAuth();
  return session;
}
async function rateLimit(client,key,limit,ttl) {
  const result=await client.query(`INSERT INTO crs.rate_limits(id,count,expires_at) VALUES($1,1,now()+$2 * interval '1 second')
    ON CONFLICT(id) DO UPDATE SET count=CASE WHEN crs.rate_limits.expires_at<=now() THEN 1 ELSE crs.rate_limits.count+1 END,
      expires_at=CASE WHEN crs.rate_limits.expires_at<=now() THEN excluded.expires_at ELSE crs.rate_limits.expires_at END RETURNING count`,[key,ttl]);
  if(result.rows[0].count>limit) return false;
  return true;
}
export async function beginSignIn(input,requestKey) {
  const cfg=config();
  if(!cfg.GOOGLE_OAUTH_CLIENT_ID || !process.env.GOOGLE_OAUTH_CLIENT_SECRET || !cfg.ALLOWED_DOMAINS.length) fail('CONFIG_ERROR','กรุณาตั้งค่า Google OAuth และโดเมนที่อนุญาต');
  const callback=new URL(process.env.GOOGLE_OAUTH_REDIRECT_URI||'');
  if(callback.origin!==cfg.WEB_APP_URL || callback.pathname!=='/auth/callback' || callback.search || callback.hash) fail('CONFIG_ERROR','OAuth callback ต้องตรงกับ WEB_APP_URL/auth/callback');
  if(!/^[A-Za-z0-9_-]{43}$/.test(input?.pollTokenHash||'') || !/^[A-Za-z0-9_-]{43}$/.test(input?.sessionTokenHash||'') || input.pollTokenHash===input.sessionTokenHash) fail('VALIDATION_FAILED','ข้อมูลเริ่มต้นการลงชื่อเข้าใช้ไม่ถูกต้อง');
  const flowId=secret('flow1_'),state=secret('callback1_'),nonce=secret('nonce1_'),verifier=secret('pkce1_');
  const expiresAt=now()+cfg.AUTH_FLOW_TTL_SECONDS;
  const limited=await transaction(async client=>{
    if(!await rateLimit(client,'signin:'+digest(requestKey),20,600)) return true;
    await client.query('DELETE FROM crs.auth_flows WHERE expires_at < now()');
    await client.query('DELETE FROM crs.sessions WHERE expires_at < now()');
    await client.query('DELETE FROM crs.proofs WHERE expires_at < now()');
    await client.query('DELETE FROM crs.rate_limits WHERE expires_at < now()');
    await client.query('DELETE FROM crs.auth_flows WHERE session_hash=$1',[input.sessionTokenHash]);
    await client.query(`INSERT INTO crs.auth_flows(id,state_hash,poll_hash,session_hash,status,data,expires_at)
      VALUES($1,$2,$3,$4,'PENDING',$5,to_timestamp($6))`,[digest(flowId),digest(state),input.pollTokenHash,input.sessionTokenHash,
      JSON.stringify({nonce,verifier,clientId:cfg.GOOGLE_OAUTH_CLIENT_ID,redirectUri:callback.toString(),expiresAt}),expiresAt]);
    return false;
  });
  if(limited) fail('RATE_LIMITED','ลงชื่อเข้าใช้บ่อยเกินไป กรุณารอสักครู่',true);
  const authorization=new URL('https://accounts.google.com/o/oauth2/v2/auth');
  for(const [key,value] of Object.entries({client_id:cfg.GOOGLE_OAUTH_CLIENT_ID,redirect_uri:callback.toString(),response_type:'code',scope:'openid email profile',state,nonce,code_challenge:digest(verifier),code_challenge_method:'S256',prompt:'select_account'})) authorization.searchParams.set(key,value);
  return {flowId,authorizationUrl:authorization.toString(),expiresAt};
}
export async function oauthCallback(parameters,diagnostic=createAuthDiagnostics()) {
  let claim;
  try {
    diagnostic.stage('CALLBACK_INPUT');
    if(['state','code','error'].some(key=>parameters.getAll(key).length>1)) rejectAuth();
    const state=parameters.get('state');
    if(!/^callback1_[A-Za-z0-9_-]{43}$/.test(state||'')) rejectAuth();
    diagnostic.stage('FLOW_CLAIM');
    claim=await transaction(async client=>{
      const result=await client.query('SELECT * FROM crs.auth_flows WHERE state_hash=$1 AND expires_at>now() FOR UPDATE',[digest(state)]);
      const flow=result.rows[0];
      if(!flow || flow.status!=='PENDING') rejectAuth();
      await client.query("UPDATE crs.auth_flows SET status='PROCESSING' WHERE id=$1",[flow.id]);
      return flow;
    });
    diagnostic.stage('PROVIDER_CALLBACK');
    if(parameters.has('error') || !parameters.get('code')) rejectAuth();
    diagnostic.stage('CONFIGURATION');
    const cfg=config();
    if(claim.data.clientId!==cfg.GOOGLE_OAUTH_CLIENT_ID) rejectAuth();
    diagnostic.stage('TOKEN_EXCHANGE');
    const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',signal:AbortSignal.timeout(15000),
      headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:parameters.get('code'),client_id:claim.data.clientId,
        client_secret:process.env.GOOGLE_OAUTH_CLIENT_SECRET,redirect_uri:claim.data.redirectUri,grant_type:'authorization_code',code_verifier:claim.data.verifier})});
    if(!response.ok) {
      // Read only a standard provider error code; never log body/description.
      let providerError;
      try {providerError=(await response.json()).error;} catch { /* Non-JSON response. */ }
      diagnostic.providerResponse(response.status,providerError);
      rejectAuth();
    }
    const tokens=await response.json();
    diagnostic.stage('TOKEN_VERIFICATION');
    const verified=await jwtVerify(tokens.id_token,googleKeys,{algorithms:['RS256'],issuer:['https://accounts.google.com','accounts.google.com'],audience:cfg.GOOGLE_OAUTH_CLIENT_ID});
    diagnostic.stage('IDENTITY_CLAIMS');
    const identity=assertGoogleClaims(verified.payload,{clientId:cfg.GOOGLE_OAUTH_CLIENT_ID,nonce:claim.data.nonce,domains:cfg.ALLOWED_DOMAINS});
    const otp=String(randomInt(1000000)).padStart(6,'0'),copyToken=secret('copy1_');
    diagnostic.stage('FLOW_RECHECK');
    await transaction(async client=>{
      const latest=(await client.query('SELECT * FROM crs.auth_flows WHERE id=$1 AND expires_at>now() FOR UPDATE',[claim.id])).rows[0];
      if(!latest || latest.status!=='PROCESSING') rejectAuth();
      diagnostic.stage('USERS_LOAD');
      const domain=await loadDomain(client);
      diagnostic.stage('USER_AUTHORIZATION');
      const user=domain.context.requireUserForIdentity_(identity);
      diagnostic.stage('OTP_COMMIT');
      const data={ clientId:claim.data.clientId,expiresAt:claim.data.expiresAt,
        candidate:{subject:identity.subject,email:identity.email,userId:user.user_id,clientId:claim.data.clientId,expiresAt:now()+cfg.AUTH_SESSION_TTL_SECONDS},
        otpHash:otpDigest(claim.id,otp),otpExpiresAt:Math.min(claim.data.expiresAt,now()+300),attempts:0,copyHash:digest(copyToken) };
      await client.query("UPDATE crs.auth_flows SET status='AWAITING_CONFIRMATION',data=$2 WHERE id=$1",[claim.id,JSON.stringify(data)]);
    });
    return {otp,copyToken,flowHash:claim.id};
  } catch(error) {
    diagnostic.failed(error);
    if(claim) {
      try {
        await transaction(client=>client.query("UPDATE crs.auth_flows SET status='DENIED',data=$2 WHERE id=$1 AND status='PROCESSING'",[claim.id,JSON.stringify({expiresAt:claim.data.expiresAt})]));
      } catch(denialError) {
        diagnostic.stage('FLOW_DENIAL');diagnostic.failed(denialError);throw denialError;
      }
    }
    throw error;
  }
}
export async function completeSignIn(flowId,pollToken,otp,token) {
  if(!/^flow1_[A-Za-z0-9_-]{43}$/.test(flowId||'') || !/^poll1_[A-Za-z0-9_-]{43}$/.test(pollToken||'')) rejectAuth();
  const result=await transaction(client=>completeInTransaction(client,flowId,pollToken,otp,token));
  if(result.error) fail(result.error,result.error==='OTP_INVALID'?'รหัสยืนยันไม่ถูกต้อง กรุณาลองอีกครั้ง':'คำขอลงชื่อเข้าใช้หมดอายุ กรุณาเริ่มใหม่');
  return result;
}
export async function completeInTransaction(client,flowId,pollToken,otp,token) {
    const found=await client.query('SELECT * FROM crs.auth_flows WHERE id=$1 AND expires_at>now() FOR UPDATE',[digest(flowId)]);
    const flow=found.rows[0];
    if(!flow || !equal(flow.poll_hash,digest(pollToken))) rejectAuth();
    if(['PENDING','PROCESSING'].includes(flow.status)) return {status:'PENDING',expiresAt:flow.data.expiresAt};
    if(flow.status!=='AWAITING_CONFIRMATION') rejectAuth();
    const data=flow.data;
    if(data.otpExpiresAt<=now()) {
      await client.query("UPDATE crs.auth_flows SET status='CONSUMED',data='{}' WHERE id=$1",[flow.id]);
      return {error:'UNAUTHENTICATED'};
    }
    if(!otp) return {status:'AWAITING_CONFIRMATION',expiresAt:data.otpExpiresAt,closePopup:Boolean(data.copyAcknowledged)};
    if(!tokenPattern.test(token||'') || !equal(digest(token),flow.session_hash)) rejectAuth();
    if(!/^\d{6}$/.test(otp) || !equal(otpDigest(flow.id,otp),data.otpHash)) {
      data.attempts++;
      await client.query('UPDATE crs.auth_flows SET status=$2,data=$3 WHERE id=$1',[flow.id,data.attempts>=5?'CONSUMED':flow.status,JSON.stringify(data.attempts>=5?{}:data)]);
      return {error:data.attempts>=5?'UNAUTHENTICATED':'OTP_INVALID'};
    }
    const domain=await loadDomain(client);
    const user=domain.context.requireUserForIdentity_(data.candidate),cfg=config();
    if(user.user_id!==data.candidate.userId || data.candidate.expiresAt<=now() ||
       data.clientId!==cfg.GOOGLE_OAUTH_CLIENT_ID || !cfg.ALLOWED_DOMAINS.includes(data.candidate.email.split('@')[1])) rejectAuth();
    await client.query("UPDATE crs.auth_flows SET status='CONSUMED',data='{}' WHERE id=$1",[flow.id]);
    await client.query('INSERT INTO crs.sessions(id,data,expires_at) VALUES($1,$2,to_timestamp($3))',[flow.session_hash,JSON.stringify(data.candidate),data.candidate.expiresAt]);
    domain.context.updateRecordById_('Users','user_id',user.user_id,{last_login_at:new Date().toISOString()});
    await saveDomain(client,domain);
    return {status:'COMPLETE',expiresAt:data.candidate.expiresAt};
}
export async function acknowledgeCopy(flowHash,copyToken) {
  await transaction(async client=>{
    const flow=(await client.query('SELECT * FROM crs.auth_flows WHERE id=$1 AND expires_at>now() FOR UPDATE',[flowHash])).rows[0];
    if(!flow || flow.status!=='AWAITING_CONFIRMATION' || !equal(flow.data.copyHash,digest(copyToken||''))) rejectAuth();
    flow.data.copyAcknowledged=true; delete flow.data.copyHash;
    await client.query('UPDATE crs.auth_flows SET data=$2 WHERE id=$1',[flow.id,JSON.stringify(flow.data)]);
  });
  return {copied:true};
}
export async function logout(token) {
  if(tokenPattern.test(token||'')) await transaction(client=>client.query('DELETE FROM crs.sessions WHERE id=$1',[digest(token)]));
  return {signedOut:true};
}
