(function(global){
  'use strict';
  async function send(method,args,token){
    const response=await fetch('/api/rpc',{method:'POST',cache:'no-store',headers:{'Content-Type':'application/json',...(token?{'Authorization':'Bearer '+token}:{})},body:JSON.stringify({method,args})});
    if(!response.ok) throw new Error('RPC transport failed');
    const result=await response.json();
    if(result.ok) global.dispatchEvent(new CustomEvent('crs:rpc-completed',{detail:{method}}));
    return result;
  }
  function digestBase64url(bytes){
    return crypto.subtle.digest('SHA-256',bytes).then(hash=>btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,''));
  }
  global.CRS_SERVER_RPC=async function(method,args){
    const index=method==='passwordSignIn'?0:method==='requestPasswordOtp'&&args[1]?.purpose!=='CHANGE'?1:-1;
    if(index>=0){
      const input={...args[index]};
      try{input.recaptchaToken=await global.CRSRecaptcha.token(index===0?'login':'reset');}
      catch{return {ok:false,error:{code:'RECAPTCHA_UNAVAILABLE',message:global.CRS?.language.effective()==='en'?'Security check unavailable. Try again or sign in with Google.':'ไม่สามารถตรวจสอบความปลอดภัยได้ กรุณาลองใหม่ หรือเข้าสู่ระบบด้วย Google',retryable:true}};}
      const parameters=args.slice();parameters[index]=input;
      try{return await send(method,index===0?parameters:parameters.slice(1),index===0?undefined:parameters[0]);}
      finally{delete input.recaptchaToken;}
    }
    if(['beginOAuthSignIn','completeOAuthSignIn','logoutSession','passwordSignIn','listPublicEquipment'].includes(method)) return send(method,args);
    const [token,...parameters]=args;
    if(method!=='adminUploadEquipmentImage') return send(method,parameters,token);
    const input=parameters[0],encoded=String(input.base64_data||'').replace(/^data:[^;]+;base64,/,'');
    const bytes=Uint8Array.from(atob(encoded),ch=>ch.charCodeAt(0));
    const hash=await digestBase64url(bytes);
    const prepared=await send('prepareEquipmentImage',[{asset_id:input.asset_id,command_id:input.command_id,expected_version:input.expected_version,mime_type:input.mime_type,byte_length:bytes.length,digest:hash}],token);
    if(!prepared.ok) return prepared;
    if(prepared.data.completed) return {...prepared,data:prepared.data.result};
    if(prepared.data.uploadUrl){
      const url=new URL(prepared.data.uploadUrl);
      if(url.protocol!=='https:' || !url.hostname.endsWith('.supabase.co') || !url.pathname.includes('/storage/v1/object/upload/sign/')) throw new Error('Invalid Storage upload capability');
      // Raw bytes bypass Vercel's request ceiling. Path cannot be overwritten.
      const uploaded=await fetch(url,{method:'PUT',headers:{'Content-Type':input.mime_type,'x-upsert':'false'},body:new Blob([bytes],{type:input.mime_type})});
      // A retry may race an already successful PUT. Finalize verifies actual bytes.
      if(!uploaded.ok && ![400,409].includes(uploaded.status)) throw new Error('Storage upload failed');
    }
    return send('finalizeEquipmentImage',[{command_id:input.command_id,resource_id:prepared.data.resourceId}],token);
  };
  global.CRS_CANONICAL_BASE=function(value){
    try{const url=new URL(value);if(url.username||url.password||url.search||url.hash||url.pathname!=='/'||!(url.protocol==='https:'||(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))))return null;return url;}catch{return null;}
  };
})(window);
