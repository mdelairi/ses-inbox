# AWS audit for the project inbox

Read-only findings from October 26, 2026, approximately 06:30–06:40 America/Toronto. Scope: the configured management, staging, and production accounts in us-east-1, their relevant Route 53 zones, and production hosting. Other regions and all possible external senders were not exhaustively searched.

The audit refreshed the existing AWS SSO session and inspected configuration, metrics, billing, and S3 object metadata. No infrastructure, mail-routing, retention, or application settings were changed. No emails or notifications were sent. Mail bodies and Secrets Manager values were not retrieved.

## Findings that affect launch

1. **Production SES is still sandboxed.** Both domains are verified, but ordinary sending to unverified recipients needs production access. This is a launch dependency, not an application-code fix.
2. **ExampleOrg receives only support@example.org.** Example has no apex MX record or receiving rule in the audited production setup.
3. **Support mail expires after 14 days.** The current bucket has three objects. The new inbox must use an explicitly agreed long-term retention policy rather than inheriting this expiry.
4. **There is no automated Sent archive.** Native SES outbound archiving is a plausible integration for the observed SES v2 send paths, but it needs a separate prototype before selection.
5. **Current volume is very small.** The 30-day account-level CloudWatch Send sums are 3 production and 87 staging. Staging includes other projects and tests; this is not a per-domain growth forecast.
6. **Google sign-in and the inbox URL are new setup.** The existing production Cognito pool has no external identity providers. Existing certificates cover the public sites, not a private inbox subdomain.

## Accounts and boundaries

| Profile | Account | Relevant role |
| --- | --- | --- |
| example-management | 333333333333 | Owns DNS for example.com and example.org; also contains unrelated legacy mail configuration |
| example-staging | 222222222222 | Project test applications and automated ExampleOrg test email |
| example-production | 111111111111 | Public websites, contact form, and ExampleOrg support receiving |

All three audited SES accounts report healthy enforcement, sending enabled, production access disabled, a 200-recipient rolling daily quota, and a maximum send rate of 1 per second. These are observed account values. The current SES pricing plan is Essentials.

The management account's active receiving rules serve Corporate Media Agency through WorkMail. The staging active rules serve massfam-tests.example.com. Neither should be replaced while building this inbox.

## Domains and aliases

| Item | Example | ExampleOrg |
| --- | --- | --- |
| Production domain verification | SUCCESS | SUCCESS |
| Production DKIM | Signing enabled, SUCCESS | Signing enabled, SUCCESS |
| Public receiving MX at apex | Absent | 10 inbound-smtp.us-east-1.amazonaws.com |
| Production receiving addresses | None configured in active rules | support@example.org only |
| Production custom MAIL FROM | Not configured | Not configured |
| DMARC policy in Route 53/public lookup | Absent | Absent |
| Known automated source | Website contact form; From address is privately configured | no-reply@example.org in staging application/Cognito configuration |

Domain verification is not an alias registry: SES can allow sending from addresses under a verified domain without separate address identities. Launch aliases therefore need an application-level list as well as receiving rules. There is a failed standalone taylor@example.com identity in the management account; that does not establish a working receiving mailbox or prevent inherited sending verification in the separate production account.

Production DKIM records for both domains match their SES configuration. ExampleOrg also has a separate successful staging MAIL FROM domain, mail-stage.example.org, with its MX/SPF records; preserve it. The absence of apex SPF does not by itself mean SES sending is broken: production currently uses SES's default MAIL FROM. Review DMARC and alignment as part of launch design rather than copying the staging records to the apex.

## Existing receiving pipeline

- Active production rule set: exampleorg-support; rule: StoreSupport. TLS required, spam/virus scanning enabled, exact recipient support@example.org.
- Actions: store in S3 with prefix inbox/support/, publish an SNS storage notification, then stop rule-set processing.
- Bucket: exampleorgsupportmail-inbox-EXAMPLE. Versioning enabled; AES256 server-side encryption; all four S3 public-access blocks enabled; bucket policy denies non-TLS access and scopes SES writes to the production account and receiving rule.
- Lifecycle: current objects expire after 14 days; noncurrent versions expire after 1 day; expired delete markers are cleaned up. This is expiry configuration, not a promise of deletion at an exact instant.
- Current prefix listing: **3 objects, 10,530 bytes total**, dated October 21–22. Contents were not opened, so their subjects, whether they are all tests, and individual recipients were not inspected.
- The SNS alert topic has an email subscription with a confirmed subscription ARN. This proves configuration, not end-to-end alert receipt during this audit.
- No S3 event notifications or S3 server-access logging are configured on this bucket. No inbox parser/indexer is present in its observed receiving actions.

