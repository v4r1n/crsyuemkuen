import sharp from 'sharp';
import {transaction} from './db.mjs';
import {rateLimit} from './auth.mjs';
import {digest} from './domain.mjs';
import {privateStorage,validateImage} from './storage.mjs';

const assetPattern=/^AST-\d{6}$/;
const mimeTypes=new Set(['image/png','image/jpeg','image/webp','image/gif']);
const headers={'Cache-Control':'private, no-store, max-age=0','CDN-Cache-Control':'no-store','Vercel-CDN-Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff','Cross-Origin-Resource-Policy':'same-origin','Referrer-Policy':'no-referrer'};
const resourceQuery=`SELECT r.*,e.data->>'row_version' AS row_version FROM crs.equipment e
  JOIN crs.equipment_visibility v ON v.asset_id=e.id AND v.is_public=true
  JOIN crs.categories c ON c.id=e.category_id AND c.status='ACTIVE'
  JOIN crs.image_resources r ON r.id=e.data->>'image_file_id' AND r.asset_id=e.id AND r.state='READY'
  WHERE e.status NOT IN ('DELETED','RETIRED','LOST') AND e.id=ANY($1::text[])`;
function eligible(resource,assetId){
  return resource?.asset_id===assetId&&resource.state==='READY'&&mimeTypes.has(resource.mime_type)&&
    Number.isSafeInteger(resource.byte_length)&&resource.byte_length>0&&resource.byte_length<=10485760&&
    /^[A-Za-z0-9_-]{43}$/.test(resource.digest||'');
}
const fingerprint=resource=>JSON.stringify([resource.id,resource.asset_id,resource.object_key,resource.mime_type,resource.byte_length,
  resource.digest,resource.state,resource.row_version,resource.operation_id,resource.owner_user_id]);
export async function publicThumbnailUrls(db,items,{storage}={}){
  if(!items.length)return {};
  const resources=(await db.query(resourceQuery,[items.map(item=>item.asset_id)])).rows;
  if(!resources.length)return {};
  const urls={};
  try{storage ||= await privateStorage();}catch{return urls;}
  // A catalog state hint is not delivery authority. The endpoint verifies full
  // bytes and current publication/reference again, even if this URL is stale.
  await Promise.all(resources.map(async resource=>{
    if(!items.some(item=>item.asset_id===resource.asset_id)||!eligible(resource,resource.asset_id))return;
    try{
      const info=await storage.info(resource.object_key);
      if(!info.error&&info.data&&Number(info.data.size)===resource.byte_length&&info.data.contentType===resource.mime_type)
        urls[resource.asset_id]='/api/public-equipment/'+resource.asset_id+'/thumbnail';
    }catch{/* Uncertain access keeps the placeholder. */}
  }));
  return urls;
}
export async function makeThumbnail(bytes){
  // First frame only, bounded decode/CPU, metadata stripped by default. Never
  // return an original or fall back to a signed Storage URL on failure.
  return sharp(bytes,{limitInputPixels:16777216,animated:false,pages:1,failOn:'warning'})
    .autoOrient().resize({width:320,height:212,fit:'inside',withoutEnlargement:true})
    .webp({quality:72,effort:2}).timeout({seconds:5}).toBuffer();
}
export function createPublicThumbnailHandler({transact=transaction,storageFactory=privateStorage,transform=makeThumbnail}={}){
  let active=0;
  const denied=status=>new Response(null,{status,headers:{...headers,...(status===429||status===503?{'Retry-After':'5'}:{})}});
  return async(request,assetId)=>{
    if(request.method!=='GET'||!assetPattern.test(assetId||'')||new URL(request.url).search)return denied(404);
    if(active>=2)return denied(503);
    active++;
    try{
      const requestKey=(request.headers.get('x-vercel-forwarded-for')||request.headers.get('x-forwarded-for')||'local').slice(0,512);
      const initial=await transact(async db=>{
        // Commit quotas before any external download/decode. Global quota
        // bounds distributed abuse; warm-instance capacity bounds concurrency.
        const ip=await rateLimit(db,'thumbnail:'+digest(requestKey),120,60);
        const global=await rateLimit(db,'thumbnail:global',300,60);
        if(!ip||!global)return {limited:true};
        return (await db.query(resourceQuery,[[assetId]])).rows[0]||null;
      });
      if(initial?.limited)return denied(429);
      if(!eligible(initial,assetId)||request.signal.aborted)return denied(404);
      const storage=await storageFactory(),download=await storage.download(initial.object_key);
      if(download.error||!download.data||download.data.type!==initial.mime_type||download.data.size!==initial.byte_length)return denied(404);
      const bytes=Buffer.from(await download.data.arrayBuffer());
      if(validateImage(bytes,initial.mime_type,10485760)!==initial.digest||request.signal.aborted)return denied(404);
      const thumbnail=await transform(bytes);
      if(!Buffer.isBuffer(thumbnail)||thumbnail.length>262144||request.signal.aborted)return denied(404);
      const current=await transact(async db=>(await db.query(resourceQuery,[[assetId]])).rows[0]);
      if(!eligible(current,assetId)||fingerprint(current)!==fingerprint(initial))return denied(404);
      return new Response(new Uint8Array(thumbnail),{headers:{...headers,'Content-Type':'image/webp','Content-Length':String(thumbnail.length)}});
    }catch{return denied(404);}finally{active--;}
  };
}
export const publicThumbnail=createPublicThumbnailHandler();
