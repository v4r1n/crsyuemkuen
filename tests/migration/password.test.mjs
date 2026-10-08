import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { passwordAuth } from '../../server/password-auth.mjs';
import { hashPassword,verifyPassword,validPassword } from '../../server/password-crypto.mjs';
import { digest,secret } from '../../server/domain.mjs';
import { sessionFor } from '../../server/auth.mjs';
import { mailOptions,sendSecurityEmail } from '../../server/mail.mjs';
import {verifyRecaptcha} from '../../server/recaptcha.mjs';
process.env.GOOGLE_OAUTH_CLIENT_ID='password-fixture.apps.googleusercontent.com';
process.env.ALLOWED_DOMAINS='example.test';
process.env.PASSWORD_OTP_SECRET='fixture-only-not-a-deployed-secret-0123456789';
const password='Correct horse battery staple!';
const sql=readFileSync(new URL('../../supabase/migrations/202610050001_crs.sql',import.meta.url),'utf8')+readFileSync(new URL('../../supabase/migrations/202610070002_identity_experience.sql',import.meta.url),'utf8');
async function fixture(){
  const db=new PGlite();await db.exec(sql);
  await db.query('INSERT INTO crs.sequences(data) VALUES($1)',[JSON.stringify({sequence_name:'LOG',prefix:'LOG-',padding:6,next_value:1,updated_at:new Date().toISOString()})]);
  for(const [id,email,role] of [['USR-000001','admin@example.test','ADMIN'],['USR-000002','user@example.test','USER']])
    await db.query('INSERT INTO crs.users(data) VALUES($1)',[JSON.stringify({user_id:id,email,name:id,role,status:'ACTIVE',row_version:1})]);
  const token=secret('session1_');
  await db.query('INSERT INTO crs.sessions(id,data,expires_at) VALUES($1,$2,now()+interval \'1 hour\')',[digest(token),JSON.stringify({userId:'USR-000001',email:'admin@example.test',clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+3600})]);
  const mails=[];
  const transact=async work=>{await db.exec('BEGIN');try{const result=await work(db);await db.exec('COMMIT');return result;}catch(error){await db.exec('ROLLBACK');throw error;}};
  const deps={transact,mailReady:()=>{},send:async value=>mails.push(value),checkAbuse:async()=>{}};
  const auth=passwordAuth(deps);
  const add=async(id='USR-000002',email='user@example.test',extra={})=>{
    await db.query('INSERT INTO crs.password_credentials(user_id,email,password_hash,must_change) VALUES($1,$2,$3,$4)',[id,email,await hashPassword(password),extra.mustChange||false]);
  };
  return {db,auth,token,mails,add,deps};
}

test('abuse rejection commits existing quotas before proof, never hashes password or creates OTP/mail/session',async()=>{
  const f=await fixture();try{
    let verifications=0,proofs=0;const rejected=passwordAuth({...f.deps,verify:async()=>{verifications++;return true;},checkAbuse:async()=>{proofs++;const error=Error('Safe synthetic rejection');error.code='RECAPTCHA_FAILED';throw error;}});
    const input={email:'user@example.test',password,sessionTokenHash:digest(secret('session1_')),recaptchaToken:'fixture-proof'};
    for(let i=0;i<12;i++)await assert.rejects(rejected.signIn(input,'proof-rejection-ip'));
    assert.equal(proofs,10);assert.equal(verifications,0);
    assert.equal((await f.db.query("SELECT count FROM crs.rate_limits WHERE id LIKE 'password-email:%'")).rows[0].count,12);
    await assert.rejects(rejected.requestOtp({purpose:'RESET',email:'user@example.test',recaptchaToken:'fixture-proof'},'','proof-reset-ip'),e=>e.code==='RECAPTCHA_FAILED');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.password_challenges')).rows[0].n,0);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.sessions')).rows[0].n,1);
    assert.equal(f.mails.length,0);
  }finally{await f.db.close();}
});

