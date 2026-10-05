import { tables } from '../server/schema.mjs';
import { digest } from '../server/domain.mjs';
import { storageMissing } from '../server/storage.mjs';
import { isDeepStrictEqual } from 'node:util';

export async function applyLegacy(plan,{transaction,storage}) {
  await transaction(async db=>{
    const run=(await db.query('SELECT manifest FROM crs.migration_runs WHERE source_hash=$1',[plan.sourceHash])).rows[0];
    if(run && !isDeepStrictEqual(run.manifest,plan.manifest)) throw new Error('Import manifest collision; use the exact original source archives');
    if(!run) for(const table of Object.values(tables)) {
      if((await db.query(`SELECT count(*)::integer AS total FROM crs.${table}`)).rows[0].total!==0) throw new Error('First import requires empty operational tables; refusing merge/overwrite');
    }
    // Reserve before external uploads. Retries use the same immutable paths;
    // interrupted objects remain tracked, never unowned Storage orphans.
    for(const image of plan.images) {
      const found=(await db.query('SELECT * FROM crs.image_resources WHERE id=$1',[image.id])).rows[0];
      if(found) {
        if(found.digest!==image.digest || found.object_key!==image.object_key || found.state==='TRASHED' || found.asset_id!==image.asset_id ||
          found.operation_id!==image.operation_id || found.byte_length!==image.byte_length || found.mime_type!==image.mime_type ||
          found.name!==image.name || found.folder_id!==image.folder_id || found.owner_user_id!==image.owner_user_id ||
          !isDeepStrictEqual(found.original,image.original)) throw new Error('Import resource collision');
        continue;
      }
      await db.query(`INSERT INTO crs.image_resources(id,object_key,operation_id,asset_id,mime_type,byte_length,digest,name,folder_id,owner_user_id,state,original)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'STAGED',$11)`,[image.id,image.object_key,image.operation_id,image.asset_id,image.mime_type,image.byte_length,image.digest,image.name,image.folder_id,image.owner_user_id,JSON.stringify(image.original)]);
    }
  });
  for(const image of plan.images) {
    const existing=await storage.info(image.object_key);
    if(existing.error) {
      if(!storageMissing(existing.error)) throw new Error('Storage state uncertain; import stopped without overwriting objects');
      const uploaded=await storage.upload(image.object_key,image.bytes,{contentType:image.mime_type,upsert:false,cacheControl:'0'});
      if(uploaded.error) throw new Error('Private image upload failed');
    }
    const downloaded=await storage.download(image.object_key);
    if(downloaded.error || !downloaded.data || downloaded.data.type!==image.mime_type) throw new Error('Cannot verify imported image');
    const bytes=Buffer.from(await downloaded.data.arrayBuffer());
    if(bytes.length!==image.byte_length || digest(bytes)!==image.digest) throw new Error('Imported image hash mismatch');
  }
  return transaction(async db=>{
    const existing=(await db.query('SELECT manifest FROM crs.migration_runs WHERE source_hash=$1',[plan.sourceHash])).rows[0];
    if(existing) {
      if(!isDeepStrictEqual(existing.manifest,plan.manifest)) throw new Error('Import manifest collision; use the exact original source archives');
      return {alreadyCommitted:true};
    }
    for(const table of Object.values(tables)) {
      if((await db.query(`SELECT count(*)::integer AS total FROM crs.${table}`)).rows[0].total!==0) throw new Error('Destination changed during import; refusing overwrite');
    }
    for(const [name,rows] of Object.entries(plan.records)) for(const row of rows) await db.query(`INSERT INTO crs.${tables[name]}(data) VALUES($1::jsonb)`,[JSON.stringify(row)]);
    for(const row of plan.archive) await db.query('INSERT INTO crs.archive(id,source_hash,sheet,row_number,reason,raw) VALUES($1,$2,$3,$4,$5,$6)',[row.id,row.source_hash,row.sheet,row.row_number,row.reason,JSON.stringify(row.raw)]);
    for(const image of plan.images) await db.query("UPDATE crs.image_resources SET state='READY',verified_at=now() WHERE id=$1",[image.id]);
    await db.query('INSERT INTO crs.migration_runs(source_hash,manifest) VALUES($1,$2)',[plan.sourceHash,JSON.stringify(plan.manifest)]);
    return {alreadyCommitted:false};
  });
}
