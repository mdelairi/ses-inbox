# Private staging release

**Live and verified October 27, 2026:** [Open the staging inbox](https://stage.example.com). Sign in as `owner@example.net`.

Deployed using the installed Agent Toolkit for AWS skills and their documented CLI fallback. The certificate, private release storage, authentication service, CloudFront distribution, and shared sample-data storage are deployed. This release contains sample mail only; it cannot send real email. Current resource identifiers and release checksum are recorded in `stage/config.json` and `stage/deployment.json`.

## Scope and destination

The owner selected a private hosted prototype with Google sign-in and fictional sample mail. Sample mail, aliases, mailbox state, and drafts now persist on the server. Sending remains simulated.

| Item | Prepared choice |
| --- | --- |
| AWS account/profile | `222222222222` / `example-staging` |
| Region | `us-east-1` |
| Live stage URL | `https://stage.example.com` |
| DNS account/profile | Existing Example zone in `example-management` |
| Sole allowed owner | `owner@example.net` |
| Stack prefix | `project-inbox-stage` |
| Data | Shared fictional mail and edits in private S3, with a DSQL revision head; local recovery for unsaved changes |
| Email | Simulated sending only; no SES permissions, receipt rules, MX changes, or project-sender integration |

Staging and management account identities were verified before rollout. The staging hostname has A/AAAA aliases and a DNS-validated ACM certificate. Production SES, receiving rules, existing public sites, and ExampleOrg source were not changed.

## Prepared implementation

- `stage/auth.mjs`: authorization-code sign-in with state, nonce, S256 PKCE, browser-bound single-use login records, verified owner email, and an immutable first-login Google subject pin. Revocable opaque sessions expire after 24 hours. The cookie is Secure, HttpOnly, host-only, and SameSite=Lax. Logout requires same-origin POST and a session CSRF token. Expiration is enforced independently of DynamoDB TTL cleanup.
- `stage/entry.mjs`: AWS adapters, Google token exchange, maintained `jose` signature/issuer/audience/expiry verification, and an explicit static-asset allowlist. Google tokens never enter browser storage or the session database. Only hashed session identifiers are stored. Every application asset, including fixture modules, requires a live owner session.
- `stage/client.mjs`: session checks and sign-out. The prepared UI adds a staging label and a sidebar sign-out control. The hosted storage adapter syncs drafts and attachments across signed-in devices. Use Refresh or reload to retrieve changes made elsewhere.
- `infra/stage.mjs`: generates independent artifact, certificate, storage, and application CloudFormation templates. Release ZIPs and sample data use separate private versioned buckets. The app uses Lambda with an AWS_IAM function URL, CloudFront SigV4 OAC, both narrowly scoped invocation permissions, and disabled caching for every application response. The distribution defaults to **disabled**.
- DynamoDB on-demand stores only short-lived authentication records and the owner pin. The table uses default AWS-owned encryption, retention on stack replacement/deletion, and deletion protection. A single existing Secrets Manager secret supplies Google OAuth credentials. The Lambda role can access its auth table, that secret, its own logs, the sample bucket’s `samples/*` objects, and `dsql:DbConnect` on the isolated sample database. It has no database-admin, bucket-list, object-version, SES, or IAM mutation permission.

This stage keeps direct Google OIDC and its authentication-only DynamoDB table. The sample-data bridge stores immutable workspace snapshots/files in S3 and one revision head in an independent single-region DSQL database. It does not implement the production relational mail schema or server search. There is no always-on server, NAT gateway, custom KMS key, or provisioned Lambda concurrency. The earlier disposable search benchmark remains deleted; this retained database belongs to the shared staging feature.

CloudFront in these templates uses standard usage pricing. CloudFormation's distribution schema does not expose flat-rate plan enrollment; the previously proposed $0 plan is **not** silently assumed. Validate compatibility and enrollment separately before adopting that production budget. [CloudFront template schema](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-cloudfront-distribution-distributionconfig.html), [plan documentation](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html).

The small Secrets Manager secret is the main fixed staging component; Lambda, DynamoDB, DSQL, logs, CDN, and S3 storage add usage charges. Treat US$2/month as a conservative light-review planning allowance, not an approved spending cap, guaranteed maximum, or measured bill. Confirm actual prices and account allowances before provisioning, and monitor the staged app's actual usage. This replaces neither the production estimate nor its validation gates.

## Validation and deployed state

- All four stacks completed: `project-inbox-stage-artifacts`, `project-inbox-stage-certificate`, `project-inbox-stage-storage`, and `project-inbox-stage-app`. CloudFront `E1EXAMPLE00003` is enabled and reports `Deployed`.
- `npm test`: 30 passing model/authentication/infrastructure/shared-API checks. `npm run stage:test`: 3 passing tests of real RSA-signed token verification, signature tampering, issuer/audience, expiry, nonce requirements, and authorized party.
- Four isolated staging browser journeys pass: the protected UI and rich message frame render under the deployed CSP, address tabs keep mail separate, phone layout fits, logout revokes the simulated server session, and signed-out requests cannot read application/fixture modules. The shared journey also checks alias edits, draft text, attachment and inline-image transfer across independent browsers, stale-save rejection, and recovery download while the composer stays open. These browser journeys mock AWS persistence; they complement the live integration checks below.
- Native Chrome live checks passed: Google owner login, immutable Google subject enrollment, repeat login with that pinned identity, complete app loading, workspace switching, separate info/support mailboxes, a fixed support sender, and server sign-out. The owner is the sole Google OAuth test user. No second real Google account was used; wrong-account rejection is covered by the handler tests and the Google test-user restriction.
- Live HTTPS checks: root redirects to `/signin`; unsigned requests to `/app.mjs` return 401; the direct AWS_IAM Lambda URL returns 403. Responses include no-store, CSP, HSTS, referrer, and anti-framing headers. No application errors appeared in the stage error log during the checks.
- Toolkit validation: `cfn-lint` 1.58.0 reports no schema findings on all four templates; `cfn-guard` 3.2.1 passes five AWS-managed S3 checks (encryption, versioning, public-read/write blocking, TLS-only). Focused infrastructure tests cover private-origin and permission constraints. AWS change-set validation reported no validation errors. This is a scoped stage review, not a comprehensive organizational compliance certification.
- IAM Policy Autopilot completed against a `.js` snapshot of the runtime source, because its extension detector did not accept `.mjs`. Its output is retained in `.audit/stage-iam-autopilot.json`. Conditional replication/customer-KMS permissions were reviewed rather than broadly granted: this stage has no global table or customer-managed key. The shared-storage review in `.audit/stage-mail-iam.json` was also inspected: conditional KMS, object-version, retention, ACL, and access-point permissions were not granted. The explicit `dsql:DbConnect` grant was checked against the connector’s authentication requirements. No generated policies were uploaded directly.
- The OAuth secret is stored in staging Secrets Manager. No secret value is present in the bundled runtime or prepared frontend/source. Secret files, tooling, and audit output are excluded from source-control candidates.

`npm run stage:prepare` remains a local build-preparation command, and `npm run stage:package` creates the Lambda ZIP. Neither deploys resources. `npm run stage:check -- --aws` verifies configuration, release checksum, account identity, and AWS template structure without provisioning anything. Earlier localhost and hosted browser-only preview stores are left intact; they are not automatically imported into the shared sample workspace.

## Google setup

The dedicated **Web application** OAuth client is named `Example Inbox Stage` in Google project `api-project-000000000000` (API Project). The app remains in Testing with only `owner@example.net` listed. The setup below documents the existing configuration and any future replacement. For an external app in testing mode, list only the owner as a test user. Request only `openid email`; there is no Gmail permission. Set the exact authorized redirect URI to:

```text
https://stage.example.com/auth/callback
```

Store the credential in a staging Secrets Manager secret with this JSON shape, entering the actual values through a private local file or the AWS console:

```json
{"clientId":"GOOGLE_WEB_CLIENT_ID.apps.googleusercontent.com","clientSecret":"GOOGLE_WEB_CLIENT_SECRET"}
```

Do not paste the secret into chat, commit it, put it in `stage/config.json`, or pass it as a literal shell argument. The Lambda retrieves it at runtime. The first successful verified owner login pins Google's stable `sub`; changing that pin is an explicit recovery operation. [Google's server sign-in flow](https://developers.google.com/identity/openid-connect/openid-connect).

## Local preparation commands

```sh
npm test
npm run stage:prepare
npm run stage:check
```

Dependencies are installed with a retained `stage/package-lock.json`. For a clean reproducible install:

```sh
npm ci --prefix stage --ignore-scripts --no-fund --no-audit
npm run stage:package
```

On this Mac, npm required `NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem` to use the trusted CA bundle; certificate verification stayed enabled. Retain `stage/package-lock.json` and keep dependencies isolated in `stage/`. Packaging regenerates the source snapshot, bundles the Lambda and protected assets, and writes `build/stage/lambda.zip` plus its SHA-256 and immutable S3 key into `build/stage/release.json`. It performs no upload or deployment.

The toolkit IAM review command for this new runtime source is:

```sh
uvx iam-policy-autopilot@latest generate-policies \
  '~/DEV/SES Inbox App/.audit/stage-entry.js' \
  --region us-east-1 --account 222222222222 \
  --service-hints dynamodb secretsmanager --pretty
```

Copy `stage/entry.mjs` to `.audit/stage-entry.js` before this command, preserving the source contents. The command has been executed and reviewed for this release; do not use `--upload-policies`. Re-run the schema, selected compliance, IAM, and change-set checks when code or infrastructure changes. AWS `validate-template` alone is not a resource-schema/compliance check.

## Rollout and future updates

1. Refresh the existing `example-staging` SSO session and verify account `222222222222`; separately verify the management/DNS identity. Re-inventory matching stack names and DNS records. A wrong-account result stops the rollout.
2. For an initial environment, review/create only the new artifact stack and staging certificate stack from `build/stage/templates/`. Add the certificate's exact validation CNAME in the existing Example zone. The certificate stack requires DNS validation before completion. No new hosted zone is needed.
3. Set up the dedicated Google OAuth client/secret, populate ARN/name config fields, and package the release. Upload its content-addressed ZIP only to the new artifact bucket. No browser-local mailbox state is included.
4. Create an **unexecuted** application change set with the exact artifact key, certificate ARN, hostname, owner, and Google secret ARN. Use `CAPABILITY_IAM`; keep the dedicated distribution disabled. Review all replacements, permissions, deletions, and charges. Retrieve pre-deployment findings through `aws cloudformation describe-events` as directed by the toolkit.
5. Execute the reviewed new-stack change set; create only the staging hostname's A/AAAA alias records pointing at the new distribution. Coordinate the DNS change with the management account. Review the enablement change set, then activate the distribution.
6. On the actual hosted endpoint, verify that unsigned origin requests fail, every asset rejects a signed-out browser, another Google account is denied, owner login works, nonce/state replays fail, sessions/logout work, aliases stay separate, staging colours match, and phone layout/rich messages work under the deployed CSP. Confirm the old localhost state remains independent and `/api/send` cannot send mail.
7. Roll back by restoring the previous immutable artifact key or disabling this distribution. Retain the auth table and owner pin. To stop usage, disable the distribution and revoke sessions; deletion of retained resources is a separately reviewed cleanup, not an automatic rollback step.

Production SES receiving, real sent capture, guaranteed deletion/recovery cleanup, the relational mail repository/server search, and iPhone background push remain outside this sample-stage release.

The production storage design is specified in [BACKEND_STORAGE.md](BACKEND_STORAGE.md). A separately approved disposable DSQL benchmark tests its schema/search primitives; [results and cleanup](planning/STORAGE_BENCHMARK.md) are recorded independently of this deployment. That earlier experiment is independent of the retained shared-sample storage described below.

## Shared sample storage release

- Bucket: `project-inbox-stage-storage-mail-EXAMPLE` (private, AES256, versioned, TLS-only, CORS restricted to the exact stage origin).
- Database: `exampleclusterstage0000000`, single-region `us-east-1`, AWS-owned encryption and deletion protection. Retained with the bucket on stack replacement/deletion.
- Runtime role: `inbox_stage`, mapped only to the existing staging Lambda role, with SELECT/INSERT/UPDATE on `inbox_stage.workspace`. Administrative setup is isolated in `scripts/init-stage-storage.mjs` and is not bundled into the Lambda.
- `stage/mail-api.mjs` validates sample workspace records, fixed draft sender identity, file ownership/size/checksum, and optimistic workspace revisions. A stale save receives HTTP 409; an uncertain database outcome never deletes a potentially published state object. Repeating the same confirmed write is idempotent.
- `stage/mail-store.mjs` uses the official DSQL Node connector and verified TLS. State is read through the authenticated API with a bounded retry if a concurrent save retires the prior object. File transfers use owner-authorized URLs valid for 60 seconds. Uploads require SHA-256 checksum and expected size; downloads require a current workspace reference. Previously issued URLs can remain valid until expiry.
- `stage/storage-client.mjs` replaces only the hosted persistence adapter. Navigation remains per tab. Shared mail/alias/preferences/draft changes are saved on the server; attachments and inline images round-trip through private S3. Refresh/reload retrieves the current shared state. Keep the page open until “Saved to shared workspace” appears.
- IndexedDB retains an unsaved recovery copy before uploads/saves. Network failures and stale writes keep that copy. Recovery controls are reachable inside an open composer, with a JSON download and an explicitly confirmed “Use shared version” action. There is no silent conflict overwrite or automatic merging of unrelated edits.
- The stage bridge supports two configured domains, up to 1,000 messages/drafts, 2 MiB metadata, 10 MiB per file, 20 MiB per message, and 100 MiB of referenced attachments. It is for sample review rather than a growing real archive.
- Superseded state objects are deleted after successful publication, leaving private noncurrent recovery versions subject to the 30-day lifecycle. Current state never expires. Orphan/removed attachment collection, recovery import, verified restore/replay, and a strict physical deletion deadline are **not implemented**; no production retention guarantee is claimed. Keep real email disconnected until those are delivered.

Live integration evidence is in `stage/shared-checks.json`. The check used a temporary in-memory owner session, verified the pinned owner, exercised real CloudFront/Lambda/DSQL/S3 saves, checksum-protected state/file reads, stale-write rejection, and denial of new download links for removed files. It removed only its uniquely identified synthetic draft/file and revoked its test session. No owner session token, signed URL, or message content is written to the evidence file. The hosted shared inbox was also opened successfully in the owner’s existing Chrome session.

To repeat the bounded live check after a reviewed deployment:

```sh
NODE_EXTRA_CA_CERTS=/etc/ssl/cert.pem node scripts/test-shared-stage.mjs
```

The check uses the existing staging administrator profile to create and explicitly revoke a ten-minute test session; it does not change the pinned owner, Google credential, production resources, or mail routing. Do not run it against another account or host.

For a storage update, create/review the storage-stack change set first, initialize its scoped schema, then package the app and pass `MailBucket`, `MailDatabaseHost`, and `MailDatabaseArn` alongside the existing application parameters. Review resource replacements and `describe-events` findings before execution. Roll back the application using its previous immutable artifact/template; retain shared data and the owner pin. Older releases ignore shared storage and show their original browser-only sample data.
