# Mail storage foundation

Prepared October 27, 2026. **Storage design and isolated feasibility work.** The hosted stage still uses browser-local sample mail. After separate approval, a disposable staging DSQL cluster was created for a synthetic benchmark. It has no connection to the app or email routing. Results and cleanup are recorded in the benchmark report.

## Ownership and stored data

The backend authenticates the sole owner before resolving a domain and alias. Every mailbox operation requires both IDs, including direct message/attachment access, draft save, search, thread reads, notification opening, and deletion. An opaque message ID alone never authorizes access.

[backend/schema.sql](backend/schema.sql) is the candidate DSQL schema tested in the disposable database. UUID identifiers remain stable when display names change. Changing an address creates a new alias; old messages and drafts keep their original address. Captured-only addresses have receiving and sending disabled independently. Disabling an alias preserves its retained mail. All timestamp values must be converted to UTC at the repository boundary; the schema uses timestamps without a stored timezone.

| Record | Purpose |
| --- | --- |
| Domain / alias | Project identity and explicit receive/send permissions |
| Message | Immutable metadata, thread, source/environment, S3 manifest pointer, published search generation |
| Mailbox entry | One alias's folder/read state and revision; multiple entries may reference one message |
| Search position | Normalized word digest, field, section, position, generation |
| Draft | Fixed domain/alias, versioned S3 content pointer, optimistic revision |
| Deletion tombstone | Minimal mailbox/message replay guard, without subject/body |
| Ingestion receipt | Durable source deduplication key, work lease, message/generation mapping |

The schema deliberately covers mail storage rather than all backend services. Delivery attempts, an outbox for notifications, device subscriptions, sessions, reconciliation work, and a change feed need separate migrations before their features are enabled. Existing staging DynamoDB authentication can remain while the mailbox foundation is tested; no sign-in migration is required for that test.

S3 stores immutable raw MIME, sanitized display HTML/text, attachments/inline images, and manifests mapping each part to its object/version. Objects are private and addressed with random application IDs under domain/message prefixes. A shared message is stored once within a domain. Cross-domain deliveries receive separate records and object ownership. Metadata contains searchable header fields; full bodies and files are not copied into database rows. Attachment downloads pass the same live mailbox authorization check before issuing a short-lived URL. A previously issued download URL may remain valid until expiry; choose a short lifetime and document this limitation.

Draft content uses immutable object versions and a compare-and-swap revision update. A conflicting save returns a conflict rather than overwriting another device. Uploaded objects that never become referenced are reconciled after a grace period. Draft send validates the fixed alias against current send permissions and takes a durable send-attempt key. SES delivery is not exactly-once: an ambiguous network response must become an explicit uncertain outcome, not an automatic resend.

## Publishing ingested mail

1. Derive trusted domain/environment/source from the receipt rule or producer IAM/prefix configuration. Resolve actual envelope recipients against enabled aliases; do not route using an arbitrary visible To header. Capture ordinary outgoing mail under its actual sender's alias. Excluded verification/reset flows remain unchanged.
2. Claim an ingestion receipt with a source-specific key: account + provider receipt ID + raw object version, or producer + durable send-attempt ID. A hash of that identity fits the bounded key column. RFC Message-ID/content hashes alone are insufficient because legitimate deliveries can repeat them.
3. Store immutable objects and a manifest. Parse bounded input with an explicit failure path for malformed or oversized mail. Preserve the raw message for repair. Generate positional rows in **bounded batches**, each comfortably below the current DSQL row, byte, and duration limits.
4. Publish the completed search generation and mailbox entries atomically, after validating domain/alias references and checking deletion tombstones. Until publication, partial index rows cannot be searched. Large messages must not be silently truncated to fit one transaction. Worker leases, retries, cleanup, and revision checks prevent two attempts publishing conflicting state.
5. Commit notification work durably with publication. Deliver push asynchronously and deduplicate it. Reconcile orphan objects, abandoned generations, stale leases, and failed deliveries.

