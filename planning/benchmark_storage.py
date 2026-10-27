#!/usr/bin/env python3
"""Local synthetic index amplification/search probe; never connects to AWS."""
import argparse
import hashlib
import json
import platform
import sqlite3
import statistics
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / 'backend'))
from search_probe import setup, positions, search, search_sql


def benchmark(size, directory):
    path = directory / f'{size}.sqlite'
    db = sqlite3.connect(path)
    setup(db)
    start = time.perf_counter()
    token_rows = 0
    for i in range(size):
        domain = 'example' if i % 4 == 0 else 'exampleorg'
        alias = 'taylor' if domain == 'example' else ('info' if i % 3 else 'support')
        address = f'{alias}@{domain}.com'
        message = f'{i:012d}'
        timestamp = f'2026-10-27T00:{i // 60 % 60:02d}:{i % 60:02d}'
        environment = 'staging' if i % 5 == 0 else 'production'
        subject = f'Project update {i}'
        body = ('Hello thank you for contacting us about your project. '
                'We have received your request and will review the details. '
                'Please keep this message for your records. ' +
                ('renew your membership today ' if i % 11 == 0 else 'your account is ready ') +
                ('rarebenchmark ' if i % 997 == 0 else '') + f'reference{i}')
        db.execute('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
                   (domain, message, message, timestamp, subject, 'sender@example.net',
                    json.dumps([address]), 'automated', environment, 'synthetic/manifest', 1, 1))
        aliases = [alias] + (['info'] if alias == 'support' and i % 7 == 0 else [])
        db.executemany('INSERT INTO mailbox_entries VALUES (?,?,?,?,?,?,?)',
                       [(domain, a, message, 'inbox', False, timestamp, 1) for a in aliases])
        rows = list(positions(domain, message, 1, {'sender': ['sender@example.net'],
                    'recipient': [address], 'subject': [subject], 'body': [body]}))
        token_rows += len(rows)
        db.executemany('INSERT INTO search_positions VALUES (?,?,?,?,?,?,?)', rows)
        if i % 100 == 99:
            db.commit()
    db.commit()
    ingest_seconds = time.perf_counter() - start
    db.execute('ANALYZE')
    db.commit()
    cases = [
        ('inbox', '', {}),
        ('common', 'project', {}),
        ('rare', 'rarebenchmark', {}),
        ('phrase', '"renew your membership"', {}),
        ('address', 'info@example.org', {'field': 'recipient'}),
        ('environment', 'project', {'environment': 'staging'}),
        ('absent', 'thereisnosuchword', {}),
    ]
    results = []
    for name, query, options in [(name + '/' + strategy, query, dict(options, strategy=strategy))
                                  for name, query, options in cases
                                  for strategy in (['term', 'mailbox'] if query else ['mailbox'])]:
        times = []
        for _ in range(5):
            start = time.perf_counter()
            rows = search(db, 'exampleorg', 'info', query, **options)
            times.append((time.perf_counter() - start) * 1000)
        if rows:
            next_page = search(db, 'exampleorg', 'info', query, before=rows[-1][::-1], **options)
            assert not set(rows).intersection(next_page), 'Cursor repeated results'
        results.append({'case': name, 'first_page_rows': len(rows),
                        'median_ms': round(statistics.median(times), 3),
                        'max_ms': round(max(times), 3),
                        'sqlite_query_plan': [r[-1] for r in db.execute(
                            'EXPLAIN QUERY PLAN ' + search_sql('exampleorg', 'info', query, **options)[0],
                            search_sql('exampleorg', 'info', query, **options)[1])]})
    entry_count = db.execute('SELECT COUNT(*) FROM mailbox_entries').fetchone()[0]
    db.close()
    return {'messages': size, 'mailbox_entries': entry_count, 'position_rows': token_rows,
            'positions_per_message': round(token_rows / size, 3),
            'sqlite_file_bytes': path.stat().st_size,
            'sqlite_bytes_per_message': round(path.stat().st_size / size, 3),
            'ingest_seconds': round(ingest_seconds, 3), 'queries': results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sizes', nargs='+', type=int, default=[1000, 10000])
    parser.add_argument('--output', type=Path, default=ROOT / 'planning/storage_probe_results.json')
    args = parser.parse_args()
    if any(n < 1 or n > 50000 for n in args.sizes):
        parser.error('Use 1..50000 synthetic messages per dataset')
    with tempfile.TemporaryDirectory(prefix='inbox-search-') as tmp:
        results = [benchmark(n, Path(tmp)) for n in args.sizes]
    report = {'kind': 'LOCAL_SQLITE_FEASIBILITY_ONLY', 'dsql_measured': False,
              'python': platform.python_version(), 'sqlite': sqlite3.sqlite_version,
              'schema_sha256': hashlib.sha256((ROOT / 'backend/schema.sql').read_bytes()).hexdigest(),
              'limitations': ['Synthetic short text, no actual mail or AWS resources.',
                             'SQLite sizes and timings cannot predict DSQL storage, latency, or DPUs.',
                             'No network, IAM, distributed transactions, or background billing measured.',
                             'Large messages, Unicode-heavy mail and production distributions need cloud validation.'],
              'datasets': results}
    args.output.write_text(json.dumps(report, indent=2) + '\n')
    for result in results:
        print(json.dumps({k: v for k, v in result.items() if k != 'queries'}))
    print(f'Wrote {args.output}')


if __name__ == '__main__':
    main()
