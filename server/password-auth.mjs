import { randomInt } from 'node:crypto';
import { transaction } from './db.mjs';
import { config } from './config.mjs';
import { digest, secret, loadDomain, saveDomain } from './domain.mjs';
import { sessionFor, rateLimit } from './auth.mjs';
import { fail } from './errors.mjs';
import { assertPassword, hashPassword, verifyPassword, temporaryPassword, emailOtpHash, safeEqual } from './password-crypto.mjs';
import { mailOptions, sendSecurityEmail } from './mail.mjs';
const tokenPattern = /^session1_[A-Za-z0-9_-]{43}$/;
const challengePattern = /^password1_[A-Za-z0-9_-]{43}$/;
const normalizedEmail = value => typeof value === 'string' && value.trim().length<=254 ? value.trim().toLowerCase() : '';
const invalid = () => fail('LOGIN_INVALID', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง หรือบัญชีถูกล็อกชั่วคราว');
const rejection = result => { if (result?.error) fail(result.error, result.error === 'OTP_INVALID' ? 'รหัสยืนยันไม่ถูกต้อง' : 'คำขอหมดอายุหรือไม่ถูกต้อง กรุณาเริ่มใหม่'); return result; };

// Both methods resolve the SAME current Users record; credentials never grant a role.
export async function authorizedUser(db, token, restricted = false) {
  const session = await sessionFor(db, token, { allowRestricted: restricted });
  const domain = await loadDomain(db, { session });
  return { session, domain, user: domain.context.requireUser_(token) };
}
async function userForEmail(db, email) {
  email=normalizedEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !config().ALLOWED_DOMAINS.includes(email.split('@')[1])) return null;
  const result = await db.query('SELECT data FROM crs.users WHERE email=$1', [email]);
  const user = result.rows[0]?.data;
  return user?.status === 'ACTIVE' && ['USER','ADMIN'].includes(user.role) ? user : null;
}
const credentialFor = async (db,id) => (await db.query('SELECT * FROM crs.password_credentials WHERE user_id=$1',[id])).rows[0];
const generation = credential => Number(credential?.generation || 0);

