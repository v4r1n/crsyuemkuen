import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { fields,keys } from '../server/schema.mjs';
import { createDomain,digest } from '../server/domain.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const canonicalPatterns={Equipment:/^AST-\d{6}$/,Users:/^USR-\d{6}$/,Borrow:/^BR-\d{6}$/,Categories:/^CAT-\d{3}$/,IncludedItems:/^ITM-\d{6}$/,BorrowItems:/^BIT-\d{6}$/,History:/^LOG-\d{6}$/,Operations:/^[A-Za-z0-9_-]{8,100}$/};
export async function planLegacy(workbookBytes,zipBytes,additionalZipBytes=[]) {
  const sourceHash=sha(workbookBytes),zipHash=sha(zipBytes),additionalZipHashes=additionalZipBytes.map(sha),records={},archive=[],issues=[];
  if(new Set([zipHash,...additionalZipHashes]).size!==additionalZipHashes.length+1) throw new Error('Duplicate image source archive');
  // ExcelJS reserves "History" on worksheet construction, but Google Sheets
  // exports a legitimate tab with that name. Rename only the in-memory reader
  // copy's workbook metadata, then restore its identity in the parsed plan.
  const readerZip=await JSZip.loadAsync(workbookBytes,{checkCRC32:true});
  const metadata=await readerZip.file('xl/workbook.xml').async('string');
  const alias='CRS_History_Import_Reserved';
  if(metadata.includes(`name="${alias}"`)) throw new Error('Reader alias collision');
  readerZip.file('xl/workbook.xml',metadata.replace(/name="History"/g,`name="${alias}"`));
  const workbook=new ExcelJS.Workbook(); await workbook.xlsx.load(await readerZip.generateAsync({type:'nodebuffer'}));
  for(const sheet of workbook.worksheets) {
    const sheetName=sheet.name===alias?'History':sheet.name;
    const headers=sheet.getRow(1).values.slice(1).map(value=>String(value||'').trim());
    const managed=Object.hasOwn(fields,sheetName);
    if(managed && (headers.length!==fields[sheetName].length || fields[sheetName].some(field=>!headers.includes(field)))) throw new Error('Schema header mismatch: '+sheetName);
    if(managed) records[sheetName]=[];
    sheet.eachRow((row,number)=>{
      if(number===1) return;
      const raw=Object.fromEntries(headers.map((header,index)=>[header,row.getCell(index+1).value??'']));
      let reason=managed?'SOURCE_SNAPSHOT':'LEGACY_TABLE';
      const data=Object.fromEntries(headers.map(field=>[field,cellValue(raw[field],field)]));
      if(managed) {
        const invalid=validateRecord(sheetName,data,raw);
        if(invalid) {reason=invalid;issues.push({sheet:sheetName,row:number,code:invalid});}
        else records[sheetName].push(data);
      }
      archive.push({id:`${sourceHash}:${sheetName}:${number}`,source_hash:sourceHash,sheet:sheetName,row_number:number,reason,raw});
    });
  }
  for(const name of Object.keys(fields)) if(!records[name]) throw new Error('Missing managed sheet: '+name);
  validateRelationships(records);
  const domain=createDomain(records),c=domain.context;
  for(const operation of records.Operations) {
    c.operationPayload_(operation); // Verifies preserved payload hash.
    if(['COMPLETED','ABORTED'].includes(operation.status)) c.operationResult_(operation);
    if(operation.status==='COMPLETED' && records.History.filter(row=>row.operation_id===operation.operation_id).length!==1) throw new Error('Completed operation lacks unique History');
  }
  for(const [sequence,definition] of Object.entries(c.SEQUENCE_DEFINITIONS)) {
    const row=records.Sequences.find(value=>value.sequence_name===sequence);
    const high=records[definition.sheet].reduce((max,item)=>Math.max(max,Number(String(item[definition.idField]).replace(definition.prefix,''))||0),0);
    if(!row || Number(row.next_value)<=high || row.prefix!==definition.prefix || Number(row.padding)!==definition.padding) throw new Error('Unsafe sequence high water: '+sequence);
  }
  const images=[],used=new Set();
  for(const archiveBytes of [zipBytes,...additionalZipBytes]) {
    const imageZipHash=sha(archiveBytes),zip=await JSZip.loadAsync(archiveBytes,{checkCRC32:true});
    for(const entry of Object.values(zip.files)) {
    if(entry.dir) continue;
    if(entry.name!==entry.unsafeOriginalName || entry.name.includes('..') || entry.name.startsWith('/') || entry.name.includes('\\')) throw new Error('Unsafe ZIP entry');
    if(images.length>=10000) throw new Error('Too many ZIP entries');
    const name=entry.name.split('/').pop();
    const matches=records.Operations.filter(op=>{
      if(op.action!=='UPLOAD_ASSET_IMAGE') return false;
      const payload=c.operationPayload_(op);
      return name===op.asset_id+'-'+op.operation_id+'.'+c.IMAGE_MIME_TYPES[payload.mimeType];
    });
    if(matches.length!==1) throw new Error('ZIP image must match exactly one journal operation');
    const operation=matches[0],payload=c.operationPayload_(operation);
    const bytes=await entry.async('nodebuffer');
    c.assertImageSignature_([...bytes],payload.mimeType);
    if(bytes.length!==Number(payload.byteLength) || digest(bytes)!==payload.digest || bytes.length>10485760 || !/^[A-Za-z0-9_-]{8,200}$/.test(operation.resource_id)) throw new Error('Image digest/length/resource mismatch');
    if(used.has(operation.resource_id)) throw new Error('Duplicate image resource'); used.add(operation.resource_id);
    images.push({id:operation.resource_id,operation_id:operation.operation_id,asset_id:operation.asset_id,name,
      mime_type:payload.mimeType,byte_length:bytes.length,digest:payload.digest,folder_id:payload.folderId,
      owner_user_id:operation.actor_user_id,object_key:`legacy/${sourceHash}/${operation.resource_id}.${c.IMAGE_MIME_TYPES[payload.mimeType]}`,
      bytes,original:{verified_import:true,source_hash:sourceHash,zip_hash:imageZipHash,legacy_resource_id:operation.resource_id}});
    }
  }
  const missing=records.Equipment.filter(row=>row.image_file_id && !used.has(row.image_file_id));
  if(missing.length) throw new Error('Current Equipment images missing from ZIP');
  const historical=records.Operations.filter(op=>op.action==='UPLOAD_ASSET_IMAGE' && op.resource_id && !used.has(op.resource_id)).length;
  return {sourceHash,zipHash,records,archive,images,manifest:{source_hash:sourceHash,zip_hash:zipHash,additional_zip_hashes:additionalZipHashes,
    counts:Object.fromEntries(Object.entries(records).map(([name,rows])=>[name,rows.length])),archive_rows:archive.length,
    quarantined_rows:issues.length,issues,image_count:images.length,image_bytes:images.reduce((total,image)=>total+image.byte_length,0),
    historical_image_bytes_unavailable:historical}};
}
function cellValue(value,field) {
  if(value instanceof Date) return field.endsWith('_date') ? value.toISOString().slice(0,10) : value.toISOString();
  if(value && typeof value==='object') {
    if(value.richText) return value.richText.map(part=>part.text).join('');
    if(Object.hasOwn(value,'result')) return cellValue(value.result,field);
    if(value.hyperlink) return value.text || value.hyperlink;
  }
  return value;
}
function validateRecord(sheet,row,raw) {
  if(Object.values(raw).some(cell=>cell && typeof cell==='object' && (cell.formula || cell.sharedFormula))) return 'FORMULA_REQUIRES_REVIEW';
  if(canonicalPatterns[sheet] && !canonicalPatterns[sheet].test(String(row[keys[sheet]]||''))) return 'INVALID_CANONICAL_ID';
  if(fields[sheet].includes('row_version') && (!Number.isSafeInteger(Number(row.row_version)) || Number(row.row_version)<1)) return 'INVALID_ROW_VERSION';
  if(sheet==='Users' && (!['USER','ADMIN'].includes(row.role) || !['ACTIVE','INACTIVE'].includes(row.status) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.email))) return 'INVALID_AUTHORIZATION_ROW';
  if(sheet==='Equipment' && (Number(row.quantity)!==1 || !['AVAILABLE','PENDING','RESERVED','BORROWED','RETURNING','MAINTENANCE','DAMAGED','LOST','RETIRED','DELETED'].includes(row.status))) return 'INVALID_ASSET';
  if(sheet==='Operations' && !['STARTED','COMPLETED','ABORTED'].includes(row.status)) return 'INVALID_OPERATION_STATUS';
  return '';
}
function validateRelationships(records) {
  for(const [table,rows] of Object.entries(records)) {
    const ids=rows.map(row=>row[keys[table]]);
    if(new Set(ids).size!==ids.length || ids.some(id=>!id)) throw new Error('Duplicate/blank primary key: '+table);
  }
  for(const [table,field,normalize] of [['Users','email',s=>s.trim().toLowerCase()],['Equipment','serial_number',s=>s.trim().replace(/\s+/g,' ').toLowerCase()],['Categories','category_name',s=>s.trim().toLowerCase()]]) {
    const values=records[table].map(row=>normalize(String(row[field]||''))).filter(Boolean);
    if(new Set(values).size!==values.length) throw new Error('Duplicate business key: '+table+'.'+field);
  }
  for(const [child,field,parent] of [['Equipment','category_id','Categories'],['Borrow','asset_id','Equipment'],['Borrow','user_id','Users'],['IncludedItems','asset_id','Equipment'],['BorrowItems','borrow_id','Borrow']]) {
    const ids=new Set(records[parent].map(row=>row[keys[parent]]));
    if(records[child].some(row=>!ids.has(row[field]))) throw new Error('Live foreign key mismatch: '+child+'.'+field);
  }
  if(!records.Users.some(row=>row.role==='ADMIN' && row.status==='ACTIVE')) throw new Error('No canonical active administrator');
}
