#!/usr/bin/env node
/**
 * Redraws the share image (static/og.png), the PNG favicon and the Apple
 * touch icon from brand.json. Run it after renaming the app.
 *
 *   cd frontend
 *   npm install --no-save playwright@1.56.1
 *   npx playwright install chromium
 *   node scripts/make-images.mjs
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { chromium } = await import('playwright').catch(() => {
  console.error('playwright is missing. run: npm install --no-save playwright@1.56.1 && npx playwright install chromium');
  process.exit(1);
});

const root = new URL('../', import.meta.url);
const brand = JSON.parse(await readFile(new URL('../brand.json', root), 'utf8'));
const name = (process.env.APP_NAME?.trim() || brand.name).toLowerCase();
// fonts are inlined: a page made with setContent can't load local files reliably
const font = async (pkg, file) =>
  `data:font/woff2;base64,${(await readFile(new URL(`node_modules/@fontsource/${pkg}/files/${file}`, root))).toString('base64')}`;
const plex = await font('ibm-plex-mono', 'ibm-plex-mono-latin-600-normal.woff2');
const inter = await font('inter', 'inter-latin-400-normal.woff2');
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

const glyph = (size) => `<svg width="${size}" height="${size}" viewBox="0 0 32 32" fill="none" stroke-linecap="round" stroke-width="2.6">
  <path stroke="#e9edef" d="M4 12.5q3-3.5 6 0t6 0 6 0 6 0"/><path stroke="#62aebf" d="M4 19.5q3-3.5 6 0t6 0 6 0 6 0"/></svg>`;

const og = `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face{font-family:Plex;src:url(${plex})}
@font-face{font-family:Inter;src:url(${inter})}
html,body{margin:0}
.og{width:1200px;height:630px;background:#0b0c0d;color:#e9edef;display:flex;flex-direction:column;justify-content:center;padding:0 110px;box-sizing:border-box;font-family:Plex}
.row{display:flex;align-items:center;gap:28px}
.w{font-size:120px;font-weight:600;letter-spacing:-.03em;line-height:1}
.ar{font-family:system-ui,sans-serif;font-size:44px;color:#808b91;align-self:flex-end;margin-bottom:10px}
p{font-family:Inter;font-size:34px;color:#b8c1c6;margin:44px 0 0;max-width:900px;line-height:1.35}
.box{margin-top:48px;display:flex;align-items:center;gap:16px;width:760px;height:76px;border:2px solid #232729;border-radius:26px;background:#141617;padding:0 10px 0 28px;box-sizing:border-box;font-size:26px;color:#808b91}
.box span{flex:1}.go{width:56px;height:56px;border-radius:18px;background:#e9edef;display:grid;place-items:center}
</style></head><body><div class="og" id="og">
<div class="row">${glyph(130)}<span class="w">${esc(name)}</span><span class="ar" lang="ar" dir="rtl">${esc(brand.arabic ?? '')}</span></div>
<p>torrents, downloaded for you. paste a magnet link, pick files, download them in your browser.</p>
<div class="box"><span>paste a magnet link or .torrent url</span><div class="go"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#0b0c0d" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg></div></div>
</div></body></html>`;

const icon = (size, rounded) =>
  `<html><body style="margin:0;background:transparent"><svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 32 32">
  <rect width="32" height="32" rx="${rounded ? 8 : 0}" fill="#0b0c0d"/><g fill="none" stroke-linecap="round" stroke-width="2.6">
  <path stroke="#e9edef" d="M4 12.5q3-3.5 6 0t6 0 6 0 6 0"/><path stroke="#62aebf" d="M4 19.5q3-3.5 6 0t6 0 6 0 6 0"/></g></svg></body></html>`;

const out = (file) => fileURLToPath(new URL(`static/${file}`, root));
const browser = await chromium.launch();
try {
  let page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
  await page.setContent(og, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.locator('#og').screenshot({ path: out('og.png') });
  await page.close();
  for (const [size, file, rounded] of [
    [32, 'favicon-32.png', true],
    [180, 'apple-touch-icon.png', false],
  ]) {
    page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(icon(size, rounded));
    await page.screenshot({ path: out(file), omitBackground: true });
    await page.close();
  }
  console.log(`wrote static/og.png, static/favicon-32.png and static/apple-touch-icon.png for "${name}"`);
} finally {
  await browser.close();
}
