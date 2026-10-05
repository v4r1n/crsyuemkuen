import { readFileSync } from 'node:fs';

export const release = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
export function config(env = process.env) {
  if(env.NODE_ENV==='production' && !env.WEB_APP_URL) throw new Error('Production WEB_APP_URL is required');
  const canonical = canonicalUrl(env.WEB_APP_URL);
  const domains = (env.ALLOWED_DOMAINS || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  return {
    APP_NAME: 'CRS Yuem-Kuen', APP_SHORT_NAME: 'CRS Yuem-Kuen', APP_VERSION: release,
    WEB_APP_URL: canonical, TIMEZONE: 'Asia/Bangkok', LOCALE: 'th_TH',
    DRIVE_FOLDER_ID: env.IMAGE_BUCKET || 'crs-images', IMAGE_SHARING: 'DOMAIN_WITH_LINK',
    ALLOWED_DOMAINS: domains, GOOGLE_OAUTH_CLIENT_ID: env.GOOGLE_OAUTH_CLIENT_ID || '',
    AUTO_PROVISION_USERS: false, MAX_PAGE_SIZE: 100, DEFAULT_PAGE_SIZE: 24,
    MAX_IMAGE_BYTES: integer(env.MAX_IMAGE_BYTES, 4194304, 1024, 10485760),
    AUTH_FLOW_TTL_SECONDS: integer(env.AUTH_FLOW_TTL_SECONDS, 600, 120, 1800),
    AUTH_SESSION_TTL_SECONDS: integer(env.AUTH_SESSION_TTL_SECONDS, 21600, 300, 21600)
  };
}
export function integer(value, fallback, min, max) {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new Error('Invalid numeric deployment configuration');
  return number;
}
export function canonicalUrl(value) {
  const url = new URL(value || 'http://localhost:3000');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new Error('WEB_APP_URL must be an explicit HTTPS application origin');
  }
  if (url.hostname === 'script.google.com' || url.hostname.endsWith('.googleusercontent.com')) throw new Error('Legacy browser URL is not a Next.js canonical origin');
  return url.origin;
}
