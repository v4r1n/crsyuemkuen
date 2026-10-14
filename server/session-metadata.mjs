import { randomUUID } from 'node:crypto';

// Coarse labels only, from the HTTP User-Agent. They are self-reported hints,
// NEVER an authorization factor. Do not persist raw UA, IP or location.
export function deviceLabels(userAgent = '') {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0,512) : '';
  const browser = /Edg(A|iOS)?\//.test(ua) ? 'Microsoft Edge' : /Firefox\/|FxiOS\//.test(ua) ? 'Firefox' :
    /Chrome\/|CriOS\//.test(ua) ? 'Chrome' : /Version\/.+Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' :
    /Windows/.test(ua) ? 'Windows' : /Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  return {browser,os};
}
export function newSessionMetadata(userAgent, instant = new Date().toISOString()) {
  return {publicId:randomUUID(),createdAt:instant,lastActiveAt:instant,...deviceLabels(userAgent)};
}
export async function touchSession(db, hash, session) {
  // Preserve absolute expiry. Old sessions have genuinely unknown creation/device
  // metadata; only an observed authenticated use supplies lastActiveAt.
  const previous = Date.parse(session.lastActiveAt || '');
  if (Number.isFinite(previous) && Date.now() - previous < 60000) return;
  await db.query(`UPDATE crs.sessions SET data=data || jsonb_build_object('lastActiveAt',$2::text)
    WHERE id=$1`,[hash,new Date().toISOString()]);
}