test('verified reCAPTCHA reaches unchanged lockout rules; RESET is protected while session-bound CHANGE needs no new provider proof',async()=>{
  const f=await fixture();try{
    await f.add();const purposes=[];
    const env={WEB_APP_URL:'https://example.test',RECAPTCHA_SITE_KEY:'fixture-site-key-not-live-000000',RECAPTCHA_SECRET_KEY:'fixture-secret-not-live-000000'};
    const auth=passwordAuth({...f.deps,checkAbuse:async(token,purpose)=>{purposes.push(purpose);return verifyRecaptcha(token,purpose,{env,fetcher:async()=>Response.json({success:true,action:purpose==='login'?'password_login':'password_reset',hostname:'example.test',score:.9,challenge_ts:new Date().toISOString()})});}});
    const input={email:'user@example.test',password:'wrong',sessionTokenHash:digest(secret('session1_')),recaptchaToken:'fixture-proof'};
    for(let i=0;i<5;i++)await assert.rejects(auth.signIn(input,'verified-proof-ip'),e=>e.code==='LOGIN_INVALID');
    await assert.rejects(auth.signIn({...input,password},'verified-proof-ip'),e=>e.code==='LOGIN_INVALID');
    assert.equal((await f.db.query('SELECT failed_attempts FROM crs.password_credentials')).rows[0].failed_attempts,5);
    await auth.requestOtp({purpose:'RESET',email:'user@example.test',recaptchaToken:'fixture-reset-proof'},'','verified-reset-ip');
    await auth.requestOtp({purpose:'CHANGE'},f.token,'authorized-change-ip');
    assert.deepEqual(purposes,['login','login','login','login','login','login','reset']);assert.equal(f.mails.length,2);
    const rows=JSON.stringify((await f.db.query('SELECT * FROM crs.password_challenges')).rows);
    assert.equal(rows.includes('fixture-reset-proof'),false);assert.equal(rows.includes('recaptcha'),false);
  }finally{await f.db.close();}
});
test('scrypt salts are unique, encoded costs are bounded, and policy allows Unicode passphrases',async()=>{
  const first=await hashPassword(password),second=await hashPassword(password);
  assert.notEqual(first,second);assert.match(first,/^scrypt\$131072\$8\$1\$/);
  assert.equal(await verifyPassword(password,first),true);assert.equal(await verifyPassword('wrong',first),false);
  assert.equal(await verifyPassword(password,'scrypt$999999999$8$1$bad$bad'),false);
  assert.equal(validPassword('passwordpassword'),false);assert.equal(validPassword('123456789012345'),false);
  assert.equal(validPassword('นี่คือรหัสผ่านที่ยาวและใช้ได้ 2026'),true);
});
test('local login activates same existing User, never provisions, and rechecks current email/status/generation',async()=>{
  const f=await fixture();try{
    await f.add();const token=secret('session1_');const result=await f.auth.signIn({email:' USER@example.test ',password,sessionTokenHash:digest(token)},'fixture-ip');
    assert.equal(result.status,'COMPLETE');const session=await sessionFor(f.db,token);assert.equal(session.userId,'USR-000002');assert.equal(session.method,'PASSWORD');
    assert.ok(result.expiresAt-Math.floor(Date.now()/1000)<=21600);
    await assert.rejects(f.auth.signIn({email:'unknown@example.test',password,sessionTokenHash:digest(secret('session1_'))},'fixture-ip'),e=>e.code==='LOGIN_INVALID');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.users')).rows[0].n,2);
    await f.db.query('UPDATE crs.password_credentials SET generation=generation+1');await assert.rejects(sessionFor(f.db,token));
    await f.db.query("UPDATE crs.users SET data=jsonb_set(data,'{status}','\"INACTIVE\"') WHERE id='USR-000002'");
    await assert.rejects(f.auth.signIn({email:'user@example.test',password,sessionTokenHash:digest(secret('session1_'))},'fixture-ip'),e=>e.code==='LOGIN_INVALID');
  }finally{await f.db.close();}
});
test('five bad passwords commit lockout, good password cannot bypass it, and IP/email limits persist',async()=>{
  const f=await fixture();try{
    await f.add();for(let i=0;i<5;i++)await assert.rejects(f.auth.signIn({email:'user@example.test',password:'bad',sessionTokenHash:digest(secret('session1_'))},'fixture-ip'));
    const row=(await f.db.query('SELECT * FROM crs.password_credentials')).rows[0];assert.equal(row.failed_attempts,5);assert.ok(row.locked_until);
    await assert.rejects(f.auth.signIn({email:'user@example.test',password,sessionTokenHash:digest(secret('session1_'))},'another-ip'));
    assert.equal((await f.db.query("SELECT count FROM crs.rate_limits WHERE id LIKE 'password-email:%'")).rows[0].count,6);
  }finally{await f.db.close();}
});
test('email OTP change needs original session, commits attempt limit, enforces expiry and is consumed once',async()=>{
  const f=await fixture();try{
    const change=await f.auth.requestOtp({purpose:'CHANGE'},f.token,'fixture-ip');
    assert.equal(f.mails.length,1);assert.equal(JSON.stringify(change).includes(f.mails[0].code),false);
    await assert.rejects(f.auth.verifyOtp({challenge:change.challenge,otp:f.mails[0].code},secret('session1_')));
    for(let i=0;i<5;i++)await assert.rejects(f.auth.verifyOtp({challenge:change.challenge,otp:'not-six'},f.token));
    assert.equal((await f.db.query('SELECT attempts,status FROM crs.password_challenges')).rows[0].attempts,5);
    await assert.rejects(f.auth.verifyOtp({challenge:change.challenge,otp:f.mails[0].code},f.token));
    await assert.rejects(f.auth.requestOtp({purpose:'CHANGE'},f.token,'fixture-ip'),e=>e.code==='RESEND_COOLDOWN');
  }finally{await f.db.close();}
});
test('verified reset changes only existing credential, rejects mismatch/replay and revokes Google/password sessions',async()=>{
  const f=await fixture();try{
    const reset=await f.auth.requestOtp({email:'admin@example.test'},'','fixture-ip');
    await f.auth.verifyOtp({challenge:reset.challenge,otp:f.mails[0].code},'');
    await assert.rejects(f.auth.changePassword({challenge:reset.challenge,password,confirmPassword:'wrong'},''));
    await f.auth.changePassword({challenge:reset.challenge,password,confirmPassword:password},'');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.sessions')).rows[0].n,0);
    assert.equal((await f.db.query('SELECT status FROM crs.password_challenges')).rows[0].status,'CONSUMED');
    assert.equal(f.mails[1].kind,'PASSWORD_CHANGED');assert.equal(f.mails[1].code,undefined);
    assert.equal((await f.db.query("SELECT data->>'action' AS action FROM crs.history")).rows[0].action,'CHANGE_PASSWORD');
    await assert.rejects(f.auth.changePassword({challenge:reset.challenge,password,confirmPassword:password},''));
    const serialized=JSON.stringify((await f.db.query('SELECT * FROM crs.password_credentials')).rows)+JSON.stringify((await f.db.query('SELECT * FROM crs.password_challenges')).rows)+JSON.stringify((await f.db.query('SELECT * FROM crs.security_mail')).rows);
    assert.equal(serialized.includes(password),false);assert.equal(serialized.includes(f.mails[0].code),false);
  }finally{await f.db.close();}
});
test('unknown reset response is generic, emits no mail, and cannot create credentials',async()=>{
  const f=await fixture();try{
    const reset=await f.auth.requestOtp({email:'unknown@example.test'},'','fixture-ip');assert.ok(reset.challenge);assert.equal(f.mails.length,0);
    await assert.rejects(f.auth.verifyOtp({challenge:reset.challenge,otp:'123456'},''));
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.password_credentials')).rows[0].n,0);
  }finally{await f.db.close();}
});
test('temporary issuance is Admin-only and command-idempotent; restricted session cannot execute business reads',async()=>{
  const f=await fixture();try{
    const input={userId:'USR-000002',commandId:'temporary-fixture-command'};
    const issued=await f.auth.issueTemporary(input,f.token);assert.equal(issued.activated,true);assert.equal(f.mails.length,1);
    assert.equal((await f.auth.issueTemporary(input,f.token)).deliveryStatus,'SENT');assert.equal(f.mails.length,1);
    assert.equal((await f.db.query("SELECT data->>'action' AS action FROM crs.history")).rows[0].action,'ISSUE_TEMPORARY_PASSWORD');
    const token=secret('session1_');await f.auth.signIn({email:'user@example.test',password:f.mails[0].temporary,sessionTokenHash:digest(token)},'fixture-ip');
    await assert.rejects(sessionFor(f.db,token),e=>e.code==='PASSWORD_CHANGE_REQUIRED');
    assert.equal((await sessionFor(f.db,token,{allowRestricted:true})).mustChangePassword,true);
    await assert.rejects(f.auth.issueTemporary({userId:'USR-000001',commandId:'non-admin-temporary-command'},token));
    assert.equal(JSON.stringify((await f.db.query('SELECT * FROM crs.password_credentials')).rows).includes(f.mails[0].temporary),false);
  }finally{await f.db.close();}
});
test('SMTP failure never activates temporary password or bypasses TLS; resend replay never duplicates secret mail',async()=>{
  const f=await fixture();try{
    await f.add();const previous=(await f.db.query('SELECT password_hash FROM crs.password_credentials')).rows[0].password_hash;
    const broken=passwordAuth({...f.deps,send:async()=>{throw new Error('fixture smtp error');}});
    const input={userId:'USR-000002',commandId:'smtp-failed-command'};
    await assert.rejects(broken.issueTemporary(input,f.token));
    assert.equal((await broken.issueTemporary(input,f.token)).deliveryStatus,'UNCERTAIN');
    assert.equal((await f.db.query('SELECT password_hash FROM crs.password_credentials')).rows[0].password_hash,previous);
    assert.throws(()=>mailOptions({}),e=>e.code==='EMAIL_UNAVAILABLE');
    const options=mailOptions({SMTP_HOST:'smtp.example.test',SMTP_PORT:'587',SMTP_USER:'fixture',SMTP_PASSWORD:'fixture',SMTP_FROM:'sender@example.test'});
    assert.equal(options.requireTLS,true);assert.equal(options.tls.rejectUnauthorized,true);assert.equal(options.logger,false);
    const sent=[];await sendSecurityEmail({to:'user@example.test',kind:'OTP',code:'123456',id:'fixture-mail-id'},{sendMail:async mail=>{sent.push(mail);return {accepted:['user@example.test']};}});
    assert.equal(sent[0].attachments,undefined);assert.equal(sent[0].disableUrlAccess,true);
  }finally{await f.db.close();}
});