export function passwordAuth({ transact = transaction, send = sendSecurityEmail, hash = hashPassword,
  verify = verifyPassword, mailReady = mailOptions, clock = () => Date.now() } = {}) {
  async function signIn(input, requestKey) {
    const email = normalizedEmail(input?.email), password = input?.password;
    if (typeof password !== 'string' || password.length > 512 || !/^[A-Za-z0-9_-]{43}$/.test(input?.sessionTokenHash || '')) invalid();
    const snapshot = await transact(async db => {
      const ipAllowed = await rateLimit(db,'password-ip:' + digest(requestKey),20,600);
      const accountAllowed = await rateLimit(db,'password-email:' + digest(email),10,900);
      if (!ipAllowed || !accountAllowed) return { limited:true };
      const user = await userForEmail(db,email);
      const credential = user && await credentialFor(db,user.user_id);
      return {user,credential};
    });
    if (snapshot.limited) invalid();
    const matches = await verify(password, snapshot.credential?.password_hash);
    const result = await transact(async db => {
      const user = await userForEmail(db,email), credential = user && await credentialFor(db,user.user_id);
      const valid = matches && credential && user?.user_id === snapshot.user?.user_id &&
        credential.email === email && credential.password_hash === snapshot.credential?.password_hash &&
        generation(credential) === generation(snapshot.credential) &&
        (!credential.locked_until || new Date(credential.locked_until).getTime() <= clock()) &&
        (!credential.temporary_expires_at || new Date(credential.temporary_expires_at).getTime() > clock());
      if (!valid) {
        if (credential && (!credential.locked_until || new Date(credential.locked_until).getTime() <= clock())) {
          // Reset a completed lock window; every wrong attempt commits, including the fifth.
          const attempts = credential.locked_until ? 1 : credential.failed_attempts + 1;
          await db.query('UPDATE crs.password_credentials SET failed_attempts=$2,locked_until=$3 WHERE user_id=$1',
            [user.user_id,attempts,attempts >= 5 ? new Date(clock()+900000).toISOString() : null]);
        }
        return {invalid:true};
      }
      const expiresAt = Math.floor(clock()/1000) + config().AUTH_SESSION_TTL_SECONDS;
      const session = { userId:user.user_id,email,subject:'local:' + user.user_id,
        clientId:config().GOOGLE_OAUTH_CLIENT_ID,method:'PASSWORD',credentialGeneration:generation(credential),expiresAt };
      await db.query('INSERT INTO crs.sessions(id,data,expires_at) VALUES($1,$2,to_timestamp($3))',[input.sessionTokenHash,JSON.stringify(session),expiresAt]);
      await db.query('UPDATE crs.password_credentials SET failed_attempts=0,locked_until=NULL WHERE user_id=$1',[user.user_id]);
      const domain = await loadDomain(db);
      domain.context.updateRecordById_('Users','user_id',user.user_id,{last_login_at:new Date(clock()).toISOString()});
      await saveDomain(db,domain);
      return {status:'COMPLETE',expiresAt,mustChangePassword:credential.must_change};
    });
    if (result.invalid) invalid();
    return result;
  }

  async function requestOtp(input, token, requestKey) {
    mailReady(); // Missing configuration fails closed; no insecure fallback or generated code response.
    emailOtpHash('preflight','000000');
    const purpose = input?.purpose === 'CHANGE' ? 'CHANGE' : 'RESET';
    const challenge = secret('password1_'), id = digest(challenge);
    const code = String(randomInt(1000000)).padStart(6,'0');
    const expiresAt = Math.floor(clock()/1000)+300;
    const result = await transact(async db => {
      const ipAllowed = await rateLimit(db,'email-ip:' + digest(requestKey),10,3600);
      const email = purpose === 'CHANGE' ? (await authorizedUser(db,token,true)).session.email : normalizedEmail(input?.email);
      const emailAllowed = await rateLimit(db,'email-subject:' + digest(email),5,3600);
      if (!ipAllowed || !emailAllowed) return { error:'RATE_LIMITED' };
      const previous = (await db.query('SELECT created_at FROM crs.password_challenges WHERE email=$1 ORDER BY created_at DESC LIMIT 1',[email])).rows[0];
      if (previous && clock() - new Date(previous.created_at).getTime() < 60000) return { error:'RESEND_COOLDOWN' };
      const user = await userForEmail(db,email), credential = user && await credentialFor(db,user.user_id);
      await db.query("UPDATE crs.password_challenges SET status='DENIED' WHERE email=$1 AND purpose=$2 AND status IN ('SENDING','READY','VERIFIED')",[email,purpose]);
      await db.query(`INSERT INTO crs.password_challenges(id,user_id,email,purpose,session_hash,credential_generation,otp_hash,status,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'SENDING',to_timestamp($8))`,
        [id,user?.user_id || null,email,purpose,purpose === 'CHANGE' ? digest(token) : null,generation(credential),emailOtpHash(id,code),expiresAt]);
      return { user, email };
    });
    if (result.error) fail(result.error,'กรุณารอก่อนขอรหัสใหม่');
    let delivered = false;
    if (result.user) {
      try { await send({to:result.email,kind:'OTP',code,id}); delivered = true; }
      catch { /* Do not expose recipient existence or SMTP transcript/errors. */ }
    }
    await transact(db => db.query('UPDATE crs.password_challenges SET status=$2 WHERE id=$1 AND status=\'SENDING\'', [id,delivered ? 'READY' : 'DENIED']));
    return { challenge, expiresAt, resendAfter:60, message:'หากบัญชีได้รับสิทธิ์ ระบบจะส่งรหัสยืนยันทางอีเมล' };
  }

  async function verifyOtp(input, token) {
    if (!challengePattern.test(input?.challenge || '')) fail('OTP_INVALID','รหัสยืนยันไม่ถูกต้อง');
    return rejection(await transact(async db => {
      const row = (await db.query('SELECT * FROM crs.password_challenges WHERE id=$1 FOR UPDATE',[digest(input.challenge)])).rows[0];
      if (!row || row.status !== 'READY' || new Date(row.expires_at).getTime() <= clock()) return {error:'OTP_EXPIRED'};
      if (row.purpose === 'CHANGE' && (!tokenPattern.test(token || '') || !safeEqual(row.session_hash,digest(token)))) return {error:'OTP_EXPIRED'};
      if (!/^\d{6}$/.test(input?.otp || '') || !safeEqual(row.otp_hash,emailOtpHash(row.id,input.otp))) {
        const attempts = row.attempts+1;
        await db.query('UPDATE crs.password_challenges SET attempts=$2,status=$3 WHERE id=$1',[row.id,attempts,attempts >= 5 ? 'DENIED' : 'READY']);
        return {error:attempts >= 5 ? 'OTP_EXPIRED' : 'OTP_INVALID'};
      }
      const user = await userForEmail(db,row.email), credential = user && await credentialFor(db,user.user_id);
      if (!user || user.user_id !== row.user_id || generation(credential) !== Number(row.credential_generation)) return {error:'OTP_EXPIRED'};
      if (row.purpose === 'CHANGE') await authorizedUser(db,token,true);
      await db.query("UPDATE crs.password_challenges SET status='VERIFIED',otp_hash='',verified_until=$2 WHERE id=$1",[row.id,new Date(clock()+300000).toISOString()]);
      return {verified:true,expiresAt:Math.floor(clock()/1000)+300};
    }));
  }

  async function changePassword(input, token, requestKey='local') {
    if (!challengePattern.test(input?.challenge || '') || input.password !== input.confirmPassword) fail('PASSWORD_POLICY','รหัสผ่านทั้งสองช่องต้องตรงกัน');
    const proof=rejection(await transact(async db=>{
      if(!await rateLimit(db,'password-change:'+digest(requestKey),10,600)) return {error:'RATE_LIMITED'};
      const row=(await db.query('SELECT * FROM crs.password_challenges WHERE id=$1',[digest(input.challenge)])).rows[0];
      if(!row || row.status!=='VERIFIED' || new Date(row.verified_until).getTime()<=clock()) return {error:'OTP_EXPIRED'};
      const user=await userForEmail(db,row.email),credential=user&&await credentialFor(db,user.user_id);
      if(!user||user.user_id!==row.user_id||generation(credential)!==Number(row.credential_generation))return {error:'OTP_EXPIRED'};
      if(row.purpose==='CHANGE') {
        if(!tokenPattern.test(token || '') || !safeEqual(row.session_hash,digest(token))) return {error:'OTP_EXPIRED'};
        await authorizedUser(db,token,true);
      }
      return {email:row.email};
    }));
    const nextHash = await hash(assertPassword(input.password,proof.email));
    const result = await transact(async db => {
      const row = (await db.query('SELECT * FROM crs.password_challenges WHERE id=$1 FOR UPDATE',[digest(input.challenge)])).rows[0];
      if (!row || row.status !== 'VERIFIED' || new Date(row.verified_until).getTime() <= clock()) return {error:'OTP_EXPIRED'};
      const user = await userForEmail(db,row.email), credential = user && await credentialFor(db,user.user_id);
      if (!user || user.user_id !== row.user_id || generation(credential) !== Number(row.credential_generation)) return {error:'OTP_EXPIRED'};
      assertPassword(input.password,row.email);
      if (row.purpose === 'CHANGE') {
        if (!tokenPattern.test(token || '') || !safeEqual(row.session_hash,digest(token))) return {error:'OTP_EXPIRED'};
        await authorizedUser(db,token,true);
      }
      await db.query(`INSERT INTO crs.password_credentials(user_id,email,password_hash,generation) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,generation=excluded.generation,
          must_change=false,temporary_expires_at=NULL,failed_attempts=0,locked_until=NULL,updated_at=now()`,[user.user_id,row.email,nextHash,generation(credential)+1]);
      await invalidate(db,user.user_id);
      await securityHistory(db,user,'CHANGE_PASSWORD',mailSafeId(row.id));
      const mailId = digest('changed:' + row.id);
      await db.query("INSERT INTO crs.security_mail(id,user_id,email,kind,status) VALUES($1,$2,$3,'PASSWORD_CHANGED','PENDING') ON CONFLICT DO NOTHING",[mailId,user.user_id,row.email]);
      return {changed:true,signedOut:true,mailId};
    });
    rejection(result);
    // Mail is post-commit: a notification transport/bookkeeping outage must not
    // turn a completed password change into a failed/retryable credential write.
    try { await deliverNotification(result.mailId); } catch { /* Metadata remains pending/uncertain; never log a payload. */ }
    return {changed:true,signedOut:true};
  }

  async function issueTemporary(input, token) {
    mailReady();
    emailOtpHash('preflight','000000'); // The recipient must be able to complete the forced change.
    if (!/^USR-\d{6}$/.test(input?.userId || '') || !/^[A-Za-z0-9_-]{8,100}$/.test(input?.commandId || '')) fail('VALIDATION_FAILED');
    const id = digest('temporary:' + input.commandId);
    const prepared = await transact(async db => {
      const actor = await authorizedUser(db,token); actor.domain.context.requireAdmin_(token);
      if (!await rateLimit(db,'temporary:' + actor.user.user_id,10,3600)) return {error:'RATE_LIMITED'};
      const existing = (await db.query('SELECT * FROM crs.security_mail WHERE id=$1',[id])).rows[0];
      if (existing) {
        if (existing.user_id !== input.userId || existing.kind !== 'TEMPORARY_PASSWORD') fail('STATE_CONFLICT');
        return {repeat:true,deliveryStatus:existing.status};
      }
      const target = actor.domain.records.Users.find(user => user.user_id === input.userId);
      const user = target && await userForEmail(db,target.email);
      if (!user || user.user_id !== input.userId) fail('FORBIDDEN','บัญชีเป้าหมายไม่ได้รับสิทธิ์');
      if (!await rateLimit(db,'temporary-target:' + user.user_id,3,3600)) return {error:'RATE_LIMITED'};
      const credential = await credentialFor(db,user.user_id);
      const email=normalizedEmail(user.email);
      await db.query("INSERT INTO crs.security_mail(id,user_id,email,kind,status) VALUES($1,$2,$3,'TEMPORARY_PASSWORD','SENDING')",[id,user.user_id,email]);
      return {email,generation:generation(credential)};
    });
    rejection(prepared);
    if (prepared.repeat) return {deliveryStatus:prepared.deliveryStatus};
    const temporary=temporaryPassword(),passwordHash=await hash(temporary);
    try { await send({to:prepared.email,kind:'TEMPORARY_PASSWORD',temporary,id}); }
    catch {
      await transact(db => db.query("UPDATE crs.security_mail SET status='UNCERTAIN' WHERE id=$1",[id]));
      fail('EMAIL_UNAVAILABLE','ไม่สามารถยืนยันการส่งรหัสได้ รหัสเดิมยังไม่เปลี่ยน');
    }
    return transact(async db => {
      const actor = await authorizedUser(db,token); actor.domain.context.requireAdmin_(token);
      const user = await userForEmail(db,prepared.email), credential = user && await credentialFor(db,user.user_id);
      if (user?.user_id !== input.userId || generation(credential) !== prepared.generation) {
        await db.query("UPDATE crs.security_mail SET status='DENIED' WHERE id=$1",[id]);
        return {deliveryStatus:'DENIED',activated:false};
      }
      await db.query(`INSERT INTO crs.password_credentials(user_id,email,password_hash,generation,must_change,temporary_expires_at)
        VALUES($1,$2,$3,$4,true,$5) ON CONFLICT(user_id) DO UPDATE SET email=excluded.email,password_hash=excluded.password_hash,
        generation=excluded.generation,must_change=true,temporary_expires_at=excluded.temporary_expires_at,failed_attempts=0,locked_until=NULL,updated_at=now()`,
        [user.user_id,prepared.email,passwordHash,prepared.generation+1,new Date(clock()+86400000).toISOString()]);
      await invalidate(db,user.user_id);
      await securityHistory(db,actor.user,'ISSUE_TEMPORARY_PASSWORD','security:'+id,user.user_id);
      await db.query("UPDATE crs.security_mail SET status='SENT',sent_at=now() WHERE id=$1",[id]);
      return {deliveryStatus:'SENT',activated:true,mustChangePassword:true,signedOut:actor.user.user_id===user.user_id};
    });
  }

  async function deliverNotification(id) {
    const row = await transact(async db => {
      const found = (await db.query("SELECT * FROM crs.security_mail WHERE id=$1 AND status='PENDING' FOR UPDATE",[id])).rows[0];
      if (!found) return null;
      await db.query("UPDATE crs.security_mail SET status='SENDING' WHERE id=$1",[id]); return found;
    });
    if (!row) return;
    let status = 'UNCERTAIN';
    try { await send({to:row.email,kind:'PASSWORD_CHANGED',id:row.id}); status = 'SENT'; } catch { /* Pending/uncertain metadata is retained, never a secret body. */ }
    await transact(db => db.query('UPDATE crs.security_mail SET status=$2,sent_at=CASE WHEN $2=\'SENT\' THEN now() ELSE NULL END WHERE id=$1',[id,status]));
  }
  return {signIn,requestOtp,verifyOtp,changePassword,issueTemporary};
}
async function invalidate(db,userId) {
  await db.query("DELETE FROM crs.sessions WHERE data->>'userId'=$1",[userId]);
  await db.query("UPDATE crs.auth_flows SET status='DENIED',data='{}' WHERE data->'candidate'->>'userId'=$1 AND status='AWAITING_CONFIRMATION'",[userId]);
  await db.query("UPDATE crs.password_challenges SET status='CONSUMED',otp_hash='' WHERE user_id=$1 AND status IN ('READY','VERIFIED','SENDING')",[userId]);
}
const mailSafeId=id=>'security:'+digest('changed:'+id);
async function securityHistory(db,actor,action,operationId,target=actor.user_id){
  const domain=await loadDomain(db);
  domain.context.appendHistoryLocked_({entityType:'USER',entityId:target,action,operationId,
    note:'Credential changed; prior sessions revoked. No password or OTP retained.'},actor);
  await saveDomain(db,domain);
}
