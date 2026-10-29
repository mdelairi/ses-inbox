# Multi-project email client

Requirements and original design · status reviewed October 28, 2026.

**Current status:** production is live at [inbox.example.com](https://inbox.example.com), with owner-only Google sign-in, relational DSQL storage, server search, receiving for all four launch addresses, manual sending and SES delivery events. The sample-only shared staging environment remains separate. See [PROJECT_STATUS.md](PROJECT_STATUS.md) for the prioritized backlog and verification limits, [PRODUCTION.md](PRODUCTION.md) for the live runbook, and [STAGING.md](STAGING.md) for sample staging.

The requirements below remain the acceptance baseline. Architecture sections describe the original proposal; the deployed design uses direct Google OIDC and a DynamoDB session table rather than Cognito. Production mail is implemented in `mail/`; `backend/schema.sql` and the SQLite/DSQL probes are historical feasibility work. The four original `server/` modules are an earlier scaffold. A planning document alone does not authorize cloud changes.

## Confirmed requirements

- A private webmail app for one owner, accessible from anywhere using Google sign-in restricted to owner@example.net. Public registration is disabled. Enroll and enforce the owner's stable identity after verifying the allowed Google account.
- An obscure HTTPS URL on example.com. Choose a subdomain or path after inspecting existing hosting; the address is not an access-control mechanism.
- Initially support example.com and example.org, with a design that accommodates additional project domains.
- Separate mailboxes for every email alias, grouped under domains. Switch domains with the workspace selector and addresses with tabs above the inbox. No combined inbox.
- Receive only explicitly enabled addresses. Manage aliases in the app: add, rename/edit, and disable.
- Launch addresses: info@example.com, taylor@example.com, info@example.org, and support@example.org. Initial sender display names and default aliases are seeded in production/config.example.json; they can be reviewed during setup.
- Use existing SES infrastructure where appropriate. Inspect identities, receipt rules, and sending configuration later to establish actual addresses and capabilities.
- No historical email migration required; a few test messages may exist.
- Include inbox, sent, archive, trash, spam, unread status, drafts, search, conversation threads, attachments, compose, reply, and forward.
- Full rich-text composition, including inline images.
- Include automated project email in its sender address’s Sent folder, as well as mail sent manually through this app. Captured-only senders have read-only mailboxes and are not enabled receiving/manual-send aliases.
- Exclude platform-generated verification-code and password-reset emails from Sent capture. Ordinary project notifications, invitations, reminders, and contact emails remain included.
- Include both staging/test and production automated mail, clearly labelled and filterable by environment within each domain. Keep automated sender capture separate from the manual-send/receiving alias list; capturing no-reply@example.org does not automatically enable it as a receiving alias.
- A background sync delay of a few minutes is acceptable for automated Sent. Manually composed mail appears immediately with its actual pending/sending/result status. This is a freshness requirement for the chosen integration, not a verified archive-service latency guarantee.
- When producer capture is enabled, save the complete ordinary email before sending. A capture-storage failure stops the send with a definite pre-send failure; this explicitly allows delivery to be delayed during a capture outage. An acknowledgement-storage failure after SES acceptance preserves success and must not trigger a resend. Verification/reset delivery is unchanged.
- Retain all mail, including Trash, until the owner explicitly deletes it permanently. No automatic mailbox, Spam, or Trash expiry. This is the new app's retention requirement; the existing support-bucket expiry has not been changed.
- Private backup/recovery copies may remain for up to 30 days after permanent deletion. Normal application access ends immediately, and restores must apply deletion records so deleted messages stay deleted.
- Support phones and desktop browsers, with background browser/phone push notifications when the app is closed on supported devices.
- Target iPhone background push through a Home Screen web app; the owner is happy to install it this way. Android-specific verification is outside the current launch target.
- New-mail push notifications show the sender and subject, including on the iPhone lock screen; omit the message-body preview. Opening a notification still requires an authorized app session.
- Estimate email volume from AWS during discovery rather than asking the owner to forecast it. Include both inbound mail and automated outgoing mail.
- Prioritize low ongoing cost and maintainability so the app can remain running long term. The proposed initial working budget is US$5/month; this is an engineering recommendation, not a user-approved spending cap or a verified production bill.
- Use distinct primary colours for workspaces: Example green, ExampleOrg blue. Apply colours to navigation surfaces, selection indicators, and compose/send controls.
- Use dark-grey text for the interface and default message reading/composition; green text was rejected during local review. Keep secondary text neutral grey and retain restrained control/surface accents.

## Proposed user experience

- Google sign-in opens the last selected domain and address, with that mailbox’s folders, unread counts, message list, and reading pane. Use a single-column navigation flow on phones.
- Each alias has independent Inbox, Sent, Drafts, Archive, Trash, Spam, search, and conversation history. Address tabs sit above the message list, keeping sidebar folders near the top. Remember the last selected address per domain.
- Compose, reply, and forward use a fixed sender matching the selected mailbox. To send as another alias, close/save the draft and switch mailbox tabs. Show the complete selected address in the header and composer; disabled/captured-only mailboxes cannot send.
- Preserve an unfinished draft's domain and alias when switching domains. Drafts autosave to the server and can be resumed on another device.
- Threads use Message-ID, In-Reply-To, and References, scoped to domain and alias; subject equality alone must not merge unrelated conversations.
- Sent identifies manual versus automated mail and staging versus production, with source/environment filters. Automation does not generate new-mail push alerts by default.
- Alias settings distinguish display-name changes from address changes. Changing an address creates a replacement; offer a choice to keep or disable the previous address. Existing messages retain their original addresses.
- Alias changes show pending/active/error states until application configuration and receiving rules agree. Disabled aliases cannot be used for new manual sends; historical messages remain readable.
- Moving mail to Trash is reversible and never starts an expiry timer. Permanent deletion is a separate explicit action. Final deletion behavior must account for original MIME, bodies, attachments/inline images, index entries, object versions, and any capture/archive copies; preserve shared content while another retained mailbox entry still references it.
- Proposed defaults, not yet confirmed: a signature per alias; external images loaded only on request.

## Proposed architecture

- Responsive installable web app, with a rich-text editor, web app manifest, and service worker for push. Do not persist authenticated mail responses in the service-worker cache by default.
- Prefer a dedicated private subdomain if the hosting audit supports it. Use CloudFront, a private static-asset origin, and HTTPS; finalize routing and exact URL after discovery.
- Google federation through Cognito. Restrict initial federation to the allowed verified Google identity and enforce the enrolled owner's stable identity on every API operation. A valid login token alone is insufficient.
- The concrete cost proposal replaces the earlier API Gateway candidate with a Lambda function URL behind CloudFront AWS_IAM origin access control, and proposes backend-managed owner session cookies. See ARCHITECTURE_PROPOSAL.md for configuration validation and security requirements.
- S3 for original MIME messages, parsed bodies, attachments, and inline images. Downloads require authorization and short-lived access. Sanitize and isolate rendered email HTML; email content must not execute scripts in the app.
- The concrete cost proposal replaces the scaffold's DynamoDB candidate with one independent Aurora DSQL database and an ordinary indexed word/phrase lookup table. This requires a query/cost benchmark before adoption; it does not assume native PostgreSQL full-text extensions. Search covers sender, recipients, subject, and message text within the selected address without fetching every body per request.
- Inbound pipeline: SES recipient rules -> raw-message storage -> queued parsing/indexing -> address mailbox entries -> new-mail push. Preserve spam/virus verdicts, retry safely, deduplicate processing, and recover failed ingestion.
- Route using the actual envelope recipients. If a message reaches multiple aliases, create a separate mailbox entry for each address; folder/read/thread/deletion state remains independent even within the same domain. Shared immutable content is retained until the last entry is deleted.
- Outbound pipeline: validate allowed domain and alias -> persist the composed message and send attempt -> SES -> update status from sending events. Keep ambiguous send outcomes explicit so retries do not silently duplicate mail.
- Push subscriptions are authenticated and revocable per device. Send a notification only after the message is readable; clicking opens the correct domain, address, and thread after any required login. Remove expired subscriptions and deduplicate notifications.
- Push payloads include the confirmed sender/subject preview and routing identifiers, without a message-body snippet, attachments, or session credentials.
- Preserve existing application mail flows during integration. App alias settings must not silently change transactional senders in other projects.
- During support-mail cutover, use durable app-owned storage without the current 14-day expiry. Agree on treatment of existing support objects and recoverable copies before applying a migration. Temporary uploads and infrastructure logs may have their own cleanup policies; retained mailbox messages do not.

## Automated project mail: integration to validate

The concrete proposal prefers a shared producer-side send-and-store integration with app-owned S3 storage for ordinary project mail. This aligns capture with the agreed deletion and 30-day recovery behavior. SES configuration-set archiving remains an evaluated fallback rather than the first choice; verification/reset delivery is excluded from capture. See ARCHITECTURE_PROPOSAL.md for the design baseline and [AUTOMATED_SENT.md](AUTOMATED_SENT.md) for the local implementation, applied local producer integrations, capture-before-send policy and rollout gates. Capture is not deployed.

- Review each producer's audited send path and exact source/infrastructure changes before integrating the shared helper. Preserve recipients, templates, configuration sets, tags, and existing outcome handling.
- Persist a complete message and send-attempt record in app-controlled storage, then import it asynchronously with domain, source, and environment labels. Validate HTML, inline images, attachments, failure handling, and deduplication.
- Use SES events for accepted/delivered/bounced/failed status. Events do not substitute for the stored message body.
- Exclude verification/password-reset delivery; review any platform-generated ordinary invitation separately rather than silently losing coverage.
- Capture starts when integration is enabled. Do not promise reconstruction of historical bodies that were never retained. Deleted message IDs must prevent replay/backfill from restoring permanently deleted mail.
- Native archive retention/deletion does not directly match the agreed 30-day recovery behavior. It remains a fallback needing a new concrete proposal if app-controlled capture proves unsuitable.

## Build milestones

1. **Read-only discovery and final design.** Inventory SES/DNS/hosting and existing project senders; identify launch aliases and owner account; estimate observed email volume; settle search storage, retention, exact URL, and estimated running cost. Produce the integration and infrastructure change list. Distinguish actual metrics from estimates and note missing history or metrics; recent usage is a baseline rather than a growth forecast.
2. **Local product prototype.** Build domain navigation, folders, threaded reading, rich compose/inline images, drafts, search, and alias settings against representative fixtures. Include desktop and phone layouts and empty/error states.
3. **Authentication and data foundation.** Implement owner-only access, domain-scoped storage/API operations, safe email rendering, upload/download controls, and deployable infrastructure definitions. Verify unauthorized access is denied through both the app and direct API calls.
4. **Real mail flows.** Connect inbound SES processing, manual send/reply/forward, attachment handling, aliases, indexed search, and delivery status. Prove add/disable alias behavior and isolation between the two domains.
5. **Automated Sent and background push.** Integrate real project senders and verify complete messages in the correct Sent folder. Implement device enrollment and test notifications with the app closed on the owner's iPhone Home Screen app and desktop browser.
6. **Launch verification.** Publish at the chosen URL, verify both domains end to end, check recovery/retry paths and restore procedures, and document operating costs and maintenance.

Milestones are implementation order; all confirmed features remain in version-one scope.

## Acceptance checks

- The owner can sign in on a fresh device; a different Google account and unauthenticated direct API requests cannot read, send, download, search, or change settings.
- Switching domains or address tabs keeps messages, unread counts, folders, drafts, threads, and search results separate. Workspace primary colours change visibly (Example green, ExampleOrg blue), while text remains dark grey. Direct message/attachment lookups enforce the same scope.
- An enabled alias receives mail and can send; replies use the correct alias; unknown or disabled addresses do not become accepted catch-all mailboxes.
- Alias updates are recoverable if receiving-rule synchronization fails. A change never erases old messages or changes another project's sender silently.
- Rich HTML and inline images survive sending, receiving, forwarding, reopening drafts, and viewing on desktop/phone. Hostile HTML cannot access the app session.
- Automated project mail appears once in the correct Sent folder, with its complete content and distinguishable delivery status. Existing delivery settings and guards are preserved; the chosen capture-before-send policy may delay ordinary mail during capture-storage outages.
- Search finds both received and sent content, including older messages, within the chosen address. Threading does not merge unrelated conversations.
- Replayed inbound events and ambiguous outbound responses do not cause duplicate messages or automatic duplicate sends.
- With permissions granted and platform setup completed, new mail produces a background push on the target devices and opens the correct message. Mail remains accessible if notification delivery fails.
- Mail stays available indefinitely in every folder, including Spam and Trash. Moving to Trash does not erase content. Explicit permanent deletion follows the documented storage/archive/version cleanup behavior and deleted mail does not reappear through an importer or recovery process.
- Launch sending and receiving work for all four confirmed aliases. Staging and production automated messages appear with correct environment labels and filters under their domain.
- Only owner@example.net can enroll as the owner. New-mail notifications show sender/subject without a body snippet. Automated Sent synchronization meets the agreed few-minute target under normal operation, with visible sync failures/delays rather than lost messages.

## Open decisions

- Expected future mail/attachment growth remains uncertain. Low cost is confirmed as a priority; the proposed budget and explicit assumptions are in ARCHITECTURE_PROPOSAL.md and planning/cost_inputs.json.
- Discovery now establishes a low-volume baseline: 3 production and 87 staging account-level Send events in the last 30 complete UTC days; 3 current support-storage objects totaling 10,530 bytes. These are not a per-domain forecast. Finalize the monthly budget after selecting search/session/archive details; full findings and cost boundaries are in AWS_AUDIT.md.
- Whether contact-form delivery should additionally appear as an Inbox inquiry; current confirmed scope includes capturing its outbound delivery in Sent.
- Review the seeded sender display names/default aliases as needed. The private URL is settled: https://inbox.example.com.
- The DSQL word index and direct Google session design are implemented. Measured operating costs remain (automated Sent capture is live for the website and ExampleOrg staging); production backup rollout/restore verification is complete within the documented same-account/region scope. Production uses standard CloudFront usage pricing; no Free-plan saving is assumed. The recovery-window maximum is 30 days.
- Future domain onboarding: configure infrastructure for new domains first; decide later whether the app should guide DNS/domain verification itself.

## Current implementation

The local prototype and shared sample staging are implemented. Production has the owner-only gateway, real SES ingestion and sending, alias-scoped mailboxes, attachments, server drafts, threading, indexed word/phrase search, folder/read changes, deletion tombstones, and inline last-reference purge. `support@example.org` currently also reaches ExampleOrg's legacy `StoreSupport` rule.

Background push, in-app production alias management, automatic refresh and complete pagination remain outstanding. Production backup/restore and hourly retention maintenance are deployed and cloud-verified for same-account/region recovery. Launch acceptance evidence and actual operating costs are incomplete. [PROJECT_STATUS.md](PROJECT_STATUS.md) tracks these items and separates implemented code from live verification. Production-data and synthetic cloud recovery/retention drills now pass; their scope and operational limits are documented in PRODUCTION_RECOVERY.md.

## References consulted

- [SES identities and inherited sending verification](https://docs.aws.amazon.com/ses/latest/dg/creating-identities.html)
- [SES receiving, recipient rules, and envelope routing](https://docs.aws.amazon.com/ses/latest/dg/receiving-email-concepts.html)
- [SES outbound archiving API](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_PutConfigurationSetArchivingOptions.html)
- [SES archive search and export](https://docs.aws.amazon.com/ses/latest/dg/eb-archiving.html)
- [SES sending events](https://docs.aws.amazon.com/ses/latest/dg/monitor-using-event-publishing.html)
- [Cognito Google federation](https://docs.aws.amazon.com/cognito/latest/developerguide/cognito-user-pools-social-idp.html)
- [Cognito pre-sign-up checks for federated identities](https://docs.aws.amazon.com/cognito/latest/developerguide/user-pool-lambda-pre-sign-up.html)
- [CloudFront custom domains](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/CNAMEs.html)
- [WebKit background push and Home Screen installation](https://webkit.org/blog/13878/)
- [Mail Manager archive deletion](https://docs.aws.amazon.com/sesmailmanager/latest/APIReference/API_DeleteArchive.html)
- [Mail Manager API operations](https://docs.aws.amazon.com/sesmailmanager/latest/APIReference/API_Operations.html)
