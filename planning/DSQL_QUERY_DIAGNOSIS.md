# SQL Query Explainability — Diagnostic Report
Preview Only - not for distribution

## Query Information

| Field | Value |
| --- | --- |
| Query Identifier | akophyqscfkxy |
| Planning Time | 90.138 ms |
| Execution Time | 3507.373 ms |
| DPU Estimate | 17.47903 DPU |

Disposable staging cluster, 10,000 synthetic messages. Runtime connection used the scoped benchmark role. SQL values below are synthetic identifiers/digests, not customer mail.

## SQL Statement

```sql
SELECT e.message_id, e.received_at FROM mailbox_entries e JOIN messages m ON m.domain_id = e.domain_id AND m.message_id = e.message_id WHERE e.domain_id = %s AND e.alias_id = %s AND EXISTS (SELECT 1 FROM search_positions p WHERE p.domain_id = e.domain_id AND p.message_id = e.message_id AND p.generation = m.search_generation AND p.token = %s AND p.field = %s) AND EXISTS (SELECT 1 FROM search_positions p WHERE p.domain_id = e.domain_id AND p.message_id = e.message_id AND p.generation = m.search_generation AND p.token = %s AND p.field = %s) AND EXISTS (SELECT 1 FROM search_positions p WHERE p.domain_id = e.domain_id AND p.message_id = e.message_id AND p.generation = m.search_generation AND p.token = %s AND p.field = %s) ORDER BY e.received_at DESC, e.message_id DESC LIMIT %s
```

Native psycopg bound parameters:

```json
[
  "1b39297f-d568-5f2b-9b8a-c7e804ea614a",
  "79915111-ba74-5153-9b2e-ddc1a0a75732",
  "06271baf49532c879aa3c58b48671884bcc858f09197412d682750496c33e1e1",
  "recipient",
  "95e7ceac053a0d60b718c76c0caa5d49b08358efc29086eb26ca0c9205e1ec9b",
  "recipient",
  "71b4f3a3748cd6843c01e293e701fce769f52381821e21daf2ff4fe9ea57a6f3",
  "recipient",
  50
]
```

## Plan Overview

