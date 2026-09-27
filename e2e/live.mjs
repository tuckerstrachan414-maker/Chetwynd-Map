// Open the deployed site (GitHub Pages) headless, wait for the world to be ready, save a PNG.
// Usage: node e2e/live.mjs <out.png> ["<query>"] [url]
import { chromium } from 'playwright-core';

const [out = 'e2e/out/live.png', q = 'at=-880,-790&yaw=75&h=1.7&t=14', url = 'https://tuckerstrachan414-maker.github.io/Chetwynd-Map/'] = process.argv.slice(2);
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'],
  ...(proxy ? { proxy: { server: proxy } } : {}),
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(e.message));
page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`));
page.on('response', (r) => { if (r.status() >= 400) errors.push(`HTTP ${r.status()} ${r.url()}`); });
const t0 = Date.now();
await page.goto(`${url}?headless=1&${q}`);
let ok = false;
while (Date.now() - t0 < 540000) {
  const st = await page.evaluate(() => (window.__cw ? { ready: window.__cw.ready } : null)).catch(() => null);
  if (st?.ready) { ok = true; break; }
  await new Promise((r) => setTimeout(r, 5000));
}
await page.screenshot({ path: out, timeout: 240000 });
const stats = await page.evaluate(() => window.__cw?.stats()).catch(() => null);
console.log(ok ? 'ready' : 'timeout', ((Date.now() - t0) / 1000).toFixed(0) + 's', JSON.stringify(stats)?.slice(0, 300));
if (errors.length) console.log('errors:\n' + errors.slice(0, 20).join('\n'));
await browser.close();
