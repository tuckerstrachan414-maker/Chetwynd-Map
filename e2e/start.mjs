// Reproduce the real start flow (no ?headless): load, click the start screen early and late,
// record console errors and whether the overlay hides and frames advance.
import { chromium } from 'playwright-core';

const [url = 'http://localhost:4173/', out = 'e2e/out/start'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') log(`console.${m.type()}:`, m.text().slice(0, 300)); });
page.on('pageerror', (e) => log('pageerror:', e.message));
page.on('response', (r) => { if (r.status() >= 400) log(`HTTP ${r.status()}`, r.url()); });
await page.goto(url);
const state = () => page.evaluate(() => ({
  start: !!document.querySelector('.hud-start') && !document.querySelector('.hud-start').classList.contains('hidden'),
  startText: document.querySelector('.hud-start')?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 120),
  app: !!window.__cw, frame: window.__cw ? window.__cw.stats().frame : -1, ready: window.__cw?.ready ?? false,
  msg: document.querySelector('.start-msg')?.textContent, bar: document.querySelector('.start-bar i')?.style.width,
  locked: document.pointerLockElement === document.getElementById('view'),
  top: (() => { const e = document.elementFromPoint(640, 600); return e ? `${e.tagName}#${e.id}.${e.className}` : null; })(),
  hint: document.querySelector('.hud-hint:not(.hidden)')?.textContent ?? null,
  error: document.querySelector('.hud-error:not(.hidden)')?.textContent ?? null,
})).catch((e) => ({ err: e.message }));
await new Promise((r) => setTimeout(r, 4000));
log('before early click', JSON.stringify(await state()));
await page.mouse.click(640, 360);
await new Promise((r) => setTimeout(r, 2000));
log('after early click', JSON.stringify(await state()));
let s;
for (let i = 0; i < 300; i++) {
  s = await state();
  if (s.msg === 'Click to explore') break;
  await new Promise((r) => setTimeout(r, 5000));
}
log('loaded', JSON.stringify(s));
await page.screenshot({ path: `${out}_1_loaded.png` });
await page.mouse.click(640, 360);
await new Promise((r) => setTimeout(r, 3000));
log('after second click', JSON.stringify(await state()));
for (let i = 0; i < 40; i++) {
  s = await state();
  if (s.frame > 30) break;
  await new Promise((r) => setTimeout(r, 5000));
}
log('later', JSON.stringify(s));
await page.screenshot({ path: `${out}_2_after.png`, timeout: 240000 });
// Free the mouse as Esc would: the card should come back and a click should resume.
await page.evaluate(() => document.exitPointerLock());
await new Promise((r) => setTimeout(r, 1500));
log('after unlock', JSON.stringify(await state()));
await new Promise((r) => setTimeout(r, 2000));
await page.mouse.click(640, 360);
await new Promise((r) => setTimeout(r, 2000));
log('after resume click', JSON.stringify(await state()));
await browser.close();
