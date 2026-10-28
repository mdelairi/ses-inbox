import test from 'node:test';
import assert from 'node:assert/strict';
import MailComposer from 'nodemailer/lib/mail-composer';
import { parseMessage, searchFields, MAX_RAW_BYTES } from '../mail/parse.mjs';
import { digest, normalize, parseQuery, positions, words, MAX_INDEXED_WORDS } from '../mail/text.mjs';
import { normalize as clientNormalize } from '../web/model.mjs';

const compose = options => new MailComposer({ from: 'Avery Quinn <Avery@Example.net>', to: ['info@example.com', 'Taylor <taylor@example.com>'], subject: 'Réunion — idea', text: 'Hello there', ...options }).compile().build();

test('tokenizer matches the client and indexes each recipient as its own section', () => {
  for (const sample of ['Réunion — idea', 'ÀÉÎ ölçü_x 42', 'taylor@example.com', '  ']) assert.equal(normalize(sample), clientNormalize(sample));
  assert.deepEqual(words('Café-crème, NOW!'), ['cafe', 'creme', 'now']);
  const { rows, partial } = positions({ recipient: ['Info info@example.com', 'Taylor taylor@example.com'], subject: ['Hello world'] });
  assert.equal(partial, false);
  assert.deepEqual(rows.filter(row => row.field === 'recipient').map(row => [row.section, row.position]), [[0, 0], [0, 1], [0, 2], [0, 3], [1, 0], [1, 1], [1, 2], [1, 3]]);
  assert.equal(rows.find(row => row.field === 'subject' && row.position === 1).token, digest('world'));
  assert.equal(positions({ body: ['word '.repeat(MAX_INDEXED_WORDS + 5)] }).partial, true);
});
test('queries are bounded and phrases keep word order', () => {
  const query = parseQuery('invoice "next week" Next', 'body');
  assert.deepEqual(query.terms, ['invoice', 'next', 'week']);
  assert.deepEqual(query.phrases, [[digest('next'), digest('week')]]);
  assert.throws(() => parseQuery('"unbalanced'), { status: 400 });
  assert.throws(() => parseQuery(Array.from({ length: 17 }, (_, i) => `w${i}`).join(' ')), { status: 400 });
  assert.throws(() => parseQuery('x', 'headers'), { status: 400 });
});
test('MIME parsing keeps threading, addresses, inline images and attachments', async () => {
  const raw = await compose({ html: '<p>Hello <b>there</b><img src="cid:logo@x"></p>', inReplyTo: '<parent@example.net>', references: ['<root@example.net>', '<parent@example.net>'], messageId: '<child@example.net>', cc: 'c@example.net',
    attachments: [{ filename: 'a.pdf', content: Buffer.from('%PDF'), contentType: 'application/pdf' }, { filename: 'logo.png', content: Buffer.from([137, 80, 78, 71]), cid: 'logo@x', contentType: 'image/png' }] });
  const message = await parseMessage(raw);
  assert.equal(message.rfcMessageId, '<child@example.net>');
  assert.deepEqual(message.references, ['<root@example.net>', '<parent@example.net>']);
  assert.deepEqual(message.from, { name: 'Avery Quinn', address: 'avery@example.net' });
  assert.deepEqual(message.to.map(item => item.address), ['info@example.com', 'taylor@example.com']);
  assert.match(message.html, /cid:logo@x/); assert.equal(message.text, 'Hello there');
  const [logo, pdf] = message.attachments;
  assert.deepEqual([logo.inline, logo.cid, pdf.inline, pdf.cid, pdf.size], [true, 'logo@x', false, null, 4]);
  assert.deepEqual(searchFields(message).recipient, ['info@example.com', 'Taylor taylor@example.com', 'c@example.net']);
});
test('single reference, HTML-only and malformed headers degrade safely', async () => {
  const html = await parseMessage(Buffer.from('From: a@b.c\r\nTo: x@example.com\r\nSubject: only html\r\nIn-Reply-To: <p@x>\r\nReferences: <p@x>\r\nDate: not a date\r\nContent-Type: text/html\r\n\r\n<div>Line one</div><div>Line <i>two</i></div>'));
  assert.equal(html.text, 'Line one\nLine two'); assert.deepEqual(html.references, ['<p@x>']); assert.equal(html.sentAt, null); assert.equal(html.rfcMessageId, null);
  const bare = await parseMessage(Buffer.from('\r\n\r\njust a body'));
  assert.deepEqual(bare.from, { name: '', address: '' }); assert.equal(bare.subject, '');
  await assert.rejects(parseMessage({ length: MAX_RAW_BYTES + 1 }), { message: 'MessageTooLarge', permanent: true });
});
