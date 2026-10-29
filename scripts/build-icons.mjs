// Renders the Home Screen / notification PNG icons from the app mark. Run after changing the
// icon; the PNGs are committed in web/. Full-bleed squares: iOS and Android apply their own mask.
import { writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const mark = size => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="${size}" height="${size}"><rect width="64" height="64" fill="#253c32"/><path d="M17 23h30v22H17zM18 24l14 11 14-11" fill="none" stroke="#f5f5ed" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const browser = await chromium.launch({ channel: 'chrome' });
try {
  for (const [name, size] of [['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0}</style>${mark(size)}`);
    await writeFile(new URL(`../web/${name}`, import.meta.url), await page.screenshot({ omitBackground: false }));
    await page.close();
  }
} finally { await browser.close(); }
console.log('Icons written to web/.');
