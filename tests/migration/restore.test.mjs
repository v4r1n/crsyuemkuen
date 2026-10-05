import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { reserveRestore,commitRestore,snapshotTables } from '../../tools/restore-records.mjs';
import { digest } from '../../server/domain.mjs';

async function fixture() {
  const db=new PGlite();
  await db.exec(readFileSync(new URL('../../supabase/migrations/202610050001_crs.sql',import.meta.url),'utf8'));
  const transaction=async work=>{await db.exec('BEGIN');try{const result=await work(db);await db.exec('COMMIT');return result;}catch(error){await db.exec('ROLLBACK');throw error;}};
  const resource={id:'restore-image-fixture',object_key:'legacy/restore/image.png',operation_id:'restore-op-fixture',asset_id:'AST-000001',
    mime_type:'image/png',byte_length:8,digest:digest(Buffer.from([137,80,78,71,13,10,26,10])),name:'image.png',folder_id:'fixture-private-bucket',owner_user_id:'USR-000001',
    state:'READY',created_at:'2026-10-05T00:00:00.000Z',verified_at:'2026-10-05T00:00:00.000Z',cleanup_after:null,original:{verified_import:true}};
  const snapshot={format:1,tables:Object.fromEntries(snapshotTables.map(name=>[name,[]]))};
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