```text
Limit  (cost=1211.18..1211.19 rows=1 width=24) (actual time=3506.770..3506.787 rows=50 loops=1)
  Output: e.message_id, e.received_at
  ->  Sort  (cost=1211.18..1211.19 rows=1 width=24) (actual time=3506.766..3506.778 rows=50 loops=1)
        Output: e.message_id, e.received_at
        Sort Key: e.received_at DESC, e.message_id DESC
        Sort Method: top-N heapsort  Memory: 30kB
        ->  Nested Loop Semi Join  (cost=1094.44..1211.17 rows=1 width=24) (actual time=142.189..3499.515 rows=5000 loops=1)
              Output: e.message_id, e.received_at
              Join Filter: (p.generation = p_2.generation)
              ->  Nested Loop (Batched Join)  (cost=994.27..1106.97 rows=1 width=100) (actual time=141.089..726.241 rows=5000 loops=1)
                    Output: e.message_id, e.received_at, e.domain_id, m.message_id, m.search_generation, p.message_id, p.generation, p_1.message_id, p_1.generation
                    Join Type: Semi
                    Recheck Cond: (p_1.message_id = e.message_id)
                    Join Filter: ((m.message_id = p_1.message_id) AND (p.generation = p_1.generation))
                    ->  Nested Loop (Batched Join)  (cost=846.85..945.35 rows=43 width=80) (actual time=80.811..473.384 rows=5000 loops=1)
                          Output: e.message_id, e.received_at, e.domain_id, m.message_id, m.search_generation, p.message_id, p.generation
                          Recheck Cond: (m.message_id = e.message_id)
                          Join Filter: (m.search_generation = p.generation)
                          ->  Nested Loop (Batched Join)  (cost=683.69..764.09 rows=57 width=60) (actual time=32.585..240.075 rows=5000 loops=1)
                                Output: e.message_id, e.received_at, e.domain_id, p.message_id, p.generation
                                Recheck Cond: (e.message_id = p.message_id)
                                ->  HashAggregate  (cost=427.15..428.55 rows=140 width=36) (actual time=19.484..20.601 rows=5000 loops=1)
                                      Output: p.domain_id, p.message_id, p.generation
                                      Group Key: p.domain_id, p.message_id, p.generation
                                      Batches: 1  Memory Usage: 737kB
                                      ->  Index Only Scan Backward using search_term on inbox_benchmark.search_positions p  (cost=332.17..426.10 rows=141 width=36) (actual time=1.605..16.750 rows=5000 loops=1)
                                            Output: p.domain_id, p.message_id, p.generation
                                            Index Cond: ((p.domain_id = '1b39297f-d568-5f2b-9b8a-c7e804ea614a'::uuid) AND (p.token = '06271baf49532c879aa3c58b48671884bcc858f09197412d682750496c33e1e1'::text))
                                            -> Storage Scan on search_term  (cost=332.17..426.10 rows=141 width=36 loops=1) (actual rows=5000 loops=1)
                                                Projections: domain_id, message_id, generation
                                                Filters: ((p.field)::text = 'recipient'::text)
                                                Rows Removed by Filter: 0
                                                -> B-Tree Scan on search_term  (cost=332.17..426.10 rows=1857 width=36 loops=1) (actual rows=5000 loops=1)
                                                    Index Cond: ((p.domain_id = '1b39297f-d568-5f2b-9b8a-c7e804ea614a'::uuid) AND (p.token = '06271baf49532c879aa3c58b48671884bcc858f09197412d682750496c33e1e1'::text))
                                ->  Index Only Scan using mailbox_entries_pkey on inbox_benchmark.mailbox_entries e  (cost=256.54..265.54 rows=140 width=40) (actual time=9.790..11.684 rows=1000 loops=5)
                                      Output: e.message_id, e.received_at, e.domain_id
                                      Index Cond: ((e.domain_id = '1b39297f-d568-5f2b-9b8a-c7e804ea614a'::uuid) AND (e.alias_id = '79915111-ba74-5153-9b2e-ddc1a0a75732'::uuid) AND (e.message_id = p.message_id))
                                      -> Storage Scan on mailbox_entries_pkey  (cost=256.54..265.54 rows=140 width=40 loops=1) (actual rows=1000 loops=1)
                                          Projections: domain_id, message_id, received_at
                                          -> B-Tree Scan on mailbox_entries_pkey  (cost=256.54..265.54 rows=140 width=40 loops=1) (actual rows=1000 loops=1)
                                              Index Cond: ((e.domain_id = '1b39297f-d568-5f2b-9b8a-c7e804ea614a'::uuid) AND (e.alias_id = '79915111-ba74-5153-9b2e-ddc1a0a75732'::uuid) AND (e.message_id = p.message_id))
                          ->  Index Only Scan using messages_pkey on inbox_benchmark.messages m  (cost=163.16..169.18 rows=57 width=36) (actual time=9.315..11.273 rows=1000 loops=5)
                                Output: m.domain_id, m.message_id, m.search_generation
                                Index Cond: ((m.domain_id = '1b39297f-d568-5f2b-9b8a-c7e804ea614a'::uuid) AND (m.message_id = e.message_id))
                                -> Storage Scan on messages_pkey  (cost=163.16..169.18 rows=57 width=36 loops=1) (actual rows=1000 loops=1)
                                    Projections: domain_id, message_id, search_generation
                                    -> B-Tree Scan on messages_pkey  (cost=163.16..169.18 rows=57 width=36 loops=1) (actual rows=1000 loops=1)
                                        Index Cond: ((m.domain_id = '1b39297f-d568-5f2b-9b8a-c7e804ea614a'::uuid) AND (m.message_id = e.message_id))
                    ->  Index Only Scan using search_term on inbox_benchmark.search_positions p_1  (cost=147.42..154.50 rows=43 width=36) (actual time=14.228..21.243 rows=1000 loops=5)
                          Output: p_1.domain_id, p_1.message_id, p_1.generation
                          Index Cond: ((p_1.domain_id = '1b39297f-d568-5f2b-9b8a-c7e804ea614a'::uuid) AND (p_1.token = '95e7ceac053a0d60b718c76c0caa5d49b08358efc29086eb26ca0c9205e1ec9b'::text) AND (p_1.message_id = e.message_id))
                          -> Storage Scan on search_term  (cost=147.42..154.50 rows=3 width=36 loops=1) (actual rows=1000 loops=1)
                              Projections: domain_id, message_id, generation
                              Filters: ((p_1.field)::text = 'recipient'::text)
                              Rows Removed by Filter: 0
                              -> B-Tree Scan on search_term  (cost=147.42..154.50 rows=43 width=36 loops=1) (actual rows=1000 loops=1)
                                  Index Cond: ((p_1.domain_id = '1b39297f-d568-5f2b-9b8a-c7e804ea614a'::uuid) AND (p_1.token = '95e7ceac053a0d60b718c76c0caa5d49b08358efc29086eb26ca0c9205e1ec9b'::text) AND (p_1.message_id = e.message_id))
              ->  Index Only Scan using search_term on inbox_benchmark.search_positions p_2  (cost=100.17..104.19 rows=1 width=36) (actual time=0.535..0.535 rows=1 loops=5000)
                    Output: p_2.domain_id, p_2.message_id, p_2.generation
                    Index Cond: ((p_2.domain_id = '1b39297f-d568-5f2b-9b8a-c7e804ea614a'::uuid) AND (p_2.token = '71b4f3a3748cd6843c01e293e701fce769f52381821e21daf2ff4fe9ea57a6f3'::text) AND (p_2.message_id = m.message_id) AND (p_2.generation = m.search_generation) AND (p_2.field = 'recipient'::text))
                    -> Storage Scan on search_term  (cost=100.17..104.19 rows=1 width=36 loops=1) (actual rows=1 loops=1)
                        Projections: domain_id, message_id, generation
                        -> B-Tree Scan on search_term  (cost=100.17..104.19 rows=1 width=36 loops=1) (actual rows=1 loops=1)
                            Index Cond: ((p_2.domain_id = '1b39297f-d568-5f2b-9b8a-c7e804ea614a'::uuid) AND (p_2.token = '71b4f3a3748cd6843c01e293e701fce769f52381821e21daf2ff4fe9ea57a6f3'::text) AND (p_2.message_id = m.message_id) AND (p_2.generation = m.search_generation) AND (p_2.field = 'recipient'::text))
Query Identifier: akophyqscfkxy
Planning Time: 90.138 ms
Execution Time: 3507.373 ms
Statement DPU Estimate:
  Compute: 3.60017 DPU
  Read: 13.87886 DPU
  Write: 0.00000 DPU
  Total: 17.47903 DPU
```

