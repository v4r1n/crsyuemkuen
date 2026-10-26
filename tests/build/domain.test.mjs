import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,relative} from 'node:path';

// Exercise Next's real production artifact, not the unbundled Node module.
// Only generated module IDs are discovered; fixture data never reaches cloud.
const require=createRequire(import.meta.url);
test('Next Admin notes align centrally and audit controls use guarded queued-cleanup copy',()=>{
  const code=readFileSync('public/crs/scripts-admin.js','utf8');
  assert.match(code,/<th class="text-center">หมายเหตุ<\/th>/);
  assert.match(code,/returned \+ '<\/td><td class="text-break text-center">'/);
  assert.match(code,/CLEANUP_QUEUED/);assert.match(code,/toggle-audit-results/);
  assert.doesNotMatch(code,/ย้ายไฟล์กำพร้าไปถังขยะแล้ว/);
  assert.doesNotMatch(code,/ไฟล์ถูกจัดคิวล้างไฟล์/);assert.match(code,/ไฟล์ถูกล้างจาก Storage/);
  const rpc=readFileSync('server/rpc.mjs','utf8');
  assert.match(rpc,/if\(method==='adminPreviewImageIntegrity'\)\s*\{\s*c.requireAdmin_\(token\);\s*cleanupJobs=\(await db.query\('SELECT id FROM crs.cleanup_jobs'\)\).rows;/);
});
const entryPath='server/app/auth/callback/route.js';
const entry=readFileSync(resolve('.next',entryPath),'utf8');
const runtime=require(resolve('.next/server/chunks/[turbopack]_runtime.js'))(entryPath);
const domainIds=new Set();
for(const [,chunk] of entry.matchAll(/R\.c\("([^"\n]+)"\)/g)) {
  // Turbopack may mangle export names and prune createDomain's unused export.
  // Find the registered production factory by its authoritative loader query,
  // then exercise that loader, never an unbundled fallback or fixed module ID.
  const registrations=require(resolve('.next',chunk)).flat(Infinity);
  for(let i=1;i<registrations.length;i++){
    const factory=registrations[i];
    if(typeof factory==='function'&&factory.toString().includes('SELECT id,data,expires_at FROM crs.proofs')&&
      factory.toString().includes('requireApplicationSession_')){
      assert.equal(typeof registrations[i-1],'number');domainIds.add(registrations[i-1]);
    }
  }
  runtime.c(chunk);
}
assert.equal(domainIds.size,1,'Exactly one compiled domain module must be present in the callback artifact');
const loaders=Object.values(runtime.m([...domainIds][0]).exports).filter(value=>
  typeof value==='function'&&value.toString().includes('SELECT id,data,expires_at FROM crs.proofs'));
assert.equal(loaders.length,1,'Compiled authoritative domain loader must remain exported');
const [loadDomain]=loaders;
process.env.WEB_APP_URL='https://example.test';
process.env.GOOGLE_OAUTH_CLIENT_ID='build-test.apps.googleusercontent.com';
process.env.ALLOWED_DOMAINS='gmail.com';
const user={user_id:'USR-000001',email:'build-test@gmail.com',name:'Build test',role:'ADMIN',status:'ACTIVE',row_version:1};
async function domain(record=user){return loadDomain({async query(sql){
  if(sql==='SELECT id,data,expires_at FROM crs.proofs WHERE expires_at > now()')return {rows:[]};
  assert.match(sql,/^SELECT data FROM crs\.[a-z_]+ ORDER BY id$/);
  return {rows:sql==='SELECT data FROM crs.users ORDER BY id'&&record?[{data:{...record}}]:[]};
}},{session:{
  userId:user.user_id,email:user.email,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+600}});}

test('production callback artifact authorizes a verified identity against current Users',async()=>{
  const value=(await domain()).context.requireUserForIdentity_({email:user.email,subject:'test-subject'});
  assert.equal(value.user_id,user.user_id);assert.equal(value.role,'ADMIN');
});
test('production artifact retains inactive/unknown-user denial without auto-provisioning',async()=>{
  const inactive=await domain({...user,status:'INACTIVE'});
  assert.throws(()=>inactive.context.requireUserForIdentity_({email:user.email}),error=>error.code==='USER_DISABLED');
  const missing=await domain(null);
  assert.throws(()=>missing.context.requireUserForIdentity_({email:user.email}),error=>error.code==='FORBIDDEN');
  assert.deepEqual(missing.records.Users,[]);
});
test('production artifact exposes guarded domain services and the authenticated bootstrap',async()=>{
  const value=await domain();
  for(const method of ['requireUserForIdentity_','getAppBootstrap','adminUpdateEquipment','adminDeleteEquipment',
    'createBorrowRequest','adminApproveBorrow','adminCheckoutBorrow']) assert.equal(typeof value.context[method],'function',method);
  const bootstrap=value.invoke('getAppBootstrap',['test-only-transport-token']);
  assert.equal(bootstrap.ok,true);assert.equal(bootstrap.data.session.user_id,user.user_id);
  assert.equal(bootstrap.data.session.role,'ADMIN');
  assert.equal(bootstrap.data.app.webAppUrl,'https://example.test');
  assert.equal(bootstrap.data.app.version,JSON.parse(readFileSync('package.json','utf8')).version);
});

test('callback function trace packages its runtime stylesheet instead of relying on the workspace',()=>{
  const path=resolve('.next/server/app/auth/callback/route.js.nft.json');
  const trace=JSON.parse(readFileSync(path,'utf8'));
  const stylesheet=resolve('web/auth-callback.css');
  assert.ok(trace.files.some(file=>resolve(path,'..',file)===stylesheet),
    'Callback stylesheet must ship in the isolated function: a workspace-only CSS file causes cloud startup HTTP 500');
});

test('all production route traces exclude private exports/credentials and public assets contain no server secret configuration',()=>{
  const root=resolve('.');
  for(const route of ['route.js','_not-found/page.js','auth/callback/route.js','api/rpc/route.js','api/experience/route.js','api/auth/recaptcha/route.js','api/image-placeholder/route.js','api/public-equipment/[assetId]/thumbnail/route.js','api/notifications/process/route.js']) {
    const path=resolve('.next/server/app',route+'.nft.json'),trace=JSON.parse(readFileSync(path,'utf8'));
    for(const file of trace.files){
      const name=relative(root,resolve(path,'..',file)).replaceAll('\\','/');
      assert.ok(!/(^|\/)(\.env[^/]*|\.migration|\.vercel|\.git)(\/|$)|\.(xlsx|zip|7z|rar|tar|gz|log)$/i.test(name) && !name.includes('\uF01B'),
        'Private workspace data must not be packaged in a function trace');
    }
  }
  for(const file of readdirSync('public/crs').filter(name=>/\.(js|html)$/.test(name))){
    const source=readFileSync(resolve('public/crs',file),'utf8');
    assert.doesNotMatch(source,/WEB_PUSH_PRIVATE_KEY|CRON_SECRET|RECAPTCHA_SECRET_KEY|PASSWORD_OTP_SECRET|SMTP_PASSWORD|SUPABASE_SECRET_KEY|DATABASE_URL|GOOGLE_OAUTH_CLIENT_SECRET|BEGIN (?:RSA |EC )?PRIVATE KEY/,'Server-only configuration must not appear in browser assets');
  }
});
