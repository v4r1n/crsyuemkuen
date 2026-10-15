import { readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {localizeScript} from './localize-ui.mjs';
const root=process.cwd(),output=join(root,'public','crs');
await mkdir(output,{recursive:true});
const read=name=>readFile(join(root,'src',name+'.html'),'utf8');
let index=await read('index');
index=index.replace('</head>',`<script src="/crs/i18n.js"></script><script>
// A blocked optional copy asset must not break the original auth/bootstrap.
window.CRSI18n = window.CRSI18n || Object.freeze({text:function(value){return value;},read:function(){try{return localStorage.getItem('crs-ui-language')==='en'?'en':'th';}catch{return 'th';}},staticUI:function(){},reload:function(){window.location.reload();}});
</script></head>`);
const uiCopy=JSON.parse(await readFile(join(root,'web','ui-copy.json'),'utf8'));
await writeFile(join(output,'i18n.js'),'window.CRS_UI_COPY='+JSON.stringify(uiCopy)+';\n'+await readFile(join(root,'web','i18n.js'),'utf8'));
const includes=[...index.matchAll(/<\?!= include_\('([^']+)'\); \?>/g)];
for(const match of includes){
  const name=match[1]; let text=await read(name);
  const removedEyebrows={dashboard:'พื้นที่ทำงานของคุณ',equipment:'ค้นหาอุปกรณ์สำหรับงานของคุณ',scan:'ค้นหาอุปกรณ์จากสติกเกอร์',admin:'จัดการทุกอย่างได้ในที่เดียว'};
  if(Object.hasOwn(removedEyebrows,name)) {
    const paragraph=new RegExp('\\s*<p class="eyebrow [^"]*">'+removedEyebrows[name]+'<\\/p>');
    if(!paragraph.test(text))throw new Error('Page eyebrow composition seam changed: '+name);
    text=text.replace(paragraph,'');
  }
  if(name==='scripts-api') {
    if(!text.includes("'adminGetEquipmentVisibility'].indexOf(method)") || !text.includes('    requestSecurity: function (method,input) {'))throw new Error('Settings security auth composition seam changed');
    text=text.replace("'adminGetEquipmentVisibility'].indexOf(method)","'adminGetEquipmentVisibility','getSettingsSecurity','listActiveSessions','revokeOtherSessions','listSecurityActivity','getNotificationPreferences','saveNotificationPreference','getOwnProfile','saveOwnName','prepareOwnAvatar','finalizeOwnAvatar','getOwnAvatar'].indexOf(method)");
    text=text.replace('    requestSecurity: function (method,input) {', `    rememberSession: function () { return Boolean(storageGet(global.localStorage, AUTH_SESSION_STORAGE_KEY)); },
    setRememberSession: function (remember) {
      if (typeof remember !== 'boolean' || !authState.sessionToken) throw new ClientApiError({code:'UNAUTHENTICATED'});
      const record=parseStoredSession(JSON.stringify({version:1,token:authState.sessionToken,expiresAt:authState.sessionExpiresAt}));
      const target=remember ? global.localStorage : global.sessionStorage;
      if(!record || !storageSet(target,AUTH_SESSION_STORAGE_KEY,JSON.stringify(record))) throw new ClientApiError({code:'CLIENT_STORAGE_UNAVAILABLE'});
      storageRemove(remember ? global.sessionStorage : global.localStorage,AUTH_SESSION_STORAGE_KEY);
      storageSet(global.localStorage,AUTH_REMEMBER_STORAGE_KEY,remember ? 'true' : 'false');
      const checkbox=document.querySelector('#remember-session');if(checkbox)checkbox.checked=remember;
    },
    requestSecurity: function (method,input) {`);
  }
  if(name==='styles')text=text.replace(/\s*\.login-orbit \{[^}]*\}/,'');
  if(name==='styles') {
    const inlineHandoffStory='.login-layout:has(#oauth-handoff-panel:not([hidden])) .login-story { display: none; }';
    if(text.split(inlineHandoffStory).length!==2)throw new Error('Inline OAuth story composition seam changed');
    text=text.replace(inlineHandoffStory,'');
  }
  if(name==='my-borrow') {
    const tabs=/<ul class="nav nav-tabs mb-4" id="my-borrow-tabs" role="tablist">[\s\S]*?<\/ul>/;
    const list=/<section id="my-borrow-list-pane" class="tab-pane fade show active" role="tabpanel"\s+aria-labelledby="my-borrow-list-tab" tabindex="0">/;
    const history=/<section id="my-borrow-history-pane" class="tab-pane fade" role="tabpanel"\s+aria-labelledby="my-borrow-history-tab" tabindex="0">/;
    if(!tabs.test(text)||!list.test(text)||!history.test(text))throw new Error('Borrow route pane composition seam changed');
    text=text.replace(tabs,'').replace('aria-labelledby="my-borrow-title"','aria-labelledby="page-title"')
      .replace('<div class="tab-content">','<div class="borrow-route-content">')
      .replace(list,'<section id="my-borrow-list-pane" aria-labelledby="page-title">')
      .replace(history,'<section id="my-borrow-history-pane" aria-labelledby="page-title" hidden>');
  }
  if(name==='scripts-borrow') {
    const tabListener=/    CRS\.\$\('#my-borrow-history-tab', page\)\.addEventListener\('shown\.bs\.tab', function \(\) \{\s+if \(!state\.historyLoaded\) loadHistory\(\);\s+\}\);/;
    const selection=/    await loadList\(\);\s+if \(params\.tab === 'history'\) \{\s+bootstrap\.Tab\.getOrCreateInstance\(CRS\.\$\('#my-borrow-history-tab', page\)\)\.show\(\);\s+\}/;
    if(!tabListener.test(text)||!selection.test(text))throw new Error('Borrow route selection composition seam changed');
    text=text.replace(tabListener,'').replace(selection,`    const showHistory = params.tab === 'history';
    CRS.$('#my-borrow-list-pane', page).hidden = showHistory;
    CRS.$('#my-borrow-history-pane', page).hidden = !showHistory;
    if (showHistory) await loadHistory();
    else await loadList();`);
  }
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
    const confirmLabel="    confirmButton.textContent = settings.confirmText || 'ยืนยัน';";
    if(text.split(confirmLabel).length!==2)throw new Error('Confirmation readiness composition seam changed');
    text=text.replace(confirmLabel,confirmLabel+`
    const confirmTrigger=document.activeElement;
    // Bootstrap ignores hide() during its entrance transition. Keep the
    // confirmation pending until shown, then allow the ordinary accept path.
    confirmButton.disabled=true;
    modalElement.addEventListener('shown.bs.modal',function(){confirmButton.disabled=false;},{once:true});
    modalElement.addEventListener('hide.bs.modal',function(){
      if(modalElement.contains(document.activeElement))document.activeElement.blur();
    },{once:true});`);
    const confirmFinish="        modalElement.removeEventListener('hidden.bs.modal', finish);";
    if(text.split(confirmFinish).length!==2)throw new Error('Confirmation focus composition seam changed');
    text=text.replace(confirmFinish,confirmFinish+"\n        if(confirmTrigger && confirmTrigger.isConnected && !confirmTrigger.disabled)confirmTrigger.focus({preventScroll:true});");
    const storageSection="    { key: 'storage', label: 'Storage', icon: 'bi-folder' },";
    const profileNav="    const navItem = function (item) {";
    const accountEnd="  CRS.registerRoute('account', renderAccount);";
    if(!text.includes(storageSection)||!text.includes(profileNav)||!text.includes(accountEnd))throw new Error('Profile navigation composition seam changed');
    text=text.replace(storageSection,'').replace(profileNav,profileNav+`
      if(item.key==='profile') return '<a class="settings-nav-item settings-profile-link" data-route="account" title="Profile"><i class="bi bi-person" aria-hidden="true"></i><span>Profile</span><i class="bi bi-arrow-up-right settings-profile-arrow" aria-hidden="true"></i></a>';`);
    text=text.replace('  function renderSettings(params) {',`  function renderSettings(params) {
    if(params && params.section==='profile') { CRS.navigate('account'); return; }`);
    text=text.replace("section.querySelectorAll('[data-settings-section]').forEach(function (item)","section.querySelectorAll('.settings-nav-item').forEach(function (item)");
    text=text.replace("link.href = base + '?view=' + encodeURIComponent(link.dataset.route);","link.href = link.classList.contains('settings-profile-link') ? base.replace(/\\/$/,'') + '/#account?view=account' : base + '?view=' + encodeURIComponent(link.dataset.route);");
    text=text.replace("{ key: 'general', label: 'General'", "{ key: 'general', label: 'การตั้งค่าทั่วไป'")
      .replace("{ key: 'security', label: 'Security and login'", "{ key: 'security', label: 'ความปลอดภัยและการลงชื่อเข้าใช้'")
      .replace('data-settings-shortcut-restore>คืนค่าเริ่มต้น / Restore defaults','data-settings-shortcut-restore>คืนค่าเริ่มต้น');
    const accountStart=text.indexOf('  function renderAccount() {'),accountStop=text.indexOf(accountEnd,accountStart);
    let account=text.slice(accountStart,accountStop);
    const accountClose="      '</button></div></div></div></section>';";
    if(account.split(accountClose).length!==2)throw new Error('Account editor composition seam changed');
    account=account.replace(accountClose,accountClose+"\n    if(global.CRSProfile) global.CRSProfile.mount(root,{CRS});");
    text=text.slice(0,accountStart)+account+text.slice(accountStop);
    if(!text.includes("CRS.features.mountSettings(sectionKey,root.querySelector('.settings-content'))"))throw new Error('Settings security subview composition seam changed');
    text=text.replace('CRS.features.mountSettings(sectionKey,root.querySelector(\'.settings-content\'))','CRS.features.mountSettings(sectionKey,root.querySelector(\'.settings-content\'),params)');
    // Next supports only explicit Thai/English, defaulting old/unknown choices to Thai.
    text=text.replace(/const LANGUAGES = Object\.freeze\(\[[\s\S]*?\]\);/, "const LANGUAGES = Object.freeze([{code:'th',name:'ไทย'},{code:'en',name:'English'}]);");
    text=text.replace(/  function languagePreference\(\) \{[\s\S]*?\n  function applyLanguage/, "  function languagePreference() { return global.CRSI18n.read(); }\n  function effectiveLanguage(preference) { return preference === 'en' ? 'en' : 'th'; }\n  function applyLanguage");
    text=text.replace("? preference : 'auto';", "? preference : 'th';");
    text=text.replaceAll("'th-TH'", "(global.CRS.language.effective() === 'en' ? 'en-GB' : 'th-TH')");
    text=text.replace('  applyLanguage(languagePreference(), false);','  applyLanguage(languagePreference(), false);\n  global.CRSI18n.staticUI(document);');
    text=text.replace('      closeDropdown(true);\n    });', '      closeDropdown(true);\n      global.CRSI18n.reload();\n    });');
    text=text.replace(/const base = \/\^https:[\s\S]*?\? configured : '';/,"const base = global.CRS_CANONICAL_BASE(configured) ? configured : '';");
    text=text.replace("new URLSearchParams(parts[1] || '')", "new URLSearchParams(raw ? (parts[1] || '') : global.location.search)");
    // Presentation only: retain the session waiter/authorization, and cover
    // bootstrap plus the awaited first route with the same UI loading lease.
    const bootstrapStart=text.indexOf('  async function bootstrapApplication() {');
    const bootstrapEnd=text.indexOf("\n  document.addEventListener('click'",bootstrapStart);
    if(bootstrapStart<0||bootstrapEnd<0)throw new Error('Session loading composition seam changed');
    let bootstrap=text.slice(bootstrapStart,bootstrapEnd);
    for(const seam of ['    initializeDesktopSidebar();','      applyBootstrap(data);','      CRS.renderRoute(target.name, target.params);','      console.error(error);\n    }']){
      if(bootstrap.split(seam).length!==2)throw new Error('Session loading bootstrap seam changed');
    }
    bootstrap=bootstrap.replace('    initializeDesktopSidebar();','    const sessionLoading = global.CRSSessionLoading && global.CRSSessionLoading.begin();\n    initializeDesktopSidebar();')
      .replace('      applyBootstrap(data);','      if (sessionLoading) sessionLoading.view();\n      applyBootstrap(data);')
      .replace('      CRS.renderRoute(target.name, target.params);','      await CRS.renderRoute(target.name, target.params);\n      if (CRS.features && CRS.features.awaitInitialView) await CRS.features.awaitInitialView();')
      .replace('      console.error(error);\n    }','      console.error(error);\n    } finally {\n      if (sessionLoading) sessionLoading.finish();\n    }');
    text=text.slice(0,bootstrapStart)+bootstrap+text.slice(bootstrapEnd);
    const toggle='if (themeToggle) cycleTheme();';
    if(!text.includes(toggle))throw new Error('Theme toggle composition seam changed');
    text=text.replace(toggle,'if (themeToggle) { if (global.CRSMagicUI) global.CRSMagicUI.toggleTheme(themeToggle, cycleTheme); else cycleTheme(); }');
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
    text=text.replace('<th>หมายเหตุ</th>','<th class="text-center">หมายเหตุ</th>')
      .replace("returned + '</td><td class=\"text-break\">'","returned + '</td><td class=\"text-break text-center\">'");
    text=text.replace("ORPHAN_FILE: 'ไฟล์กำพร้าในโฟลเดอร์ภาพ',","ORPHAN_FILE: 'ไฟล์กำพร้าในโฟลเดอร์ภาพ',\n      CLEANUP_QUEUED: 'เข้าคิวล้างแล้ว — ยังไม่ได้ลบไฟล์',")
      .replace("['orphan_files', 'ไฟล์กำพร้า'],","['orphan_files', 'ไฟล์กำพร้า'],\n      ['cleanup_queued', 'รอล้างไฟล์'],");
    for(const [from,to] of [
      ['ย้ายไฟล์กำพร้าไปถังขยะแล้ว','จัดคิวล้างไฟล์กำพร้าแล้ว ยังไม่ได้ลบไฟล์'],
      ['ย้ายไฟล์กำพร้าไปถังขยะ','จัดคิวล้างไฟล์กำพร้า'],
      ['ก่อนย้ายไฟล์ไปถังขยะ: ','ก่อนจัดคิวล้างไฟล์: '],
      ['กำลังตรวจและย้ายไฟล์…','กำลังตรวจและจัดคิวล้างไฟล์…'],
      ['ไฟล์ถูกย้ายไปถังขยะ','ไฟล์ถูกล้างจาก Storage'],
      ['ย้ายไปถังขยะ','จัดคิวล้างไฟล์']
    ])text=text.replaceAll(from,to);
    const confirmationSuffix=" + identifier,\n      confirmText:";
    if(!text.includes(confirmationSuffix))throw new Error('Cleanup confirmation composition seam changed');
    text=text.replace(confirmationSuffix," + identifier + (isOrphan ? ' การล้างจริงต้องผ่านช่วงรอและสั่งประมวลผลคิว ระบบจะตรวจการอ้างอิงซ้ำก่อนล้าง และไม่ใช่การย้ายลงถังขยะ' : ''),\n      confirmText:");
    for(const functionName of ['renderIntegrity','renderImageIntegrity']) {
      const start=text.indexOf('  function '+functionName+'('),stop=text.indexOf('\n  async function ',start);
      let body=text.slice(start,stop);
      const seam='    setVisible(host, true);';
      if(body.split(seam).length!==2)throw new Error('Audit disclosure composition seam changed');
      body=body.replace(seam,seam+`\n    var toggle=context.page.querySelector('[data-audit-result="'+host.id+'"]');
    if(toggle){toggle.disabled=false;toggle.setAttribute('aria-expanded','true');}`);
      text=text.slice(0,start)+body+text.slice(stop);
    }
    text=text.replace("      var action = target.dataset.action;",`      var action = target.dataset.action;
      if(action==='toggle-audit-results') {
        var auditHost=CRS.$('#'+target.dataset.auditResult,context.page);
        var expanded=target.getAttribute('aria-expanded')!=='true';
        if(auditHost){setVisible(auditHost,expanded);target.setAttribute('aria-expanded',String(expanded));}
        return;
      }`);
    text=text.replace(/actions.push\('<a class="btn btn-sm btn-outline-secondary" target="_blank" rel="noopener noreferrer" ' \+[\s\S]*?\/view">ตรวจสอบ<\/a>'\);/,
      `actions.push('<button type="button" class="btn btn-sm btn-outline-secondary" data-action="inspect-storage-resource" data-file-id="' + escape(issue.file_id) + '">ตรวจสอบ</button>');`);
    text=text.replace(/actions.push\('<a class="btn btn-sm btn-outline-secondary" target="_blank" rel="noopener noreferrer" ' \+[\s\S]*?ตรวจสอบโฟลเดอร์<\/a>'\);/,
      `actions.push('<span class="text-secondary">ตรวจผ่าน private Storage</span>');`);
  }
  if(name==='admin')for(const id of ['admin-integrity','admin-image-integrity']) {
    const heading=new RegExp('<h3 id="'+id+'-title" class="h5">([^<]+)<\\/h3>');
    if(!heading.test(text))throw new Error('Audit heading composition seam changed');
    text=text.replace(heading,`<h3 id="${id}-title" class="h5"><button type="button" class="admin-audit-toggle" data-action="toggle-audit-results" data-audit-result="${id}-result" aria-controls="${id}-result" aria-expanded="false" disabled><span>$1</span><i class="bi bi-chevron-down" aria-hidden="true"></i></button></h3>`);
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
    await writeFile(join(output,name+'.js'),name.startsWith('scripts-')?localizeScript(code):code); text=`<script src="/crs/${name}.js"></script>`;
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
index=index.replace('</head>','<link rel="stylesheet" href="/crs/experience.css"><link rel="stylesheet" href="/crs/magic-ui.css"><link rel="stylesheet" href="/crs/react-bits.css"><script src="/crs/transport.js"></script></head>');
index=index.replace('</body>','<script src="/crs/migration-admin.js"></script></body>');
const loginControls=await readFile(join(root,'web','login-controls.html'),'utf8');
index=index.replace('<div class="startup-card access-card">','<div class="startup-card access-card text-center">');
index=index.replace('<p class="login-welcome">ยินดีต้อนรับกลับมา</p>','');
// Keep the restored illustration and adapt only the requested Next story copy.
const kicker=/<p class="login-kicker">[^<]*<\/p>/g;
if([...index.matchAll(kicker)].length!==1)throw new Error('Login kicker composition seam changed');
index=index.replace(kicker,'<p class="login-kicker" data-experience-text="loginKicker">อุปกรณ์พร้อมใช้ มีไหมนั่นอีกเรื่อง</p>');
const artOpening='<div class="login-art" aria-hidden="true">',artClosing=/          <\/div>\r?\n        <\/div>\r?\n      <div class="startup-card access-card text-center">/;
if(!index.includes(artOpening)||!artClosing.test(index))throw new Error('Login art stage seam changed');
index=index.replace(artOpening,'<div class="login-art-stage" aria-hidden="true">'+artOpening).replace(artClosing,'          </div></div>\n        </div>\n      <div class="startup-card access-card text-center">');
const orbit='<div class="login-orbit"></div>';
if(index.split(orbit).length!==2)throw new Error('Login Ripple seam changed');
index=index.replace(orbit,'<div class="magic-ripple" aria-hidden="true">'+Array.from({length:6},(_,i)=>'<span class="magic-ripple-ring" style="--ripple-size:'+ (150+i*50)+'px;--ripple-opacity:'+Math.max(.03,.22-i*.035).toFixed(3)+';--ripple-delay:'+i*.2+'s"></span>').join('')+'</div>');
// Keep the Login-card caption removal.
for(const selector of ['id="access-state-eyebrow"']){
  const pattern=new RegExp('<p[^>]*'+selector+'[^>]*>[\\s\\S]*?<\\/p>','g');
  if([...index.matchAll(pattern)].length!==1)throw new Error('Login copy removal seam changed');
  index=index.replace(pattern,'');
}
index=index.replace(/<span class="state-icon state-icon-warning mx-auto"[\s\S]*?<\/span>/,'');
const brandIcon=/(<span class="brand-mark(?: [^"]*)?"[^>]*>)\s*<i class="bi bi-box-seam"[^>]*><\/i>\s*(<\/span>)/g;
if(!brandIcon.test(index)) throw new Error('Brand mark composition seam changed');
index=index.replace(brandIcon,'$1<img src="/brand/icon-yuemkuen.png" alt="" width="44" height="44" decoding="async">$2');
// Keep the native checkbox and its translated label/session listener intact.
// The decorative sibling must not be inside the label: translation replaces
// that label's textContent. Compose only the Next shell, not the GAS baseline.
const rememberInput='<input id="remember-session" class="form-check-input" type="checkbox">';
if(index.split(rememberInput).length!==2) throw new Error('Remember session composition seam changed');
index=index.replace(rememberInput,`<span class="remember-session-control">
          ${rememberInput}
          <span class="check" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 18 18" focusable="false">
              <path d="M1 9V3a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V9Z"/>
              <polyline points="1 9 7 14 17 3"/>
            </svg>
          </span>
        </span>`);
index=index.replace(/        <button\s+id="google-signin-button"/,match=>loginControls+match);
if(!index.includes('id="password-login-form"')) throw new Error('Login composition seam changed');
const googleIcon=await readFile(join(root,'web','google-icon.svg'),'utf8');
if(!index.includes('<i class="bi bi-google me-2" aria-hidden="true"></i>')) throw new Error('Google icon seam changed');
index=index.replace('<i class="bi bi-google me-2" aria-hidden="true"></i>',googleIcon);
index=index.replace('</body>','<script src="/crs/magic-ui.js"></script><script src="/crs/react-bits.js"></script><script src="/crs/recaptcha.js"></script><script src="/crs/login-parallax.js"></script><script src="/crs/session-loading.js"></script><script src="/crs/notification-inbox.js"></script><script src="/crs/settings-security.js"></script><script src="/crs/oauth-handoff.js"></script><script src="/crs/experience.js"></script></body>');
// Remove only this retired generated asset on incremental builds as well.
await rm(join(output,'login-scene.js'),{force:true});
await rm(join(output,'guest-scene.js'),{force:true});
await writeFile(join(output,'recaptcha.js'),await readFile(join(root,'web','recaptcha.js'),'utf8'));
await writeFile(join(output,'magic-ui.js'),await readFile(join(root,'web','magic-ui.js'),'utf8'));
await writeFile(join(output,'magic-ui.css'),await readFile(join(root,'web','magic-ui.css'),'utf8'));
for(const name of ['react-bits.js','react-bits.css','react-bits-license.txt'])await writeFile(join(output,name),await readFile(join(root,'web',name),'utf8'));
await writeFile(join(output,'login-parallax.js'),await readFile(join(root,'web','login-parallax.js'),'utf8'));
await writeFile(join(output,'session-loading.js'),await readFile(join(root,'web','session-loading.js'),'utf8'));
await writeFile(join(output,'notification-inbox.js'),await readFile(join(root,'web','notification-inbox.js'),'utf8'));
await writeFile(join(output,'settings-security.js'),await readFile(join(root,'web','settings-security.js'),'utf8'));
await writeFile(join(output,'profile.js'),await readFile(join(root,'web','profile.js'),'utf8'));
index=index.replace('<script src="/crs/settings-security.js">','<script src="/crs/profile.js"></script><script src="/crs/settings-security.js">');
await writeFile(join(output,'oauth-handoff.js'),await readFile(join(root,'web','oauth-handoff.js'),'utf8'));
const styleSource=await read('styles');
const tokens=[styleSource.match(/  :root \{[^}]*\}/)?.[0],styleSource.match(/  \[data-bs-theme="dark"\] \{[^}]*\}/)?.[0]];
if(tokens.some(value=>!value))throw new Error('404 design token seam changed');
await writeFile(join(output,'not-found.css'),tokens.join('\n')+'\n'+await readFile(join(root,'web','not-found.css'),'utf8'));
await writeFile(join(output,'transport.js'),await readFile(join(root,'web','transport.js'),'utf8'));
await writeFile(join(output,'migration-admin.js'),localizeScript(await readFile(join(root,'web','migration-admin.js'),'utf8')));
await writeFile(join(output,'experience.js'),await readFile(join(root,'web','experience.js'),'utf8'));
await writeFile(join(output,'experience.css'),await readFile(join(root,'web','experience.css'),'utf8'));
if(index.includes('<?')) throw new Error('Unresolved Apps Script template');
await writeFile(join(output,'shell.html'),index);