test('OTP expiry and credential generation changes deny a reset without hashing an unverified proof',async()=>{
  const f=await fixture();try{
    let hashes=0;const auth=passwordAuth({...f.deps,hash:async value=>{hashes++;return hashPassword(value);}});
    await assert.rejects(auth.changePassword({challenge:secret('password1_'),password,confirmPassword:password},''));assert.equal(hashes,0);
    const reset=await auth.requestOtp({email:'user@example.test'},'','expiry-fixture');
    await f.db.query("UPDATE crs.password_challenges SET expires_at=now()-interval '1 second'");
    await assert.rejects(auth.verifyOtp({challenge:reset.challenge,otp:f.mails[0].code},''),e=>e.code==='OTP_EXPIRED');
    await f.db.query("UPDATE crs.password_challenges SET expires_at=now()+interval '1 minute'");
    await auth.verifyOtp({challenge:reset.challenge,otp:f.mails[0].code},'');
    await f.add(); // Credential was changed after the email proof was issued.
    await assert.rejects(auth.changePassword({challenge:reset.challenge,password,confirmPassword:password},''),e=>e.code==='OTP_EXPIRED');
    assert.equal(hashes,0);
    assert.equal((await f.db.query('SELECT generation FROM crs.password_credentials')).rows[0].generation,1);
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.history')).rows[0].n,0);
  }finally{await f.db.close();}
});

