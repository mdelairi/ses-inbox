import { transaction } from './repository.mjs';
import { parseQuery } from './text.mjs';

export const FOLDERS = ['inbox', 'sent', 'archive', 'trash', 'spam'];
const SEARCH_CANDIDATES = 500;
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const placeholders = (values, offset) => values.map((_, i) => `$${i + 1 + offset}`).join(',');
const utc = value => value == null ? null : new Date(String(value).replace(' ', 'T') + 'Z').toISOString();
const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value) ? value : fail('Invalid identifier');
const MESSAGE_COLUMNS = 'm.message_id, m.thread_id, m.received_at::text AS received_at, m.sent_at::text AS sent_at, m.subject, m.sender_name, m.sender_address, m.recipients_json, m.snippet, m.has_attachments, m.source, m.environment, m.quarantined, m.object_manifest_key, e.folder, e.is_read';

function summary(row) {
  const recipients = JSON.parse(row.recipients_json);
  return { id: row.message_id, thread: row.thread_id, fromName: row.sender_name, from: row.sender_address, to: recipients.to.map(item => item.address), cc: recipients.cc.map(item => item.address),
    subject: row.subject, snippet: row.snippet, date: utc(row.received_at), sentAt: utc(row.sent_at), source: row.source, environment: row.environment, hasAttachments: row.has_attachments,
    quarantined: row.quarantined, folder: row.folder, read: row.is_read };
}
const encodeCursor = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function decodeCursor(cursor) {
  if (!cursor) return null;
  try { const value = JSON.parse(Buffer.from(cursor, 'base64url')); uuid(value.thread); if (Number.isNaN(Date.parse(value.latest))) throw 0; return value; } catch { fail('Invalid page cursor'); }
}

