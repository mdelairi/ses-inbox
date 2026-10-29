// Throwaway embedded PostgreSQL (PGlite), or INBOX_TEST_NATIVE_POSTGRES=1 for native.
// No existing project database or machine settings are changed. DSQL is a subset, so
// this catches SQL and transaction mistakes, not DSQL-specific limits or OCC timing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';

const bin = fileURLToPath(new URL('../../.tools/postgres/17/bin/', import.meta.url));
const native = process.env.INBOX_TEST_NATIVE_POSTGRES === '1';
export const postgresAvailable = !native || existsSync(join(bin, 'pg_ctl'));
const freePort = () => new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });

export async function startPostgres() {
  if (!native) {
    const database = await PGlite.create();
    let tail = Promise.resolve();
    const query = async (sql, args) => { const result = await database.query(sql, args); return { ...result, rowCount: result.rowCount ?? (result.command === 'SELECT' ? result.rows.length : result.affectedRows) }; };
    const pool = {
      async connect() {
        const before = tail; let release;
        tail = new Promise(resolve => { release = resolve; });
        await before;
        return { query, release };
      },
      async query(sql, args) { const client = await this.connect(); try { return await client.query(sql, args); } finally { client.release(); } },
      async end() { await tail; await database.close(); },
    };
    await initialize(pool);
    return { pool, reset: () => reset(pool), stop: () => pool.end() };
  }
  const dir = mkdtempSync(join(tmpdir(), 'inbox-pg-')), port = await freePort();
  execFileSync(join(bin, 'initdb'), ['-D', dir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { stdio: 'ignore' });
  execFileSync(join(bin, 'pg_ctl'), ['-D', dir, '-o', `-c listen_addresses=127.0.0.1 -c unix_socket_directories='' -p ${port}`, '-l', join(dir, 'log'), '-w', 'start'], { stdio: 'ignore' });
  const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 4 });
  await initialize(pool);
  return {
    pool,
    reset: () => reset(pool),
    async stop() { await pool.end(); execFileSync(join(bin, 'pg_ctl'), ['-D', dir, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' }); rmSync(dir, { recursive: true, force: true }); },
  };
}

async function initialize(pool) {
  await pool.query('CREATE SCHEMA mail');
  // DSQL-only syntax: asynchronous index builds.
  const ddl = readFileSync(new URL('../../mail/schema.sql', import.meta.url), 'utf8').replace(/^--.*$/gm, '').replaceAll('INDEX ASYNC', 'INDEX');
  for (const statement of ddl.split(';').map(text => text.trim()).filter(Boolean)) await pool.query(statement);
}
async function reset(pool) { const { rows } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='mail'"); for (const { tablename } of rows) await pool.query(`TRUNCATE mail.${tablename}`); }
