import { createMailbox } from './mailbox.mjs';
import { createDrafts } from './drafts.mjs';
import { createSender } from './send.mjs';

// RPC-style JSON API behind the owner-only gateway (stage/auth.mjs): every call is a POST,
// so reads also pass its origin, CSRF and body-hash checks.
export function createMailApi({ pool, objects, ses, bucket, configurationSet, environment, now = Date.now }) {
  const mailbox = createMailbox({ pool, objects });
  const drafts = createDrafts({ pool, objects, mailbox, now });
  const sender = createSender({ pool, objects, ses, mailbox, bucket, configurationSet, environment, now });
  const routes = {
    '/api/mail/mailboxes': () => mailbox.aliases(),
    '/api/mail/entries': body => mailbox.entries({ limit: body.limit }),
    '/api/mail/threads': body => mailbox.listThreads(body),
    '/api/mail/search': body => mailbox.search(body),
    '/api/mail/thread': body => mailbox.readThread(body),
    '/api/mail/state': body => mailbox.setState(body),
    '/api/mail/delete': body => mailbox.deleteForever({ mailbox: body.mailbox, ids: body.ids }),
    '/api/mail/attachment': async body => { const file = await mailbox.attachment(body); return { name: file.name, type: file.type, size: file.size, url: await objects.downloadUrl(file.key, file.name, file.type) }; },
    '/api/mail/upload': body => drafts.uploadTicket(body),
    '/api/mail/upload/download': body => drafts.uploadDownload(body),
    '/api/mail/drafts': body => drafts.list(body),
    '/api/mail/draft': body => drafts.get(body),
    '/api/mail/draft/save': body => drafts.save(body),
    '/api/mail/draft/delete': body => drafts.remove(body),
    // The draft is removed only once the send is recorded, so a failed request keeps it.
    '/api/mail/send': async body => {
      const result = await sender.send(body);
      if (body.draftId && result.state !== 'failed') await drafts.remove({ mailbox: body.mailbox, id: body.draftId });
      return result;
    },
  };
  return async ({ method, path, body }) => {
    const route = routes[path];
    if (!route) return { status: 404, data: { error: 'Not found' } };
    if (method !== 'POST') return { status: 405, data: { error: 'Method not allowed' } };
    try { return { status: 200, data: await route(body && typeof body === 'object' ? body : {}) }; }
    catch (error) {
      if (error.status) return { status: error.status, data: { error: error.message } };
      throw error;
    }
  };
}