DSQL's documented transaction limits include 3,000 mutated table rows and 10 MiB of changes; index/row bytes and transaction duration also need measurement. The schema uses no foreign keys or triggers, so the repository must enforce parent checks, dependent deletion, and concurrency guards. Serialize membership publication and final-content deletion through a conditional update of the shared message revision. Retry OCC failures with bounded jitter, never unbounded loops. [DSQL limits](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/CHAP_quotas.html)

## Search and synchronization

The probe normalizes case/accents, ANDs words, and matches quoted phrases only at adjacent positions within the same field and section. A phrase cannot bridge subject/body or two recipient addresses. Sender, recipient, subject, and body are separately filterable. SHA-256 word digests bound index key size even for unusually long input tokens; this accepts negligible digest-collision risk rather than implementing exact collision disambiguation. HTML must first become safe plain text. Version the tokenizer before indexing real mail. Attachment content indexing is deferred.

Every result joins current message generation to an existing entry for the selected domain/alias. Environment and folder filters apply before the page limit. The probe returns matching message IDs; the eventual conversation endpoint must group matches by thread **before its own page limit** and return only that alias's visible messages. It must not silently paginate messages as though they were conversations.

Pages use descending received timestamp plus message ID, avoiding OFFSET and timestamp-tie duplicates. Production cursors must also be signed and bind alias, filters, tokenizer version, and query. Live changes between pages can legitimately alter results; a stable snapshot is not promised. For cross-device changes, begin with a mailbox refresh after mutations and conditional revision reads on focus. A later durable change feed must include deletion events and have an explicit resync path for expired cursors; timestamps alone are not a reliable global change cursor.

The probes compare ordered mailbox-first EXISTS, word-first candidate selection, and grouped-word matching. Common words can favor stopping after a page of recent matches; rare/absent words can favor the inverted word index. The cloud experiment adds a bounded choice: read at most 65 postings per query word, use a rare word as an anchor when found, otherwise use grouped words or positional phrase checks. These hints affect performance only; the final query still checks every word, field, current generation, and selected mailbox. They need no persisted counters or maintenance writes. Cross-alias/unpublished hints and unusually repetitive messages can produce a poor performance choice, so production monitoring and query work limits remain necessary.

## Permanent deletion and recovery

Moving mail to Trash/Spam never starts an expiry. Permanent deletion atomically removes only the selected alias entry and writes its durable tombstone. All list, search, message, and attachment endpoints must join a live mailbox entry, so retained index/object data cannot bypass deletion. Other retained aliases keep shared content.

After the last entry disappears, enqueue bounded removal of search rows, message metadata, raw MIME, display parts, attachments, every object version, producer capture copies, and manifests. Failed cleanup remains visible to reconciliation. A worker must lock through the message revision so a concurrent delivery cannot acquire a reference while content is being removed. Tombstones are checked during retries, reindexing, capture replay, and restore.

Keep recovery copies for **at most 30 days after explicit deletion**, including snapshots and copies made before the deletion. Use a cleanup deadline and verify physical version/snapshot removal; lifecycle expiry alone is asynchronous. Tombstones contain no mail content and remain for as long as any restore/replay source could recreate an entry. Test a restore into isolation, apply the latest deletion ledger before serving anything, and prove one alias's deletion does not remove another's copy. These are production acceptance requirements, not implemented recovery guarantees.

## Reproduce local feasibility checks

```sh
python3 -m unittest discover -s backend -p 'test_*.py'
python3 planning/benchmark_storage.py --sizes 1000 10000 50000
```

The standard-library Python probe creates temporary SQLite databases from the candidate schema (replacing asynchronous index syntax), generates synthetic short messages, records index amplification and query timings, then removes the databases. Only [planning/storage_probe_results.json](planning/storage_probe_results.json) remains. It tests shared entries, independent deletion visibility, field/phrase boundaries, Unicode normalization, repeated words, hidden index generations, parameter binding, filters, and tied-timestamp pagination. It does **not** implement a deployable repository or test real AWS transactions.

