import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const additions=[{id:'202610070002_identity_experience',sql:readFileSync(new URL('../supabase/migrations/202610070002_identity_experience.sql',import.meta.url),'utf8')}];
// Caller supplies the same advisory-locked transaction used by the runtime.
// Never reset or rewrite an existing installation; record exact additive source.
export async function applyAdditiveMigrations(transact){
  return transact(async db=>{
    await db.query('CREATE TABLE IF NOT EXISTS crs.runtime_migrations(id text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    await db.query('ALTER TABLE crs.runtime_migrations ENABLE ROW LEVEL SECURITY');
    await db.query('REVOKE ALL ON crs.runtime_migrations FROM PUBLIC');
    await db.query("DO $$ BEGIN IF EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN REVOKE ALL ON crs.runtime_migrations FROM anon,authenticated; END IF; END $$");
    for(const entry of additions){
      const hash=createHash('sha256').update(entry.sql).digest('hex');
      const prior=(await db.query('SELECT sha256 FROM crs.runtime_migrations WHERE id=$1',[entry.id])).rows[0];
      if(prior){if(prior.sha256!==hash)throw new Error('Applied migration source changed; review required');continue;}
      // Source migrations are trusted and retain BEGIN/COMMIT for SQL operators.
      // The CLI adapter owns the outer transaction and lock instead.
      await db.query(entry.sql.replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,''));
      await db.query('INSERT INTO crs.runtime_migrations(id,sha256) VALUES($1,$2)',[entry.id,hash]);
    }
  });
}
