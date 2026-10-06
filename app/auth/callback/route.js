import { oauthCallback } from '../../../server/auth.mjs';
import { callbackPage } from '../../../server/callback-page.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request) {
  const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"};
  try {
    const result=await oauthCallback(new URL(request.url).searchParams);
    return new Response(callbackPage(result),{headers});
  } catch {return new Response(callbackPage(),{headers,status:400});}
}
