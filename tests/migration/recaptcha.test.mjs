import test from 'node:test';
import assert from 'node:assert/strict';
import {publicRecaptcha,recaptchaConfig,verifyRecaptcha} from '../../server/recaptcha.mjs';

const env={WEB_APP_URL:'https://example.test',RECAPTCHA_SITE_KEY:'fixture-site-key-not-live-000000',RECAPTCHA_SECRET_KEY:'fixture-secret-not-live-000000'};
const now=Date.now(),proof='fixture-current-request-proof';
const valid={success:true,action:'password_login',hostname:'example.test',score:.8,challenge_ts:new Date(now-1000).toISOString()};
const options=(data=valid)=>({env,clock:()=>now,fetcher:async()=>Response.json(data)});
const error=code=>value=>value.code===code&&!value.message.includes(env.RECAPTCHA_SECRET_KEY)&&!value.message.includes(proof);

test('reCAPTCHA public metadata is an exact site-key/action projection and target hostname cannot drift',()=>{
  assert.deepEqual(publicRecaptcha(env),{siteKey:env.RECAPTCHA_SITE_KEY,actions:{login:'password_login',reset:'password_reset'}});
  assert.equal(recaptchaConfig(env).hostname,'example.test');
  for(const patch of [{RECAPTCHA_SECRET_KEY:''},{RECAPTCHA_SITE_KEY:''},{RECAPTCHA_MIN_SCORE:'NaN'},{RECAPTCHA_MIN_SCORE:'0'},
    {RECAPTCHA_MIN_SCORE:'1.1'},{RECAPTCHA_HOSTNAME:'evil.test'},{RECAPTCHA_LOGIN_ACTION:'user email'},{RECAPTCHA_RESET_ACTION:'password_login'}])
    assert.throws(()=>recaptchaConfig({...env,...patch}),error('RECAPTCHA_UNAVAILABLE'));
  assert.deepEqual(publicRecaptcha({...env,RECAPTCHA_LOGIN_ACTION:'login_custom',RECAPTCHA_RESET_ACTION:'reset_custom'}).actions,{login:'login_custom',reset:'reset_custom'});
});

test('fresh current-action proof verifies only through bounded server POST with no query/cache/IP/token persistence',async()=>{
  let calls=0;
  for(const purpose of ['login','reset'])await verifyRecaptcha(proof,purpose,{env,clock:()=>now,fetcher:async(url,request)=>{
    calls++;assert.equal(url,'https://www.google.com/recaptcha/api/siteverify');assert.equal(request.method,'POST');assert.equal(request.redirect,'error');assert.equal(request.cache,'no-store');
    assert.equal(request.body.get('secret'),env.RECAPTCHA_SECRET_KEY);assert.equal(request.body.get('response'),proof);assert.equal(request.body.has('remoteip'),false);
    assert.ok(request.signal instanceof AbortSignal);
    return Response.json({...valid,action:purpose==='login'?'password_login':'password_reset'});
  }});
  assert.equal(calls,2);
});

test('missing/malformed/oversized proof cannot make a provider request; missing policy fails closed',async()=>{
  let calls=0;const settings={...options(),fetcher:async()=>{calls++;return Response.json(valid);}};
  for(const token of [undefined,null,{},'',123,' '+proof,'a'.repeat(8193),proof+'\n'])await assert.rejects(verifyRecaptcha(token,'login',settings),error('RECAPTCHA_FAILED'));
  await assert.rejects(verifyRecaptcha(proof,'unconfigured',settings),error('RECAPTCHA_FAILED'));
  await assert.rejects(verifyRecaptcha(proof,'login',{...settings,env:{WEB_APP_URL:'https://example.test'}}),error('RECAPTCHA_UNAVAILABLE'));
  assert.equal(calls,0);
});

test('wrong action/hostname, low/non-numeric score, stale/future timestamp or ambiguous provider response is denied',async()=>{
  for(const patch of [{success:false},{success:'true'},{action:'password_reset'},{hostname:'crsyuemkuen.vercel.app'},
    {hostname:'example.test.evil.test'},{score:.49},{score:'1'},{score:null},{score:1.1},{score:-1},
    {challenge_ts:'invalid'},{challenge_ts:new Date(now-120001).toISOString()},
    {challenge_ts:new Date(now+10001).toISOString()},{'error-codes':['invalid-input-secret']},{'error-codes':'bad'}])
    await assert.rejects(verifyRecaptcha(proof,'login',options({...valid,...patch})),error('RECAPTCHA_FAILED'));
  await assert.rejects(verifyRecaptcha(proof,'login',{...options(),env:{...env,RECAPTCHA_MIN_SCORE:'.9'}}),error('RECAPTCHA_FAILED'));
});

test('provider outage, redirects, invalid JSON and oversized response return safe unavailable errors',async()=>{
  for(const fetcher of [async()=>{throw Error(proof+' '+env.RECAPTCHA_SECRET_KEY);},async()=>new Response('',{status:503}),
    async()=>new Response('not-json'),async()=>new Response('x'.repeat(16385)),async()=>Response.json(null)]){
    await assert.rejects(verifyRecaptcha(proof,'login',{...options(),fetcher}),value=>['RECAPTCHA_UNAVAILABLE','RECAPTCHA_FAILED'].includes(value.code)&&error(value.code)(value));
  }
});

test('request replay is reverified with Google, never served from a cached proof',async()=>{
  let used=false,calls=0;
  const settings={...options(),fetcher:async()=>{calls++;if(used)return Response.json({success:false,'error-codes':['timeout-or-duplicate']});used=true;return Response.json(valid);}};
  assert.equal(await verifyRecaptcha(proof,'login',settings),undefined);
  await assert.rejects(verifyRecaptcha(proof,'login',settings),error('RECAPTCHA_FAILED'));assert.equal(calls,2);
});
