# Project Inbox — local prototype

A browser-based prototype for private project mail on example.com and example.org. It uses fictional sample messages and browser-local storage. **Send locally never sends an email.**

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

The twelve model tests cover search/domain isolation, word/phrase matching, filters, alias-aware replies, address changes, Trash retention/deletion, simulated send deduplication, send validation, alias isolation, and independent deletion of copies delivered to multiple addresses.

Browser checks use the declared Playwright development dependency and Chrome:

```sh
npm install
npm run test:browser
```

Eight browser journeys cover domain/search/filter behaviour, draft persistence, rich compose/files/images/local sends, archive/delete/undo, alias management, untrusted HTML isolation, phone-sized navigation, fixed mailbox senders, and workspace colour changes. They passed in isolated Chrome contexts. These tests do not touch the user's preview data. The renderer strips active email HTML and isolates rich messages in sandboxed frames; this is prototype validation, not a completed production email-security review.

## Still to connect

The next backend foundation is documented in [BACKEND_STORAGE.md](BACKEND_STORAGE.md), with a candidate SQL schema, a reproducible local search/storage probe, and a separately approved temporary DSQL experiment. See [measured results](planning/STORAGE_BENCHMARK.md). Run `python3 -m unittest discover -s backend -p 'test_*.py'` and `python3 planning/benchmark_storage.py --sizes 1000 10000 50000` for local-only checks. The UI is not yet connected to server mailbox storage.

The private sample-only staging release is live at [stage.example.com](https://stage.example.com), with Google sign-in restricted to the owner. See [STAGING.md](STAGING.md) for resources, release commands, validation, and the runbook. `npm run stage:prepare` is local-only; `npm run stage:check` reports readiness without provisioning anything.

Production mail integration, real SES receiving/sending, automated project capture, DSQL persistence/search-cost benchmarking, server-side drafts, background iPhone push, private backups, and deployment are not connected. The browser word index demonstrates search behaviour; it does not validate DSQL cost or CloudFront configuration.

No live AWS settings or other project sources were changed to build this preview. See [PROJECT_PLAN.md](PROJECT_PLAN.md), [AWS_AUDIT.md](AWS_AUDIT.md), and [ARCHITECTURE_PROPOSAL.md](ARCHITECTURE_PROPOSAL.md) for the confirmed requirements, existing infrastructure, and proposed production design.
