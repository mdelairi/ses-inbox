-- Candidate schema, NOT deployed. Execute one DDL statement per transaction.
-- Wait for each CREATE INDEX ASYNC job before serving queries.
CREATE TABLE domains (
  domain_id UUID PRIMARY KEY,
  name VARCHAR(253) NOT NULL,
  revision INTEGER NOT NULL
);
CREATE UNIQUE INDEX ASYNC domains_name ON domains(name);

CREATE TABLE aliases (
  domain_id UUID NOT NULL,
  alias_id UUID NOT NULL,
  address VARCHAR(254) NOT NULL,
  display_name TEXT NOT NULL,
  receive_enabled BOOLEAN NOT NULL,
  send_enabled BOOLEAN NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (domain_id, alias_id)
);
CREATE UNIQUE INDEX ASYNC aliases_address ON aliases(domain_id, address);

CREATE TABLE messages (
  domain_id UUID NOT NULL,
  message_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  received_at TIMESTAMP NOT NULL,
  subject TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipients_json TEXT NOT NULL,
  source VARCHAR(16) NOT NULL,
  environment VARCHAR(16) NOT NULL,
  object_manifest_key TEXT NOT NULL,
  search_generation INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (domain_id, message_id)
);

CREATE TABLE mailbox_entries (
  domain_id UUID NOT NULL,
  alias_id UUID NOT NULL,
  message_id UUID NOT NULL,
  folder VARCHAR(16) NOT NULL,
  is_read BOOLEAN NOT NULL,
  received_at TIMESTAMP NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (domain_id, alias_id, message_id)
);
CREATE INDEX ASYNC mailbox_recent ON mailbox_entries(domain_id, alias_id, received_at, message_id);
CREATE INDEX ASYNC mailbox_folder ON mailbox_entries(domain_id, alias_id, folder, received_at, message_id);
CREATE INDEX ASYNC mailbox_message ON mailbox_entries(domain_id, message_id, alias_id);

-- Separate sections prevent phrases matching across header fields or recipients.
-- token is a SHA-256 hex digest of a normalized word: bounded index key size,
-- including unusually long words. Digest collision risk is accepted for v1 search.
CREATE TABLE search_positions (
  domain_id UUID NOT NULL,
  message_id UUID NOT NULL,
  generation INTEGER NOT NULL,
  field VARCHAR(16) NOT NULL,
  section INTEGER NOT NULL,
  position INTEGER NOT NULL,
  token VARCHAR(64) NOT NULL,
  PRIMARY KEY (domain_id, message_id, generation, field, section, position)
);
CREATE INDEX ASYNC search_term ON search_positions(domain_id, token, message_id, generation, field, section, position);

CREATE TABLE drafts (
  domain_id UUID NOT NULL,
  alias_id UUID NOT NULL,
  draft_id UUID NOT NULL,
  object_manifest_key TEXT NOT NULL,
  updated_at TIMESTAMP NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (domain_id, alias_id, draft_id)
);

-- Minimal non-content replay guard. Must survive longer than backup copies.
CREATE TABLE deletion_tombstones (
  domain_id UUID NOT NULL,
  alias_id UUID NOT NULL,
  message_id UUID NOT NULL,
  deleted_at TIMESTAMP NOT NULL,
  PRIMARY KEY (domain_id, alias_id, message_id)
);

-- Receipt identifies original input, never just RFC Message-ID or content hash.
CREATE TABLE ingestion_receipts (
  domain_id UUID NOT NULL,
  receipt_key VARCHAR(64) NOT NULL,
  message_id UUID NOT NULL,
  state VARCHAR(16) NOT NULL,
  generation INTEGER NOT NULL,
  lease_until TIMESTAMP NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY (domain_id, receipt_key)
);
