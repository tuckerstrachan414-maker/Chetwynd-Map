// Load one view, wait until it is ready, then evaluate page expressions and print the results.
// Usage: node e2e/probe.mjs <baseUrl> "<query>" "<js expr>" ["<js expr>" ...]
import { chromium } from 'playwright-core';

const [base = 'http://localhost:4173', q = '', ...exprs] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
const t0 = Date.now();
await page.goto(`${base.replace(/\/$/, '')}/?headless=1&${q}`);
while (Date.now() - t0 < 900000) {
  if (await page.evaluate(() => window.__cw?.ready).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 4000));
}
for (const e of exprs) {
  const r = await page.evaluate(e).catch((err) => `error: ${err.message}`);
  console.log(`> ${e.slice(0, 100)}\n${typeof r === 'string' ? r : JSON.stringify(r, null, 1)}`);
}
await browser.close();
