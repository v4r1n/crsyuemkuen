import pg from 'pg';
let pool;
export function database() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const url=new URL(process.env.DATABASE_URL);
  if(!['postgres:','postgresql:'].includes(url.protocol)) throw new Error('Invalid database URL');
  const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  // pg connection-string SSL options can override the explicit verified TLS
  // object. Strip them; secrets/usernames containing "localhost" are not hosts.
  for(const key of [...url.searchParams.keys()]) if(key.startsWith('ssl')) url.searchParams.delete(key);
  pool ||= new pg.Pool({ connectionString: url.toString(), max: 1,
    connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000,
    ssl: local ? false : { rejectUnauthorized: true, ...(process.env.DATABASE_CA ? { ca: process.env.DATABASE_CA } : {}) } });
  return pool;
}
// READ COMMITTED + lock before reading = the old global Script Lock semantics,
// now an atomic database commit. No cached role, sequence or workflow decisions.
export async function transaction(work, source = database()) {
  const client = await source.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '45s'");
    await client.query('SELECT pg_advisory_xact_lock(73184116)');
    const result = await work(client);
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
