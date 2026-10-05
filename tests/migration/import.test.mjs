import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { fields } from '../../server/schema.mjs';
import { planLegacy } from '../../tools/legacy-plan.mjs';
import { applyLegacy } from '../../tools/apply-legacy.mjs';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
const require=createRequire(import.meta.url);
const {bootstrappedHarness,createEquipment,expectOk}=require('../backend/test-helpers.cjs');
async function fixture({corrupt=false,missing=false}={}) {
  const harness=bootstrappedHarness(),asset=createEquipment(harness);
  const bytes=Buffer.from([137,80,78,71,13,10,26,10]);
  harness.properties.setProperty('DRIVE_FOLDER_ID','test-import-folder');
  let file;
  const folder={getId:()=> 'test-import-folder',getSharingAccess:()=> 'PRIVATE',getSharingPermission:()=> 'NONE',
    getFilesByName:()=>({hasNext:()=>false}),createFile:blob=>(file={getId:()=> 'test-import-image',getName:()=>blob.getName(),
      getSize:()=>bytes.length,getMimeType:()=> 'image/png',getBlob:()=>({getBytes:()=>[...bytes]}),getResourceKey:()=>'',
      getParents:()=>{let available=true;return {hasNext:()=>available,next:()=>{available=false;return folder;}};},
      getOwner:()=>({getEmail:()=> 'admin@example.com'}),isTrashed:()=>false,getSharingAccess:()=> 'DOMAIN_WITH_LINK',
      getSharingPermission:()=> 'VIEW',setSharing(){return this;}})};
  harness.context.DriveApp.getFolderById=()=>folder;
  harness.context.DriveApp.getFileById=()=>file;
  expectOk(harness.invoke('adminUploadEquipmentImage',{asset_id:asset.asset_id,expected_version:1,command_id:'import-image-fixture',mime_type:'image/png',base64_data:bytes.toString('base64')}));
  const workbook=new ExcelJS.Workbook();
  for(const [name,headers] of Object.entries(fields)) {
    const sheet=workbook.addWorksheet(name==='History'?'History_Reader_Copy':name);sheet.addRow(headers);
    for(const row of harness.records(name)) sheet.addRow(headers.map(field=>row[field]??''));
    if(name==='Users') sheet.addRow(['malformed@example.com','shifted name','Admin','User','Active']);
  }
  const legacy=workbook.addWorksheet('Items');legacy.addRow(['ID','Qty']);legacy.addRow(['AST-001',10]);
  const original=await workbook.xlsx.writeBuffer(),metadataZip=await JSZip.loadAsync(original);
  const meta=await metadataZip.file('xl/workbook.xml').async('string');
  metadataZip.file('xl/workbook.xml',meta.replace('name="History_Reader_Copy"','name="History"'));
  const xlsx=await metadataZip.generateAsync({type:'nodebuffer'}),zip=new JSZip();
  if(!missing) zip.file(asset.asset_id+'-import-image-fixture.png',corrupt?Buffer.from('not PNG'):bytes);
  return {xlsx,images:await zip.generateAsync({type:'nodebuffer'}),harness};
}
test('import retains every source row, quarantines malformed authorization, preserves counters and journal strings',async()=>{
  const value=await fixture(),plan=await planLegacy(value.xlsx,value.images);
  assert.equal(plan.images.length,1);assert.equal(plan.manifest.quarantined_rows,1);
  assert.ok(plan.archive.some(row=>row.sheet==='Items'&&row.raw.Qty===10));
  assert.ok(plan.archive.some(row=>row.sheet==='Users'&&row.reason==='INVALID_CANONICAL_ID'));
  assert.equal(plan.records.Users.some(row=>row.user_id.includes('@')),false);
  for(const name of ['Sequences','Operations','History']) for(const row of plan.records[name]) {
    const original=value.harness.records(name).find(item=>item[fields[name][0]]===row[fields[name][0]]);
    for(const field of fields[name]) assert.deepEqual(row[field],original[field]??'');
  }
  const again=await planLegacy(value.xlsx,value.images);
  assert.deepEqual(again.manifest,plan.manifest);
  assert.deepEqual(again.images.map(row=>row.object_key),plan.images.map(row=>row.object_key));
});
test('missing or corrupted current binary blocks import instead of silently dropping an image',async()=>{
  for(const options of [{corrupt:true},{missing:true}]) {
    const value=await fixture(options);
    await assert.rejects(planLegacy(value.xlsx,value.images));
  }
});

