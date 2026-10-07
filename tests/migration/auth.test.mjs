import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { digest,secret } from '../../server/domain.mjs';
import { completeInTransaction,sessionFor,otpDigest } from '../../server/auth.mjs';
import { callbackPage } from '../../server/callback-page.mjs';
process.env.GOOGLE_OAUTH_CLIENT_ID='test.apps.googleusercontent.com';
process.env.GOOGLE_OAUTH_CLIENT_SECRET='test-only-confidential-key';
process.env.ALLOWED_DOMAINS='gmail.com';
const migration=readFileSync(new URL('../../supabase/migrations/202610050001_crs.sql',import.meta.url),'utf8')+readFileSync(new URL('../../supabase/migrations/202610070002_identity_experience.sql',import.meta.url),'utf8');
async function setup(){
  const db=new PGlite();await db.exec(migration);
  await db.query('INSERT INTO crs.users(data) VALUES($1)',[JSON.stringify({user_id:'USR-000001',email:'test@gmail.com',name:'Test',role:'ADMIN',status:'ACTIVE',row_version:1})]);
  const flow=secret('flow1_'),poll=secret('poll1_'),token=secret('session1_'),otp='123456';
  const data={clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+600,otpExpiresAt:Math.floor(Date.now()/1000)+300,
    otpHash:otpDigest(digest(flow),otp),attempts:0,candidate:{userId:'USR-000001',email:'test@gmail.com',subject:'google-subject',clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+21600}};
  await db.query("INSERT INTO crs.auth_flows(id,state_hash,poll_hash,session_hash,status,data,expires_at) VALUES($1,$2,$3,$4,'AWAITING_CONFIRMATION',$5,now()+interval '10 minutes')",[digest(flow),digest('state'),digest(poll),digest(token),JSON.stringify(data)]);
  return {db,flow,poll,token,otp};
}
async function redeem(value,otp=value.otp,token=value.token,poll=value.poll){
  await value.db.exec('BEGIN');
  try{const result=await completeInTransaction(value.db,value.flow,poll,otp,token);await value.db.exec('COMMIT');return result;}
  catch(error){await value.db.exec('ROLLBACK');throw error;}
}
test('poll never activates; original browser proofs plus correct OTP activate once with six-hour absolute expiry',async()=>{
  const value=await setup();
  assert.equal((await redeem(value,'')).status,'AWAITING_CONFIRMATION');
  assert.equal((await value.db.query('SELECT count(*)::int AS count FROM crs.sessions')).rows[0].count,0);
  await assert.rejects(redeem(value,value.otp,secret('session1_')));
  await assert.rejects(redeem(value,value.otp,value.token,secret('poll1_')));
  const result=await redeem(value);assert.equal(result.status,'COMPLETE');
  assert.ok(result.expiresAt-Math.floor(Date.now()/1000)<=21600);
  const session=await sessionFor(value.db,value.token);assert.equal(session.userId,'USR-000001');
  await assert.rejects(redeem(value));
  await value.db.query('DELETE FROM crs.sessions WHERE id=$1',[digest(value.token)]);
  await assert.rejects(sessionFor(value.db,value.token));await value.db.close();
});
test('wrong OTP attempts persist through failed responses and lock after exactly five',async()=>{
  const value=await setup();
  for(let attempt=1;attempt<=5;attempt++) assert.equal((await redeem(value,'000000')).error,attempt===5?'UNAUTHENTICATED':'OTP_INVALID');
  await assert.rejects(redeem(value));
  assert.equal((await value.db.query('SELECT count(*)::int AS count FROM crs.sessions')).rows[0].count,0);await value.db.close();
});
test('expired OTP or changed current Users status cannot activate a session',async()=>{
  let value=await setup();
  await value.db.query("UPDATE crs.auth_flows SET data=jsonb_set(data,'{otpExpiresAt}','0')");
  assert.equal((await redeem(value)).error,'UNAUTHENTICATED');await value.db.close();
  value=await setup();
  await value.db.query("UPDATE crs.users SET data=jsonb_set(data,'{status}','\"INACTIVE\"')");
  await assert.rejects(redeem(value),error=>error.code==='USER_DISABLED');await value.db.close();
});

test('callback preserves accessible OTP/copy/close UX, replaces only the GAS bridge, and rejects injected output',()=>{
  const page=callbackPage({otp:'123456',flowHash:'a'.repeat(43),copyToken:'copy1_'+'b'.repeat(43)});
  assert.match(page,/id="oauth-handoff-code" readonly inputmode="numeric"/);
  assert.match(page,/acknowledgeOAuthCopy/);assert.match(page,/window.top.close/);assert.doesNotMatch(page,/google.script/);
  assert.doesNotMatch(callbackPage(),/oauth-handoff-code" readonly/);
  assert.throws(()=>callbackPage({otp:'<img>',flowHash:'a'.repeat(43),copyToken:'copy1_'+'b'.repeat(43)}));
});
