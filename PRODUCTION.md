# Production mail

**Live October 28, 2026:** [inbox.example.com](https://inbox.example.com). Sign in as `owner@example.net`.

Real mail for all four addresses is received and sent here. support@example.org is in dual delivery: `project-inbox-exampleorg` files it here, then ExampleOrg's `StoreSupport` rule (which ends with Stop) still stores a 14-day copy and emails an alert. Disabling `StoreSupport` is ExampleOrg's step; keep `project-inbox-exampleorg` above it. Resource identifiers and the release checksum are in `production/config.json` and `production/deployment.json`.

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
- **Database roles:** `inbox_mail` (app) and `inbox_worker` (worker) are mapped to their Lambda roles with per-table grants; neither can administer the cluster. The worker cannot send mail or delete objects.

## Validation (October 28, 2026)

- Database schema, 8 indexes, roles, and the 2 domains / 4 aliases initialized by `scripts/init-production-storage.mjs`.
- `/` redirects signed-out visitors to `/signin`; HTTP upgrades to HTTPS; certificate valid for the hostname; signed-out API calls get 401; the direct function URL gets 403.
- Owner Google sign-in succeeded.
- A message sent from info@example.com reached `delivered` from the SES delivery event.
- An SES-originated test and a Gmail message to info@example.com landed in the Inbox. A Gmail message sent minutes before the MX record existed was deferred by Gmail and arrives on its retry.

## Release runbook

1. `npm test`, then `node scripts/package-production.mjs`. It builds `build/production/lambda.zip`, templates, and `release.json` locally only.
2. Upload the ZIP to the artifacts bucket at the `artifactKey` from `release.json`.
3. Create a change set for `project-inbox-prod-app` with `ArtifactKey` set to the new key and every other parameter `UsePreviousValue=true`. Review it, then execute.
4. Schema changes: rerun `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem node scripts/init-production-storage.mjs`. It is idempotent and never overwrites seeded aliases.
5. Record the new checksum in `production/deployment.json`.

## Adding a receiving address

Deploy `build/production/templates/receiving.json` as a new stack per domain with `RuleName=project-inbox-<name>` and exact `Recipients`. The bucket policy only accepts writes from rules named `project-inbox-*` in `exampleorg-support`. The domain then needs an MX record pointing to SES, after checking what that domain receives today. Update an existing stack's `Recipients` with a change set rather than adding a second rule for the same domain. CloudFormation inserts new rules at the top of the set, so they run before `StoreSupport`.

## Retention and cleanup

There is no scheduled cleanup job; each rule below runs inline or as a bucket lifecycle rule.

- **Delete forever** removes the alias's entry and writes a tombstone. When no other alias holds the message, the same request deletes its filed objects, search positions and rows. A purge failure is logged (`purge-failed`) and leaves only invisible data.
- **`incoming/`** is an intake buffer: current objects expire after 14 days (the dead-letter retention), noncurrent ones a day later. Each filed message keeps its own `raw.eml`. Mail received before October 28's cleanup release points its raw copy at `incoming/`, so that copy expires with the buffer.
- **Recovery versions** of everything else expire 29 days after they are replaced or deleted, keeping asynchronous lifecycle lag inside the 30-day limit.
- **Uploads** are deleted with their draft, after sending or on discard. An upload whose draft was never saved is not cleaned up; with 25 MB per file and a single owner this is accepted.
- **Alarms** (dead-letter queue, worker crashes) email the owner through the `Alarms` topic once the subscription is confirmed.

## Accepted risks

- SNS topics are not encrypted at rest. Notifications carry headers (sender, subject), not bodies, and only transit SNS on the way to the encrypted queue. Encrypting would need a customer-managed KMS key (about US$1/month), because SES cannot publish to a topic using the AWS-managed key.
- Thread list cursors are unsigned. They are validated as a timestamp and UUID and only ever used as query parameters inside the signed-in owner's own mailbox.
- example.com and example.org have no DMARC record. Outgoing mail is DKIM-signed for each domain, so a `p=none` record could be added later.
