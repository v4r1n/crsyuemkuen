import { rpc } from '../../../server/rpc.mjs';
import { config } from '../../../server/config.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function POST(request) {
  const headers={'Cache-Control':'no-store','Content-Type':'application/json'};
  // Bearer secrets are never cookies. Require same-origin browser requests too.
  if(request.headers.get('origin')!==config().WEB_APP_URL || !request.headers.get('content-type')?.startsWith('application/json')) return new Response('{}',{status:403,headers});
  const reader=request.body?.getReader(); let length=0,chunks=[];
  if(!reader) return new Response('{}',{status:400,headers});
  while(true) {
    const {done,value}=await reader.read(); if(done) break;
    length+=value.length;
    if(length>524288) { await reader.cancel(); return new Response('{}',{status:413,headers}); }
    chunks.push(Buffer.from(value));
  }
  let input;
  try {
    input=JSON.parse(Buffer.concat(chunks).toString('utf8'),(key,value)=>{
      if(['__proto__','constructor','prototype'].includes(key)) throw new Error('Unsafe key'); return value;
    });
  } catch { return new Response('{}',{status:400,headers}); }
  if(!input || typeof input.method!=='string') return new Response('{}',{status:400,headers});
  const token=(request.headers.get('authorization')||'').replace(/^Bearer /,'');
  const key=request.headers.get('x-vercel-forwarded-for')||request.headers.get('x-forwarded-for')||'local';
  return new Response(JSON.stringify(await rpc(input.method,input.args,token,key)),{headers});
}
