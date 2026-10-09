import {publicThumbnail} from '../../../../../server/public-thumbnail.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=30;
export async function GET(request,{params}){
  return publicThumbnail(request,(await params).assetId);
}
