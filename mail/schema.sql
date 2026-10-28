-- Production mail repository schema for Aurora DSQL, evolved from backend/schema.sql.
-- Execute one statement per transaction; wait for every CREATE INDEX ASYNC job before serving.
-- No foreign keys or triggers: the repository enforces parents, CAS revisions and tombstones.
-- Timestamps are UTC without a stored zone.
CREATE TABLE IF NOT EXISTS mail.domains (
  domain_id UUID PRIMARY KEY,
  name VARCHAR(253) NOT NULL,
  label TEXT NOT NULL,
  revision INTEGER NOT NULL
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS domains_name ON mail.domains(name);

CREATE TABLE IF NOT EXISTS mail.aliases (
  domain_id UUID NOT NULL,
  alias_id UUID NOT NULL,
  address VARCHAR(254) NOT NULL,
  display_name TEXT NOT NULL,
  receive_enabled BOOLEAN NOT NULL,
  send_enabled BOOLEAN NOT NULL,
  is_default BOOLEAN NOT NULL,
  signature TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (domain_id, alias_id)
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS aliases_address ON mail.aliases(address);

CREATE TABLE IF NOT EXISTS mail.messages (
  domain_id UUID NOT NULL,
  message_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  received_at TIMESTAMP NOT NULL,
  sent_at TIMESTAMP,
  subject TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  sender_address VARCHAR(254) NOT NULL,
  recipients_json TEXT NOT NULL,
  snippet VARCHAR(200) NOT NULL,
  has_attachments BOOLEAN NOT NULL,
  source VARCHAR(16) NOT NULL,
  environment VARCHAR(16) NOT NULL,
  verdicts_json TEXT NOT NULL,
  quarantined BOOLEAN NOT NULL,
  object_manifest_key TEXT NOT NULL,
  search_generation INTEGER NOT NULL,
  search_partial BOOLEAN NOT NULL,
  tokenizer_version INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (domain_id, message_id)
);
CREATE INDEX ASYNC IF NOT EXISTS messages_thread ON mail.messages(domain_id, thread_id, received_at);

-- Hashed RFC Message-ID -> message, for threading replies and references.
CREATE TABLE IF NOT EXISTS mail.message_ids (
  domain_id UUID NOT NULL,
  rfc_hash VARCHAR(64) NOT NULL,
  message_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  PRIMARY KEY (domain_id, rfc_hash, message_id)
);

CREATE TABLE IF NOT EXISTS mail.mailbox_entries (
  domain_id UUID NOT NULL,
  alias_id UUID NOT NULL,
  message_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  folder VARCHAR(16) NOT NULL,
  is_read BOOLEAN NOT NULL,
  received_at TIMESTAMP NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (domain_id, alias_id, message_id)
);
CREATE INDEX ASYNC IF NOT EXISTS mailbox_folder ON mail.mailbox_entries(domain_id, alias_id, folder, received_at, message_id);
CREATE INDEX ASYNC IF NOT EXISTS mailbox_message ON mail.mailbox_entries(domain_id, message_id, alias_id);
CREATE INDEX ASYNC IF NOT EXISTS mailbox_thread ON mail.mailbox_entries(domain_id, alias_id, thread_id);

-- Separate sections prevent phrases matching across fields or recipients.
-- token is the SHA-256 digest of a normalized word (mail/text.mjs).
CREATE TABLE IF NOT EXISTS mail.search_positions (
  domain_id UUID NOT NULL,
  message_id UUID NOT NULL,
  generation INTEGER NOT NULL,
  field VARCHAR(16) NOT NULL,
  section INTEGER NOT NULL,
  position INTEGER NOT NULL,
  token VARCHAR(64) NOT NULL,
  PRIMARY KEY (domain_id, message_id, generation, field, section, position)
);
CREATE INDEX ASYNC IF NOT EXISTS search_term ON mail.search_positions(domain_id, token, message_id, generation, field, section, position);

CREATE TABLE IF NOT EXISTS mail.drafts (
  domain_id UUID NOT NULL,
  alias_id UUID NOT NULL,
  draft_id UUID NOT NULL,
  object_key TEXT NOT NULL,
  subject TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (domain_id, alias_id, draft_id)
);

-- Minimal non-content replay guard. Must outlive every backup copy.
CREATE TABLE IF NOT EXISTS mail.deletion_tombstones (
  domain_id UUID NOT NULL,
  alias_id UUID NOT NULL,
  message_id UUID NOT NULL,
  deleted_at TIMESTAMP NOT NULL,
  PRIMARY KEY (domain_id, alias_id, message_id)
);

-- Identifies original input (SES message + stored object), never just RFC Message-ID or content.
CREATE TABLE IF NOT EXISTS mail.ingestion_receipts (
  domain_id UUID NOT NULL,
  receipt_key VARCHAR(64) NOT NULL,
  message_id UUID NOT NULL,
  state VARCHAR(16) NOT NULL,
  generation INTEGER NOT NULL,
  lease_token VARCHAR(64),
  lease_until TIMESTAMP NOT NULL,
  attempts INTEGER NOT NULL,
  error TEXT,
  revision INTEGER NOT NULL,
  PRIMARY KEY (domain_id, receipt_key)
);

-- One durable row per manual send, written before SES is called.
CREATE TABLE IF NOT EXISTS mail.send_attempts (
  domain_id UUID NOT NULL,
  attempt_id UUID NOT NULL,
  alias_id UUID NOT NULL,
  message_id UUID NOT NULL,
  state VARCHAR(16) NOT NULL,
  ses_message_id VARCHAR(128),
  detail TEXT,
  updated_at TIMESTAMP NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (domain_id, attempt_id)
);
CREATE UNIQUE INDEX ASYNC IF NOT EXISTS send_attempts_ses ON mail.send_attempts(ses_message_id);
