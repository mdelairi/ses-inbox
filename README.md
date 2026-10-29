# Project Inbox

Private project mail for example.com and example.org is live at [inbox.example.com](https://inbox.example.com). See [PRODUCTION.md](PRODUCTION.md) for the production runbook and [PROJECT_STATUS.md](PROJECT_STATUS.md) for the current outstanding work.

The localhost preview described below uses fictional sample messages and browser-local storage. **Send locally never sends an email.**

Source: [mdelairi/ses-inbox](https://github.com/mdelairi/ses-inbox) (private repository).

## Run

Use Node.js 22 or later:

```sh
npm run dev
```

Open **http://127.0.0.1:4317** on this computer. No dependency installation, AWS credentials, or cloud resources are needed to run the local preview. The server binds only to the loopback interface; this URL is not reachable from a separate phone. Narrow the browser window to review the phone layout.

`INBOX_PORT=4318 npm run dev` selects another port. Stop the process with Ctrl+C. `npm run build` copies the frontend to `dist`; it does not provision or publish a working mail service. The original backend build is retained as `npm run build:server` and requires the declared dependencies; those server modules are a partial earlier scaffold, not the proposed production architecture.

## Try the flows

- Switch between Example (green) and ExampleOrg (blue), then choose an address from the tabs above the message list. Each address has separate folders, unread state, drafts, search, and thread history.
- Open a conversation, reply, forward, or compose. The sender is fixed to the selected mailbox; close the draft and switch address tabs to use another sender. Use formatting, links, signatures, attachments, and inline PNG/JPEG/GIF/WebP images.
- Close a draft to save it. Switch domains or reload, then reopen it from its address’s Drafts folder. Local drafts and files stay in this browser; cross-device synchronization is not implemented.
- Use word or quoted-phrase search over sender, recipients, subject, and body. Search covers only the selected address across folders. Filters select source, environment, and unread state.
- In each address’s Sent folder, distinguish manual/automated mail and staging/production. Captured senders such as no-reply@example.org have a read-only mailbox; capturing outgoing mail does not enable sending or receiving at that address. Local sends are explicitly labelled as previews.
- If one message reaches two aliases, each copy has independent folder/read state. Archive, move to Trash/Spam, undo a folder move, restore to Inbox, or explicitly delete Trash mail permanently. Trash has no automatic expiry. A deletion removes data from this local preview; it does not create a cloud recovery copy.
- In **Aliases & settings**, add/edit/disable addresses and choose a default sender. Address changes create a replacement alias and can optionally disable the old one; existing message addresses remain unchanged.
- Preview sender/subject notifications. **Local preview → Add sample** creates a fictional incoming message and displays a notification preview if enabled.

Keyboard shortcuts: **C** to compose, **/** to search, **⌘/Ctrl+Enter** to send locally. Changes use IndexedDB; storage failures are displayed instead of being reported as saved. **Settings → Local preview → Reset local sample data** restores fixtures after an explicit confirmation and removes local preview edits.

The text palette uses dark and medium greys, following the owner's review; workspace-specific green/blue is used for surfaces and control accents. Spelling in compose is delegated to the browser/OS, with spell-check and English language hints enabled on the body and subject. Chrome's **Edit → Spelling and Grammar → Check Spelling While Typing** must also be enabled for native checking; this prototype does not call a spelling service or include a separate dictionary.

## Validation

```sh
npm test
npm run build
```

The main suite now has 113 passing checks, including automated Sent capture, producer contract checks and an isolated backup/restore drill against embedded PostgreSQL (PGlite). Producer contract checks read the local ExampleOrg/website checkouts and use mocked AWS clients; they do not edit those projects or send email. Set `INBOX_TEST_NATIVE_POSTGRES=1` to use the optional native test server instead; these checks do not reproduce DSQL-specific IAM or concurrency. The twelve model tests cover search/domain isolation, word/phrase matching, filters, alias-aware replies, address changes, Trash retention/deletion, simulated send deduplication, send validation, alias isolation, and independent deletion of copies delivered to multiple addresses.

Browser checks use the declared Playwright development dependency and Chrome:

```sh
npm install
npm run test:browser
```

Eight browser journeys cover domain/search/filter behaviour, draft persistence, rich compose/files/images/local sends, archive/delete/undo, alias management, untrusted HTML isolation, phone-sized navigation, fixed mailbox senders, and workspace colour changes. They passed in isolated Chrome contexts. These tests do not touch the user's preview data. The renderer strips active email HTML and isolates rich messages in sandboxed frames; this is prototype validation, not a completed production email-security review.

## Hosted environments and remaining work

The historical storage feasibility work is documented in [BACKEND_STORAGE.md](BACKEND_STORAGE.md), with the original candidate schema, a reproducible local search/storage probe, and the temporary DSQL experiment. Production now uses the evolved repository and schema in `mail/`. See [measured results](planning/STORAGE_BENCHMARK.md). Run `python3 -m unittest discover -s backend -p 'test_*.py'` and `python3 planning/benchmark_storage.py --sizes 1000 10000 50000` for local-only checks. The hosted stage now uses a separate DSQL/S3 bridge for shared sample data; localhost remains browser-local.

The private sample-only staging release is live at [stage.example.com](https://stage.example.com), with Google sign-in restricted to the owner. See [STAGING.md](STAGING.md) for resources, release commands, validation, and the runbook. `npm run stage:prepare` is local-only; `npm run stage:check` reports readiness without provisioning anything.

The hosted sample stage persists drafts, aliases, mailbox state, attached files, and inline images across devices. Create a draft, wait for “Saved to shared workspace,” then open the same mailbox’s Drafts on another signed-in device. Use Refresh/reload to retrieve changes. Earlier browser-only samples are preserved separately and are not automatically imported.

Source now also includes sample-stage retention: a permanent-deletion ledger that prevents resurrection, 29-day retirement of replaced states and attachments, an hourly cleanup Lambda with failure alarms, and an additive recovery function. It was deployed to staging on October 28, 2026; see [STAGING.md](STAGING.md#retention-and-recovery-deployed-october-28-2026).

Real mail is live in production at [inbox.example.com](https://inbox.example.com) for all four aliases (support@example.org in dual delivery with ExampleOrg for now). See [PRODUCTION.md](PRODUCTION.md) for the mail flow, runbook, and known gaps.

Automated Sent capture is live in production for the website contact form; ExampleOrg staging capture is implemented but not yet enabled. See [AUTOMATED_SENT.md](AUTOMATED_SENT.md). Retiring ExampleOrg's duplicate support@ copy (its StoreSupport rule), background iPhone push, in-app production alias changes and complete refresh/pagination remain pending. Production backups and hourly retention maintenance are deployed and cloud-verified; early raw originals are preserved, isolated restore/deletion drills passed and temporary resources were removed. See [PRODUCTION_RECOVERY.md](PRODUCTION_RECOVERY.md). Production uses the relational mail repository and server search; the shared sample stage still searches in the browser; the separate benchmark validates candidate DSQL query behavior, not complete production costs.

The local preview runs without AWS. Hosted staging changes are isolated to this app; production email routing is unchanged; producer source changes are local and opt-in. See [PROJECT_PLAN.md](PROJECT_PLAN.md), [AWS_AUDIT.md](AWS_AUDIT.md), and [ARCHITECTURE_PROPOSAL.md](ARCHITECTURE_PROPOSAL.md) for the confirmed requirements, existing infrastructure, and proposed production design.
