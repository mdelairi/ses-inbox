# Production backup and recovery

**Live and verified October 28, 2026.** Production has self-contained backups, an independent deletion ledger, resumable purge and hourly retention maintenance. A full isolated cloud restore and synthetic deletion/retention drill passed. Maintenance is enabled at `rate(1 hour)` after successful scheduled execution at an accelerated cadence. The temporary drill database and bucket have been removed.

Deployment resources and checksums are in [production/deployment.json](production/deployment.json); durable evidence and verification limits are in [production/recovery-verification.json](production/recovery-verification.json).

## Completed live preservation

On October 28, the production audit inspected eight retained messages. Five early manifests pointed raw MIME at the expiring incoming/ buffer. `scripts/preserve-production-raw.mjs --apply` copied those five originals into their message's mail/ prefix, read them back and verified SHA-256, then updated the manifests. A second dry run found zero remaining intake references and zero missing originals. Intake copies and mailbox state were left intact.

## Live behavior

- Each acknowledged permanent deletion writes an independent, non-content S3 tombstone before the SQL deletion commits. The SQL tombstone remains too. A failed SQL commit after the S3 intent is written can conservatively hide that entry during recovery; normal live data is not deleted by the recovery tool.
- Last-reference deletion atomically creates a durable purge job. Inline cleanup is resumable without the original manifest. The hourly job retries failed object/index/row cleanup, backfills older orphan-message retirements, and keeps a minimal retirement fence to reject stale publication. Another retained alias copy prevents retirement.
- Physical version cleanup runs at 29 days from last-reference deletion, rather than waiting for an asynchronous lifecycle rule. Other noncurrent versions use their successor's timestamp. Current retained messages never age out. Intake copies are bounded separately to 15 days, after the 14-day queue/dead-letter window. Operational failures alarm and must be repaired; this is not a promise that AWS outages cannot cause a deadline breach.
- At the first hourly pass at least 24 hours after the previous complete backup, maintenance takes one repeatable-read SQL snapshot, excludes unreferenced/tombstoned messages, and independently copies full raw MIME, bodies, attachments, drafts and draft uploads to a separate private encrypted S3 bucket. A checksummed final manifest commits the backup only after every copy succeeds. Incomplete runs cannot restore and expire too.
- Snapshots and all their versions are physically removed 29 days from snapshot start. This bounds copies made before deletion within the 30-day maximum. Bucket lifecycle remains a backstop, never the sole deadline mechanism. The independent tombstone ledger has no mail body, subject or sender, and remains for replay/recovery protection.
- Restore verifies checksums, fetches the latest independent ledger, filters deleted alias entries, and drops content with no retained entries. Unconfirmed sending attempts become uncertain. All destination objects are verified after writing. A ledger change during restoration fails the drill; discard that isolated destination and rerun before serving it.
- The app and mail worker cannot access the backup bucket. Maintenance uses a separate `inbox_maintenance` database role and cannot send mail, edit aliases/receipt rules, administer the database, or delete the independent ledger. Recovery does not copy login sessions, credentials or IAM role mappings.

## Limits and operating cost

Complete backups are normally about 24–25 hours apart because the hourly job checks a 24-hour threshold. The freshness alarm triggers above 26 hours. Restore has been verified in AWS, including fresh schema/index creation; a recovery-time SLA has not been established. These are same-account, same-region copies; they do not protect against loss of the whole AWS account or region. This first low-volume implementation limits each table to 100,000 rows, the uncompressed metadata snapshot to 64 MiB and an individual object to 50 MiB. It fails and alarms rather than publishing an incomplete backup. Growth requires a streaming/paginated design before those limits are reached. The maintenance Lambda has a five-minute budget and checks time between copies.