The generated short-message corpus is intentionally reproducible, not representative of a real mailbox. SQLite file size includes its own tables/indexes/page overhead. Neither those bytes nor local elapsed time establish DSQL storage, latency, or DPUs. Keep the existing production estimate explicitly provisional.

## Approved cloud experiment

The owner approved installing the client and running/removing the temporary experiment. PostgreSQL 17.11 client binaries were installed under ignored `.tools/postgres/17` after Homebrew failed its developer-tool compatibility check. The Python runner uses the official DSQL connector, verified TLS, and in-memory IAM authentication. Tokens are never saved to files or committed configuration. Dependencies are isolated under `.tools/dsql-venv`; [planning/dsql-requirements.txt](planning/dsql-requirements.txt) records the direct versions.

Approved scope: one disposable **single-region** DSQL cluster in `example-staging` / `us-east-1`, tagged `Project=ses-inbox-app`, `Environment=benchmark`, `created_by=codex`, with default encryption and initial deletion protection. No connection to hosted stage, production databases, or SES. Synthetic mail only. Bootstrap uses the owner's temporary admin session, then maps a separate scoped benchmark database role to a temporary IAM role granting only `dsql:DbConnect` on that cluster. No permanent admin credentials or additional runtime secret. [Resource record](planning/dsql_benchmark_resources.json).

1. Start with 1,000 messages, then 10,000; advance to 50,000 only after inspecting measured usage. Include larger bodies, many recipients, inline parts, multilingual text, an absent word, common/rare words, phrases, field/source/environment filters, deep pagination, and a second domain/alias.
2. Execute each table DDL separately, create indexes with `CREATE INDEX ASYNC`, wait for all index jobs, and verify schema/catalogs. Test bounded writes, replay deduplication, unpublished-generation invisibility, revision conflicts, alias deletion races, and cleanup. DSQL compatibility is not established by the local SQLite run.
3. Capture baseline/end CloudWatch cluster DPUs, bytes, and timestamps for isolated ingestion, reads, writes, and cleanup. Capture repeated read-only `EXPLAIN ANALYZE VERBOSE` plans for both query variants. Statement estimates omit some transaction/background work and are **not billing-grade**; reconcile against cluster metrics. [DPU interpretation](https://docs.aws.amazon.com/aurora-dsql/latest/userguide/understanding-dpus-explain-analyze.html)
4. Report measured per-operation ranges and storage amplification, then calculate the Personal/Active/Growing scenarios using explicit monthly operation counts. Include ingestion, retries, draft autosaves, folder/read updates, sessions, reconciliation, and deletion—not just search. Adopt DSQL only if the measured result fits the working budget without excessive search machinery.
5. Keep the run serial with fixed dataset/repetition limits, and stop at an **estimated US$1 experiment threshold** before increasing the dataset. Growth is gated at US$0.50 of reported DPU use to leave headroom. This is a stop target, not a hard billing cap: metrics can lag and background work continues. DSQL rejected `SET statement_timeout`, so a PostgreSQL per-query timeout is not claimed; its server transaction limit still applies. Confirm current prices before starting. Inspect final usage, then remove only the recorded disposable benchmark resources after disabling their deletion protection. Record cleanup results and any residual chargeable resources.

The reusable runner is [planning/benchmark_dsql.py](planning/benchmark_dsql.py). It checks the account, region, and ownership tags before database operations, binds data values through psycopg, executes one DDL at a time, waits for async indexes, and uses 500-row insert batches. On this Mac, the pure-Python psycopg implementation loads the installed client library through `PSYCOPG_IMPL=python` and `DYLD_LIBRARY_PATH`; the scoped profile lives in ignored `.audit/dsql-aws-config`. The benchmark uses direct SQL primitives; it does not implement production ingestion, replay protection, S3 cleanup, API authorization, or backups.
