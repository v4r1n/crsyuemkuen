import test,{before,after,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { callbackPage as realCallbackPage } from '../../server/callback-page.mjs';

const privateValues=['PRIVATE-CODE','PRIVATE-STATE','PRIVATE-TOKEN','PRIVATE-SECRET',
  'PRIVATE-DESCRIPTION','PRIVATE-DATABASE','private-person@gmail.com'];
let db,logs,claims,verifyError,renderError,queryFailure,tokenResponse;
mock.module(new URL('../../server/db.mjs',import.meta.url),{namedExports:{transaction:async work=>{
  await db.exec('BEGIN');
  try {
    const client={query:async(sql,values)=>{
      if(queryFailure && sql.includes(queryFailure.match)) throw queryFailure.error;
      return db.query(sql,values);
    }};
    const result=await work(client);await db.exec('COMMIT');return result;
  } catch(error){await db.exec('ROLLBACK');throw error;}
}}});
mock.module('jose',{namedExports:{createRemoteJWKSet:()=>()=>{},jwtVerify:async()=>{
  if(verifyError) throw verifyError;
  return {payload:claims};
}}});
mock.module(new URL('../../server/callback-page.mjs',import.meta.url),{namedExports:{callbackPage:result=>{
  if(result && renderError) throw renderError;
  return realCallbackPage(result);
}}});
const {digest}=await import('../../server/domain.mjs');
const {GET}=await import('../../app/auth/callback/route.js');
const state='callback1_'+'a'.repeat(43),flowId='b'.repeat(43);
before(async()=>{
  db=new PGlite();
  await db.exec(readFileSync(new URL('../../supabase/migrations/202610050001_crs.sql',import.meta.url),'utf8'));
});
after(async()=>{mock.restoreAll();await db.close();});
beforeEach(async()=>{
  process.env.AUTH_DIAGNOSTICS='true';process.env.VERCEL_ENV='preview';
  process.env.GOOGLE_OAUTH_CLIENT_ID='test.apps.googleusercontent.com';
  process.env.GOOGLE_OAUTH_CLIENT_SECRET='PRIVATE-SECRET';
  process.env.ALLOWED_DOMAINS='gmail.com';process.env.WRITE_FREEZE='true';
  logs=[];verifyError=null;renderError=null;queryFailure=null;
  const now=Math.floor(Date.now()/1000);
  claims={iss:'https://accounts.google.com',aud:process.env.GOOGLE_OAUTH_CLIENT_ID,
    exp:now+300,iat:now,nonce:'PRIVATE-NONCE',sub:'PRIVATE-SUBJECT',
    email:'private-person@gmail.com',email_verified:true};
  tokenResponse=new Response(JSON.stringify({id_token:'PRIVATE-TOKEN',access_token:'PRIVATE-ACCESS-TOKEN'}));
  mock.method(globalThis,'fetch',async()=>tokenResponse);
  mock.method(console,'error',value=>logs.push(value));
  await db.exec('DELETE FROM crs.auth_flows; DELETE FROM crs.sessions;');
  // Immutable domain rows are never hard-deleted, even in this fixture.
  const users=(await db.query('SELECT data FROM crs.users')).rows;
  if(!users.length) await db.query('INSERT INTO crs.users(data) VALUES($1)',[JSON.stringify({
    user_id:'USR-000001',email:claims.email,name:'Test',role:'ADMIN',status:'ACTIVE',row_version:1})]);
  else await db.query("UPDATE crs.users SET data=jsonb_set(data,'{status}','\"ACTIVE\"')");
  await db.query("INSERT INTO crs.auth_flows(id,state_hash,poll_hash,session_hash,status,data,expires_at) VALUES($1,$2,$3,$4,'PENDING',$5,now()+interval '10 minutes')",
    [flowId,digest(state),'c'.repeat(43),'d'.repeat(43),JSON.stringify({clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,
      nonce:claims.nonce,verifier:'PRIVATE-VERIFIER',redirectUri:'https://example.test/auth/callback',expiresAt:now+600})]);
});
afterEach(()=>{mock.restoreAll();});
async function callback(query=new URLSearchParams({state,code:'PRIVATE-CODE'})){
  return GET(new Request('https://example.test/auth/callback?'+query));
}
async function status(){return (await db.query('SELECT status FROM crs.auth_flows WHERE id=$1',[flowId])).rows[0].status;}
function event(stage,code){
  assert.equal(logs.length,1,'one bounded event per failure');
  assert.match(logs[0],/^\[DEBUG-crs-oauth-v1\] /);
  for(const secret of [...privateValues,state,flowId,'PRIVATE-NONCE','PRIVATE-VERIFIER','PRIVATE-SUBJECT']) assert.ok(!logs[0].includes(secret));
  const value=JSON.parse(logs[0].slice('[DEBUG-crs-oauth-v1] '.length));
  assert.equal(value.stage,stage);assert.equal(value.code,code);
  assert.match(value.requestId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.ok(Object.keys(value).every(key=>['requestId','stage','code','outcome','providerStatus','providerError'].includes(key)));
  return value;
}
async function denied(stage,code){
  const response=await callback();assert.equal(response.status,400);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.text();for(const secret of privateValues) assert.ok(!body.includes(secret));
  assert.doesNotMatch(body,/oauth-handoff-code" readonly/);
  assert.equal(await status(),'DENIED');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM crs.sessions')).rows[0].count,0);
  return event(stage,code);
}
test('missing or duplicate callback state is logged without a flow, and cannot consume it',async()=>{
  const response=await callback(new URLSearchParams({state:'PRIVATE-STATE',code:'PRIVATE-CODE'}));
  assert.equal(response.status,400);assert.equal(await status(),'PENDING');
  event('CALLBACK_INPUT','UNAUTHENTICATED');
  logs=[];const query=new URLSearchParams({state,code:'PRIVATE-CODE'});query.append('state',state);
  assert.equal((await callback(query)).status,400);assert.equal(await status(),'PENDING');
  event('CALLBACK_INPUT','UNAUTHENTICATED');
});
test('flow replay remains rejected before token exchange',async()=>{
  await db.query("UPDATE crs.auth_flows SET status='DENIED',data='{}' WHERE id=$1",[flowId]);
  assert.equal((await callback()).status,400);event('FLOW_CLAIM','UNAUTHENTICATED');
  assert.equal(globalThis.fetch.mock.callCount(),0);
});
test('provider errors are allowlisted, never token bodies or descriptions',async()=>{
  tokenResponse=new Response(JSON.stringify({error:'invalid_client',error_description:'PRIVATE-DESCRIPTION PRIVATE-SECRET',id_token:'PRIVATE-TOKEN'}),{status:401});
  const value=await denied('TOKEN_EXCHANGE','UNAUTHENTICATED');
  assert.equal(value.providerStatus,401);assert.equal(value.providerError,'invalid_client');
});
test('untrusted provider error strings are reduced to a bounded sentinel',async()=>{
  tokenResponse=new Response(JSON.stringify({error:'PRIVATE-SECRET'}),{status:400});
  assert.equal((await denied('TOKEN_EXCHANGE','UNAUTHENTICATED')).providerError,'OTHER');
});
test('network failures log only allowlisted error codes, never messages or stacks',async()=>{
  globalThis.fetch.mock.mockImplementation(async()=>{throw Object.assign(new Error('PRIVATE-DATABASE PRIVATE-SECRET'),{code:'PRIVATE-TOKEN'});});
  await denied('TOKEN_EXCHANGE','INTERNAL');
});
test('signature/JWKS failure is distinguished from authoritative-claim rejection',async()=>{
  verifyError=Object.assign(new Error('PRIVATE-TOKEN'),{code:'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'});
  await denied('TOKEN_VERIFICATION','ERR_JWS_SIGNATURE_VERIFICATION_FAILED');
});
test('invalid nonce still denies identity without persisting a candidate or OTP',async()=>{
  claims.nonce='WRONG-NONCE';await denied('IDENTITY_CLAIMS','UNAUTHENTICATED');
  const data=(await db.query('SELECT data FROM crs.auth_flows WHERE id=$1',[flowId])).rows[0].data;
  assert.deepEqual(Object.keys(data),['expiresAt']);
});
test('current inactive Users still deny access at the authorization stage',async()=>{
  await db.query("UPDATE crs.users SET data=jsonb_set(data,'{status}','\"INACTIVE\"')");
  await denied('USER_AUTHORIZATION','USER_DISABLED');
});
test('database loading and OTP commit errors have separate stages',async()=>{
  queryFailure={match:'FROM crs.equipment',error:Object.assign(new Error('PRIVATE-DATABASE'),{code:'42501'})};
  await denied('USERS_LOAD','42501');
});
test('an interrupted OTP commit rolls back and denies; it never activates a session',async()=>{
  queryFailure={match:"status='AWAITING_CONFIRMATION'",error:Object.assign(new Error('PRIVATE-DATABASE'),{code:'57014'})};
  await denied('OTP_COMMIT','57014');
});
test('valid callback retains OTP/copy UX without logging OTP, tokens or identity',async()=>{
  const response=await callback();assert.equal(response.status,200);assert.equal(await status(),'AWAITING_CONFIRMATION');
  const page=await response.text();assert.match(page,/oauth-handoff-code" readonly/);assert.match(page,/acknowledgeOAuthCopy/);
  const value=event('CALLBACK_READY','OK');assert.equal(value.outcome,'READY');
  const data=(await db.query('SELECT data FROM crs.auth_flows WHERE id=$1',[flowId])).rows[0].data;
  assert.equal(data.candidate.email,claims.email);assert.ok(data.otpHash);assert.equal(data.attempts,0);
  const otp=/value="(\d{6})"/.exec(page)?.[1];assert.ok(otp);assert.ok(!logs[0].includes(otp));
});
test('render failure does not change a verified awaiting-confirmation flow',async()=>{
  renderError=new Error('PRIVATE-TOKEN');assert.equal((await callback()).status,400);
  assert.equal(await status(),'AWAITING_CONFIRMATION');event('CALLBACK_RENDER','INTERNAL');
});
test('diagnostics are off by default and cannot be enabled in Vercel Production',async()=>{
  delete process.env.AUTH_DIAGNOSTICS;
  assert.equal((await callback(new URLSearchParams())).status,400);assert.deepEqual(logs,[]);
  process.env.AUTH_DIAGNOSTICS='true';process.env.VERCEL_ENV='production';
  assert.equal((await callback(new URLSearchParams())).status,400);assert.deepEqual(logs,[]);
});
test('logger accepts only controlled fields and logging errors cannot break authentication',async()=>{
  const {createAuthDiagnostics}=await import('../../server/auth-diagnostics.mjs');
  const diagnostic=createAuthDiagnostics();
  diagnostic.stage('PRIVATE-SECRET');diagnostic.providerResponse(401,'PRIVATE-TOKEN');
  diagnostic.failed(Object.assign(new Error('PRIVATE-SECRET'),{code:'PRIVATE-TOKEN',email:'private-person@gmail.com'}));
  event('CALLBACK_INPUT','INTERNAL');
  console.error.mock.mockImplementation(()=>{throw new Error('test log sink unavailable');});
  assert.doesNotThrow(()=>createAuthDiagnostics().failed(new Error('PRIVATE-SECRET')));
});
