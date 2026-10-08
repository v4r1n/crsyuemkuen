import {publicRecaptcha} from '../../../../server/recaptcha.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export function GET(){
  const headers={'Cache-Control':'no-store'};
  try{return Response.json(publicRecaptcha(),{headers});}
  catch{return Response.json({error:'RECAPTCHA_UNAVAILABLE'},{status:503,headers});}
}