SES permits one active receipt rule set per account/region. Plan an extension or coordinated migration of the production rule set; activating an independent inbox rule set without preserving support would interrupt existing receiving. Alias reconciliation must also respect CloudFormation ownership of the existing StoreSupport rule and the final Stop action.

## Automated outgoing email

### Example contact form

- The live production contact Lambda uses SES v2, identity example.com, and configuration set example-website-production-contact.
- Source sends plain text to a fixed private destination; the visitor's address is Reply-To. Routing lives in Secrets Manager and was intentionally not retrieved. Exact configured From/destination addresses remain unverified by this audit.
- Current event publishing covers bounce, complaint, delivery delay, and rejection metrics. It does not archive bodies or publish successful delivery events to a mailbox importer.
- Archiving this traffic into Sent will capture contact-form submissions as sent mail; moving those inquiries into Inbox as a separate intake feature would be an additional behavior decision.

### ExampleOrg

- Local staging configuration uses no-reply@example.org, Reply-To support@example.org, and exampleorg-staging-invitations.
- Application mailers send text and HTML with SES v2 SendEmail. Cognito also uses the named configuration set in the infrastructure definitions; its exact archive coverage should be verified in the prototype.
- The live staging configuration set publishes delivery, bounce, complaint, rejection, and rendering-failure events to SNS. It has no archive attached.
- Production ExampleOrg's configuration has no onboarding email settings, and the live application role has no SES sending action. The live Lambda identifies itself as production and has no invitation-feedback topic. Do not assume production automated ExampleOrg mail is enabled just because staging sends test mail.
- Neither production nor staging has a Mail Manager archive. Production has no Mail Manager ingress endpoints.

### Capture proposal

Evaluate a configuration-set archive plus a background importer. The SES archiving API explicitly supports the observed SendEmail path, and Mail Manager provides full-message retrieval. Preserve existing configuration-set event destinations and associate archive messages with domain/source/account/environment. Test delayed availability, search-result limits, checkpointing, overlap, deduplication, full HTML/images/attachments, and recovery before adopting it. Avoid provisioning a paid Mail Manager ingress endpoint merely to receive this app's mail; existing SES receiving can remain the inbound foundation.

If archive import cannot meet the agreed freshness requirement, propose a send-and-archive integration in the relevant projects. Changes to ExampleOrg or the website require their own reviewed implementation details; this audit does not authorize them.

## Observed activity and cost

CloudWatch window: September 26, 2026 00:00 UTC through October 26, 2026 00:00 UTC, end exclusive: 30 complete UTC days. Account-level AWS/SES metrics with no dimensions, daily Sum aggregation:

| Account | Send sum | Delivery sum | Largest daily Send sum |
| --- | ---: | ---: | ---: |
| Management | No data points | No data points | Not available |
| Staging | 87 | 87 | 61 |
| Production | 3 | 3 | 2 |

No Bounce, Complaint, or Reject points were returned for this window. Missing metric points are not proof that every possible failure mode was absent. At the audit snapshot, SES's rolling last-24-hour counter was 9 in staging and 0 in production. The completed-day window excludes today's partial activity.

Only account-level Send metrics were discoverable in the recent metric listing. Staging also has cmntx-stage-follow-alerts and MassFam mail tests, so the 87 cannot be attributed solely to ExampleOrg. The 3 current support objects are a storage inventory, not a 30-day receipt-rate measurement.

Cost Explorer for the same dates, filtered to Amazon Simple Email Service and excluding credits/refunds, reports these UnblendedCost totals in USD:

| Account | SES cost |
| --- | ---: |
| Production | $0.00052 |
| Staging | $0.01980 |

The October billing portion is estimated. These are SES-only historic charges, not total project costs or a forecast for the new client. Cost Explorer usage categories do not exactly reconcile with CloudWatch counts: keep them as separate observations rather than claiming an exact count of unique sent messages from billing. Arithmetic was calculated using Python Decimal; usage quantities with different units were not added together.

