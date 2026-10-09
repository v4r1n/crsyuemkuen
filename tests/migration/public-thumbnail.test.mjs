import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {createPublicThumbnailHandler,makeThumbnail,publicThumbnailUrls} from '../../server/public-thumbnail.mjs';
import {digest} from '../../server/domain.mjs';
const assetId='AST-000001';
const bytes=await sharp({create:{width:1254,height:1254,channels:3,background:'#014d8b'}}).png().withMetadata().toBuffer();
const resource={id:'private-resource',asset_id:assetId,object_key:'private/original.png',mime_type:'image/png',byte_length:bytes.length,digest:digest(bytes),state:'READY',row_version:1,owner_user_id:'USR-000001',operation_id:'fixture-operation'};
function fixture(){
  let current={...resource},reads=0,downloads=0,limited=false;
  const db={query:async(sql)=>{
    if(sql.includes('rate_limits'))return {rows:[{count:limited?1000:1}]};
    reads++;return {rows:current?[{...current}]:[]};
  }};
  const storage={download:async()=>{downloads++;return {data:new Blob([bytes],{type:'image/png'})};},info:async()=>({data:{size:bytes.length,contentType:'image/png'}})};
  const handler=createPublicThumbnailHandler({transact:work=>work(db),storageFactory:async()=>storage});
  const request=new Request('https://fixture.example.test/api/public-equipment/'+assetId+'/thumbnail');
  return {db,storage,handler,request,get downloads(){return downloads;},get reads(){return reads;},set current(value){current=value;},set limited(value){limited=value;}};
}
test('public thumbnail is a bounded metadata-free derivative, never the original or a Storage capability',async()=>{
  const f=fixture(),response=await f.handler(f.request,assetId);
  assert.equal(response.status,200);assert.equal(response.headers.get('content-type'),'image/webp');
  assert.equal(response.headers.get('cache-control'),'private, no-store, max-age=0');assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
  const output=Buffer.from(await response.arrayBuffer()),metadata=await sharp(output).metadata();
  assert.ok(metadata.width<=320&&metadata.height<=212);assert.equal(metadata.exif,undefined);assert.equal(metadata.icc,undefined);assert.notDeepEqual(output,bytes);
  assert.equal(f.downloads,1);assert.equal(f.reads,2,'Authoritative reference/publication must be checked again after external I/O');
});
test('unknown/unpublished/lifecycle-excluded assets, invalid IDs and resource parameters fail closed without fetching originals',async()=>{
  const f=fixture();f.current=null;
  assert.equal((await f.handler(f.request,assetId)).status,404);assert.equal(f.downloads,0);
  assert.equal((await f.handler(f.request,'private-resource')).status,404);
  assert.equal((await f.handler(new Request(f.request.url+'?file=private-resource'),assetId)).status,404);
  assert.equal((await f.handler(new Request(f.request.url,{method:'POST'}),assetId)).status,404);assert.equal(f.downloads,0);
  assert.equal(await makeThumbnail(Buffer.alloc(0)).catch(()=>null),null);
});
test('missing/inaccessible/trashed/mismatched/foreign-asset resources and revoked/replaced references return no thumbnail',async()=>{
  for(const patch of [{state:'TRASHED'},{state:'STAGED'},{asset_id:'AST-000002'},{byte_length:999},{digest:'wrong'},{mime_type:'text/html'}]){
    const f=fixture();f.current={...resource,...patch};assert.equal((await f.handler(f.request,assetId)).status,404);
  }
  for(const failure of [{error:{statusCode:404}},{error:{statusCode:403}}]){
    const f=fixture();f.storage.download=async()=>failure;assert.equal((await f.handler(f.request,assetId)).status,404);
  }
  for(const change of [null,{...resource,row_version:2},{...resource,id:'replacement'}]){
    const f=fixture();f.storage.download=async()=>{f.current=change;return {data:new Blob([bytes],{type:'image/png'})};};assert.equal((await f.handler(f.request,assetId)).status,404);
  }
});
test('durable quota denial and per-instance saturation stop expensive work and release capacity after completion',async()=>{
  const f=fixture();f.limited=true;assert.equal((await f.handler(f.request,assetId)).status,429);assert.equal(f.downloads,0);
  f.limited=false;let release;const gate=new Promise(resolve=>release=resolve);f.storage.download=async()=>{await gate;return {data:new Blob([bytes],{type:'image/png'})};};
  const first=f.handler(f.request,assetId),second=f.handler(f.request,assetId);assert.equal((await f.handler(f.request,assetId)).status,503);release();assert.equal((await first).status,200);assert.equal((await second).status,200);assert.equal((await f.handler(f.request,assetId)).status,200);
});
test('catalog advertises only asset-bound READY thumbnails with current Storage metadata; stale URLs are ignored',async()=>{
  const f=fixture(),items=[{asset_id:assetId,image_url:'https://private.invalid/stale'}];
  assert.equal((await publicThumbnailUrls(f.db,items,{storage:f.storage}))[assetId],'/api/public-equipment/'+assetId+'/thumbnail');
  f.storage.info=async()=>({error:{statusCode:404}});assert.deepEqual(await publicThumbnailUrls(f.db,items,{storage:f.storage}),{});
  f.current={...resource,asset_id:'AST-000002'};assert.deepEqual(await publicThumbnailUrls(f.db,items,{storage:f.storage}),{});
});
test('JPEG/PNG/WebP/GIF inputs produce only bounded WebP output and aborted requests never read an original',async()=>{
  for(const format of ['jpeg','png','webp','gif']){
    const input=await sharp(bytes)[format]().toBuffer(),output=await makeThumbnail(input),metadata=await sharp(output).metadata();
    assert.equal(metadata.format,'webp');assert.ok(metadata.width<=320&&metadata.height<=212);assert.equal(metadata.exif,undefined);
  }
  const f=fixture(),abort=new AbortController();abort.abort();assert.equal((await f.handler(new Request(f.request.url,{signal:abort.signal}),assetId)).status,404);assert.equal(f.downloads,0);
});
