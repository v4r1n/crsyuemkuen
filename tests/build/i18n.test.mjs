import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
test('generated workflow scripts localize authored copy before external script emission',()=>{
  for(const file of [...['core','equipment','borrow','admin','dashboard','account-menu','qr','api'].map(name=>'scripts-'+name+'.js'),'migration-admin.js']){
    const code=readFileSync('public/crs/'+file,'utf8');
    assert.ok(code.includes('global.CRSI18n.text('),'Missing generated localization seam: '+file);
  }
});
test('generated core contains exactly explicit Thai/English options and Settings-only refresh',()=>{
  const code=readFileSync('public/crs/scripts-core.js','utf8');
  assert.match(code,/const LANGUAGES = Object\.freeze\(\[\{code:'th',name:[\s\S]*?\{code:'en',name:'English'\}\]\);/);
  assert.match(code,/closeDropdown\(true\);\s+global\.CRSI18n\.reload\(\);/);
});
