import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { database,transaction } from '../server/db.mjs';
import { snapshotTables,reserveRestore,commitRestore,normalizeSnapshot } from './restore-records.mjs';
import { supabase,privateStorage,validateImage,storageMissing } from '../server/storage.mjs';
import { config } from '../server/config.mjs';
import { applyAdditiveMigrations } from '../server/migrations.mjs';
try{process.loadEnvFile('.env.local');}catch{}
const action=process.argv[2],pool=database();
const sql=await readFile(new URL('../supabase/migrations/202610050001_crs.sql',import.meta.url),'utf8');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
try{
  if(action==='migrate'){
    const existing=await pool.query("SELECT to_regclass('crs.equipment') AS name");
    if(existing.rows[0].name) {
      // Existence checks detect incomplete installs, not constraint drift.
      // A manually changed schema requires operator review, never a reset.
      for(const table of snapshotTables.filter(name=>!['password_credentials','security_mail','equipment_visibility','notifications'].includes(name))) if(!(await pool.query('SELECT to_regclass($1) AS name',['crs.'+table])).rows[0].name) throw new Error('Existing schema is incomplete');
      console.log('Schema already exists; not overwritten.');
    }else{await pool.query(sql);console.log('Transactional database schema installed.');}
    await applyAdditiveMigrations(transaction);
    const bucket=config().DRIVE_FOLDER_ID;
    const found=await supabase().storage.getBucket(bucket);
    if(found.error){
      if(Number(found.error.statusCode ?? found.error.status)!==404) throw new Error('Cannot verify Storage bucket access; provisioning stopped');
      const created=await supabase().storage.createBucket(bucket,{public:false,fileSizeLimit:10485760,allowedMimeTypes:['image/jpeg','image/png','image/webp','image/gif']});
      if(created.error) throw new Error('Private Storage provisioning failed');
    }
    await privateStorage(); console.log('Private image bucket verified.');
  }else if(action==='backup'){
    if(process.env.WRITE_FREEZE!=='true') throw new Error('Freeze writes before taking DB + Storage backup');
    const destination=resolve(process.argv[3]||join('.migration','backup-'+new Date().toISOString().replace(/[:.]/g,'-')));
    const storage=await privateStorage(); await mkdir(join(destination,'objects'),{recursive:true});
    const snapshot=await transaction(async db=>{
      const result={format:2,created_at:new Date().toISOString(),tables:{},objects:[]};
      for(const table of snapshotTables) result.tables[table]=(await db.query(`SELECT * FROM crs.${table} ORDER BY 1`)).rows;
      return result;
    });
    for(const resource of snapshot.tables.image_resources.filter(row=>row.state!=='TRASHED')){
      const downloaded=await storage.download(resource.object_key);
      if(resource.state==='STAGED' && storageMissing(downloaded.error) &&
        !snapshot.tables.equipment.some(row=>row.data.image_file_id===resource.id)) continue;
      if(downloaded.error || !downloaded.data) throw new Error('Image cannot be backed up; backup is incomplete');
      const bytes=Buffer.from(await downloaded.data.arrayBuffer());
      if(bytes.length!==resource.byte_length || downloaded.data.type!==resource.mime_type || validateImage(bytes,resource.mime_type,10485760)!==resource.digest) throw new Error('Backup image hash mismatch');
      const filename=sha(Buffer.from(resource.id))+'.bin';
      await writeFile(join(destination,'objects',filename),bytes);
      snapshot.objects.push({id:resource.id,filename,sha256:sha(bytes)});
    }
    const bytes=Buffer.from(JSON.stringify(snapshot,null,2));
    await writeFile(join(destination,'database.json'),bytes);
    await writeFile(join(destination,'sha256.txt'),sha(bytes)+'\n');
    console.log('Backup verified: database, archive, journal, image metadata and '+snapshot.objects.length+' image binaries. Sessions intentionally excluded.');
  }else if(action==='restore'){
    if(process.env.WRITE_FREEZE!=='true' || !process.argv.includes('--confirm-empty')) throw new Error('Restore requires WRITE_FREEZE=true and --confirm-empty; destination must be an empty provisioned project');
    const directory=resolve(process.argv[3]||''),bytes=await readFile(join(directory,'database.json'));
    if(sha(bytes)!==(await readFile(join(directory,'sha256.txt'),'utf8')).trim()) throw new Error('Backup manifest checksum mismatch');
    const snapshot=normalizeSnapshot(JSON.parse(bytes));
    if(snapshot.format!==2 || Object.keys(snapshot.tables).sort().join()!==snapshotTables.slice().sort().join()) throw new Error('Unknown backup format');
    const ids=snapshot.objects.map(item=>item.id);
    if(new Set(ids).size!==ids.length || snapshot.tables.image_resources.some(row=>row.state==='READY'&&!ids.includes(row.id))) throw new Error('Backup omits a READY image');
    // Reserve tracked objects before external writes; protect an interrupted
    // restore from untracked orphan creation just like the importer.
    await reserveRestore(snapshot,transaction);
    const storage=await privateStorage();
    for(const item of snapshot.objects){
      if(!/^[a-f0-9]{64}\.bin$/.test(item.filename)) throw new Error('Invalid backup path');
      const content=await readFile(join(directory,'objects',item.filename));
      if(sha(content)!==item.sha256) throw new Error('Backup object checksum mismatch');
      const row=snapshot.tables.image_resources.find(resource=>resource.id===item.id);
      if(!row || row.state==='TRASHED' || content.length!==row.byte_length || validateImage(content,row.mime_type,10485760)!==row.digest) throw new Error('Backup resource mismatch');
      const info=await storage.info(row.object_key);
      if(info.error) {
        if(!storageMissing(info.error)) throw new Error('Storage state uncertain; restore stopped');
        if((await storage.upload(row.object_key,content,{contentType:row.mime_type,upsert:false})).error) throw new Error('Restore upload failed');
      }
      const downloaded=await storage.download(row.object_key);
      if(downloaded.error || !downloaded.data || downloaded.data.type!==row.mime_type || sha(Buffer.from(await downloaded.data.arrayBuffer()))!==item.sha256) throw new Error('Restore image verification failed');
    }
    await commitRestore(snapshot,transaction);
    console.log('Restore committed to empty destination; all image hashes verified; new sign-in required.');
  }else throw new Error('Usage: node tools/database.mjs migrate | backup [private-directory] | restore <private-directory> --confirm-empty');
}finally{await pool.end();}
