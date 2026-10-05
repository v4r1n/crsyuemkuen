import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from './config.mjs';
import { fields, keys, tables } from './schema.mjs';
import { fail } from './errors.mjs';

const modules = ['Config','Constants','Schema','Errors','Utils','Validation','ServiceUtils','DataStore',
  'Migrations','Auth','OperationService','HistoryService','CategoryService','UserService',
  'EquipmentService','BorrowService','DashboardService','IntegrityService','ImageService',
  'ImageIntegrityService','OperationAdminService','Api'];
const source = modules.map(name => readFileSync(new URL(`../src/${name}.gs`, import.meta.url),'utf8')).join('\n');
export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : Buffer.from(value)).digest('base64url');
export const secret = prefix => prefix + randomBytes(32).toString('base64url');
const copy = value => JSON.parse(JSON.stringify(value));

// Trusted, source-controlled domain code only; vm is NOT a security sandbox.
// Mutable records belong to this transaction, never a process-global cache.
export function createDomain(records, { session = null, proofs = {}, images = {}, runtimeConfig = config() } = {}) {
  const before = copy(records);
  const proofWrites = new Map(), cleanup = new Set();
  const context = vm.createContext({
    console: { error() {}, warn() {}, log() {} },
    Utilities: {
      getUuid: randomUUID, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_algorithm, input) => [...createHash('sha256').update(typeof input === 'string' ? input : Buffer.from(input)).digest()],
      base64EncodeWebSafe: input => Buffer.from(input).toString('base64url'),
      base64Encode: input => Buffer.from(input).toString('base64'),
      base64Decode: input => [...Buffer.from(input,'base64')],
      newBlob: (bytes,mime,name) => ({ getBytes: () => bytes, getContentType: () => mime, getName: () => name }),
      formatDate: (date,zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year:'numeric', month:'2-digit', day:'2-digit' }).format(date)
    },
    SpreadsheetApp: { flush() {} },
    CacheService: { getScriptCache: () => ({
      get: key => proofs[key]?.expiresAt > Date.now() ? JSON.stringify(proofs[key].data) : null,
      put: (key,text,ttl) => { const value={data:JSON.parse(text),expiresAt:Date.now()+ttl*1000}; proofs[key]=value; proofWrites.set(key,value); }
    }) }
  });
  vm.runInContext(source,context,{timeout:10000});
  const c = context;
  c.getRuntimeConfig_ = () => runtimeConfig;
  c.createOAuthRandomValue_ = secret; c.sha256Base64Url_ = digest;
  c.requireApplicationSession_ = () => {
    if (!session || session.expiresAt <= Date.now()/1000 || session.clientId !== runtimeConfig.GOOGLE_OAUTH_CLIENT_ID ||
      !runtimeConfig.ALLOWED_DOMAINS.includes(session.email?.split('@')[1])) fail('UNAUTHENTICATED','กรุณาลงชื่อเข้าใช้อีกครั้ง');
    return session;
  };
  c.withScriptLock_ = callback => callback(); // Outer SQL transaction owns the advisory lock.
  c.cacheGetJson_ = () => null; c.cachePutJson_ = () => false; c.bumpCacheEpoch_ = () => '1'; c.getCacheEpoch_ = () => '1';
  c.getWebAppBaseUrl_ = () => runtimeConfig.WEB_APP_URL;
  c.normalizeWebAppExecUrl_ = () => runtimeConfig.WEB_APP_URL;
  c.listRecords_ = table => records[table] || [];
  c.readTable_ = table => ({ records: c.listRecords_(table), headers: fields[table] });
  c.findRecordByField_ = (table,field,value,insensitive) => c.listRecords_(table).find(row =>
    insensitive ? c.normalizeWhitespace_(row[field]).toLowerCase()===c.normalizeWhitespace_(value).toLowerCase() : String(row[field])===String(value)) || null;
  c.findRecordById_ = (table,field,value) => c.findRecordByField_(table,field,value,false);
  c.getFieldValues_ = (table,field) => c.listRecords_(table).map(row=>row[field]);
  c.getFieldValueSet_ = (table,field) => Object.fromEntries(c.getFieldValues_(table,field).filter(Boolean).map(value=>[value,true]));
  c.insertRecord_ = (table,record) => {
    c.assertKnownRecordFields_(fields[table],record,table);
    if(c.findRecordById_(table,keys[table],record[keys[table]])) fail('STATE_CONFLICT','รหัสข้อมูลซ้ำ');
    const row=Object.fromEntries(fields[table].map(field=>[field,record[field]??'']));
    row.__rowNumber=(records[table]?.length||0)+2; (records[table] ||= []).push(row); return copy(row);
  };
  c.insertRecords_ = (table,rows) => rows.map(row=>c.insertRecord_(table,row));
  c.updateRecordById_ = (table,field,id,changes) => {
    c.assertKnownRecordFields_(fields[table],changes,table);
    const row=c.findRecordById_(table,field,id);
    if(!row) fail('NOT_FOUND','ไม่พบข้อมูล');
    if(table==='History' || (changes[field]!==undefined && changes[field]!==row[field])) fail('STATE_CONFLICT','ไม่สามารถเปลี่ยนรหัสหรือ History ได้');
    Object.assign(row,changes); return copy(row);
  };
  c.updateRecordsById_ = (table,field,updates) => updates.map(update=>c.updateRecordById_(table,field,update.id,update.changes));
  c.upsertRecordByField_ = (table,field,value,row) => c.findRecordByField_(table,field,value,false)
    ? c.updateRecordById_(table,field,value,row) : c.insertRecord_(table,row);
  c.equipmentImageState_ = id => ({ imageAvailable: Boolean(images[id]?.available),
    image_url: images[id]?.available ? '/api/image-placeholder' : '' });
  // Placeholder URL is only a transport hook. Browser asks authenticated API for
  // a short-lived private capability; stale Drive URLs are never trusted.
  c.buildDriveImageUrl_ = id => `storage:${id}`;
  c.isDriveImageUrlForFile_ = (url,id) => url === `storage:${id}`;
  c.getImageFileIfPresent_ = id => images[id]?.available ? storageFile(images[id]) : null;
  c.inspectImageFileReference_ = id => ({ state: images[id]?.state === 'TRASHED' ? 'TRASHED' : images[id]?.available ? 'AVAILABLE' : images[id]?.inspection==='MISSING' ? 'MISSING' : id ? 'UNKNOWN' : 'NONE', file:c.getImageFileIfPresent_(id) });
  c.getImageFolder_ = id => ({ getId:()=>id, getFiles:()=>iterator(Object.values(images).filter(x=>x.folder_id===id && x.available).map(storageFile)),
    getFilesByName:name=>iterator(Object.values(images).filter(x=>x.name===name && x.folder_id===id && x.available).map(storageFile)) });
  c.assertImageFolderSharingPolicy_ = () => {};
  c.applyImageSharing_ = () => {}; // Private bucket enforced by Storage adapter, not Drive ACLs.
  c.assertRecoverableImageEvidence_ = (file,operation,payload) => {
    const image=images[file.getId()];
    c.assertApp_(image && image.asset_id===operation.asset_id && image.operation_id===operation.operation_id &&
      image.folder_id===payload.folderId && image.name===operation.asset_id+'-'+operation.operation_id+'.'+c.IMAGE_MIME_TYPES[payload.mimeType] &&
      (image.owner_user_id===operation.actor_user_id || image.original?.verified_import===true) &&
      c.imageFileMatches_(file,payload.digest,payload.mimeType,payload.byteLength), 'STATE_CONFLICT','หลักฐานไฟล์ภาพไม่ตรงกับ operation',null,false);
  };
  c.imageFileMatches_ = (file,hash,mime,size) => {
    const image=images[file?.getId()]; return Boolean(image?.available && image.digest===hash && image.mime_type===mime && Number(image.byte_length)===Number(size));
  };
  c.imageIntegrityFileOwnedByDeployer_ = file => Boolean(images[file.getId()]);
  c.trashReplacedImageAfterCommit_ = (op,old,current) => {
    if(op.status==='COMPLETED' && old?.image_file_id && old.image_file_id!==current.image_file_id && images[old.image_file_id]) cleanup.add(old.image_file_id);
  };
  c.trashNewImageQuietly_ = () => {}; // SQL rollback keeps staged resource for recovery, never deletes committed image.
  c.getSpreadsheet_ = () => ({ getSheets:()=>Object.keys(records).map(name=>({getName:()=>name})) });
  return { context:c, records, proofWrites, cleanup,
    invoke: (method,args=[]) => {
      const result=c[method](...args);
      return copy(result);
    },
    changes: () => Object.keys(tables).flatMap(table=>(records[table]||[]).filter(row=>{
      const old=(before[table]||[]).find(x=>x[keys[table]]===row[keys[table]]);
      return JSON.stringify(old)!==JSON.stringify(row);
    }).map(row=>({table,id:row[keys[table]],data:Object.fromEntries(fields[table].map(field=>[field,row[field]??''])),isNew:!(before[table]||[]).some(x=>x[keys[table]]===row[keys[table]])})))
  };
  function storageFile(image) {
    return { getId:()=>image.id, getName:()=>image.name, getSize:()=>image.byte_length, getMimeType:()=>image.mime_type,
      isTrashed:()=>image.state==='TRASHED', getResourceKey:()=>'', getOwner:()=>({getEmail:()=> 'storage-owner'}),
      getParents:()=>iterator([{getId:()=>image.folder_id}]),
      getBlob:()=>({getBytes:()=>{if(!image.bytes) throw new Error('Image bytes not loaded');return [...image.bytes];},getContentType:()=>image.mime_type}),
      setTrashed:()=>cleanup.add(image.id) };
  }
}
function iterator(values) { let index=0; return {hasNext:()=>index<values.length,next:()=>values[index++]}; }

