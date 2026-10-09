import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,cp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve,join,dirname,basename} from 'node:path';

test('story composition adds Ripple/Magic adapters and retires only obsolete scene assets on repeat builds',async()=>{
  const root=resolve(import.meta.dirname,'../..'),temporaryRoot=resolve(tmpdir());
  const target=await mkdtemp(join(temporaryRoot,'crs-login-story-'));
  try{
    await cp(join(root,'src'),join(target,'src'),{recursive:true});
    await cp(join(root,'web'),join(target,'web'),{recursive:true});
    const output=join(target,'public','crs');await mkdir(output,{recursive:true});
    await writeFile(join(output,'login-scene.js'),'window.retiredLoginScene=true;');
    await writeFile(join(output,'guest-scene.js'),'window.retiredGuestScene=true;');
    await writeFile(join(output,'keep-fixture.txt'),'retain unrelated generated files');
    const source=(await readFile(join(target,'src','index.html'),'utf8')).replace(/\r\n/g,'\n');
    const story=html=>html.slice(html.indexOf('<div class="login-story">'),html.indexOf('<div class="startup-card access-card'));
    const expected=story(source).replace('<i class="bi bi-box-seam"></i>','<img src="/brand/icon-yuemkuen.png" alt="" width="44" height="44" decoding="async">')
      .replace(/<p class="login-kicker">[^<]*<\/p>/,'<p class="login-kicker" data-experience-text="loginKicker">อุปกรณ์พร้อมใช้ มีไหมนั่นอีกเรื่อง</p>')
      .replace('<div class="login-art" aria-hidden="true">','<div class="login-art-stage" aria-hidden="true"><div class="login-art" aria-hidden="true">')
      .replace('          </div>\n        </div>','          </div></div>\n        </div>')
      .replace('<div class="login-orbit"></div>','<div class="magic-ripple" aria-hidden="true">'+Array.from({length:6},(_,i)=>'<span class="magic-ripple-ring" style="--ripple-size:'+(150+i*50)+'px;--ripple-opacity:'+Math.max(.03,.22-i*.035).toFixed(3)+';--ripple-delay:'+i*.2+'s"></span>').join('')+'</div>');
    for(let attempt=0;attempt<2;attempt++){
      const result=spawnSync(process.execPath,[join(root,'tools','build-web.mjs')],{cwd:target,encoding:'utf8',timeout:20000});
      assert.equal(result.status,0,'Next-only composition must still build');
      const shell=(await readFile(join(output,'shell.html'),'utf8')).replace(/\r\n/g,'\n');
      assert.equal(story(shell),expected,'Keep the remaining story copy, illustration and supplied brand mark');
      assert.match(shell,/\.login-kicker\s*\{/);assert.doesNotMatch(shell,/id="access-state-eyebrow"|\/crs\/login-scene\.js/);
      assert.match(shell,/id="password-login-form"/);assert.match(shell,/\/crs\/recaptcha\.js/);assert.match(shell,/\/crs\/magic-ui\.js/);
      assert.doesNotMatch(shell,/\/crs\/guest-scene\.js|\.login-orbit\s*\{/);
      assert.match(shell,/\/crs\/login-parallax\.js/);
      assert.equal(await readFile(join(output,'login-parallax.js'),'utf8'),await readFile(join(target,'web','login-parallax.js'),'utf8'));
      for(const name of ['magic-ui.js','magic-ui.css'])assert.equal(await readFile(join(output,name),'utf8'),await readFile(join(target,'web',name),'utf8'));
      await assert.rejects(access(join(output,'login-scene.js')),error=>error.code==='ENOENT');
      await assert.rejects(access(join(output,'guest-scene.js')),error=>error.code==='ENOENT');
      assert.equal(await readFile(join(output,'keep-fixture.txt'),'utf8'),'retain unrelated generated files');
    }
  }finally{
    assert.equal(dirname(resolve(target)),temporaryRoot);assert.match(basename(target),/^crs-login-story-/);
    await rm(target,{recursive:true,force:true});
  }
});
