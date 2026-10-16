import {timingSafeEqual,createHash} from 'node:crypto';
import {deliveryProcessor} from '../../../../server/notification-delivery.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export const maxDuration=60;
export async function GET(request) {
  const headers={'Cache-Control':'no-store'};
  const secret=process.env.CRON_SECRET;
  const given=request.headers.get('authorization')||'';
  if(!secret || secret.length<32 || given.length>512 || !timingSafeEqual(
    createHash('sha256').update('Bearer '+secret).digest(),createHash('sha256').update(given).digest()))return new Response('{}',{status:403,headers});
  try{return Response.json(await deliveryProcessor()(),{headers});}
  catch{console.error(JSON.stringify({code:'NOTIFICATION_WORKER_UNAVAILABLE'}));return new Response('{}',{status:503,headers});}
}
