import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve,relative} from 'node:path';

// Exercise Next's real production artifact, not the unbundled Node module.
// Only generated module IDs are discovered; fixture data never reaches cloud.
const require=createRequire(import.meta.url);
const entryPath='server/app/auth/callback/route.js';
const entry=readFileSync(resolve('.next',entryPath),'utf8');
const runtime=require(resolve('.next/server/chunks/[turbopack]_runtime.js'))(entryPath);
let domainId;
for(const [,chunk] of entry.matchAll(/R\.c\("([^"\n]+)"\)/g)) {
  const source=readFileSync(resolve('.next',chunk),'utf8');
  const match=/\.s\(\["createDomain"[\s\S]*?\],(\d+)\)/.exec(source);
  if(match) domainId=Number(match[1]);
  runtime.c(chunk);
}
assert.ok(domainId,'Compiled domain module must be present in the callback artifact');
const {createDomain}=runtime.m(domainId).exports;
process.env.WEB_APP_URL='https://example.test';
process.env.GOOGLE_OAUTH_CLIENT_ID='build-test.apps.googleusercontent.com';
process.env.ALLOWED_DOMAINS='gmail.com';
const user={user_id:'USR-000001',email:'build-test@gmail.com',name:'Build test',role:'ADMIN',status:'ACTIVE',row_version:1};
function domain(record=user){return createDomain({Users:record?[{...record}]:[]},{session:{
  userId:user.user_id,email:user.email,clientId:process.env.GOOGLE_OAUTH_CLIENT_ID,expiresAt:Math.floor(Date.now()/1000)+600}});}

test('production callback artifact authorizes a verified identity against current Users',()=>{
  const value=domain().context.requireUserForIdentity_({email:user.email,subject:'test-subject'});
  assert.equal(value.user_id,user.user_id);assert.equal(value.role,'ADMIN');
});
test('production artifact retains inactive/unknown-user denial without auto-provisioning',()=>{
  assert.throws(()=>domain({...user,status:'INACTIVE'}).context.requireUserForIdentity_({email:user.email}),error=>error.code==='USER_DISABLED');
  const missing=domain(null);
  assert.throws(()=>missing.context.requireUserForIdentity_({email:user.email}),error=>error.code==='FORBIDDEN');
  assert.deepEqual(missing.records.Users,[]);
});
test('production artifact exposes guarded domain services and the authenticated bootstrap',()=>{
  const value=domain();
  for(const method of ['requireUserForIdentity_','getAppBootstrap','adminUpdateEquipment','adminDeleteEquipment',
    'createBorrowRequest','adminApproveBorrow','adminCheckoutBorrow']) assert.equal(typeof value.context[method],'function',method);
  const bootstrap=value.invoke('getAppBootstrap',['test-only-transport-token']);
  assert.equal(bootstrap.ok,true);assert.equal(bootstrap.data.session.user_id,user.user_id);
  assert.equal(bootstrap.data.session.role,'ADMIN');
  assert.equal(bootstrap.data.app.webAppUrl,'https://example.test');
});

test('production callback file tracing never packages private workspace exports or credentials',()=>{
  const path=resolve('.next',entryPath+'.nft.json');
  const trace=JSON.parse(readFileSync(path,'utf8'));
  const root=resolve('.');
  for(const file of trace.files){
    const name=relative(root,resolve(path,'..',file)).replaceAll('\\','/');
    assert.ok(!/(^|\/)(\.env[^/]*|\.migration|\.vercel|\.git)(\/|$)|\.(xlsx|zip|7z|rar|tar|gz|log)$/i.test(name) && !name.includes('\uF01B'),
      'Private workspace data must not be packaged in a function trace');
  }
});
