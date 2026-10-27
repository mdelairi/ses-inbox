import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { extname, resolve, sep } from 'node:path';

const root = fileURLToPath(new URL('../web/', import.meta.url));
const port = Number(process.env.INBOX_PORT || 4317);
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json' };
export function createDevServer() {
  return createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) { res.writeHead(403).end('Local access only.'); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end('This prototype has no mail service.'); return; }
    try {
      const pathname = decodeURIComponent(new URL(req.url, `http://127.0.0.1:${port}`).pathname);
      if (pathname.startsWith('/api')) { res.writeHead(404).end('No live email API is connected.'); return; }
      const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root.endsWith(sep) ? root : root + sep) || !(await stat(file)).isFile()) { res.writeHead(404).end('Not found.'); return; }
      res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : await readFile(file));
    } catch { res.writeHead(404).end('Not found.'); }
  });
}

const server = createDevServer();
server.listen(port, '127.0.0.1', () => console.log(`Inbox local prototype: http://127.0.0.1:${port}\nSample data only. No emails are sent. Ctrl+C to stop.`));
