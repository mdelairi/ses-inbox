export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const allowed = new Set('p div span br strong b em i u s strike del ins sub sup small big mark q cite abbr blockquote ul ol li dl dt dd h1 h2 h3 h4 h5 h6 a img table caption thead tbody tfoot tr td th colgroup col hr pre code'.split(' '));
const discard = new Set('script style iframe object embed svg math form input button select textarea template link meta base video audio source title head'.split(' '));
// Layout wrappers that mail clients use for blocks; kept as plain blocks rather than flattened.
const blocks = { center: 'div', section: 'div', article: 'div', header: 'div', footer: 'div', main: 'div', aside: 'div', nav: 'div', figure: 'div', figcaption: 'div', address: 'div' };
const styles = ['color', 'background-color', 'background', 'font', 'font-size', 'font-weight', 'font-style', 'font-family', 'font-variant', 'text-align', 'text-decoration', 'text-transform', 'text-indent', 'line-height', 'letter-spacing', 'word-break', 'white-space', 'vertical-align', 'list-style', 'list-style-type', 'display',
  'padding', 'padding-left', 'padding-right', 'padding-top', 'padding-bottom', 'margin', 'margin-left', 'margin-right', 'margin-top', 'margin-bottom',
  'border', 'border-left', 'border-right', 'border-top', 'border-bottom', 'border-color', 'border-style', 'border-width', 'border-radius', 'border-collapse', 'border-spacing', 'width', 'min-width', 'max-width', 'height'];
// <font size> 1–7 in the sizes browsers give it.
const FONT_SIZES = ['', '10px', '13px', '16px', '18px', '24px', '32px', '48px'];
const unsafeStyle = value => /url\s*\(|expression\s*\(|@import|javascript:|behavior\s*:/i.test(value);
const number = value => /^\d{1,4}%?$/.test(value || '');
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
    const source = node.localName.toLowerCase();
    if (discard.has(source)) return;
    // Gmail and older clients set color, typeface and size with <font>.
    const tag = source === 'font' ? 'span' : blocks[source] || source;
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
      for (const name of ['width', 'height']) if (number(node.getAttribute(name))) result.setAttribute(name, node.getAttribute(name));
      result.style.maxWidth = '100%';
    }
    if (source === 'font') {
      const color = node.getAttribute('color'), face = node.getAttribute('face'), size = Number(node.getAttribute('size'));
      if (color && !unsafeStyle(color)) result.style.setProperty('color', color);
      if (face && !unsafeStyle(face)) result.style.setProperty('font-family', face);
      if (size >= 1 && size <= 7) result.style.setProperty('font-size', FONT_SIZES[size]);
    }
    if (source === 'center') result.style.setProperty('text-align', 'center');
    for (const style of styles) { const val = node.style.getPropertyValue(style); if (val && !unsafeStyle(val)) result.style.setProperty(style, val, node.style.getPropertyPriority(style)); }
    // Presentational attributes that newsletters and Gmail tables still rely on.
    const attribute = name => node.getAttribute(name);
    if (/^(ltr|rtl|auto)$/i.test(attribute('dir') || '')) result.setAttribute('dir', attribute('dir'));
    if (/^(left|right|center|justify)$/i.test(attribute('align') || '')) result.setAttribute('align', attribute('align'));
    if (['td', 'th', 'tr'].includes(tag) && /^(top|middle|bottom|baseline)$/i.test(attribute('valign') || '')) result.setAttribute('valign', attribute('valign'));
    if (['table', 'td', 'th', 'tr'].includes(tag) && /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(attribute('bgcolor') || '')) result.setAttribute('bgcolor', attribute('bgcolor'));
    if (['table', 'td', 'th', 'col', 'colgroup'].includes(tag)) for (const name of ['width', 'height']) if (number(attribute(name))) result.setAttribute(name, attribute(name));
    if (tag === 'table') for (const name of ['border', 'cellpadding', 'cellspacing']) if (/^\d{1,2}$/.test(attribute(name) || '')) result.setAttribute(name, attribute(name));
    if (['td', 'th'].includes(tag)) for (const name of ['colspan', 'rowspan']) if (/^\d{1,2}$/.test(attribute(name) || '')) result.setAttribute(name, attribute(name));
    if (['col', 'colgroup'].includes(tag) && /^\d{1,2}$/.test(attribute('span') || '')) result.setAttribute('span', attribute('span'));
    if (tag === 'ol') { if (/^-?\d{1,6}$/.test(attribute('start') || '')) result.setAttribute('start', attribute('start')); if (/^[1aAiI]$/.test(attribute('type') || '')) result.setAttribute('type', attribute('type')); }
    if (tag === 'li' && /^-?\d{1,6}$/.test(attribute('value') || '')) result.setAttribute('value', attribute('value'));
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
// The frame is its own viewport, so the phone rule applies whenever the frame itself is narrow.
export function messageDocument(html, allowRemote = false) {
  const csp = `default-src 'none'; img-src data:${allowRemote ? ' https:' : ''}; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>body{margin:0;padding:0;font:14px/1.85 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#41474c;overflow-wrap:anywhere;-webkit-text-size-adjust:100%}p{margin:0 0 15px}h1,h2,h3{line-height:1.4;font-weight:500}a{color:#4e5860}img{max-width:100%;height:auto}table{max-width:100%}blockquote{border-left:2px solid #dfe7d4;margin:16px 0;padding-left:15px;color:#697177}pre{white-space:pre-wrap}@media(max-width:600px){body{font-size:16px;line-height:1.7}}</style></head><body>${sanitizeHTML(html, { allowRemote })}</body></html>`;
}
