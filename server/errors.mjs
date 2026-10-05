import { randomUUID } from 'node:crypto';
export function fail(code, message = 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง', retryable = false,fieldErrors=null) {
  const error = new Error(message); error.name='AppError';error.code = code; error.retryable = retryable;error.fieldErrors=fieldErrors;throw error;
}
export async function envelope(work) {
  const requestId = randomUUID();
  try { return { ok: true, data: await work(), meta: { requestId } }; }
  catch (error) {
    const known=error.name==='AppError';
    // Never log credentials, tokens, payloads or database connection strings.
    console.error(JSON.stringify({ requestId, code: known ? error.code : 'INTERNAL' }));
    return { ok: false, error: { code: known ? error.code : 'INTERNAL',
      message: known ? error.message : 'ไม่สามารถดำเนินการได้ กรุณาลองใหม่อีกครั้ง',
      retryable: known ? Boolean(error.retryable) : true, fieldErrors: known ? error.fieldErrors || error.details?.fieldErrors || null : null }, meta: { requestId } };
  }
}
