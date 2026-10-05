import { readFileSync } from 'node:fs';
import { join } from 'node:path';
export const runtime='nodejs';
export const dynamic='force-dynamic';
const routes=new Set(['dashboard','equipment','equipment-detail','borrow','my-borrow','history','admin','scan','account','settings']);
export async function GET(request) {
  const params=new URL(request.url).searchParams;
  const id=String(params.get('id')||params.get('asset_id')||'').trim().toUpperCase();
  const asset=/^AST-\d{6}$/.test(id)?id:'';
  let view=params.get('view')||params.get('route')||(asset?'equipment-detail':'dashboard');
  if(!routes.has(view)) view='dashboard';
  if(view==='equipment-detail' && !asset) view='equipment';
  const html=readFileSync(join(process.cwd(),'public','crs','shell.html'),'utf8')
    .replace('CRS_INITIAL_VIEW',view).replace('CRS_INITIAL_ASSET',asset);
  return new Response(html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}});
}
