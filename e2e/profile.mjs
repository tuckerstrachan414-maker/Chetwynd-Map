// Frame profile at fixed viewpoints: main-thread CPU by section, draw calls by pass and scene part,
// triangles and shader programs (GPU timings need a real GPU; SwiftShader has no timer queries).
// Usage: node e2e/profile.mjs <baseUrl> "<query1>" ["<query2>" ...]   (e.g. a `vite preview` URL)
import { chromium } from 'playwright-core';

const [base = 'http://localhost:4173', ...queries] = process.argv.slice(2);
const FRAMES = Number(process.env.PROF_FRAMES || 12);
const browser = await chromium.launch({
  executablePath: process.env.CHROME || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--enable-webgl', '--disable-gpu-sandbox'],
});
const page = await browser.newPage({ viewport: { width: Number(process.env.PROF_W || 1280), height: Number(process.env.PROF_H || 720) } });
page.on('pageerror', (e) => console.log('pageerror', e.message));
for (const q of queries) {
  const t0 = Date.now();
  await page.goto(`${base.replace(/\/$/, '')}/?headless=1&prof=0&${q}`);
  while (Date.now() - t0 < 900000) {
    const ready = await page.evaluate(() => window.__cw?.ready).catch(() => false);
    if (ready) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  const f0 = await page.evaluate(() => { window.__cw.app.prof.summary(true); return window.__cw.stats().frame; });
  while ((await page.evaluate(() => window.__cw.stats().frame)) < f0 + FRAMES) await new Promise((r) => setTimeout(r, 2000));
  const s = await page.evaluate(() => window.__cw.app.prof.summary(false));
  const drawTotal = Object.values(s.draws).reduce((a, b) => a + b, 0);
  console.log(`\n=== ${q}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  console.log(`frames ${s.frames}  draws ${Math.round(drawTotal)}  tris ${(s.tris / 1e6).toFixed(2)} M  programs ${s.programs}`);
  console.log('cpu ms', JSON.stringify(s.cpu));
  console.log('draws', JSON.stringify(Object.fromEntries(Object.entries(s.draws).map(([k, v]) => [k, Math.round(v)]))));
  console.log('ktris', JSON.stringify(Object.fromEntries(Object.entries(s.trisBy ?? {}).map(([k, v]) => [k, Math.round(v / 1000)]))));
}
await browser.close();