export async function loadDomain(client, options={}) {
  const records={};
  for(const [name,table] of Object.entries(tables)) {
    const rows=await client.query(`SELECT data FROM crs.${table} ORDER BY id`);
    records[name]=rows.rows.map((row,index)=>({...row.data,__rowNumber:index+2}));
  }
  const proofs=Object.fromEntries((await client.query('SELECT id,data,expires_at FROM crs.proofs WHERE expires_at > now()')).rows.map(row=>[row.id,{data:row.data,expiresAt:new Date(row.expires_at).getTime()}]));
  return createDomain(records,{...options,proofs});
}
export async function saveDomain(client, domain) {
  for(const change of domain.changes()) {
    if(change.isNew) await client.query(`INSERT INTO crs.${tables[change.table]}(data) VALUES($1::jsonb)`,[JSON.stringify(change.data)]);
    else await client.query(`UPDATE crs.${tables[change.table]} SET data=$1::jsonb WHERE id=$2`,[JSON.stringify(change.data),change.id]);
  }
  for(const [id,proof] of domain.proofWrites) await client.query('INSERT INTO crs.proofs(id,data,expires_at) VALUES($1,$2,to_timestamp($3)) ON CONFLICT(id) DO UPDATE SET data=excluded.data,expires_at=excluded.expires_at',[id,JSON.stringify(proof.data),proof.expiresAt/1000]);
  for(const id of domain.cleanup) await client.query('INSERT INTO crs.cleanup_jobs(id) VALUES($1) ON CONFLICT DO NOTHING',[id]);
}
