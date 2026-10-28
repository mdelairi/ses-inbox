# Production mail

**Live October 28, 2026:** [inbox.example.com](https://inbox.example.com). Sign in as `owner@example.net`.

Real mail for info@example.com and taylor@example.com is received and sent here. info@example.org and support@example.org are seeded as sending aliases but do not receive here yet; support@example.org still flows only through ExampleOrg's existing `StoreSupport` rule. Resource identifiers and the release checksum are in `production/config.json` and `production/deployment.json`.

| Item | Value |
| --- | --- |
| AWS account/profile | `111111111111` / `example-production` |
| Region | `us-east-1` |
| DNS account/profile | Example zone `Z0000000000EXAMPLE` in `example-management` |
| Stacks | `project-inbox-prod-artifacts`, `-certificate`, `-storage`, `-app`, `-receiving-example` |
| Receipt rule set | `exampleorg-support` (the account's one active set; shared with ExampleOrg) |
| Sole allowed owner | `owner@example.net` |

## How mail flows

- **Receiving:** MX `10 inbound-smtp.us-east-1.amazonaws.com` → SES receipt rule `project-inbox-example` (exact recipients, TLS required, spam/virus scan, no Stop) → raw message in the mail bucket under `incoming/` → SNS → SQS → worker Lambda. The worker parses, stores bodies and parts under `mail/`, indexes search positions, threads by Message-ID/References, and publishes the message to each matching alias in one DSQL transaction. Routing uses only SES envelope recipients. Spam or virus failures go to Spam; virus failures are also quarantined and their attachments refuse download.
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

Deploy `build/production/templates/receiving.json` as a new stack per domain with `RuleName=project-inbox-<name>` and exact `Recipients`. The bucket policy only accepts writes from rules named `project-inbox-*` in `exampleorg-support`. The domain then needs an MX record pointing to SES, after checking what that domain receives today. Do not list support@example.org until its cutover from `StoreSupport` is reviewed with ExampleOrg.

## Known gaps

- Permanent deletion removes database rows and records a tombstone, but stored message objects are not yet purged; there is no production cleanup job.
- Abandoned uploads are not cleaned up.
- Dead-letter and worker-error alarms have no notification target.
- SNS topics have no server-side encryption (SES cannot publish to topics using the AWS-managed key).
- Thread list cursors are unsigned (owner-only, so low risk).
- example.com has no DMARC record. Outgoing mail is DKIM-signed for example.com, so a `p=none` policy could be added with reporting.
