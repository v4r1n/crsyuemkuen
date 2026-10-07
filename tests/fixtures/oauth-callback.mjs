import test,{before,after,beforeEach,afterEach,mock} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { callbackPage as realCallbackPage } from '../../server/callback-page.mjs';

// Module doubles live only in the isolated experimental test worker.
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
  await db.exec(readFileSync(new URL('../../supabase/migrations/202610070002_identity_experience.sql',import.meta.url),'utf8'));
});
after(async()=>{mock.restoreAll();await db.close();});
beforeEach(async()=>{
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
function silent(){assert.deepEqual(logs,[],'callback must not log authorization material');}
async function denied(query){
  const response=await callback(query);assert.equal(response.status,400);
  assert.equal(response.headers.get('cache-control'),'no-store');
  const body=await response.text();for(const secret of privateValues) assert.ok(!body.includes(secret));
  assert.doesNotMatch(body,/oauth-handoff-code" readonly/);
  assert.equal(await status(),'DENIED');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM crs.sessions')).rows[0].count,0);
  silent();
}
test('missing or duplicate callback state cannot consume a flow',async()=>{
  const response=await callback(new URLSearchParams({state:'PRIVATE-STATE',code:'PRIVATE-CODE'}));
  assert.equal(response.status,400);assert.equal(await status(),'PENDING');silent();
  const query=new URLSearchParams({state,code:'PRIVATE-CODE'});query.append('state',state);
  assert.equal((await callback(query)).status,400);assert.equal(await status(),'PENDING');silent();
});
test('flow replay remains rejected before token exchange',async()=>{
  await db.query("UPDATE crs.auth_flows SET status='DENIED',data='{}' WHERE id=$1",[flowId]);
  assert.equal((await callback()).status,400);silent();
  assert.equal(globalThis.fetch.mock.callCount(),0);
});
test('provider errors deny without leaking token bodies or descriptions',async()=>{
  tokenResponse=new Response(JSON.stringify({error:'invalid_client',error_description:'PRIVATE-DESCRIPTION PRIVATE-SECRET',id_token:'PRIVATE-TOKEN'}),{status:401});
  await denied();assert.equal(tokenResponse.bodyUsed,false,'failed provider body is not read');
});
test('untrusted provider error strings never reach logs or the error page',async()=>{
  tokenResponse=new Response(JSON.stringify({error:'PRIVATE-SECRET'}),{status:400});await denied();
});
test('network failures deny without leaking messages or stacks',async()=>{
  globalThis.fetch.mock.mockImplementation(async()=>{throw Object.assign(new Error('PRIVATE-DATABASE PRIVATE-SECRET'),{code:'PRIVATE-TOKEN'});});
  await denied();
});
test('signature/JWKS failure still rejects the callback',async()=>{
  verifyError=Object.assign(new Error('PRIVATE-TOKEN'),{code:'ERR_JWS_SIGNATURE_VERIFICATION_FAILED'});await denied();
});
test('invalid nonce denies identity without persisting a candidate or OTP',async()=>{
  claims.nonce='WRONG-NONCE';await denied();
  const data=(await db.query('SELECT data FROM crs.auth_flows WHERE id=$1',[flowId])).rows[0].data;
  assert.deepEqual(Object.keys(data),['expiresAt']);
});
test('current inactive Users still deny access',async()=>{
  await db.query("UPDATE crs.users SET data=jsonb_set(data,'{status}','\"INACTIVE\"')");await denied();
});
test('database loading failure cannot authorize a visitor',async()=>{
  queryFailure={match:'FROM crs.equipment',error:Object.assign(new Error('PRIVATE-DATABASE'),{code:'42501'})};await denied();
});
test('an interrupted OTP commit rolls back and denies; it never activates a session',async()=>{
  queryFailure={match:"status='AWAITING_CONFIRMATION'",error:Object.assign(new Error('PRIVATE-DATABASE'),{code:'57014'})};await denied();
});
test('valid callback retains OTP/copy UX without logging OTP, tokens or identity',async()=>{
  const response=await callback();assert.equal(response.status,200);assert.equal(await status(),'AWAITING_CONFIRMATION');
  const page=await response.text();assert.match(page,/oauth-handoff-code" readonly/);assert.match(page,/acknowledgeOAuthCopy/);silent();
  const data=(await db.query('SELECT data FROM crs.auth_flows WHERE id=$1',[flowId])).rows[0].data;
  assert.equal(data.candidate.email,claims.email);assert.ok(data.otpHash);assert.equal(data.attempts,0);
  assert.ok(/value="(\d{6})"/.exec(page)?.[1]);
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.match(response.headers.get('content-security-policy'),/frame-ancestors 'none'/);
});
test('render failure does not change a verified awaiting-confirmation flow',async()=>{
  renderError=new Error('PRIVATE-TOKEN');assert.equal((await callback()).status,400);
  assert.equal(await status(),'AWAITING_CONFIRMATION');silent();
});
test('provider consent denial consumes the claim without token exchange',async()=>{
  await denied(new URLSearchParams({state,error:'access_denied'}));assert.equal(globalThis.fetch.mock.callCount(),0);
});
test('unknown Users remain denied without auto-provisioning',async()=>{
  const count=Number((await db.query('SELECT count(*) AS n FROM crs.users')).rows[0].n);
  claims.email='unknown-person@gmail.com';await denied();
  assert.equal(Number((await db.query('SELECT count(*) AS n FROM crs.users')).rows[0].n),count);
});