test('supplemental image archives retain verified original bytes and provenance without replacing the primary export',async()=>{
  const value=await fixture(),empty=await new JSZip().generateAsync({type:'nodebuffer'});
  const plan=await planLegacy(value.xlsx,empty,[value.images]);
  assert.equal(plan.images.length,1);
  assert.equal(plan.manifest.historical_image_bytes_unavailable,0);
  assert.equal(plan.manifest.additional_zip_hashes.length,1);
  assert.equal(plan.images[0].original.zip_hash,plan.manifest.additional_zip_hashes[0]);
  assert.notEqual(plan.images[0].original.zip_hash,plan.zipHash);
  assert.deepEqual((await planLegacy(value.xlsx,empty,[value.images])).manifest,plan.manifest);
  await assert.rejects(planLegacy(value.xlsx,value.images,[value.images]),/Duplicate image source archive/);
  const duplicate=await JSZip.loadAsync(value.images);
  duplicate.comment='Different archive, same resource';
  await assert.rejects(planLegacy(value.xlsx,value.images,[await duplicate.generateAsync({type:'nodebuffer'})]),/Duplicate image resource/);
  await assert.rejects(planLegacy(value.xlsx,empty,[(await fixture({corrupt:true})).images]));
});

test('interrupted import keeps a durable reservation; rerun commits once without duplicate objects/archive/history',async()=>{
  const value=await fixture(),plan=await planLegacy(value.xlsx,value.images),db=new PGlite();
  await db.exec(readFileSync(new URL('../../supabase/migrations/202610050001_crs.sql',import.meta.url),'utf8'));
  const transaction=async work=>{await db.exec('BEGIN');try{const result=await work(db);await db.exec('COMMIT');return result;}catch(error){await db.exec('ROLLBACK');throw error;}};
  const objects=new Map();let uploads=0,interrupted=true;
  const storage={info:async key=>objects.has(key)?{data:{}}:{error:{statusCode:404,code:'NoSuchKey'}},
    upload:async(key,bytes,options)=>{assert.equal(options.upsert,false);assert.equal(objects.has(key),false);uploads++;objects.set(key,new Blob([bytes],{type:options.contentType}));return {data:{}};},
    download:async key=>{if(interrupted){interrupted=false;return {error:new Error('interrupted after upload')};}return {data:objects.get(key)};}};
  await assert.rejects(applyLegacy(plan,{transaction,storage}));
  assert.equal((await db.query('SELECT state FROM crs.image_resources')).rows[0].state,'STAGED');
  assert.equal((await db.query('SELECT count(*)::int AS count FROM crs.equipment')).rows[0].count,0);
  assert.equal((await applyLegacy(plan,{transaction,storage})).alreadyCommitted,false);
  assert.equal((await applyLegacy(plan,{transaction,storage})).alreadyCommitted,true);
  assert.equal(uploads,1);
  const changedPlan=await planLegacy(value.xlsx,value.images,[await new JSZip().generateAsync({type:'nodebuffer'})]);
  await assert.rejects(applyLegacy(changedPlan,{transaction,storage}),/manifest collision/);
  assert.equal(uploads,1);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM crs.archive')).rows[0].count,plan.archive.length);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM crs.history')).rows[0].count,plan.records.History.length);
  assert.equal((await db.query('SELECT state FROM crs.image_resources')).rows[0].state,'READY');
  await db.close();
});

test('import refuses a nonempty destination before external image writes',async()=>{
  const value=await fixture(),plan=await planLegacy(value.xlsx,value.images),db=new PGlite();
  await db.exec(readFileSync(new URL('../../supabase/migrations/202610050001_crs.sql',import.meta.url),'utf8'));
  await db.query('INSERT INTO crs.users(data) VALUES($1)',[JSON.stringify(plan.records.Users[0])]);
  const transaction=async work=>{await db.exec('BEGIN');try{const result=await work(db);await db.exec('COMMIT');return result;}catch(error){await db.exec('ROLLBACK');throw error;}};
  let touched=false;
  await assert.rejects(applyLegacy(plan,{transaction,storage:{info:async()=>{touched=true;return {};}}}),/empty operational/);
  assert.equal(touched,false);assert.equal((await db.query('SELECT count(*)::int AS count FROM crs.image_resources')).rows[0].count,0);
  await db.close();
});
