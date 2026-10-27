# Storage benchmark results

October 27, 2026. Synthetic data only. Hosted stage and live email routing were unchanged.

**Decision:** DSQL remains a viable candidate for the next server-backed sample-mail milestone. The schema and search primitives work on the service. This experiment does not establish a production monthly bill, representative long-message storage, or completed ingestion/deletion/recovery behavior.

**Temporary resource status:** `deleted-and-verified`. See [resource/cleanup record](dsql_benchmark_resources.json).

## Measured query behavior

Largest measured corpus: **50,000 short synthetic messages**. Timings include client/network round trips and bounded strategy probes for adaptive runs. Each cell uses the median of three runs; these are not p95 latency promises.

| Case | Choice | Median round trip (ms) | Final-query DPU estimate |
| --- | --- | ---: | ---: |
| inbox | mailbox | 31.238 | 0.04259 |
| common | aggregate | 108.447 | 0.17882 |
| rare | term | 63.403 | 0.07487 |
| phrase | mailbox | 952.354 | 30.17254 |
| address | aggregate | 186.787 | 0.23389 |
| environment | aggregate | 2618.619 | 30.52451 |
| source | aggregate | 133.978 | 0.79539 |
| absent | term | 75.385 | 0.00259 |

**DPU caveat:** final-query statement estimates exclude the bounded strategy probes and some transaction/background activity. Cluster metrics include more of that work and were used for the experiment usage check. Statements are tuning evidence, not billing-grade measurements.

**Remaining performance work:** the environment-filtered search is materially slower than ordinary mailbox/address searches at the largest corpus. Before production, test pushing immutable environment/source labels into mailbox entries or a suitable covered index. Keep the result semantics unchanged and re-measure; no improvement from that proposed change is claimed here.

At 10,000 messages, address search changed from 2728.574 ms to 240.003 ms including probes (91.20% lower in these runs). Removing an unnecessary message join also made folder paging cheaper. Both rewrites retain mailbox and generation checks where needed. Common-word grouping is slower for rare/absent words; bounded posting probes select a rare anchor when available. No persistent frequency counters or extra service are required.

The experiment tested three query shapes, then the bounded choice. The full result JSON includes plans, medians, DPU samples, catalog snapshots, load operations, and timestamped metric points. See [raw cloud evidence](dsql_benchmark_results.json) and [address-query diagnosis](DSQL_QUERY_DIAGNOSIS.md).

## Usage and retention costs

Last observed aggregate DPU charge equivalent: **US$0.4879**, before free allowances/credits. This is reported cluster usage multiplied by the verified regional rate, not a settled AWS invoice. It includes schema setup, loading, diagnostics, and query runs; late/background usage, storage, data transfer, and monitoring API calls can add charges. The approved US$1 threshold was a stop target, not a hard cap.

Verified Price List API rates: US$0.000008/DPU and US$0.33/GB-month in us-east-1. [AWS pricing](https://aws.amazon.com/rds/aurora/dsql/pricing/).

Post-load observed database storage reached **0.914 GiB** (980,905,050 bytes). Holding that measured size for a whole month would cost about **US$0.301/month** for database storage alone, before allowances. This includes the short-message corpus, its indexes, and the edge fixture; it excludes S3 mail/attachments and backups. Longer real bodies can require many more word-position rows. It is not a production storage forecast.

The original US$5 working budget remains provisional. For a query-cost sensitivity check only, the largest final-query DPU median in the last corpus gives:

| Monthly searches | Final-query component at that measured DPU |
| ---: | ---: |
| 1,000 | US$0.2442 |
| 5,000 | US$1.2210 |
| 20,000 | US$4.8839 |

These are sensitivity calculations, not monthly forecasts: they exclude probe overhead, ingestion, drafts, updates, sessions, storage, retries, backups, and every other AWS service. Neither audited sending volume nor this synthetic archive predicts the owner’s search frequency. Do not replace the complete operating model with this table.

## Checks and limits

- large-index-batched; Unicode/repeated-word/field/recipient phrase boundaries.
- independent folder/read/delete; retained shared copy; durable tombstone lookup.
- unpublished generation hidden; generation switch changes search visibility.
- concurrent draft revision update rejects one transaction with SQLSTATE 40001.
- Local SQL tests cover alias/domain isolation, filters, bound values, phrase boundaries, generation visibility, cursor ties, and query-strategy agreement.
- Cloud checks exercise database primitives and search, not a running mail API. No real bodies, attachments, sends, backups, or restore/replay pipeline were exercised.
- Fixed short-text corpus and low concurrency. Larger/multilingual message fixtures check semantics but do not establish real-mail performance distributions.
- Ordinary search endpoints still need signed cursors, API authorization, conversation grouping before pagination, production workload limits, monitoring, and cross-device persistence.

## Next implementation

Build the scoped repository/API against sample mail first: server-stored aliases, mailbox state, immutable draft/body objects, revision conflicts, and signed pagination. Verify the same draft on desktop and iPhone. Keep SES disconnected until that milestone passes. Then test ingestion and restoration with the agreed 30-day recovery policy.
