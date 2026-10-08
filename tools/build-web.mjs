import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root=process.cwd(),output=join(root,'public','crs');
await mkdir(output,{recursive:true});
const read=name=>readFile(join(root,'src',name+'.html'),'utf8');
let index=await read('index');
const includes=[...index.matchAll(/<\?!= include_\('([^']+)'\); \?>/g)];
for(const match of includes){
  const name=match[1]; let text=await read(name);
  if(name==='scripts-api') text=text.replace(/  function serverRpc\(method, args\) \{[\s\S]*?\n  function randomBrowserSecret/,`  function serverRpc(method, args) {
    return global.CRS_SERVER_RPC(method, args || []).then(function(response) {
      if (response && response.ok) return response.data;
      throw new ClientApiError(response && response.error, response && response.meta && response.meta.requestId);
    }).catch(function(error) {
      if (error instanceof ClientApiError) throw error;
      throw new ClientApiError({code:'TRANSPORT_ERROR',message:'เชื่อมต่อระบบไม่สำเร็จ กรุณาลองใหม่',retryable:true});
    });
  }
  function randomBrowserSecret`);
  if(name==='scripts-dashboard') text=text.replace(/var match = \/\^https:[\s\S]*?if \(match\) global.location.assign\(match\[0\]/,
    'var match = global.CRS_CANONICAL_BASE(configured);\n      if (match) global.location.assign(configured');
  if(name==='scripts-qr') text=text.replace(/var match = \^?\/\^https:[\s\S]*?return match \? new URL\([\s\S]*? : null;/, 'return global.CRS_CANONICAL_BASE(configured);');
  if(name==='scripts-core') {
    // Thai is the Next default; retain a user's saved selection (including auto).
    text=text.replace("? saved : 'auto';", "? saved : 'th';").replace("catch (error) { return 'auto'; }", "catch (error) { return 'th'; }");
    text=text.replace(/const base = \/\^https:[\s\S]*?\? configured : '';/,"const base = global.CRS_CANONICAL_BASE(configured) ? configured : '';");
    text=text.replace("new URLSearchParams(parts[1] || '')", "new URLSearchParams(raw ? (parts[1] || '') : global.location.search)");
    text=text.replace(/!\/\^\[A-Za-z0-9\+\/\]\+\=\{0,2\}\$\/\.test\(result\.base64_data \|\| ''\) \|\|\s*result\.base64_data\.length > 14 \* 1024 \* 1024/, "!result.signed_url");
    const first=text.indexOf('      const binary = atob(result.base64_data);');
    const last=text.indexOf('      imageObjectUrls.set(image, objectUrl);',first);
    if(first<0||last<0) throw new Error('Image delivery seam changed');
    text=text.slice(0,first)+`      const capability = new URL(result.signed_url);
      if (capability.protocol !== 'https:' || !capability.hostname.endsWith('.supabase.co') ||
        !capability.pathname.includes('/storage/v1/object/sign/')) return;
      const response = await fetch(capability, { cache: 'no-store', referrerPolicy: 'no-referrer' });
      if (!response.ok) return;
      const blob = await response.blob();
      if (blob.type !== result.mime_type || blob.size > 10485760) return;
      if (!image.isConnected || image.dataset.imageRequestSerial !== serial) return;
      const objectUrl = URL.createObjectURL(blob);
`+text.slice(last);
    text=text.replace(/return \/\^https:\\\/\\\/drive[\s\S]*?\? url : '';/,"return url === '/api/image-placeholder' ? url : '';");
  }
  if(name==='scripts-admin') {
    text=text.replace(/actions.push\('<a class="btn btn-sm btn-outline-secondary" target="_blank" rel="noopener noreferrer" ' \+[\s\S]*?\/view">ตรวจสอบ<\/a>'\);/,
      `actions.push('<button type="button" class="btn btn-sm btn-outline-secondary" data-action="inspect-storage-resource" data-file-id="' + escape(issue.file_id) + '">ตรวจสอบ</button>');`);
    text=text.replace(/actions.push\('<a class="btn btn-sm btn-outline-secondary" target="_blank" rel="noopener noreferrer" ' \+[\s\S]*?ตรวจสอบโฟลเดอร์<\/a>'\);/,
      `actions.push('<span class="text-secondary">ตรวจผ่าน private Storage</span>');`);
    text=text.replace('ย้ายไปถังขยะ','จัดคิวล้างไฟล์');
  }
  if(name==='admin') text=text.replace('<div class="tab-content">',`<details class="card p-3 mb-3" data-migration-archive><summary>คลังข้อมูลต้นฉบับก่อนย้ายระบบ (อ่านอย่างเดียว)</summary>
    <p class="text-secondary mt-2">เก็บข้อมูลเดิมและแถวผิดรูปแบบ โดยไม่ให้สิทธิ์ใช้งานจาก archive</p>
    <button type="button" class="btn btn-outline-secondary" data-action="load-migration-archive">เปิดข้อมูล 100 แถวแรก</button>
    <div data-archive-results class="mt-3"></div><button type="button" class="btn btn-outline-secondary mt-2" data-action="archive-next" hidden>หน้าถัดไป</button>
    <hr><p class="text-secondary">ล้างเฉพาะไฟล์ที่อยู่ในคิวจากการเปลี่ยนภาพหรือ Admin Repair และพ้นช่วงรอ 2 ชั่วโมง 5 นาทีแล้ว</p>
    <button type="button" class="btn btn-outline-danger" data-action="cleanup-storage-queue">ประมวลผลคิวล้างภาพ</button>
    </details><div class="tab-content">`);
  if(name.startsWith('scripts-') || name.startsWith('vendor-')) {
    const code=text.replace(/^\s*<script[^>]*>/,'').replace(/<\/script>\s*$/,'');
    await writeFile(join(output,name+'.js'),code); text=`<script src="/crs/${name}.js"></script>`;
  }
  index=index.replace(match[0],text);
}
// Assert the transport seams so upstream changes fail a build, never silently
// ship Apps Script URLs or an unadapted base64 response validator.
for(const name of ['scripts-core','scripts-qr','scripts-dashboard','scripts-admin','scripts-api']) {
  const generated=await readFile(join(output,name+'.js'),'utf8');
  if(/drive\.google\.com|script\.google\.com|result\.base64_data/.test(generated)) throw new Error('Unadapted '+name+' seam');
}
index=index.replace('<?= initialView ?>','CRS_INITIAL_VIEW').replace('<?= initialAssetId ?>','CRS_INITIAL_ASSET');
index=index.replace('</head>','<link rel="stylesheet" href="/crs/experience.css"><script src="/crs/transport.js"></script></head>');
index=index.replace('</body>','<script src="/crs/migration-admin.js"></script></body>');
const loginControls=await readFile(join(root,'web','login-controls.html'),'utf8');
index=index.replace('<div class="startup-card access-card">','<div class="startup-card access-card text-center">');
index=index.replace('<p class="login-welcome">ยินดีต้อนรับกลับมา</p>','');
index=index.replace(/<span class="state-icon state-icon-warning mx-auto"[\s\S]*?<\/span>/,'');
const brandIcon=/(<span class="brand-mark(?: [^"]*)?"[^>]*>)\s*<i class="bi bi-box-seam"[^>]*><\/i>\s*(<\/span>)/g;
if(!brandIcon.test(index)) throw new Error('Brand mark composition seam changed');
index=index.replace(brandIcon,'$1<img src="/brand/icon-yuemkuen.png" alt="" width="44" height="44" decoding="async">$2');
index=index.replace(/        <button\s+id="google-signin-button"/,match=>loginControls+match);
if(!index.includes('id="password-login-form"')) throw new Error('Login composition seam changed');
const googleIcon=await readFile(join(root,'web','google-icon.svg'),'utf8');
if(!index.includes('<i class="bi bi-google me-2" aria-hidden="true"></i>')) throw new Error('Google icon seam changed');
index=index.replace('<i class="bi bi-google me-2" aria-hidden="true"></i>',googleIcon);
index=index.replace('</body>','<script src="/crs/guest-scene.js"></script><script src="/crs/experience.js"></script></body>');
await writeFile(join(output,'guest-scene.js'),await readFile(join(root,'web','guest-scene.js'),'utf8'));
await writeFile(join(output,'transport.js'),await readFile(join(root,'web','transport.js'),'utf8'));
await writeFile(join(output,'migration-admin.js'),await readFile(join(root,'web','migration-admin.js'),'utf8'));
await writeFile(join(output,'experience.js'),await readFile(join(root,'web','experience.js'),'utf8'));
await writeFile(join(output,'experience.css'),await readFile(join(root,'web','experience.css'),'utf8'));
if(index.includes('<?')) throw new Error('Unresolved Apps Script template');
await writeFile(join(output,'shell.html'),index);
