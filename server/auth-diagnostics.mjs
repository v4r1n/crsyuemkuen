import { randomUUID } from 'node:crypto';

// Temporary, opt-in Preview diagnostics. Never accept arbitrary log fields,
// error messages/stacks, query strings, identities or authorization material.
const stages=new Set(['CALLBACK_INPUT','FLOW_CLAIM','PROVIDER_CALLBACK','CONFIGURATION',
  'TOKEN_EXCHANGE','TOKEN_VERIFICATION','IDENTITY_CLAIMS','FLOW_RECHECK','USERS_LOAD',
  'USER_AUTHORIZATION','OTP_COMMIT','FLOW_DENIAL','CALLBACK_RENDER','CALLBACK_READY']);
const codes=new Set(['UNAUTHENTICATED','FORBIDDEN','USER_DISABLED','CONFIG_ERROR',
  'ERR_JWT_EXPIRED','ERR_JWT_CLAIM_VALIDATION_FAILED','ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  'ERR_JWS_INVALID','ERR_JWT_INVALID','ERR_JWK_INVALID','ERR_JWKS_INVALID',
  'ERR_JWKS_NO_MATCHING_KEY','ERR_JWKS_MULTIPLE_MATCHING_KEYS','ERR_JWKS_TIMEOUT',
  'ERR_JOSE_ALG_NOT_ALLOWED','ERR_JOSE_GENERIC','ERR_JOSE_NOT_SUPPORTED',
  'SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENOTFOUND',
  '28P01','42P01','42501','42703','08006','57014','55P03','53300']);
const providerErrors=new Set(['invalid_request','invalid_client','invalid_grant',
  'unauthorized_client','unsupported_grant_type','invalid_scope','access_denied',
  'server_error','temporarily_unavailable']);

export function createAuthDiagnostics() {
  const enabled=process.env.AUTH_DIAGNOSTICS==='true' && process.env.VERCEL_ENV!=='production';
  const requestId=randomUUID(), reported=new WeakSet();
  let stage='CALLBACK_INPUT',providerStatus,providerError;
  function emit(code,outcome) {
    if(!enabled) return;
    // Diagnostics must never influence authentication or denial transactions.
    try {
      const event={requestId,stage,code,outcome};
      if(stage==='TOKEN_EXCHANGE' && providerStatus!==undefined) {
        event.providerStatus=providerStatus;event.providerError=providerError;
      }
      console.error('[DEBUG-crs-oauth-v1] '+JSON.stringify(event));
    } catch { /* A failed log sink must not change authorization. */ }
  }
  return {
    stage(value){if(stages.has(value)) stage=value;},
    providerResponse(status,error){
      if(Number.isInteger(status) && status>=400 && status<=599) providerStatus=status;
      providerError=providerErrors.has(error)?error:'OTHER';
    },
    failed(error){
      if(!enabled) return;
      try {
        if(error && typeof error==='object') {
          if(reported.has(error)) return;
          reported.add(error);
        }
        emit(codes.has(error?.code)?error.code:'INTERNAL','DENIED');
      } catch { /* Never inspect/stringify unknown error objects. */ }
    },
    ready(){stage='CALLBACK_READY';emit('OK','READY');}
  };
}