The current published low-volume Essentials sending rate is $0.16 per 1,000 outbound emails, charged per recipient, plus applicable data charges. The published archive rate is $2/GB ingested and $0.19/GB-month for storage/search. These are rate references, not an all-in estimate. Final monthly cost still depends on the selected metadata/search/session design, archive volume/retention, hosting/WAF choice, logs, and attachments. Given observed volume, compare lightweight indexed search before choosing a service with a fixed running cost. [Current SES pricing](https://aws.amazon.com/ses/pricing/)

## Hosting and owner access

- Example production distribution: E1EXAMPLE00001, aliases example.com and www.example.com. It routes public resources paths to ExampleOrg and ordinary content to the website's S3 origin.
- ExampleOrg production distribution: E1EXAMPLE00002, aliases example.org and www.example.org.
- Issued production certificates currently cover each apex and www only. An inbox subdomain needs an appropriate certificate and DNS record.
- Existing production Cognito pool: exampleorg-production-owners. No federated identity providers are configured. Do not repurpose this pool as the inbox's owner authorization boundary without a separate design decision.
- **Proposal:** a dedicated inbox subdomain, independent deployment/origin, and owner-only Google federation/session. It avoids adding private mail routes to the already shared public-site distribution. The exact name remains to be chosen; the owner account was subsequently confirmed as owner@example.net. The URL is not a secret credential.

## Decisions and work remaining

- Launch aliases are now confirmed: info@example.com, taylor@example.com, info@example.org, and support@example.org. Only support currently exists in receiving rules; the other three need implementation.
- Include both staging/test and production automated mail, clearly labelled and filterable. A background import delay of a few minutes is acceptable; actual archive/import latency still needs verification.
- Retain all mail, including Trash, until explicit permanent deletion. Implement durable storage and a reviewed cutover from the current 14-day support policy; that policy remains unchanged.
- A private backup recovery window of up to 30 days after permanent deletion is accepted. Restores must preserve deletion records and keep deleted messages out of the app.
- Verification-code/password-reset email capture is excluded; ordinary project notifications, invitations, reminders, and contact emails remain in scope. Cost effectiveness and long-term operation are priorities.
- Check native archive compatibility with per-message permanent deletion. The documented API exposes archive-level deletion rather than an individual-message delete operation. Treat this as an unresolved capture-design constraint, not as a promise that deleting an imported message deletes its archive copy. [Archive deletion](https://docs.aws.amazon.com/sesmailmanager/latest/APIReference/API_DeleteArchive.html), [API operations](https://docs.aws.amazon.com/sesmailmanager/latest/APIReference/API_Operations.html)
- Google owner account is confirmed as owner@example.net. Push notifications show sender and subject, with no message-body preview. The exact private subdomain name remains to be chosen.
- The concrete design and budget are proposed in ARCHITECTURE_PROPOSAL.md, favouring app-owned capture, DSQL word indexing, and backend-managed sessions. These require feasibility validation; the audit itself establishes infrastructure and observed usage only.
- Obtain SES production access for the chosen sending account/region; add Example receiving MX/rules and enabled aliases; preserve existing DKIM, staging mail, WorkMail, and public-site routing.
- Prototype the selected capture/search/hosting approach and test iPhone background push with the actual Home Screen app. These require implementation/setup and were not run during this audit.

## Evidence and references

Local machine-readable evidence is stored in .audit/aws-inventory.json (65 checks), .audit/ses_cost_usage.json, .audit/support_objects.json, and .audit/calculated_summary.json. The directory is excluded from future Git commits. It contains resource configuration/metrics, not credentials or message bodies.

Relevant local source: ../exampleorg/config/support-mail.mjs, config/stage.mjs, config/production.mjs, infra/support-mail-stack.ts, infra/delivery-stack.ts, library/server/invitation-mail.mjs, library/server/learning-mail.mjs; ../website/functions/contact/handler.ts, infra/contact-stack.ts, and docs/EXAMPLEORG-INTEGRATION.md. Source-derived behavior is distinguished above from live observations.

- [SES sandbox and production access](https://docs.aws.amazon.com/ses/latest/dg/request-production-access.html)
- [SES receiving rules and active rule sets](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html)
- [SES identities and domain inheritance](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- [SES account-level sending metrics](https://docs.aws.amazon.com/ses/latest/dg/event-publishing-retrieving-cloudwatch.html)
- [SES DMARC alignment](https://docs.aws.amazon.com/ses/latest/dg/send-email-authentication-dmarc.html)
- [SES outbound archive configuration API](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_PutConfigurationSetArchivingOptions.html)
- [Mail Manager message retrieval](https://docs.aws.amazon.com/sesmailmanager/latest/APIReference/API_GetArchiveMessage.html)
- [Mail Manager archive search API](https://docs.aws.amazon.com/sesmailmanager/latest/APIReference/API_StartArchiveSearch.html)
