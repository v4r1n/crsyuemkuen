import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readdirSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {localizeScript} from '../../tools/localize-ui.mjs';
const source=readFileSync(new URL('../../web/i18n.js',import.meta.url),'utf8'),copy=JSON.parse(readFileSync(new URL('../../web/ui-copy.json',import.meta.url),'utf8'));
function fixture(language='en'){
  const values=new Map(),window={CRS_UI_COPY:copy,CRS:{language:{effective:()=>language}},localStorage:{getItem:key=>values.get(key)||null}};
  const context=vm.createContext({window,localStorage:window.localStorage,sessionStorage:{getItem:()=>null}});vm.runInContext(source,context);return {window,context,values};
}
test('UI compiler wraps authored literals, not record expressions, enums, selectors or object keys',()=>{
  const {window,context}=fixture();context.global=window;context.record={name:'ชื่ออุปกรณ์',status:'AVAILABLE'};
  context.record['ชื่อ']='ชื่ออุปกรณ์';
  const program="global.result={name:record.name,status:record.status,label:'ชื่ออุปกรณ์',selector:'#equipment-search','ชื่อ':record['ชื่อ']};";
  vm.runInContext(localizeScript(program),context);
  assert.equal(window.result.label,'Equipment name');assert.equal(window.result.name,'ชื่ออุปกรณ์');assert.equal(window.result.status,'AVAILABLE');assert.equal(window.result.selector,'#equipment-search');assert.equal(window.result['ชื่อ'],'ชื่ออุปกรณ์');
});
test('source help dictionaries and regex patterns remain unchanged',()=>{
  const original="const LANGUAGE_TEXT={th:{help:'ช่วยเหลือ'},en:{help:'Help'}};global.pattern=/ชื่อ/;global.copy=LANGUAGE_TEXT;";
  const {window,context}=fixture();context.global=window;vm.runInContext(localizeScript(original),context);assert.equal(window.copy.th.help,'ช่วยเหลือ');assert.equal(window.pattern.source,'ชื่อ');
});
test('bilingual source UI includes workflow statuses and preserves source markup',()=>{
  const en=fixture().window.CRSI18n,th=fixture('th').window.CRSI18n;
  assert.equal(en.text('<button class="btn">ขอยืมอุปกรณ์</button>'),'<button class="btn">Request equipment</button>');
  assert.equal(en.text('รอตรวจรับคืน'),'Awaiting return inspection');assert.equal(en.text('AVAILABLE'),'AVAILABLE');
  assert.equal(th.text('General'),'ทั่วไป');assert.equal(th.text('พร้อมยืม'),'พร้อมยืม');
});
test('language preference allowlist defaults obsolete/invalid values to Thai',()=>{
  const {window,values}=fixture();for(const value of ['auto','de','zh','garbage']){values.set('crs-ui-language',value);assert.equal(window.CRSI18n.read(),'th');}values.set('crs-ui-language','en');assert.equal(window.CRSI18n.read(),'en');
});
test('bilingual resource has no empty, executable or translated storage enum values',()=>{
  for(const [key,value] of Object.entries(copy)){assert.ok(key.length&&typeof value==='string'&&value.length);assert.equal(/<script|javascript:/i.test(value),false);}for(const key of ['AVAILABLE','PENDING','BORROWED','ADMIN','USER'])assert.equal(Object.hasOwn(copy,key),false);
});
test('all source-authored Thai UI literals and template fragments have English coverage',()=>{
  const {tokenizer}=createRequire(import.meta.url)('next/dist/compiled/acorn'),i18n=fixture().window.CRSI18n;
  const directory=new URL('../../src/',import.meta.url);
  for(const file of readdirSync(directory).filter(name=>name.endsWith('.html')&&!name.includes('vendor')&&name!=='styles.html')){
    const raw=readFileSync(new URL(file,directory),'utf8');
    const values=file.startsWith('scripts-')?[...tokenizer(raw.replace(/^<script>\s*/,'').replace(/<\/script>\s*$/,''),{ecmaVersion:'latest'})].filter(token=>token.type.label==='string').map(token=>token.value):[raw.replace(/<script>[\s\S]*?<\/script>/g,'')];
    for(const value of values)assert.equal(/[\u0e00-\u0e7f]/.test(i18n.text(value)),false,'Missing English source UI coverage: '+file);
  }
});
