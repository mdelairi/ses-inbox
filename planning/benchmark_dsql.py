#!/usr/bin/env python3
"""Explicit, bounded operations against the recorded disposable staging cluster.

Requires the official DSQL Python connector. Never provisions AWS resources.
Run setup as the owner; data operations use the isolated benchmark IAM role.
"""
import argparse
from datetime import datetime, timezone
from decimal import Decimal
import json
import os
from pathlib import Path
import re
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
import uuid

import aurora_dsql_psycopg as dsql
from psycopg import sql as pgsql

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'backend'))
from search_probe import search_sql, positions, choose_strategy
from benchmark_storage import benchmark

RESOURCES = ROOT / 'planning/dsql_benchmark_resources.json'
RESULTS = ROOT / 'planning/dsql_benchmark_results.json'


def now():
    return datetime.now(timezone.utc).isoformat()


def aws(r, *args):
    result = subprocess.run(['aws', *args, '--profile', r['profile'], '--region', r['region'],
                             '--output', 'json'], capture_output=True, text=True, check=True)
    return json.loads(result.stdout) if result.stdout.strip() else None


def guard(r):
    if r['account'] != '222222222222' or r['region'] != 'us-east-1':
        raise RuntimeError('Unexpected benchmark account/region')
    if aws(r, 'sts', 'get-caller-identity')['Account'] != r['account']:
        raise RuntimeError('Wrong AWS identity')
    cluster = aws(r, 'dsql', 'get-cluster', '--identifier', r['cluster_id'])
    if cluster['tags'].get('Project') != 'ses-inbox-app' or cluster['tags'].get('Environment') != 'benchmark':
        raise RuntimeError('Refusing a cluster without the benchmark ownership tags')
    return cluster


def metrics(r):
    result = {'observed_at': now(), 'window_start': r['metric_window_start']}
    for name, stat in [('TotalDPU', 'Sum'), ('ComputeDPU', 'Sum'), ('ReadDPU', 'Sum'),
                       ('WriteDPU', 'Sum'), ('ClusterStorageSize', 'Maximum')]:
        data = aws(r, 'cloudwatch', 'get-metric-statistics', '--namespace', 'AWS/AuroraDSQL',
                   '--metric-name', name, '--dimensions', f'Name=ClusterId,Value={r["cluster_id"]}',
                   '--start-time', result['window_start'], '--end-time', now(),
                   '--period', '60', '--statistics', stat)
        points = sorted(data['Datapoints'], key=lambda p: p['Timestamp'])
        result[name] = {'points': points,
                        'value': (sum(p[stat] for p in points) if stat == 'Sum'
                                  else max(p[stat] for p in points)) if points else None}
    if result['TotalDPU']['value'] is not None:
        result['estimated_dpu_usd'] = str(Decimal(str(result['TotalDPU']['value'])) * Decimal('0.000008'))
    return result


def connect(r, setup=False):
    conn = dsql.connect(host=r['host'], region=r['region'],
                        profile=r['profile'] if setup else 'inbox-benchmark',
                        user='admin' if setup else r['db_role'], autocommit=True,
                        sslmode='verify-full', sslrootcert='/etc/ssl/cert.pem',
                        connect_timeout=15, application_name='ses-inbox-cost-benchmark')
    conn.execute('SET search_path TO inbox_benchmark, public')
    # DSQL rejects statement_timeout. Fixed query/data limits and its server-side
    # transaction limit apply; do not claim a PostgreSQL timeout is enforced.
    return conn


