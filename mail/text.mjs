import { createHash } from 'node:crypto';

// Bump when normalization changes; indexed generations record the version they used.
export const TOKENIZER_VERSION = 1;
export const FIELDS = ['sender', 'recipient', 'subject', 'body'];
export const MAX_INDEXED_WORDS = 50000;

// Must match web/model.mjs so hosted search behaves like the prototype.
export function normalize(value) { return String(value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
export function words(value) { return normalize(value).split(/\s+/).filter(Boolean); }
// A digest bounds index key size even for unusually long tokens; collision risk is accepted for v1.
export const digest = word => createHash('sha256').update(word).digest('hex');

// fields: { sender: [..], recipient: [address, ..], subject: [..], body: [..] }.
// Each entry is its own section, so phrases never bridge two recipients or subject/body.
export function positions(fields) {
  const rows = [];
  let partial = false;
  for (const field of FIELDS) for (const [section, text] of (fields[field] || []).entries()) {
    for (const [position, word] of words(text).entries()) {
      if (rows.length >= MAX_INDEXED_WORDS) { partial = true; break; }
      rows.push({ field, section, position, token: digest(word) });
    }
  }
  return { rows, partial };
}

// Words are ANDed; "quoted phrases" must be adjacent within one field section.
export function parseQuery(query, field) {
  const text = String(query || '');
  if (field && !FIELDS.includes(field)) throw Object.assign(new Error('Unknown search field'), { status: 400 });
  if (text.length > 1000 || (text.match(/"/g) || []).length % 2) throw Object.assign(new Error('Use balanced quotes and at most 1,000 characters'), { status: 400 });
  const terms = [...new Set(words(text))];
  if (terms.length > 16) throw Object.assign(new Error('Search for at most 16 words'), { status: 400 });
  const phrases = [...text.matchAll(/"([^"]+)"/g)].map(match => words(match[1])).filter(phrase => phrase.length > 1);
  return { terms, tokens: terms.map(digest), phrases: phrases.map(phrase => phrase.map(digest)), field: field || null };
}
