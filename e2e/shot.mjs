// Headless screenshot tool: starts Vite, opens the app in Chromium (SwiftShader WebGL2),
// waits for window.__cw.ready and saves PNGs.
// Usage: node e2e/shot.mjs <outDir> "<query1>" ["<query2>" ...]
import { chromium } from 'playwright-core';
import { createServer } from 'vite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [outDir = 'e2e/out', ...queries] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const W = Number(process.env.SHOT_W || 1280);
const H = Number(process.env.SHOT_H || 720);

const server = await createServer({ server: { port: 5199 + Math.floor(Math.random() * 500), host: '127.0.0.1', strictPort: false }, logLevel: 'error' });
await server.listen();
const base = server.resolvedUrls.local[0].replace(/\/$/, '');
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('console', (m) => {
  if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  if (process.env.SHOT_LOG) console.log(`[page ${m.type()}] ${m.text()}`);
});
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
let idx = 0;
for (const q of queries.length ? queries : ['']) {
  const url = `${base}/?headless=1&${q}`;
  const t0 = Date.now();
  await page.goto(url);
  const limit = Number(process.env.SHOT_TIMEOUT || 540000);
  let ok = false;
  while (Date.now() - t0 < limit) {
    const st = await page.evaluate(() => window.__cw ? { ready: window.__cw.ready, ...window.__cw.stats() } : null).catch(() => null);
    if (process.env.SHOT_PROGRESS) console.log(`  t=${((Date.now() - t0) / 1000).toFixed(0)}s`, JSON.stringify(st));
    if (st && st.ready) { ok = true; break; }
    await new Promise((r) => setTimeout(r, 5000));
  }
  if (!ok) console.log('  (timeout: capturing anyway)');
  const stats = await page.evaluate(() => window.__cw.stats && window.__cw.stats());
  const file = join(outDir, `${String(idx++).padStart(2, '0')}_${q.replace(/[^a-z0-9=,.-]+/gi, '_').slice(0, 80) || 'default'}.png`);
  await page.screenshot({ path: file });
  console.log(`${file}  ${((Date.now() - t0) / 1000).toFixed(1)}s  ${JSON.stringify(stats)}`);
}
if (errors.length) console.log('--- console errors/warnings ---\n' + errors.slice(0, 50).join('\n'));
await browser.close();
await server.close();