def setup(r):
    with connect(r, setup=True) as conn:
        conn.execute('CREATE SCHEMA IF NOT EXISTS inbox_benchmark')
        if not conn.execute("SELECT 1 FROM pg_roles WHERE rolname = 'inbox_benchmark'").fetchone():
            conn.execute('CREATE ROLE inbox_benchmark WITH LOGIN')
        conn.execute(pgsql.SQL('AWS IAM GRANT {} TO {}').format(
            pgsql.Identifier(r['db_role']), pgsql.Literal(r['role_arn'])))
        statements = re.sub(r'--[^\n]*', '', (ROOT / 'backend/schema.sql').read_text()).split(';')
        for statement in filter(str.strip, statements):
            statement = statement.replace('CREATE TABLE ', 'CREATE TABLE IF NOT EXISTS ')
            statement = statement.replace('INDEX ASYNC ', 'INDEX ASYNC IF NOT EXISTS ')
            cur = conn.execute(statement)
            if re.match(r'\s*CREATE (UNIQUE )?INDEX', statement):
                row = cur.fetchone() if cur.description else None
                if row:
                    for _ in range(60):
                        state = conn.execute('SELECT status FROM sys.jobs WHERE job_id = %s', (row[0],)).fetchone()
                        if state and state[0] == 'completed':
                            break
                        if state and state[0] == 'failed':
                            raise RuntimeError('Index build failed')
                        time.sleep(1)
                    else:
                        raise RuntimeError('Index build did not complete within the probe limit')
            print(statement.strip().split('(')[0].strip(), flush=True)
        conn.execute('GRANT USAGE ON SCHEMA inbox_benchmark TO inbox_benchmark')
        conn.execute('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA inbox_benchmark TO inbox_benchmark')
        conn.execute('ALTER DEFAULT PRIVILEGES IN SCHEMA inbox_benchmark GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO inbox_benchmark')
        return {'status': 'schema-and-scoped-role-created', 'at': now()}


def uid(value):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, 'inbox-benchmark/' + str(value)))


def batch_insert(conn, table, rows):
    # One bounded transaction per statement; only fixed application table names.
    statement = pgsql.SQL('INSERT INTO {} VALUES {}').format(
        pgsql.Identifier(table), pgsql.SQL(',').join(
            pgsql.SQL('(') + pgsql.SQL(',').join(pgsql.Placeholder() for _ in row) + pgsql.SQL(')')
            for row in rows))
    args = [v for row in rows for v in row]
    for attempt in range(5):
        try:
            conn.execute(statement, args)
            return
        except Exception as error:
            if getattr(error, 'sqlstate', None) != '40001' or attempt == 4:
                raise
            time.sleep(0.1 * 2 ** attempt)


def load(r, size):
    with connect(r) as conn:
        existing = conn.execute('SELECT COUNT(*) FROM messages').fetchone()[0]
        # Fixed corpus has forty word positions per message plus one rare marker
        # at each multiple of 997. Refuse to build on a partially loaded corpus.
        actual_positions = conn.execute('SELECT COUNT(*) FROM search_positions').fetchone()[0]
        if actual_positions != 40 * existing + (existing + 996) // 997:
            raise RuntimeError('Incomplete synthetic load; stop and rebuild the disposable experiment')
        if existing >= size:
            return {'messages': existing, 'inserted': 0, 'at': now()}
        before = metrics(r)
        observed = before.get('estimated_dpu_usd')
        if size > 1000 and (observed is None or Decimal(observed) >= Decimal('0.5')):
            raise RuntimeError('Missing usage evidence or insufficient experiment headroom; stop before growth')
        with tempfile.TemporaryDirectory(prefix='inbox-dsql-source-') as tmp:
            benchmark(size, Path(tmp))
            local = sqlite3.connect(Path(tmp) / f'{size}.sqlite')
            start = time.perf_counter()
            tables = [('messages', [0, 1, 2]), ('mailbox_entries', [0, 1, 2]),
                      ('search_positions', [0, 1])]
            counts = {}
            for table, identifiers in tables:
                cursor = local.execute(f'SELECT * FROM {table} WHERE message_id >= ?', (f'{existing:012d}',))
                total = 0
                while rows := cursor.fetchmany(500):
                    converted = []
                    for row in rows:
                        row = list(row)
                        # Alias IDs are domain scoped, not just the local part.
                        if table == 'mailbox_entries':
                            row[1] = row[0] + '/' + row[1]
                            row[4] = bool(row[4])
                        for index in identifiers:
                            row[index] = uid(row[index])
                        converted.append(row)
                    batch_insert(conn, table, converted)
                    total += len(rows)
                    if total % 10000 == 0:
                        print(f'{table}: {total} rows loaded', flush=True)
                counts[table] = total
            local.close()
        return {'messages': size, 'rows_inserted': counts,
                'load_seconds': round(time.perf_counter() - start, 3),
                'start_metrics': before, 'finished_at': now()}


