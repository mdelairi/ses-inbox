# Production mail

**Live October 28, 2026:** [inbox.example.com](https://inbox.example.com). Sign in as `owner@example.net`.

Real mail for all four addresses is received and sent here. support@example.org is in dual delivery: `project-inbox-exampleorg` files it here, then ExampleOrg's `StoreSupport` rule (which ends with Stop) still stores a 14-day copy and emails an alert. Disabling `StoreSupport` is ExampleOrg's step; keep `project-inbox-exampleorg` above it. Resource identifiers and the release checksum are in `production/config.example.json` and `production/deployment.example.json`.

| Item | Value |
| --- | --- |
| AWS account/profile | `111111111111` / `example-production` |
| Region | `us-east-1` |
| DNS account/profile | Example zone `Z0000000000EXAMPLE` in `example-management` |
| Stacks | `project-inbox-prod-artifacts`, `-certificate`, `-storage`, `-app`, `-receiving-example`, `-receiving-exampleorg` |
| Receipt rule set | `exampleorg-support` (the account's one active set; shared with ExampleOrg) |
| Sole allowed owner | `owner@example.net` |

## How mail flows

- **Receiving:** MX `10 inbound-smtp.us-east-1.amazonaws.com` → SES receipt rules `project-inbox-example` and `project-inbox-exampleorg` (exact recipients, TLS required, spam/virus scan, no Stop) → raw message in the mail bucket under `incoming/` → SNS → SQS → worker Lambda. The worker parses, files the raw copy, bodies and parts under `mail/`, indexes search positions, threads by Message-ID/References, and publishes the message to each matching alias in one DSQL transaction. Routing uses only SES envelope recipients. Spam or virus failures go to Spam; virus failures are also quarantined and their attachments refuse download.
- **Sending:** the app builds MIME, stores and indexes the sent copy, records a `sending` attempt, then calls SES once. Errors SES defines as definite mark the attempt `failed`; anything else is `uncertain` and is never retried automatically. Configuration-set events (delivery, bounce, complaint, reject, delay) flow through the same queue and update the attempt shown on the message.
- **App:** CloudFront (OAC, SigV4) → Lambda function URL (AWS_IAM) running the owner-only Google sign-in gateway with `MAIL_MODE=real`. The direct function URL returns 403. Browser POSTs carry `x-amz-content-sha256`, which OAC requires.
- **New Inbox mail:** once a message is filed in Inbox (never Spam), the worker sends a Web Push notification (sender and subject only) to every enrolled device and forwards a copy to that address's forwarding targets (Settings → Addresses, up to three outside addresses). A forward is sent from the receiving address with Reply-To set to the original sender, at most once per target (`mail.forward_attempts` is written before SES is called), and never for copies carrying this inbox's `X-Inbox-Forwarded` header. Neither is retried after a failure. VAPID keys live in Secrets Manager as `project-inbox-prod/push-vapid` (created once by `scripts/create-push-keys.mjs`; replacing them breaks every enrolled device). `/sw.js`, `/manifest.webmanifest` and the PNG icons are served without a session; on iPhone, notifications work only from the Home Screen app.
- **Database roles:** `inbox_mail` (app) and `inbox_worker` (worker) are mapped to their Lambda roles with per-table grants; neither can administer the cluster. The worker cannot delete objects; it may send only forwarded copies, from the two domains.

## Validation (October 28, 2026)

- Database schema, 8 indexes, roles, and the 2 domains / 4 aliases initialized by `scripts/init-production-storage.mjs`.
- `/` redirects signed-out visitors to `/signin`; HTTP upgrades to HTTPS; certificate valid for the hostname; signed-out API calls get 401; the direct function URL gets 403.
- Owner Google sign-in succeeded.
- A message sent from info@example.com reached `delivered` from the SES delivery event.
- An SES-originated test and a Gmail message to info@example.com landed in the Inbox. A Gmail message sent minutes before the MX record existed was deferred by Gmail and arrives on its retry.

## Release runbook

1. `npm test`, then `node scripts/package-production.mjs`. It builds `build/production/lambda.zip`, templates, and `release.json` locally only.
2. Upload the ZIP to the artifacts bucket at the `artifactKey` from `release.json`.
3. Schema changes first: rerun `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem node scripts/init-production-storage.mjs`. It is idempotent and never overwrites seeded aliases. New code must never run before its tables exist.
4. Create a change set for `project-inbox-prod-app` with `ArtifactKey` set to the new key and every other parameter `UsePreviousValue=true`. Review it, then execute.
5. Record the new checksum in `production/deployment.example.json`.

## Adding a receiving address

Deploy `build/production/templates/receiving.json` as a new stack per domain with `RuleName=project-inbox-<name>` and exact `Recipients`. The bucket policy only accepts writes from rules named `project-inbox-*` in `exampleorg-support`. The domain then needs an MX record pointing to SES, after checking what that domain receives today. Update an existing stack's `Recipients` with a change set rather than adding a second rule for the same domain. CloudFormation inserts new rules at the top of the set, so they run before `StoreSupport`.

## Retention, backups and cleanup

Live and cloud-verified October 28, 2026. The separate `project-inbox-prod-recovery` stack runs maintenance hourly and creates a self-contained backup at the first pass at least 24 hours after the last complete backup. See [PRODUCTION_RECOVERY.md](PRODUCTION_RECOVERY.md) for operations, recovery commands, cost/scale limits and verification evidence.

- **Delete forever** writes an independent S3 deletion intent and SQL tombstone, then removes that alias's entry. The last reference creates a durable purge job; inline cleanup and hourly retry remove stored content, index rows and metadata. Another retained alias copy prevents retirement.
- **Recovery copies** are physically swept at 29 days from retirement; S3 lifecycle remains an asynchronous backstop. Current retained mailbox content, including Trash and Spam, never expires by age. The independent non-content ledger persists so replay and restore cannot resurrect deleted entries. Failures alarm and require repair.
- **Backups** use a separate private encrypted bucket, contain consistent SQL metadata plus full message/draft files, and are committed by a checksummed manifest. All snapshot versions are swept 29 days from snapshot start. Restoration uses empty isolated destinations and the latest deletion ledger; live overwrite is refused. These are same-account/region copies, not account/region-loss protection.
- **`incoming/`** remains an intake buffer with 14-day lifecycle and a 15-day physical sweep, after queue/dead-letter retention. Each filed message retains its own raw MIME. Five early originals were preserved and verified; the follow-up audit found no retained raw references to the buffer.
- **Uploads** are deleted with their draft, after sending or on discard. Uploads whose drafts were never saved remain an accepted orphan-upload limitation.
- **Alarms** email the owner through the confirmed SNS subscription. The four recovery alarms and scheduled execution were verified healthy; the final rule is enabled at one-hour cadence.

## Accepted risks

- SNS topics are not encrypted at rest. Notifications carry headers (sender, subject), not bodies, and only transit SNS on the way to the encrypted queue. Encrypting would need a customer-managed KMS key (about US$1/month), because SES cannot publish to a topic using the AWS-managed key.
- Thread list cursors are unsigned. They are validated as a timestamp and UUID and only ever used as query parameters inside the signed-in owner's own mailbox.
- example.com and example.org have no DMARC record. Outgoing mail is DKIM-signed for each domain, so a `p=none` record could be added later.