Full daily copies retain about 29 times the backed-up live content, plus incomplete runs, request charges and metadata. Hourly version listing also grows with mailbox/version count. Budget approximately US$0.70/month before allowances for four standard alarms and one custom freshness metric, plus S3, Lambda, DSQL, logs and queue usage. This is an incremental monitoring estimate, not a maximum or a measured total bill. The CloudWatch examples list US East rates of $0.10 per standard alarm metric and $0.30 per custom metric: [CloudWatch pricing](https://aws.amazon.com/cloudwatch/pricing/). Usage rates and allowances must be checked for the account: [S3 pricing](https://aws.amazon.com/s3/pricing/), [Lambda pricing](https://aws.amazon.com/lambda/pricing/). No new customer-managed KMS key or always-on compute is proposed. Consider S3 access logging/CloudTrail data events for deeper object auditing, with their additional storage/request costs; the deployed controls use TLS, SSE-S3, scoped IAM, logs and alarms.

## Validation

- Node tests exercise a synthetic isolated restore, latest-ledger filtering after the backup was taken, shared-alias retention, complete file/body recovery, corrupt/partial backup rejection, physical backup expiry, manifest-loss purge retry, raw preservation and version retirement timing.
- Repository tests now default to PGlite's embedded PostgreSQL, avoiding the local native server's shared-memory failure. `INBOX_TEST_NATIVE_POSTGRES=1 npm test` retains native coverage where `.tools/postgres/17` is available. Embedded tests exercise SQL semantics; they do not reproduce DSQL optimistic-concurrency timing or IAM grants.
- Infrastructure tests cover scoped permissions, private encrypted retained backup storage, disabled scheduling and template size/reference integrity. cfn-lint and five AWS-managed S3 guard rules pass.
- The maintenance runtime role created a complete production backup of eight messages, 24 content objects and 50,871 bytes including compressed metadata. Restoring into a fresh private DSQL/S3 target matched every SQL table digest and object checksum. All eight messages were readable; production runtime roles were absent from the target.
- The synthetic cloud drill verified shared-alias retention, latest-ledger filtering, failed-purge retry after manifest loss, real S3-version removal at a simulated 29-day deadline, current Spam retention, rich HTML/inline parts, drafts/uploads and scoped phrase search. Only disposable drill data was changed.
- A final restore preview used the latest production ledger and excluded six messages deleted after the original backup. It proposed two messages and six content objects; it applied no changes.
- The same EventBridge rule/target completed 295 scheduled verification invocations at a one-minute cadence; no maintenance error events were found. It is now enabled at one-hour cadence. A natural one-hour interval was not waited out. All four recovery alarms were OK at final verification.
- The disposable bucket's 40 remaining versions were removed, its stack reached DELETE_COMPLETE, and the bucket and cluster were verified absent. The production backup is retained.

## Deployed state and release procedure

- App/worker release: `a7f4622f7be8092718beef40239dfcdbc74f30bfb09264f2bc4bd1f5c3d93ed0`.
- Maintenance release: `d2ede586cae860de5728551e31f5900a0aa5445c1362f414c2124bc652506c16`. This includes the tested safeguard that attempts all cleanup stages even when preservation fails; any failed stage still fails the invocation and alarms.
- Recovery stack: `project-inbox-prod-recovery`. Backup bucket: `project-inbox-prod-recovery-backups-EXAMPLE`. Schedule: `project-inbox-prod-recovery-Schedule-EXAMPLE`, enabled hourly.
- First verified snapshot: `snapshots/1793206322541-1a705252-2a48-4ad2-90ad-92784f1a07fd/manifest.json`. Its content is from that point in time; recovery always applies the latest ledger.

For later releases:

1. Run `npm test`, `npm run stage:test`, relevant browser checks and `node scripts/package-production.mjs`; validate generated templates with cfn-lint and scoped security checks.
2. `node scripts/prepare-production-recovery.mjs --aws` uploads the immutable artifact and creates unexecuted change sets. It now selects CREATE only for a new recovery stack; an existing stack gets UPDATE with current scheduling preserved. Inspect `.audit/recovery-rollout-plan.json` and pre-deployment findings before execution.
3. Apply any additive schema/grant migration with `scripts/init-production-storage.mjs --recovery` before deploying code that requires it. This script is idempotent and does not overwrite seeded aliases or mail.
4. Execute reviewed changes after authorization. Verify runtime role access, code checksums, complete backups, alarms and unauthorized-access rejection. Relevant mail/backup changes require another isolated drill. New schedules start disabled until verification.
5. A repeat cloud drill can prepare the disposable template using `node scripts/prepare-recovery-drill.mjs`. Create/review its change set, restore into the tagged target, then use `scripts/verify-recovery-drill.mjs` for row/file comparison and `--synthetic` for deletion/retention cases. The scripts use the locally recorded `.audit/recovery-drill-resources.json`; record the new stack/change-set IDs there. They refuse source destinations.
6. When a schedule test is needed, `scripts/prepare-recovery-schedule.mjs` prepares a brief one-minute canary; `--artifact-key` can select a tested maintenance release. `scripts/execute-recovery-schedule.mjs` validates/reviews the narrow changes before executing under existing authorization. Once a successful scheduled run is observed, use both commands with `--hourly` and verify ENABLED / `rate(1 hour)` immediately.
7. `scripts/cleanup-recovery-drill.mjs` previews the exact tagged disposable resources. After reviewing the targets, `--apply` removes their versions and deletes only that temporary stack. Verify the database and bucket are gone and record the new drill evidence.

## Recovery commands

List complete backup manifests:

```sh
NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem node scripts/recover-production.mjs
```

Verify and preview a selected backup, applying the latest independent ledger:

```sh
NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem node scripts/recover-production.mjs --backup snapshots/EXACT_RUN/manifest.json
```

Apply only to new tagged, empty destinations; initialize the mail schema once:

```sh
NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem node scripts/recover-production.mjs \
  --backup snapshots/EXACT_RUN/manifest.json \
  --target-host NEW_CLUSTER.dsql.us-east-1.on.aws \
  --target-bucket NEW_PRIVATE_RECOVERY_BUCKET \
  --initialize-schema --apply
```

Source host/buckets are refused. Existing target data or object versions are refused. A missing/unreadable independent ledger, invalid digest, expired snapshot or concurrent ledger change aborts recovery. A partially written target is disposable and must never be promoted. A successful command establishes an isolated copy only; promotion needs a fresh ledger check, mail-flow reconciliation and a separate reviewed cutover.

Rollback the application by its previous immutable artifact key. Do not drop purge jobs or tombstones. If disabling maintenance, handle already-retained backup/version cleanup separately: disabling the schedule does not satisfy deletion deadlines, and deleting the retained recovery stack leaves its bucket behind.
