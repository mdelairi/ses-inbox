// Throwaway local PostgreSQL for repository tests. DSQL is a PostgreSQL subset, so
// this catches SQL and transaction mistakes, not DSQL-specific limits or OCC timing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const bin = fileURLToPath(new URL('../../.tools/postgres/17/bin/', import.meta.url));
export const postgresAvailable = existsSync(join(bin, 'pg_ctl'));
const freePort = () => new Promise(resolve => { const server = createServer().listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });

export async function startPostgres() {
  const dir = mkdtempSync(join(tmpdir(), 'inbox-pg-')), port = await freePort();
  execFileSync(join(bin, 'initdb'), ['-D', dir, '-U', 'postgres', '--auth=trust', '-E', 'UTF8'], { stdio: 'ignore' });
  execFileSync(join(bin, 'pg_ctl'), ['-D', dir, '-o', `-c listen_addresses=127.0.0.1 -c unix_socket_directories='' -p ${port}`, '-l', join(dir, 'log'), '-w', 'start'], { stdio: 'ignore' });
  const pool = new pg.Pool({ host: '127.0.0.1', port, user: 'postgres', database: 'postgres', max: 4 });
  await pool.query('CREATE SCHEMA mail');
  // DSQL-only syntax: asynchronous index builds.
  const ddl = readFileSync(new URL('../../mail/schema.sql', import.meta.url), 'utf8').replace(/^--.*$/gm, '').replaceAll('INDEX ASYNC', 'INDEX');
  for (const statement of ddl.split(';').map(text => text.trim()).filter(Boolean)) await pool.query(statement);
  return {
    pool,
    async reset() { const { rows } = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='mail'"); for (const { tablename } of rows) await pool.query(`TRUNCATE mail.${tablename}`); },
    async stop() { await pool.end(); execFileSync(join(bin, 'pg_ctl'), ['-D', dir, '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' }); rmSync(dir, { recursive: true, force: true }); },
  };
}
