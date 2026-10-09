import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=name=>readFileSync(new URL('../../'+name,import.meta.url),'utf8');
test('React Bits is a Next-only presentation adapter with full application license and no independent data/auth authority',()=>{
  const code=read('web/react-bits.js'),css=read('web/react-bits.css'),build=read('tools/build-web.mjs');
  new vm.Script(code);
  assert.match(code,/7b69ba117ca7876dc9ca5ff3c09cf514de4b2d62/);
  assert.match(read('web/react-bits-license.txt'),/MIT \+ Commons Clause/);
  assert.doesNotMatch(code,/fetch\(|CRS_SERVER_RPC|adminDeleteEquipment|createBorrowRequest|picsum|localStorage/);
  assert.match(code,/requestSubmit\(button\)/);assert.match(code,/submitPermit!==event.target/);
  assert.match(code,/visibilitychange/);assert.match(code,/animation.cancel\(\)/);assert.match(code,/CRS.cancelEquipmentImage/);
  assert.match(css,/prefers-reduced-motion/);assert.match(css,/forced-colors/);
  assert.match(build,/react-bits-license.txt/);
  assert.doesNotMatch(read('src/index.html'),/react-bits/);
});