test('expired temporary credentials and an email/identity changed during verification cannot sign in',async()=>{
  const f=await fixture();try{
    await f.add();await f.db.query("UPDATE crs.password_credentials SET temporary_expires_at=now()-interval '1 second'");
    const input={email:'user@example.test',password,sessionTokenHash:digest(secret('session1_'))};
    await assert.rejects(f.auth.signIn(input,'expiry-fixture'),e=>e.code==='LOGIN_INVALID');
    await f.db.query('UPDATE crs.password_credentials SET temporary_expires_at=NULL');
    const racing=passwordAuth({...f.deps,verify:async(value,encoded)=>{
      const valid=await verifyPassword(value,encoded);
      await f.db.query("UPDATE crs.users SET data=jsonb_set(data,'{email}','\"changed@example.test\"') WHERE id='USR-000002'");return valid;
    }});
    await assert.rejects(racing.signIn(input,'race-fixture'),e=>e.code==='LOGIN_INVALID');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.sessions')).rows[0].n,1); // Original Admin Google session only.
  }finally{await f.db.close();}
});

test('account request throttles stop expensive verification; security mail failure cannot undo committed change',async()=>{
  const f=await fixture();try{
    let verifications=0;
    const limited=passwordAuth({...f.deps,verify:async()=>{verifications++;return false;}});
    for(let i=0;i<12;i++)await assert.rejects(limited.signIn({email:'unknown@example.test',password,sessionTokenHash:digest(secret('session1_'))},'limit-fixture'));
    assert.equal(verifications,10);assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.users')).rows[0].n,2);
    const auth=passwordAuth({...f.deps,send:async value=>{if(value.kind==='PASSWORD_CHANGED')throw new Error('synthetic outage');f.mails.push(value);}});
    const reset=await auth.requestOtp({email:'admin@example.test'},'','notification-fixture');
    await auth.verifyOtp({challenge:reset.challenge,otp:f.mails[0].code},'');
    assert.deepEqual(await auth.changePassword({challenge:reset.challenge,password,confirmPassword:password},''),{changed:true,signedOut:true});
    assert.equal((await f.db.query('SELECT status FROM crs.security_mail')).rows[0].status,'UNCERTAIN');
    assert.equal((await f.db.query('SELECT count(*)::int AS n FROM crs.history')).rows[0].n,1);
  }finally{await f.db.close();}
});

test('issuing a temporary password to the Admin itself revokes its session and reports the sign-out handoff',async()=>{
  const f=await fixture();try{
    const result=await f.auth.issueTemporary({userId:'USR-000001',commandId:'self-temporary-fixture'},f.token);
    assert.equal(result.signedOut,true);assert.equal(result.activated,true);
    await assert.rejects(sessionFor(f.db,f.token),e=>e.code==='UNAUTHENTICATED');
    assert.equal((await f.db.query('SELECT must_change FROM crs.password_credentials')).rows[0].must_change,true);
  }finally{await f.db.close();}
});
