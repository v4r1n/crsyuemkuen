import { createClient } from '@supabase/supabase-js';
import { config } from './config.mjs';
import { digest, createDomain } from './domain.mjs';
import { fail } from './errors.mjs';
let client;
export function serverSupabaseKey(env=process.env) {
  const key=env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || '';
  if(/^sb_secret_[A-Za-z0-9_-]{20,}$/.test(key)) return key;
  if(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key)) {
    try {
      if(JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString('utf8')).role==='service_role') return key;
    } catch {}
  }
  // Configuration validation only: Supabase still verifies the key's
  // authenticity. Never silently use a publishable/anon key for the backend.
  throw new Error('A Supabase server secret key is required; publishable/anon keys cannot access private Storage');
}
export function supabase() {
  if(!process.env.SUPABASE_URL) throw new Error('Supabase server configuration required');
  const key=serverSupabaseKey();
  client ||= createClient(process.env.SUPABASE_URL,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
  return client;
}
export async function privateStorage() {
  const bucket=config().DRIVE_FOLDER_ID;
  const {data,error}=await supabase().storage.getBucket(bucket);
  if(error || !data || data.public) fail('CONFIG_ERROR','Storage bucket ต้องเป็น private และ backend ต้องเข้าถึงได้');
  return supabase().storage.from(bucket);
}
export function validateImage(bytes,mime,max=config().MAX_IMAGE_BYTES) {
  if(!Buffer.isBuffer(bytes)) bytes=Buffer.from(bytes);
  if(bytes.length<=0 || bytes.length>max) fail('VALIDATION_FAILED','ไฟล์ภาพมีขนาดเกินกว่าที่ระบบกำหนด');
  const domain=createDomain({});
  domain.context.assertImageSignature_([...bytes],mime);
  if(!domain.context.IMAGE_MIME_TYPES[mime]) fail('VALIDATION_FAILED','รองรับเฉพาะ JPEG, PNG, WebP หรือ GIF');
  return digest(bytes);
}
// Only an explicit Storage 404 is evidence of absence. Access/rate/network
// failures and digest mismatches must never authorize abort or deletion.
export function storageMissing(error) {
  const code=error?.code ?? error?.error;
  return Number(error?.statusCode ?? error?.status)===404 && !['NoSuchBucket','InvalidJWT','AccessDenied'].includes(code);
}
export async function inspectResources(db,{bytes=false,storage}={}) {
  storage ||= await privateStorage();
  const rows=(await db.query('SELECT * FROM crs.image_resources')).rows;
  const images={};
  await Promise.all(rows.map(async row=>{
    const image=images[row.id]={...row,available:false,inspection:'UNKNOWN'};
    if(row.state==='TRASHED') {image.inspection='TRASHED';return;}
    let info;
    try {info=await storage.info(row.object_key);} catch {return;}
    if(info.error) {if(storageMissing(info.error)) image.inspection='MISSING';return;}
    if(!info.data) return;
    if(Number(info.data.size)!==row.byte_length || info.data.contentType!==row.mime_type) {image.inspection='MISMATCH';return;}
    if(bytes) {
      let downloaded;
      try {downloaded=await storage.download(row.object_key);} catch {return;}
      if(downloaded.error || !downloaded.data) {if(storageMissing(downloaded.error)) image.inspection='MISSING';return;}
      const content=Buffer.from(await downloaded.data.arrayBuffer());
      try {
        if(content.length!==row.byte_length || validateImage(content,row.mime_type,10485760)!==row.digest) {image.inspection='MISMATCH';return;}
      } catch { image.inspection='MISMATCH';return; }
      image.bytes=content;
    }
    image.available=true;image.inspection='AVAILABLE';
  }));
  return images;
}
export async function verifiedResource(db,id,storage) {
  storage ||= await privateStorage();
  const image=(await db.query('SELECT * FROM crs.image_resources WHERE id=$1 AND state<>\'TRASHED\'',[id])).rows[0];
  if(!image) fail('IMAGE_FILE_UNAVAILABLE','ไม่พบไฟล์ภาพ กรุณาอัปโหลดใหม่');
  const downloaded=await storage.download(image.object_key);
  if(downloaded.error || !downloaded.data) fail('IMAGE_FILE_UNAVAILABLE','ไม่สามารถอ่านไฟล์ภาพได้ กรุณาลองอัปโหลดใหม่',true);
  const bytes=Buffer.from(await downloaded.data.arrayBuffer());
  if(downloaded.data.type!==image.mime_type || bytes.length!==image.byte_length || validateImage(bytes,image.mime_type,10485760)!==image.digest) fail('STATE_CONFLICT','เนื้อหาไฟล์ไม่ตรงกับคำสั่งอัปโหลด');
  return {...image,available:true,bytes};
}
