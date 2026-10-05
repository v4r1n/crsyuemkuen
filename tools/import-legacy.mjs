import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve,join } from 'node:path';
import { planLegacy } from './legacy-plan.mjs';
import { transaction } from '../server/db.mjs';
import { privateStorage } from '../server/storage.mjs';
import { applyLegacy } from './apply-legacy.mjs';
try{process.loadEnvFile('.env.local');}catch{}
const args=process.argv.slice(2),apply=args.includes('--apply');
const paths=args.filter(value=>!value.startsWith('--'));
if(paths.length<2 || args.some(value=>value.startsWith('--') && value!=='--apply')) throw new Error('Usage: node tools/import-legacy.mjs <workbook.xlsx> <images.zip> [additional-images.zip ...] [--apply] (default: preview, no external writes)');
const workbook=resolve(paths[0]),zip=resolve(paths[1]),additionalZips=paths.slice(2).map(value=>resolve(value));
const plan=await planLegacy(await readFile(workbook),await readFile(zip),await Promise.all(additionalZips.map(value=>readFile(value))));
const staging=join(process.cwd(),'.migration',plan.sourceHash);
await mkdir(staging,{recursive:true});
await copyFile(workbook,join(staging,'source.xlsx')); await copyFile(zip,join(staging,'images.zip'));
for(const [index,path] of additionalZips.entries()) await copyFile(path,join(staging,`additional-images-${index+1}.zip`));
await writeFile(join(staging,'manifest.json'),JSON.stringify(plan.manifest,null,2));
console.log(JSON.stringify(plan.manifest,null,2));
if(!apply) {console.log('Preview only. Local source backups created; Supabase unchanged.');process.exit(0);}
if(process.env.WRITE_FREEZE!=='true') throw new Error('Set WRITE_FREEZE=true in local environment and freeze old application writes before applying');
const storage=await privateStorage();
const result=await applyLegacy(plan,{transaction,storage});
console.log(result.alreadyCommitted?'Import already committed; images verified; no records overwritten.':'Import committed with source archive, journal hashes and verified private images.');
process.exit(0);
