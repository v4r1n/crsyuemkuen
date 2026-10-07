import nodemailer from 'nodemailer';
import { fail } from './errors.mjs';
const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
export function mailOptions(env = process.env) {
  const port = Number(env.SMTP_PORT);
  if (!env.SMTP_HOST || ![465,587].includes(port) || !env.SMTP_USER || !env.SMTP_PASSWORD || !emailPattern.test(env.SMTP_FROM || '')) {
    fail('EMAIL_UNAVAILABLE', 'ระบบส่งอีเมลยังไม่พร้อม กรุณาติดต่อผู้ดูแลระบบ');
  }
  return { host: env.SMTP_HOST, port, secure: port === 465, requireTLS: true,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD },
    tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true,
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 };
}
export async function sendSecurityEmail({to,kind,code,temporary,id}, transport) {
  if (!emailPattern.test(to || '')) fail('EMAIL_UNAVAILABLE', 'ไม่สามารถส่งอีเมลได้');
  const messages = {
    OTP: ['CRS Yuem-Kuen: รหัสยืนยัน / Verification code', 'รหัสยืนยัน / Verification code: ' + code + '\nหมดอายุใน 5 นาที ใช้ได้ครั้งเดียว ห้ามส่งรหัสให้ผู้อื่น\nExpires in 5 minutes. Use once. Never share this code.'],
    TEMPORARY_PASSWORD: ['CRS Yuem-Kuen: รหัสชั่วคราว / Temporary password', 'รหัสผ่านชั่วคราว / Temporary password: ' + temporary + '\nหมดอายุใน 24 ชั่วโมง คุณต้องเปลี่ยนรหัสผ่านก่อนใช้งาน\nหากไม่ได้คาดหมาย โปรดติดต่อผู้ดูแลระบบ\nExpires in 24 hours. Change before using CRS. If unexpected, contact your administrator.'],
    PASSWORD_CHANGED: ['CRS Yuem-Kuen: เปลี่ยนรหัสแล้ว / Password changed', 'รหัสผ่านของคุณถูกเปลี่ยนแล้ว session เดิมถูกเพิกถอน\nหากคุณไม่ได้ดำเนินการ โปรดติดต่อผู้ดูแลระบบทันที\nYour password changed and prior sessions were revoked. If you did not do this, contact your administrator immediately.']
  };
  if (!messages[kind] || (kind === 'OTP' && !/^\d{6}$/.test(code || '')) ||
    (kind === 'TEMPORARY_PASSWORD' && !/^[A-Za-z0-9_-]{32}$/.test(temporary || ''))) fail('EMAIL_UNAVAILABLE');
  const options = transport ? null : mailOptions();
  const sender = transport || nodemailer.createTransport(options);
  try {
    const result = await sender.sendMail({ from: process.env.SMTP_FROM || 'fixture@example.test', to,
      subject: messages[kind][0], text: messages[kind][1],
      messageId: '<' + id + '@crs.local>', disableFileAccess: true, disableUrlAccess: true });
    if (!Array.isArray(result.accepted) || !result.accepted.some(address => address.toLowerCase() === to.toLowerCase())) fail('EMAIL_UNAVAILABLE');
  } catch { fail('EMAIL_UNAVAILABLE', 'ไม่สามารถยืนยันการส่งอีเมลได้ กรุณาลองใหม่ภายหลัง'); }
  finally { if (!transport) sender.close(); }
}
