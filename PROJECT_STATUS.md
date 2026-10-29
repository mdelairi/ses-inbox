# Project status

Reviewed October 29, 2026. This is the current backlog; PROJECT_PLAN.md remains the requirements baseline. Status includes the October 28 production recovery rollout, isolated cloud drills and the October 29 website capture release. Other launch acceptance scenarios remain scoped below.

Production is live at https://inbox.example.com. Owner sign-in, relational storage, inbound routing, manual send, SES delivery events, server drafts, attachments, mailbox isolation, search and deletion tombstones are implemented. Sample staging remains separate.

## Priorities and current status

| Priority | Work | Status / acceptance evidence still needed |
| --- | --- | --- |
| 1 | Production backup, recovery and retention | **Complete for the agreed same-account/region scope.** Early raw originals preserved; backups, independent deletion ledger, retryable purge and hourly physical cleanup deployed. Full production-data and synthetic cloud restores passed. Scheduled execution passed and final cadence is hourly; all four recovery alarms are healthy. Temporary resources were removed. See PRODUCTION_RECOVERY.md for limits. |
| 2 | Automated Sent capture | **Website production live; ExampleOrg staging pending.** The capture stack and Inbox release `f664a0b…` are deployed, and the owner confirmed a real website contact submission was delivered and filed. ExampleOrg staging still needs its delivery-stack enablement, the feedback-topic parameter and focused live checks. Keep the tested design and capture-before-send policy. SNS trial alerts and template-test mail remain outside Sent on the backlog, without blocking this release. See [AUTOMATED_SENT.md](AUTOMATED_SENT.md#minimal-finish). |
| 3 | Background push | Implement authenticated device enrollment/revocation, service worker and notification routing; test app-closed delivery on the owner's iPhone Home Screen app and desktop. Payload includes sender/subject only. |
| 4 | Production alias settings | Live add/edit/disable controls currently show a setup message. Add API persistence and recoverable exact-recipient rule synchronization, plus sender display-name/default/signature settings. |
| 5 | Support-mail cutover | The app receives support@example.org, but ExampleOrg's StoreSupport rule is still enabled and makes its own expiring copy/alert. Coordinate retirement with ExampleOrg; preserve rule ordering until then. |
| 6 | Refresh and older mail | Manual refresh currently reloads the page. Add safe background refresh and wire the paginated thread API into the UI. The adapter loads at most 5,000 entries globally; server search returns IDs that the UI can only display if those entries are already loaded. |
| 7 | Launch acceptance and cost measurement | Complete live send/receive/reply/forward/files/inline-image checks across all four aliases and target devices, remaining mail-flow retry scenarios and wrong-account live verification, and measured monthly operating costs. Existing tests and isolated benchmarks do not establish the full bill. |
| 8 | Documentation and release tracking | Status contradictions corrected in this review; recovery rollout and verification gates are documented. Keep deployment checks and the plan aligned with verified behavior. The local real-mail branch is ahead of local main; remote PR/merge state was not checked. |

## Verified in this review

- Production AWS identity matched account 111111111111.
- Both production receipt rules are enabled with the four exact launch recipients; StoreSupport remains enabled after them.
- Dead-letter and worker-error alarms are both OK. The owner's SNS email subscription is confirmed; the deployment record previously said pending.
- The working tree was clean before this work.
- Main Node suite: 48 passed, 23 database-backed tests failed during setup because local PostgreSQL could not allocate shared memory. These are environment blocks, not demonstrated application assertion failures. The initial sandbox attempt also could not bind localhost.
- Google token-verifier suite: 3 passed. Python storage/search probe suite: 7 passed. Frontend build passed.
- Browser journeys were not rerun in this audit. Earlier recorded production checks cover owner login, unsigned API/origin rejection, a delivered send and inbound mail; they do not prove every launch acceptance case.

## Recovery outcome

- All five early raw originals were copied to durable mail/ keys and verified; no retained message still referenced incoming/ at the preservation check.
- The first complete production backup covered eight messages and 24 content objects. An isolated DSQL/S3 restore matched every SQL table digest and file checksum, and runtime role mappings were absent.
- Synthetic cloud checks proved latest-ledger filtering, shared-alias retention, last-reference purge retry, physical version deletion at a simulated deadline, current Spam retention, drafts/files/inline parts, and scoped phrase search.
- A fresh restore preview excluded six messages deleted after the original backup; it applied no changes.
- Maintenance completed 295 accelerated scheduled verification runs with no error events found. The final rule is ENABLED at rate(1 hour); all four recovery alarms are OK. A natural one-hour interval was not waited out.
- The temporary drill stack, bucket and database were removed. Full evidence and deployment hashes are in production/recovery-verification.json and production/deployment.json.
- Remaining limits: same account/region, approximately 24–25-hour backup cadence, bounded snapshot size, and retention dependent on healthy maintenance. Regional/account-loss resilience is outside this implementation.

Accepted items rather than immediate blockers: unencrypted SNS metadata topics, validated unsigned owner-scoped cursors, orphan uploads from never-saved drafts, and absent DMARC records. See PRODUCTION.md for their scope.

## Final validation

- 80 main Node tests pass using embedded PostgreSQL, including failure isolation between preservation and deadline cleanup. No machine PostgreSQL settings or other project's data were changed.
- All 14 browser journeys passed across the full run (12) and targeted live-mail rerun (2). A pre-existing clock-dependent thread-title expectation and lease setup were corrected.
- Three Google token tests, seven Python probe tests and the frontend build passed. Production/recovery/drill templates passed cfn-lint; five AWS-managed S3 security rules passed. AWS pre-deployment change-set validation reported no findings.
- The app still redirects signed-out visitors, rejects unsigned API calls (401) and denies the direct origin (403). App and maintenance code hashes were verified against the deployed Lambdas.

## Automated Sent implementation status

The capture worker, source trust rules, read-only mailbox behavior, retention/backup integration and opt-in infrastructure are deployed in production (`project-inbox-prod-capture`; all four Inbox Lambdas run `f664a0b…`, which rebuilds byte-identically from the committed source). Website production capture was enabled on 2026-10-29 03:39 UTC. ExampleOrg staging capture is not enabled: the staging feedback stack `project-inbox-capture-exampleorg-staging` exists, but `ExampleorgStagingDelivery` has no capture environment. The disposable synthetic verification message (`[Disposable Inbox verification — no email sent]`) was permanently deleted by the owner on 2026-10-29. [AUTOMATED_SENT.md](AUTOMATED_SENT.md) contains the applied source changes, capture-before-send policy, coverage gaps and release gates.

The current local suite passes all 113 checks, including exact-request contract comparisons against ExampleOrg's current mailers, explicit digest/marking classifications and full Sent imports for both. Three Google verifier checks and production packaging also pass. Template-test mail and SNS trial notifications remain outside capture. Producer-local types, builds and mail/infrastructure checks pass, including all 175 ExampleOrg unit tests. Offline baseline/default/enabled CDK comparisons pass for staging and production in both projects: defaults preserve the original infrastructure; enablement adds only two capture environment values and a source-prefix write grant, with no replacements. These local checks preceded the cloud release; see `production/deployment.json` under `capture` for the deployed identifiers.
