#!/usr/bin/env python3
"""Render measured evidence; all numerical comparisons are calculated here."""
from decimal import Decimal
from datetime import datetime
import json
from pathlib import Path
import re
import statistics

ROOT = Path(__file__).resolve().parent


def plan_value(plan, label):
    match = re.search(re.escape(label) + r':\s+([^\n]+)', plan)
    return match[1] if match else 'not reported'


def main():
    runs = json.loads((ROOT / 'dsql_benchmark_results.json').read_text())['runs']
    resources = json.loads((ROOT / 'dsql_benchmark_resources.json').read_text())
    measured = [r['result'] for r in runs if r['operation'] == 'measure']
    latest = measured[-1]
    metrics = [r['result'] for r in runs if r['operation'] == 'metrics']
    metric = metrics[-1] if metrics else {}
    checks = [r['result'] for r in runs if r['operation'] == 'checks']
    diagnostic = [r['result'] for r in runs if r['operation'] == 'diagnose'][-1]
    baseline = next(q for m in measured if m['messages'] == 10000
                    for q in m['queries'] if q['case'] == 'address' and q['strategy'] == 'mailbox')
    adaptive10k = next(q for m in reversed(measured) if m['messages'] == 10000
                       for q in m['queries'] if q['case'] == 'address' and q['strategy'] == 'adaptive')
    reduction = (1 - adaptive10k['median_roundtrip_ms'] / baseline['median_roundtrip_ms']) * 100
    cost = Decimal(metric.get('estimated_dpu_usd', '0'))
    storage = metric.get('ClusterStorageSize', {}).get('value')
    last_load = [r['result'] for r in runs if r['operation'] == 'load'][-1]
    post_load = [p for p in metric.get('ClusterStorageSize', {}).get('points', [])
                 if datetime.fromisoformat(p['Timestamp']) >= datetime.fromisoformat(last_load['finished_at'])]
    if post_load:
        peak = Decimal(str(max(p['Maximum'] for p in post_load)))
        gib = peak / Decimal(1024 ** 3)
        storage_note = (f'Post-load observed database storage reached **{gib:.3f} GiB** '
                        f'({peak:,.0f} bytes). Holding that measured size for a whole month '
                        f'would cost about **US${gib * Decimal("0.33"):.3f}/month** for database storage alone, '
                        'before allowances. This includes the short-message corpus, its indexes, and the '
                        'edge fixture; it excludes S3 mail/attachments and backups. Longer real bodies '
                        'can require many more word-position rows. It is not a production storage forecast.')
    else:
        storage_note = (f'Largest storage metric observed: `{storage}` bytes. No post-load point '
                        'has caught up, so completed archive storage remains provisional. '
                        'Local SQLite bytes are not a substitute for DSQL storage.')
    text = ['# Storage benchmark results', '',
        'October 27, 2026. Synthetic data only. Hosted stage and live email routing were unchanged.', '',
        '**Decision:** DSQL remains a viable candidate for the next server-backed sample-mail milestone. '
        'The schema and search primitives work on the service. This experiment does not establish a production '
        'monthly bill, representative long-message storage, or completed ingestion/deletion/recovery behavior.', '',
        f'**Temporary resource status:** `{resources["status"]}`. See [resource/cleanup record](dsql_benchmark_resources.json).', '',
        '## Measured query behavior', '',
        f'Largest measured corpus: **{latest["messages"]:,} short synthetic messages**. '
        'Timings include client/network round trips and bounded strategy probes for adaptive runs. '
        'Each cell uses the median of three runs; these are not p95 latency promises.', '',
        '| Case | Choice | Median round trip (ms) | Final-query DPU estimate |',
        '| --- | --- | ---: | ---: |']
    for q in latest['queries']:
        dpu = statistics.median(v for v in q['dpu_estimates'] if v is not None)
        text.append(f'| {q["case"]} | {q.get("selected_strategy", {}).get("strategy", q["strategy"])} '
                    f'| {q["median_roundtrip_ms"]:.3f} | {dpu:.5f} |')
    text += ['', '**DPU caveat:** final-query statement estimates exclude the bounded strategy probes and '
             'some transaction/background activity. Cluster metrics include more of that work and were used '
             'for the experiment usage check. Statements are tuning evidence, not billing-grade measurements.', '',
             '**Remaining performance work:** the environment-filtered search is materially slower than ordinary '
             'mailbox/address searches at the largest corpus. Before production, test pushing immutable '
             'environment/source labels into mailbox entries or a suitable covered index. Keep the result '
             'semantics unchanged and re-measure; no improvement from that proposed change is claimed here.', '',
             f'At 10,000 messages, address search changed from {baseline["median_roundtrip_ms"]:.3f} ms '
             f'to {adaptive10k["median_roundtrip_ms"]:.3f} ms including probes '
             f'({reduction:.2f}% lower in these runs). Removing an unnecessary message join also made folder '
             'paging cheaper. Both rewrites retain mailbox and generation checks where needed. '
             'Common-word grouping is slower for rare/absent words; bounded posting probes select a rare '
             'anchor when available. No persistent frequency counters or extra service are required.', '',
             'The experiment tested three query shapes, then the bounded choice. The full result JSON includes '
             'plans, medians, DPU samples, catalog snapshots, load operations, and timestamped metric points. '
             'See [raw cloud evidence](dsql_benchmark_results.json) and [address-query diagnosis](DSQL_QUERY_DIAGNOSIS.md).', '',
             '## Usage and retention costs', '',
             f'Last observed aggregate DPU charge equivalent: **US${cost:.4f}**, before free allowances/credits. '
             'This is reported cluster usage multiplied by the verified regional rate, not a settled AWS invoice. '
             'It includes schema setup, loading, diagnostics, and query runs; late/background usage, storage, '
             'data transfer, and monitoring API calls can add charges. The approved US$1 threshold was a stop '
             'target, not a hard cap.', '',
             'Verified Price List API rates: US$0.000008/DPU and US$0.33/GB-month in us-east-1. '
             '[AWS pricing](https://aws.amazon.com/rds/aurora/dsql/pricing/).', '',
             storage_note, '',
             'The original US$5 working budget remains provisional. For a query-cost sensitivity check only, '
             'the largest final-query DPU median in the last corpus gives:', '',
             '| Monthly searches | Final-query component at that measured DPU |',
             '| ---: | ---: |']
    worst = max(statistics.median(v for v in q['dpu_estimates'] if v is not None) for q in latest['queries'])
    for count in (1000, 5000, 20000):
        text.append(f'| {count:,} | US${Decimal(str(worst)) * count * Decimal("0.000008"):.4f} |')
    text += ['', 'These are sensitivity calculations, not monthly forecasts: they exclude probe overhead, '
             'ingestion, drafts, updates, sessions, storage, retries, backups, and every other AWS service. '
             'Neither audited sending volume nor this synthetic archive predicts the owner’s search frequency. '
             'Do not replace the complete operating model with this table.', '',
             '## Checks and limits', '']
    if checks:
        text += [f'- {item}.' for item in checks[-1]['passed']]
    text += ['- Local SQL tests cover alias/domain isolation, filters, bound values, phrase boundaries, '
             'generation visibility, cursor ties, and query-strategy agreement.',
             '- Cloud checks exercise database primitives and search, not a running mail API. '
             'No real bodies, attachments, sends, backups, or restore/replay pipeline were exercised.',
             '- Fixed short-text corpus and low concurrency. Larger/multilingual message fixtures check '
             'semantics but do not establish real-mail performance distributions.',
             '- Ordinary search endpoints still need signed cursors, API authorization, conversation grouping '
             'before pagination, production workload limits, monitoring, and cross-device persistence.', '',
             '## Next implementation', '',
             'Build the scoped repository/API against sample mail first: server-stored aliases, mailbox state, '
             'immutable draft/body objects, revision conflicts, and signed pagination. Verify the same draft '
             'on desktop and iPhone. Keep SES disconnected until that milestone passes. Then test ingestion '
             'and restoration with the agreed 30-day recovery policy.']
    (ROOT / 'STORAGE_BENCHMARK.md').write_text('\n'.join(text) + '\n')

    plan = diagnostic['baseline']
    lines = ['# SQL Query Explainability — Diagnostic Report',
             'Preview Only - not for distribution', '',
             '## Query Information', '', '| Field | Value |', '| --- | --- |',
             f'| Query Identifier | {plan_value(plan, "Query Identifier")} |',
             f'| Planning Time | {plan_value(plan, "Planning Time")} |',
             f'| Execution Time | {plan_value(plan, "Execution Time")} |',
             f'| DPU Estimate | {plan_value(plan, "Total")} |', '',
             'Disposable staging cluster, 10,000 synthetic messages. Runtime connection used the scoped '
             'benchmark role. SQL values below are synthetic identifiers/digests, not customer mail.', '',
             '## SQL Statement', '', '```sql', diagnostic['sql'], '```', '',
             'Native psycopg bound parameters:', '', '```json',
             json.dumps(diagnostic['bound_values'], indent=2), '```', '',
             '## Plan Overview', '', '```text', plan, '```', '',
             '## Findings', '', '### 1. Repeated per-candidate token lookups (CRITICAL, Original Query)', '',
             '#### What we observed', '',
             'The final semi-join processes 5,000 candidates and performs a token index probe for each '
             'before sorting for the first 50 results. The plan reports one estimated final match versus '
             '5,000 actual matches. The full plan above records node times and loop counts.', '',
             '#### Why it happened', '',
             'The three normalized address words are strongly correlated; treating each as a separate '
             'semi-join underestimates matches and permits repeated lookups. Statistics observed during '
             'bulk ingestion can also lag actual rows. Actual counts at diagnosis: `' +
             json.dumps(diagnostic['counts']) + '`. Distinct token/field/domain counts: `' +
             json.dumps(diagnostic['distinct']) + '`.', '',
             '#### Recommendation', '',
             'Use grouped-word matching for common unquoted words and bounded posting probes to choose '
             'a selective anchor for rare words. Exact implementation is in `backend/search_probe.py` '
             '(`search_sql` and `choose_strategy`). Do not force a global join setting. '
             f'The measured 10,000-message adaptive address run was {adaptive10k["median_roundtrip_ms"]:.3f} ms '
             f'including probes, versus {baseline["median_roundtrip_ms"]:.3f} ms initially. '
             'No magnitude is promised for real mail or future optimizer statistics.', '',
             '### 2. Planner settings and redundant scope predicate (MODERATE, experiments)', '',
             '#### What we observed', '',
             'Merge-only settings changed the plan but retained batched nested loops. An extra explicit '
             'message-domain predicate did not remove the core candidate work. Each experiment ran in a '
             'fresh transaction with SET LOCAL; all were SELECT-only.', '',
             '#### Why it happened', '',
             'The domain constant was already inferred through equality joins. Query structure and '
             'correlated words matter more than adding that redundant predicate.', '',
             '#### Recommendation', '',
             'Keep the semantically checked query rewrite. Reassess statistics after the real ingestion '
             'pipeline exists. These single diagnostic runs do not establish that a planner setting is '
             'universally better.', '', '## GUC Experiment Results', '',
             '| Variant | Execution time | Final-query DPU |', '| --- | ---: | ---: |',
             f'| Default | {plan_value(plan,"Execution Time")} | {plan_value(plan,"Total")} |']
    for name, experiment in diagnostic['experiments'].items():
        if 'plan' in experiment:
            lines.append(f'| {name} | {plan_value(experiment["plan"],"Execution Time")} '
                         f'| {plan_value(experiment["plan"],"Total")} |')
        else:
            lines.append(f'| {name} | Failed: {experiment["error"]} | no comparison |')
    lines += ['', 'Full experiment plans and pg_stats evidence are retained in '
              '[dsql_benchmark_results.json](dsql_benchmark_results.json). No physically impossible '
              'cardinalities were identified; no support ticket was created.', '', '## Summary', '',
              '| # | Finding | Severity | Recommendation | Expected Impact |',
              '| --- | --- | --- | --- | --- |',
              '| 1 | Repeated candidate lookups | CRITICAL | Group common words; selectively anchor rare ones '
              '| Measured improvement above; real-mail magnitude unknown |',
              '| 2 | Join settings/domain inference | MODERATE | Keep default planner settings and explicit mailbox scope '
              '| Avoid depending on a global setting; no numerical forecast |', '',
              '## Next Steps', '',
              'Apply the repository/search design to sample data, then re-measure before enabling real mail. '
              'Say **reassess** after a schema or workload change to capture fresh plans and compare them '
              'with this evidence. If observed performance differs, investigate rather than treating this '
              'benchmark as a permanent guarantee.']
    (ROOT / 'DSQL_QUERY_DIAGNOSIS.md').write_text('\n'.join(lines) + '\n')
    print('Rendered STORAGE_BENCHMARK.md and DSQL_QUERY_DIAGNOSIS.md')


if __name__ == '__main__':
    main()