## Findings

### 1. Repeated per-candidate token lookups (CRITICAL, Original Query)

#### What we observed

The final semi-join processes 5,000 candidates and performs a token index probe for each before sorting for the first 50 results. The plan reports one estimated final match versus 5,000 actual matches. The full plan above records node times and loop counts.

#### Why it happened

The three normalized address words are strongly correlated; treating each as a separate semi-join underestimates matches and permits repeated lookups. Statistics observed during bulk ingestion can also lag actual rows. Actual counts at diagnosis: `{"messages": 10000, "mailbox_entries": 10357, "search_positions": 400011}`. Distinct token/field/domain counts: `[20039, 4, 2]`.

#### Recommendation

Use grouped-word matching for common unquoted words and bounded posting probes to choose a selective anchor for rare words. Exact implementation is in `backend/search_probe.py` (`search_sql` and `choose_strategy`). Do not force a global join setting. The measured 10,000-message adaptive address run was 240.003 ms including probes, versus 2728.574 ms initially. No magnitude is promised for real mail or future optimizer statistics.

### 2. Planner settings and redundant scope predicate (MODERATE, experiments)

#### What we observed

Merge-only settings changed the plan but retained batched nested loops. An extra explicit message-domain predicate did not remove the core candidate work. Each experiment ran in a fresh transaction with SET LOCAL; all were SELECT-only.

#### Why it happened

The domain constant was already inferred through equality joins. Query structure and correlated words matter more than adding that redundant predicate.

#### Recommendation

Keep the semantically checked query rewrite. Reassess statistics after the real ingestion pipeline exists. These single diagnostic runs do not establish that a planner setting is universally better.

## GUC Experiment Results

| Variant | Execution time | Final-query DPU |
| --- | ---: | ---: |
| Default | 3507.373 ms | 17.47903 DPU |
| merge-only | 901.736 ms | 14.69516 DPU |
| redundant-domain | 3443.330 ms | 17.23756 DPU |

Full experiment plans and pg_stats evidence are retained in [dsql_benchmark_results.json](dsql_benchmark_results.json). No physically impossible cardinalities were identified; no support ticket was created.

## Summary

| # | Finding | Severity | Recommendation | Expected Impact |
| --- | --- | --- | --- | --- |
| 1 | Repeated candidate lookups | CRITICAL | Group common words; selectively anchor rare ones | Measured improvement above; real-mail magnitude unknown |
| 2 | Join settings/domain inference | MODERATE | Keep default planner settings and explicit mailbox scope | Avoid depending on a global setting; no numerical forecast |

## Next Steps

Apply the repository/search design to sample data, then re-measure before enabling real mail. Say **reassess** after a schema or workload change to capture fresh plans and compare them with this evidence. If observed performance differs, investigate rather than treating this benchmark as a permanent guarantee.
