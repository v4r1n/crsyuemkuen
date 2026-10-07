import { isDeepStrictEqual } from 'node:util';
import { tables } from '../server/schema.mjs';

const legacySnapshotTables=[...Object.values(tables),'archive','migration_runs','image_resources','cleanup_jobs'];
export const snapshotTables=[...legacySnapshotTables,'password_credentials','security_mail','equipment_visibility','notifications'];
export function normalizeSnapshot(snapshot){
  if(snapshot.format===1 && snapshot.tables && Object.keys(snapshot.tables).sort().join()===legacySnapshotTables.slice().sort().join()) {
    return {...snapshot,format:2,tables:{...snapshot.tables,...Object.fromEntries(snapshotTables.filter(name=>!legacySnapshotTables.includes(name)).map(name=>[name,[]]))}};
  }
  return snapshot;
}
const identityFields=['id','object_key','operation_id','asset_id','mime_type','byte_length','digest','name','folder_id','owner_user_id','original'];
const reservedState=row=>row.state==='READY'?'STAGED':row.state;
function sameReservation(found,expected) {
  return found.state===reservedState(expected) && identityFields.every(key=>isDeepStrictEqual(found[key],expected[key]));
}
function validateSnapshot(snapshot) {
  if(snapshot.format!==2 || !snapshot.tables || Object.keys(snapshot.tables).sort().join()!==snapshotTables.slice().sort().join() ||
    snapshotTables.some(name=>!Array.isArray(snapshot.tables[name]))) throw new Error('Unknown backup format');
}
async function requireEmptyRecords(db) {
  for(const table of snapshotTables.filter(name=>name!=='image_resources')) {
    if((await db.query(`SELECT count(*)::integer AS count FROM crs.${table}`)).rows[0].count) throw new Error('Destination is not empty; restore refused');
  }
}
async function requireReservations(db,snapshot,complete=false) {
  const found=(await db.query('SELECT * FROM crs.image_resources')).rows;
  if(found.some(row=>!snapshot.tables.image_resources.some(expected=>expected.id===row.id && sameReservation(row,expected))) ||
    (complete && found.length!==snapshot.tables.image_resources.length)) throw new Error('Unexpected or changed restore resource reservation');
}
export async function reserveRestore(snapshot,transaction) {
  snapshot=normalizeSnapshot(snapshot);
  validateSnapshot(snapshot);
  return transaction(async db=>{
    await requireEmptyRecords(db);
    await requireReservations(db,snapshot);
    for(const row of snapshot.tables.image_resources) {
      if(!(await db.query('SELECT id FROM crs.image_resources WHERE id=$1',[row.id])).rows.length) await insertPlain(db,'image_resources',{...row,state:reservedState(row)});
    }
  });
}
// The caller must verify every backed-up binary before this commit. Nothing
// can become READY or restore a projection while verification is incomplete.
export async function commitRestore(snapshot,transaction) {
  snapshot=normalizeSnapshot(snapshot);
  validateSnapshot(snapshot);
  return transaction(async db=>{
    await requireEmptyRecords(db);
    await requireReservations(db,snapshot,true);
    for(const table of snapshotTables.filter(name=>name!=='image_resources')) for(const row of snapshot.tables[table]) {
      if(Object.values(tables).includes(table)) await db.query(`INSERT INTO crs.${table}(data) VALUES($1)`,[JSON.stringify(row.data)]);
      else await insertPlain(db,table,row);
    }
    for(const row of snapshot.tables.image_resources) await db.query('UPDATE crs.image_resources SET state=$2,verified_at=$3 WHERE id=$1',[row.id,row.state,row.verified_at]);
    // Ephemeral identity/proof data is never restored or allowed to authorize
    // the restored Users. Fresh linked Google or password sign-in is mandatory.
    for(const table of ['sessions','auth_flows','proofs','rate_limits','password_challenges']) await db.query(`DELETE FROM crs.${table}`);
    await db.query("UPDATE crs.security_mail SET status='UNCERTAIN' WHERE status IN ('PENDING','SENDING')");
  });
}
async function insertPlain(db,table,row) {
  const columns=Object.keys(row);
  if(!snapshotTables.includes(table) || columns.some(name=>!/^[a-z_]+$/.test(name))) throw new Error('Invalid backup columns');
  await db.query(`INSERT INTO crs.${table}(${columns.join(',')}) VALUES(${columns.map((_,index)=>'$'+(index+1)).join(',')})`,columns.map(name=>row[name]));
}
