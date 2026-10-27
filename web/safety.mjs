export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const allowed = new Set('p div span br strong b em i u s blockquote ul ol li h1 h2 h3 h4 a img table thead tbody tr td th hr pre code'.split(' '));
const discard = new Set('script style iframe object embed svg math form input button select textarea template link meta base video audio source'.split(' '));
const styles = ['color', 'background-color', 'font-size', 'font-weight', 'font-style', 'font-family', 'text-align', 'text-decoration', 'line-height', 'letter-spacing', 'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom', 'margin', 'margin-top', 'margin-bottom', 'border', 'border-radius', 'border-collapse', 'width', 'max-width', 'height'];
export function safeLink(value) {
  try { const url = new URL(value); return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : ''; } catch { return ''; }
}
export function sanitizeHTML(value, { allowRemote = false } = {}) {
  const template = document.createElement('template');
  template.innerHTML = String(value || '');
  const output = document.createElement('template');
  function clean(node, parent) {
    if (node.nodeType === Node.TEXT_NODE) { parent.append(document.createTextNode(node.textContent)); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.localName.toLowerCase();
    if (discard.has(tag)) return;
    if (!allowed.has(tag)) { for (const child of node.childNodes) clean(child, parent); return; }
    const result = document.createElement(tag);
    if (tag === 'a') { const href = safeLink(node.getAttribute('href')); if (href) { result.setAttribute('href', href); result.setAttribute('target', '_blank'); result.setAttribute('rel', 'noopener noreferrer'); } }
    if (tag === 'img') {
      const src = node.getAttribute('src') || '';
      const local = /^data:image\/(png|jpeg|gif|webp);base64,/i.test(src);
      const remote = allowRemote && /^https:\/\//i.test(src);
      if (!local && !remote) { result.setAttribute('alt', node.getAttribute('alt') || 'Image hidden'); } else result.setAttribute('src', src);
      result.setAttribute('alt', node.getAttribute('alt') || 'Inline image');
      if (/^[a-z0-9-]{1,80}$/i.test(node.getAttribute('data-file-id') || '')) result.setAttribute('data-file-id', node.getAttribute('data-file-id'));
      result.style.maxWidth = '100%';
    }
    for (const style of styles) { const val = node.style.getPropertyValue(style); if (val && !/url\s*\(|expression\s*\(|@import/i.test(val)) result.style.setProperty(style, val); }
    if (['td', 'th'].includes(tag)) for (const name of ['colspan', 'rowspan']) if (/^\d{1,2}$/.test(node.getAttribute(name) || '')) result.setAttribute(name, node.getAttribute(name));
    for (const child of node.childNodes) clean(child, result);
    parent.append(result);
  }
  for (const child of template.content.childNodes) clean(child, output.content);
  return output.innerHTML;
}
export function htmlText(html) {
  const template = document.createElement('template'); template.innerHTML = String(html || '');
  const block = new Set(['div', 'p', 'li', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'tr']);
  function text(node) { if (node.nodeType === Node.TEXT_NODE) return node.textContent; if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return ''; if (node.localName === 'br') return '\n'; return [...node.childNodes].map(text).join('') + (block.has(node.localName) ? '\n' : ''); }
  return text(template.content).replace(/\n{3,}/g, '\n\n').trim();
}
export function messageDocument(html, allowRemote = false) {
  const csp = `default-src 'none'; img-src data:${allowRemote ? ' https:' : ''}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{margin:0;padding:0;font:14px/1.85 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#41474c;overflow-wrap:anywhere}p{margin:0 0 15px}h1,h2,h3{line-height:1.4;font-weight:500}a{color:#4e5860}img{max-width:100%;height:auto}table{max-width:100%}blockquote{border-left:2px solid #dfe7d4;margin:16px 0;padding-left:15px;color:#697177}pre{white-space:pre-wrap}</style></head><body>${sanitizeHTML(html, { allowRemote })}</body></html>`;
}