// Every operation is scoped to one resolved alias; message ids alone never authorize access.
export function createMailbox({ pool, objects }) {
  async function alias(address) {
    const { rows: [row] } = await pool.query('SELECT a.domain_id, a.alias_id, a.address, a.display_name, a.receive_enabled, a.send_enabled, a.signature, d.name AS domain FROM mail.aliases a JOIN mail.domains d ON d.domain_id=a.domain_id WHERE a.address=$1', [String(address || '').toLowerCase()]);
    if (!row) fail('Unknown mailbox', 404);
    return { domainId: row.domain_id, aliasId: row.alias_id, address: row.address, displayName: row.display_name, domain: row.domain, receiveEnabled: row.receive_enabled, sendEnabled: row.send_enabled, signature: row.signature };
  }
  // Latest visible message per thread, in the given thread order.
  async function summaries(scope, threads, folder) {
    if (!threads.length) return [];
    const args = [scope.domainId, scope.aliasId, ...threads.map(item => item.thread)];
    const { rows } = await pool.query(`SELECT ${MESSAGE_COLUMNS} FROM mail.mailbox_entries e JOIN mail.messages m ON m.domain_id=e.domain_id AND m.message_id=e.message_id
      WHERE e.domain_id=$1 AND e.alias_id=$2 AND e.thread_id IN (${placeholders(threads, 2)})${folder ? ` AND e.folder=$${args.length + 1}` : ''} ORDER BY e.received_at DESC, e.message_id DESC`, folder ? [...args, folder] : args);
    const latest = new Map();
    for (const row of rows) if (!latest.has(row.thread_id)) latest.set(row.thread_id, row);
    return threads.filter(item => latest.has(item.thread)).map(item => ({ ...summary(latest.get(item.thread)), count: item.count, unread: item.unread }));
  }

  return {
    alias,
    async aliases() {
      const { rows } = await pool.query('SELECT a.address, a.display_name, a.receive_enabled, a.send_enabled, a.is_default, a.signature, d.name AS domain, d.label FROM mail.aliases a JOIN mail.domains d ON d.domain_id=a.domain_id ORDER BY d.name, a.address');
      return rows.map(row => ({ address: row.address, name: row.display_name, domain: row.domain, domainLabel: row.label, receiveEnabled: row.receive_enabled, sendEnabled: row.send_enabled, default: row.is_default, signature: row.signature }));
    },

    // Conversations are paged by their latest message in the folder, never as loose messages.
    async listThreads({ mailbox, folder = 'inbox', unread = false, source, environment, cursor, limit = 50 }) {
      if (!FOLDERS.includes(folder)) fail('Unknown folder');
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('Page size must be 1..100');
      const scope = await alias(mailbox), after = decodeCursor(cursor);
      const args = [scope.domainId, scope.aliasId, folder], where = [], having = [];
      if (source) { args.push(source); where.push(`m.source=$${args.length}`); }
      if (environment) { args.push(environment); where.push(`m.environment=$${args.length}`); }
      if (unread) having.push('max(CASE WHEN e.is_read THEN 0 ELSE 1 END)=1');
      if (after) { args.push(after.latest, after.thread); having.push(`(max(e.received_at) < $${args.length - 1}::timestamp OR (max(e.received_at) = $${args.length - 1}::timestamp AND e.thread_id < $${args.length}::uuid))`); }
      args.push(limit + 1);
      const { rows } = await pool.query(`SELECT e.thread_id, max(e.received_at)::text AS latest, count(*)::int AS count, max(CASE WHEN e.is_read THEN 0 ELSE 1 END)::int AS unread
        FROM mail.mailbox_entries e JOIN mail.messages m ON m.domain_id=e.domain_id AND m.message_id=e.message_id
        WHERE e.domain_id=$1 AND e.alias_id=$2 AND e.folder=$3${where.map(clause => ` AND ${clause}`).join('')}
        GROUP BY e.thread_id${having.length ? ` HAVING ${having.join(' AND ')}` : ''} ORDER BY max(e.received_at) DESC, e.thread_id DESC LIMIT $${args.length}`, args);
      const page = rows.slice(0, limit).map(row => ({ thread: row.thread_id, latest: utc(row.latest), count: row.count, unread: row.unread === 1 }));
      const last = page.at(-1);
      return { threads: await summaries(scope, page, folder), cursor: rows.length > limit ? encodeCursor({ latest: last.latest, thread: last.thread }) : null };
    },

    // Words are ANDed against the current search generation; phrases are verified by position.
    async search({ mailbox, query, field, limit = 50 }) {
      const scope = await alias(mailbox), parsed = parseQuery(query, field);
      if (!parsed.tokens.length) return { threads: [], truncated: false };
      const args = [scope.domainId, scope.aliasId], exists = parsed.tokens.map(token => {
        const tokenParam = args.push(token), fieldClause = parsed.field ? ` AND p.field=$${args.push(parsed.field)}` : '';
        return `EXISTS (SELECT 1 FROM mail.search_positions p WHERE p.domain_id=e.domain_id AND p.message_id=e.message_id AND p.generation=m.search_generation AND p.token=$${tokenParam}${fieldClause})`;
      });
      args.push(SEARCH_CANDIDATES + 1);
      const { rows } = await pool.query(`SELECT e.message_id, e.thread_id, e.received_at::text AS received_at, m.search_generation FROM mail.mailbox_entries e JOIN mail.messages m ON m.domain_id=e.domain_id AND m.message_id=e.message_id
        WHERE e.domain_id=$1 AND e.alias_id=$2 AND ${exists.join(' AND ')} ORDER BY e.received_at DESC, e.message_id DESC LIMIT $${args.length}`, args);
      const truncated = rows.length > SEARCH_CANDIDATES;
      let matches = rows.slice(0, SEARCH_CANDIDATES);
      if (parsed.phrases.length && matches.length) {
        const tokens = [...new Set(parsed.phrases.flat())], phraseArgs = [scope.domainId, ...matches.map(row => row.message_id), ...tokens];
        const { rows: hits } = await pool.query(`SELECT p.message_id, p.field, p.section, p.position, p.token FROM mail.search_positions p JOIN mail.messages m ON m.domain_id=p.domain_id AND m.message_id=p.message_id AND m.search_generation=p.generation
          WHERE p.domain_id=$1 AND p.message_id IN (${placeholders(matches, 1)}) AND p.token IN (${placeholders(tokens, 1 + matches.length)})${parsed.field ? ` AND p.field=$${phraseArgs.push(parsed.field)}` : ''}`, phraseArgs);
        const at = new Map(hits.map(hit => [`${hit.message_id}|${hit.field}|${hit.section}|${hit.position}`, hit.token]));
        const starts = hits.reduce((map, hit) => map.set(hit.message_id, [...(map.get(hit.message_id) || []), hit]), new Map());
        matches = matches.filter(row => parsed.phrases.every(phrase => (starts.get(row.message_id) || []).some(hit => hit.token === phrase[0] && phrase.every((token, i) => at.get(`${hit.message_id}|${hit.field}|${hit.section}|${hit.position + i}`) === token))));
      }
      const order = [], threads = new Map();
      for (const row of matches) { if (!threads.has(row.thread_id)) { threads.set(row.thread_id, { thread: row.thread_id, count: 0, unread: false }); order.push(threads.get(row.thread_id)); } threads.get(row.thread_id).count++; }
      return { threads: await summaries(scope, order.slice(0, limit)), truncated: truncated || order.length > limit };
    },

    async readThread({ mailbox, thread }) {
      const scope = await alias(mailbox);
      const { rows } = await pool.query(`SELECT ${MESSAGE_COLUMNS} FROM mail.mailbox_entries e JOIN mail.messages m ON m.domain_id=e.domain_id AND m.message_id=e.message_id
        WHERE e.domain_id=$1 AND e.alias_id=$2 AND e.thread_id=$3 ORDER BY e.received_at, e.message_id`, [scope.domainId, scope.aliasId, uuid(thread)]);
      if (!rows.length) fail('Conversation not found', 404);
      return Promise.all(rows.map(async row => {
        const manifest = JSON.parse(await objects.get(row.object_manifest_key)), body = JSON.parse(await objects.get(manifest.body));
        return { ...summary(row), text: body.text, html: body.html, replyTo: manifest.replyTo || [], rfcMessageId: manifest.rfcMessageId || null,
          attachments: manifest.parts.map(part => ({ id: String(part.index), name: part.filename, type: part.contentType, size: part.size, inline: part.inline, cid: part.cid })) };
      }));
    },

    async setState({ mailbox, ids, folder, read }) {
      const scope = await alias(mailbox);
      if (!Array.isArray(ids) || !ids.length || ids.length > 500) fail('Choose 1..500 messages');
      ids.forEach(uuid);
      if (folder !== undefined && !FOLDERS.includes(folder)) fail('Unknown folder');
      if (folder === undefined && typeof read !== 'boolean') fail('Nothing to change');
      const sets = [], args = [scope.domainId, scope.aliasId, ...ids];
      if (folder !== undefined) sets.push(`folder=$${args.push(folder)}`);
      if (typeof read === 'boolean') sets.push(`is_read=$${args.push(read)}`);
      const { rowCount } = await pool.query(`UPDATE mail.mailbox_entries SET ${sets.join(',')}, revision=revision+1 WHERE domain_id=$1 AND alias_id=$2 AND message_id IN (${placeholders(ids, 2)})`, args);
      return { updated: rowCount };
    },

    // Only Trash entries can be deleted. The tombstone blocks replay and restore from re-adding them.
    async deleteForever({ mailbox, ids, now = Date.now() }) {
      const scope = await alias(mailbox);
      if (!Array.isArray(ids) || !ids.length || ids.length > 500) fail('Choose 1..500 messages');
      ids.forEach(uuid);
      return transaction(pool, async client => {
        const { rows } = await client.query(`SELECT message_id FROM mail.mailbox_entries WHERE domain_id=$1 AND alias_id=$2 AND folder='trash' AND message_id IN (${placeholders(ids, 2)})`, [scope.domainId, scope.aliasId, ...ids]);
        for (const { message_id: id } of rows) {
          await client.query('DELETE FROM mail.mailbox_entries WHERE domain_id=$1 AND alias_id=$2 AND message_id=$3', [scope.domainId, scope.aliasId, id]);
          await client.query('INSERT INTO mail.deletion_tombstones(domain_id,alias_id,message_id,deleted_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING', [scope.domainId, scope.aliasId, id, new Date(now).toISOString()]);
        }
        return { deleted: rows.length };
      });
    },

    // Downloads require a live entry for this alias; quarantined parts are never served.
    async attachment({ mailbox, id, part }) {
      const scope = await alias(mailbox);
      const { rows: [row] } = await pool.query('SELECT m.object_manifest_key, m.quarantined FROM mail.mailbox_entries e JOIN mail.messages m ON m.domain_id=e.domain_id AND m.message_id=e.message_id WHERE e.domain_id=$1 AND e.alias_id=$2 AND e.message_id=$3',
        [scope.domainId, scope.aliasId, uuid(id)]);
      if (!row) fail('Attachment not found', 404);
      if (row.quarantined) fail('This message failed a virus check; its attachments are withheld.', 403);
      const found = JSON.parse(await objects.get(row.object_manifest_key)).parts.find(item => String(item.index) === String(part));
      if (!found) fail('Attachment not found', 404);
      return { key: found.key, name: found.filename, type: found.contentType, size: found.size };
    },
  };
}