def measure(r, optimized=False):
    cases = [('inbox', '', {}), ('common', 'project', {}), ('rare', 'rarebenchmark', {}),
             ('phrase', '"renew your membership"', {}),
             ('address', 'info@example.org', {'field': 'recipient'}),
             ('environment', 'project', {'environment': 'staging'}),
             ('source', 'project', {'source': 'automated', 'unread': True}),
             ('absent', 'thereisnosuchword', {})]
    results = []
    with connect(r) as conn:
        count = conn.execute('SELECT COUNT(*) FROM messages').fetchone()[0]
        catalogs = {
            'tables': conn.execute('SELECT c.relname, c.reltuples FROM pg_class c '
                'JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=%s '
                'AND c.relname IN (%s,%s,%s)', ('inbox_benchmark', 'messages',
                'mailbox_entries', 'search_positions')).fetchall(),
            'indexes': conn.execute('SELECT tablename,indexname,indexdef FROM pg_indexes '
                'WHERE schemaname=%s ORDER BY tablename,indexname', ('inbox_benchmark',)).fetchall(),
        }
        for name, query, options in cases:
            first = None
            for strategy in (['adaptive'] if optimized else (['term', 'mailbox', 'aggregate'] if query else ['mailbox'])):
                adapter = lambda statement, values: conn.execute(statement.replace('?', '%s'), values)
                choice = choose_strategy(adapter, uid('exampleorg'), query, field=options.get('field')) if optimized else {'strategy': strategy}
                statement, values = search_sql(uid('exampleorg'), uid('exampleorg/info'), query,
                                                **choice, **options)
                statement = statement.replace('?', '%s')
                plans, timings, dpus = [], [], []
                for _ in range(3):
                    start = time.perf_counter()
                    if optimized:
                        choice = choose_strategy(adapter, uid('exampleorg'), query, field=options.get('field'))
                        statement, values = search_sql(uid('exampleorg'), uid('exampleorg/info'), query, **choice, **options)
                        statement = statement.replace('?', '%s')
                    plan = '\n'.join(row[0] for row in conn.execute(
                        'EXPLAIN ANALYZE VERBOSE ' + statement, values))
                    timings.append((time.perf_counter() - start) * 1000)
                    plans.append(plan)
                    match = re.search(r'Total:\s+([\d.]+)\s+DPU', plan)
                    dpus.append(float(match[1]) if match else None)
                rows = conn.execute(statement, values).fetchall()
                if first is not None and rows != first:
                    raise RuntimeError('Search variants disagree')
                first = rows
                if rows:
                    next_sql, next_values = search_sql(uid('exampleorg'), uid('exampleorg/info'), query,
                        **choice, before=(rows[-1][1], rows[-1][0]), **options)
                    second = conn.execute(next_sql.replace('?', '%s'), next_values).fetchall()
                    if set(rows).intersection(second):
                        raise RuntimeError('Cursor repeated a result')
                entry = {'case': name, 'strategy': strategy, 'rows': len(rows),
                         'selected_strategy': choice,
                         'median_roundtrip_ms': round(statistics.median(timings), 3),
                         'dpu_estimates': dpus, 'plans': plans}
                results.append(entry)
                print(json.dumps({k: v for k, v in entry.items() if k != 'plans'}), flush=True)
        return {'messages': count, 'queries': results, 'catalogs': catalogs, 'finished_at': now()}


