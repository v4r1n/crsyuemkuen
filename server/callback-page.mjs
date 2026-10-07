import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const source=readFileSync(new URL('../src/OAuthService.gs',import.meta.url),'utf8');
const presentation=readFileSync(new URL('../web/auth-callback.css',import.meta.url),'utf8');

// Preserve the accessible callback controls/behavior, with a presentation-only layer.
export function callbackPage(result=null) {
  if(result && (!/^\d{6}$/.test(result.otp) || !/^[A-Za-z0-9_-]{43}$/.test(result.flowHash) || !/^copy1_[A-Za-z0-9_-]{43}$/.test(result.copyToken))) throw new Error('Invalid callback output');
  const context=vm.createContext({HtmlService:{createHtmlOutput:html=>({html,setTitle(){return this;}})}});
  vm.runInContext(source,context,{timeout:1000});
  let html=context.createOAuthCallbackOutput_(result?{handoffCode:result.otp,flowId:result.flowHash,copyToken:result.copyToken}:null).html;
  html=html.replace('</style>',presentation+'</style>');
  if(result) {
    const original='google.script.run.withSuccessHandler(done).withFailureHandler(done).acknowledgeOAuthOtpCopy("'+result.flowHash+'","'+result.copyToken+'");';
    if(!html.includes(original)) throw new Error('Callback transport seam changed');
    html=html.replace(original,"fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'acknowledgeOAuthCopy',args:"+JSON.stringify([result.flowHash,result.copyToken])+"})}).then(done,done);");
  }
  return html;
}
