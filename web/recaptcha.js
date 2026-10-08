/* Lazy, per-action proof. Never cache/store/log tokens or change OAuth. */
(function(global){
  'use strict';
  let ready=null;
  const message=()=>global.CRS?.language.effective()==='en'?'Security check unavailable. Try again or sign in with Google.':'ไม่สามารถตรวจสอบความปลอดภัยได้ กรุณาลองใหม่ หรือเข้าสู่ระบบด้วย Google';
  const failure=()=>new Error(message());
  async function load(){
    const response=await fetch('/api/auth/recaptcha',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(8000)});
    if(!response.ok)throw failure();
    const policy=await response.json();
    if(!/^[A-Za-z0-9_-]{20,200}$/.test(policy.siteKey||'')||!policy.actions||
      !['login','reset'].every(key=>/^[A-Za-z0-9_/]{1,100}$/.test(policy.actions[key]||'')))throw failure();
    await new Promise((resolve,reject)=>{
      let script=null;
      const timer=global.setTimeout(()=>{script?.remove();reject(failure());},10000);
      const finish=()=>{if(!global.grecaptcha?.ready||!global.grecaptcha?.execute){clearTimeout(timer);reject(failure());return;}
        global.grecaptcha.ready(()=>{clearTimeout(timer);resolve();});};
      if(global.grecaptcha?.execute){finish();return;}
      script=document.createElement('script');script.src='https://www.google.com/recaptcha/api.js?render='+encodeURIComponent(policy.siteKey);
      script.async=true;script.onerror=()=>{clearTimeout(timer);script.remove();reject(failure());};script.onload=finish;
      document.head.append(script);
    });
    return policy;
  }
  async function token(purpose){
    let proof;
    try{
      // Only SDK/config readiness is shared, never a proof. A rejected load may
      // be retried; each submit still executes a fresh action-bound challenge.
      if(!ready)ready=load().catch(()=>{ready=null;throw failure();});
      const policy=await ready;if(!['login','reset'].includes(purpose))throw failure();
      proof=await new Promise((resolve,reject)=>{
        const timer=global.setTimeout(()=>reject(failure()),10000);
        Promise.resolve().then(()=>global.grecaptcha.execute(policy.siteKey,{action:policy.actions[purpose]})).then(
          value=>{clearTimeout(timer);resolve(value);},()=>{clearTimeout(timer);reject(failure());});
      });
      if(typeof proof!=='string'||!proof.length||proof.length>8192)throw failure();
      return proof;
    }catch{throw failure();}
    finally{proof=undefined;}
  }
  global.CRSRecaptcha=Object.freeze({token});
})(window);