def checks(r):
    """Database primitives/search checks, not an end-to-end ingestion implementation."""
    domain, message = uid('exampleorg'), uid('edge-fixture')
    info, support = uid('exampleorg/info'), uid('exampleorg/support')
    passed = []
    with connect(r) as conn:
        batch_insert(conn, 'messages', [(domain, message, message, '2026-10-27T12:00:00',
            'Edge fixture', 'sender@example.net', '[]', 'automated', 'staging',
            'synthetic/edge', 1, 1)])
        batch_insert(conn, 'mailbox_entries', [(domain, alias, message, 'inbox', False,
                     '2026-10-27T12:00:00', 1) for alias in (info, support)])
        rows = list(positions(domain, message, 1, {'body': [
            'onlyedgebenchmark go go Café ' + 'word ' * 3500 + 'x' * 4000],
            'subject': ['crossfieldboundary'], 'recipient': ['one@example.net', 'two@example.net']}))
        for offset in range(0, len(rows), 500):
            batch_insert(conn, 'search_positions', rows[offset:offset+500])

        def found(alias, query, **options):
            statement, values = search_sql(domain, alias, query, **options)
            return {str(row[0]) for row in conn.execute(statement.replace('?', '%s'), values)}

        assert message in found(info, 'onlyedgebenchmark "go go" cafe')
        assert not found(info, 'onlyedgebenchmark', field='subject')
        assert not found(info, '"crossfieldboundary onlyedgebenchmark"')
        assert not found(info, '"com two"')
        passed.append('large-index-batched; Unicode/repeated-word/field/recipient phrase boundaries')
        batch_insert(conn, 'search_positions', list(positions(domain, message, 2,
                                                              {'body': ['nextgenerationfixture']})))
        assert message not in found(info, 'nextgenerationfixture')
        conn.execute('UPDATE mailbox_entries SET folder=%s, is_read=%s '
                     'WHERE domain_id=%s AND alias_id=%s AND message_id=%s',
                     ('archive', True, domain, info, message))
        assert message in found(info, 'onlyedgebenchmark', folder='archive')
        assert message in found(support, 'onlyedgebenchmark', folder='inbox', unread=True)
        with conn.transaction():
            conn.execute('INSERT INTO deletion_tombstones VALUES (%s,%s,%s,%s)',
                         (domain, info, message, datetime.now(timezone.utc).replace(tzinfo=None)))
            conn.execute('DELETE FROM mailbox_entries WHERE domain_id=%s AND alias_id=%s AND message_id=%s',
                         (domain, info, message))
        assert message not in found(info, 'onlyedgebenchmark')
        assert message in found(support, 'onlyedgebenchmark')
        assert conn.execute('SELECT 1 FROM deletion_tombstones WHERE domain_id=%s '
                            'AND alias_id=%s AND message_id=%s', (domain, info, message)).fetchone()
        passed.append('independent folder/read/delete; retained shared copy; durable tombstone lookup')
        conn.execute('UPDATE messages SET search_generation=%s WHERE domain_id=%s AND message_id=%s',
                     (2, domain, message))
        assert message not in found(support, 'onlyedgebenchmark')
        assert message in found(support, 'nextgenerationfixture')
        passed.append('unpublished generation hidden; generation switch changes search visibility')
        draft = uid('edge-draft')
        conn.execute('INSERT INTO drafts VALUES (%s,%s,%s,%s,%s,%s)',
                     (domain, support, draft, 'synthetic/draft', datetime.now(timezone.utc).replace(tzinfo=None), 1))
        with connect(r) as second:
            conn.execute('BEGIN')
            second.execute('BEGIN')
            update = ('UPDATE drafts SET revision=revision+1 WHERE domain_id=%s AND alias_id=%s '
                      'AND draft_id=%s AND revision=%s')
            conn.execute(update, (domain, support, draft, 1))
            conflict = None
            try:
                second.execute(update, (domain, support, draft, 1))
                conn.execute('COMMIT')
                second.execute('COMMIT')
            except Exception as error:
                conflict = getattr(error, 'sqlstate', None)
                second.execute('ROLLBACK')
                conn.execute('COMMIT')
            assert conflict == '40001', f'Expected OCC conflict, got {conflict}'
        assert conn.execute('SELECT revision FROM drafts WHERE domain_id=%s AND alias_id=%s AND draft_id=%s',
                            (domain, support, draft)).fetchone()[0] == 2
        passed.append('concurrent draft revision update rejects one transaction with SQLSTATE 40001')
        return {'passed': passed, 'fixture_position_rows': len(rows), 'finished_at': now(),
                'limitations': 'Primitives only; no real ingestion/replay/restore/S3 implementation exercised.'}


