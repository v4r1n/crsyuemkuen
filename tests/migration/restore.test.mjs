import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { createRequire } from 'node:module';
import { reserveRestore,commitRestore,snapshotTables,normalizeSnapshot } from '../../tools/restore-records.mjs';
import { digest } from '../../server/domain.mjs';
import { fields,tables } from '../../server/schema.mjs';
const {bootstrappedHarness,createEquipment,createUser,createBorrowRequest}=createRequire(import.meta.url)('../backend/test-helpers.cjs');

async function fixture() {
  const db=new PGlite();
  await db.exec(readFileSync(new URL('../../supabase/migrations/202610050001_crs.sql',import.meta.url),'utf8'));
  await db.exec(readFileSync(new URL('../../supabase/migrations/202610070002_identity_experience.sql',import.meta.url),'utf8'));
  const transaction=async work=>{await db.exec('BEGIN');try{const result=await work(db);await db.exec('COMMIT');return result;}catch(error){await db.exec('ROLLBACK');throw error;}};
  const resource={id:'restore-image-fixture',object_key:'legacy/restore/image.png',operation_id:'restore-op-fixture',asset_id:'AST-000001',
    mime_type:'image/png',byte_length:8,digest:digest(Buffer.from([137,80,78,71,13,10,26,10])),name:'image.png',folder_id:'fixture-private-bucket',owner_user_id:'USR-000001',
    state:'READY',created_at:'2026-10-05T00:00:00.000Z',verified_at:'2026-10-05T00:00:00.000Z',cleanup_after:null,original:{verified_import:true}};
  const snapshot={format:2,tables:Object.fromEntries(snapshotTables.map(name=>[name,[]]))};
  snapshot.tables.image_resources=[resource];
  snapshot.tables.archive=[{id:'restore:Users:3',source_hash:'restore',sheet:'Users',row_number:3,reason:'INVALID_CANONICAL_ID',raw:{value:'raw archive, not authorization'}}];
  snapshot.tables.cleanup_jobs=[{id:resource.id,not_before:'2026-10-05T05:00:00.000Z'}];
  return {db,transaction,snapshot};
}

test('restore reservations resume safely; commit retains archive/image IDs and invalidates prior sessions/proofs',async()=>{
  const {db,transaction,snapshot}=await fixture();
  try {
    await db.query("INSERT INTO crs.sessions(id,data,expires_at) VALUES('prior-session','{}',now()+interval '1 hour')");
    await db.query("INSERT INTO crs.proofs(id,data,expires_at) VALUES('prior-proof','{}',now()+interval '1 hour')");
    await reserveRestore(snapshot,transaction);await reserveRestore(snapshot,transaction);
    assert.equal((await db.query('SELECT state FROM crs.image_resources')).rows[0].state,'STAGED');
    await commitRestore(snapshot,transaction);
    assert.equal((await db.query('SELECT state FROM crs.image_resources')).rows[0].state,'READY');
    assert.deepEqual((await db.query('SELECT raw FROM crs.archive')).rows[0].raw,snapshot.tables.archive[0].raw);
    assert.equal((await db.query('SELECT id FROM crs.cleanup_jobs')).rows[0].id,snapshot.tables.image_resources[0].id);
    for(const table of ['sessions','proofs','auth_flows','rate_limits']) assert.equal((await db.query(`SELECT count(*)::int AS n FROM crs.${table}`)).rows[0].n,0);
    await assert.rejects(reserveRestore(snapshot,transaction),/not empty/);
  } finally {await db.close();}
});

test('restore rejects unrelated resources and changed ownership before committing any archived data',async()=>{
  const {db,transaction,snapshot}=await fixture();
  try {
    await reserveRestore(snapshot,transaction);
    await db.query("UPDATE crs.image_resources SET owner_user_id='unexpected-owner'");
    await assert.rejects(reserveRestore(snapshot,transaction),/changed restore resource/);
    await assert.rejects(commitRestore(snapshot,transaction),/changed restore resource/);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM crs.archive')).rows[0].n,0);
    await db.query("UPDATE crs.image_resources SET owner_user_id='USR-000001'");
    const unrelated=structuredClone(snapshot);unrelated.tables.image_resources=[];
    await assert.rejects(reserveRestore(unrelated,transaction),/restore resource/);
  } finally {await db.close();}
});

test('format 2 retains linked credentials, visibility and inbox while consuming all old proofs and uncertain mail',async()=>{
  const {db,transaction,snapshot}=await fixture();try{
    const legacy=bootstrappedHarness(),asset=createEquipment(legacy),user=createUser(legacy,{suffix:'restore'});
    legacy.setActiveEmail(user.email);const borrow=createBorrowRequest(legacy,asset.asset_id);
    for(const [name,table]of Object.entries(tables))snapshot.tables[table]=legacy.records(name).map(row=>({data:Object.fromEntries(fields[name].map(field=>[field,row[field]??'']))}));
    const admin=legacy.records('Users').find(row=>row.role==='ADMIN'),history=legacy.records('History').find(row=>row.borrow_id===borrow.borrow_id);
    snapshot.tables.password_credentials=[{user_id:user.user_id,email:user.email,password_hash:'scrypt$synthetic-fixture',generation:7,must_change:true,failed_attempts:0}];
    snapshot.tables.security_mail=[{id:'fixture-security-event',user_id:user.user_id,email:user.email,kind:'PASSWORD_CHANGED',status:'SENDING'}];
    snapshot.tables.equipment_visibility=[{asset_id:asset.asset_id,is_public:true,updated_by:admin.user_id}];
    snapshot.tables.notifications=[{id:digest('fixture-notification'),user_id:user.user_id,history_id:history.log_id,borrow_id:borrow.borrow_id,action:'BORROW_REQUEST',created_at:history.timestamp,read_at:null}];
    await db.query("INSERT INTO crs.password_challenges(id,email,purpose,credential_generation,otp_hash,status,expires_at) VALUES('expired-proof','none@example.test','RESET',0,'hash','READY',now()+interval '1 minute')");
    await reserveRestore(snapshot,transaction);await commitRestore(snapshot,transaction);
    assert.equal((await db.query('SELECT generation,must_change FROM crs.password_credentials')).rows[0].generation,7);
    assert.equal((await db.query('SELECT is_public FROM crs.equipment_visibility')).rows[0].is_public,true);
    assert.equal((await db.query('SELECT user_id FROM crs.notifications')).rows[0].user_id,user.user_id);
    assert.equal((await db.query('SELECT status FROM crs.security_mail')).rows[0].status,'UNCERTAIN');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM crs.password_challenges')).rows[0].n,0);
  }finally{await db.close();}
});

test('legacy format 1 backups upgrade without inventing passwords, public assets or notifications',async()=>{
  const {db,transaction,snapshot}=await fixture();try{
    const old={...snapshot,format:1,tables:{...snapshot.tables}};
    for(const table of ['password_credentials','security_mail','equipment_visibility','notifications'])delete old.tables[table];
    const normalized=normalizeSnapshot(old);assert.equal(normalized.format,2);
    for(const table of ['password_credentials','security_mail','equipment_visibility','notifications'])assert.deepEqual(normalized.tables[table],[]);
    await reserveRestore(old,transaction);await commitRestore(old,transaction);
    assert.equal((await db.query('SELECT state FROM crs.image_resources')).rows[0].state,'READY');
    for(const table of ['password_credentials','security_mail','equipment_visibility','notifications'])assert.equal((await db.query(`SELECT count(*)::int AS n FROM crs.${table}`)).rows[0].n,0);
  }finally{await db.close();}
});
