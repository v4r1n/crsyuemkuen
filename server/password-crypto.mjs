import { scrypt, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { fail } from './errors.mjs';
const derive = promisify(scrypt);
const options = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 });
const blocked = new Set(['passwordpassword', '123456789012345', 'qwertyuiopasdfgh', 'letmeinletmein12', 'administrator123']);
export function normalizePassword(value) {
  if (typeof value !== 'string' || value.length > 512) return '';
  return value.normalize('NFC');
}
export function validPassword(value, email = '') {
  const password = normalizePassword(value), length = [...password].length;
  const lower = password.toLowerCase();
  return length >= 15 && length <= 128 && !/[\u0000-\u001f\u007f]/u.test(password) &&
    !blocked.has(lower) && new Set(password).size >= 4 &&
    (!email || !lower.includes(email.toLowerCase())) && !/^(.)\1+$/u.test(password);
}
export function assertPassword(value, email) {
  if (!validPassword(value, email)) fail('PASSWORD_POLICY', 'ใช้รหัสผ่าน 15–128 ตัวอักษรที่ไม่ใช่รหัสทั่วไปหรืออีเมลของคุณ');
  return normalizePassword(value);
}
export async function hashPassword(value) {
  const salt = randomBytes(16);
  const result = await derive(normalizePassword(value), salt, 32, options);
  return 'scrypt$131072$8$1$' + salt.toString('base64url') + '$' + result.toString('base64url');
}
export async function verifyPassword(value, encoded) {
  const match = /^scrypt\$131072\$8\$1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{43})$/.exec(String(encoded || ''));
  // Unknown accounts do the same bounded memory-hard work; never shortcut to a fast hash.
  const salt = match ? Buffer.from(match[1], 'base64url') : Buffer.alloc(16, 71);
  const expected = match ? Buffer.from(match[2], 'base64url') : Buffer.alloc(32);
  const result = await derive(normalizePassword(value), salt, 32, options);
  return Boolean(match && timingSafeEqual(result, expected));
}
export const temporaryPassword = () => randomBytes(24).toString('base64url');
export function emailOtpHash(id, otp) {
  const key = process.env.PASSWORD_OTP_SECRET;
  if (typeof key !== 'string' || key.length < 32) fail('CONFIG_ERROR', 'กรุณาตั้งค่าระบบยืนยันทางอีเมล');
  return createHmac('sha256', key).update('crs:password-otp:v1|' + id + '|' + otp).digest('base64url');
}
export const safeEqual = (a,b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