def diagnose(r):
    statement, values = search_sql(uid('exampleorg'), uid('exampleorg/info'), 'info@example.org',
                                   field='recipient', strategy='mailbox')
    statement = statement.replace('?', '%s')
    result = {'sql': statement, 'bound_values': values, 'at': now(), 'experiments': {}}
    with connect(r) as conn:
        result['baseline'] = '\n'.join(row[0] for row in conn.execute(
            'EXPLAIN ANALYZE VERBOSE ' + statement, values))
        result['counts'] = {table: conn.execute(pgsql.SQL('SELECT COUNT(*) FROM {}').format(
            pgsql.Identifier(table))).fetchone()[0]
            for table in ('messages', 'mailbox_entries', 'search_positions')}
        result['statistics'] = conn.execute('SELECT tablename,attname,n_distinct,most_common_vals,'
            'most_common_freqs FROM pg_stats WHERE schemaname=%s AND tablename=%s '
            'AND attname IN (%s,%s,%s)', ('inbox_benchmark', 'search_positions',
                                        'token', 'field', 'domain_id')).fetchall()
        result['distinct'] = conn.execute('SELECT COUNT(DISTINCT token),COUNT(DISTINCT field),'
                                         'COUNT(DISTINCT domain_id) FROM search_positions').fetchone()
        for experiment in ('merge-only', 'redundant-domain'):
            try:
                with conn.transaction():
                    if experiment == 'merge-only':
                        conn.execute('SET LOCAL enable_hashjoin = off')
                        conn.execute('SET LOCAL enable_nestloop = off')
                        conn.execute('SET LOCAL enable_mergejoin = on')
                        query, params = statement, values
                    else:
                        query = statement.replace(' WHERE ', ' WHERE m.domain_id = %s AND ', 1)
                        params = [uid('exampleorg'), *values]
                    plan = '\n'.join(row[0] for row in conn.execute('EXPLAIN ANALYZE VERBOSE ' + query, params))
                    result['experiments'][experiment] = {'plan': plan}
            except Exception as error:
                result['experiments'][experiment] = {'error': str(error), 'sqlstate': getattr(error, 'sqlstate', None)}
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=['setup', 'load', 'measure', 'metrics', 'checks', 'diagnose'])
    parser.add_argument('--size', type=int, choices=[1000, 10000, 50000], default=1000)
    parser.add_argument('--optimized', action='store_true')
    args = parser.parse_args()
    r = json.loads(RESOURCES.read_text())
    if args.operation == 'metrics' and r['status'] == 'deleted-and-verified':
        if aws(r, 'sts', 'get-caller-identity')['Account'] != r['account']:
            raise RuntimeError('Wrong AWS identity')
    else:
        guard(r)
    if args.operation == 'setup':
        result = setup(r)
    elif args.operation == 'load':
        result = load(r, args.size)
    elif args.operation == 'measure':
        result = measure(r, optimized=args.optimized)
    elif args.operation == 'checks':
        result = checks(r)
    elif args.operation == 'diagnose':
        result = diagnose(r)
    else:
        result = metrics(r)
    history = json.loads(RESULTS.read_text()) if RESULTS.exists() else {'runs': []}
    history['runs'].append({'operation': args.operation, 'result': result})
    RESULTS.write_text(json.dumps(history, indent=2, default=str) + '\n')
    print('Recorded', args.operation, 'in', RESULTS)


if __name__ == '__main__':
    main()
