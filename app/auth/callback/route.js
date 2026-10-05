import { oauthCallback } from '../../../server/auth.mjs';
import { callbackPage } from '../../../server/callback-page.mjs';
import { createAuthDiagnostics } from '../../../server/auth-diagnostics.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(request) {
  const diagnostic=createAuthDiagnostics();
  const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"};
  try {
    const result=await oauthCallback(new URL(request.url).searchParams,diagnostic);
    diagnostic.stage('CALLBACK_RENDER');
    const response=new Response(callbackPage(result),{headers});
    diagnostic.ready();
    return response;
  } catch(error) {diagnostic.failed(error);return new Response(callbackPage(),{headers,status:400});}
}
