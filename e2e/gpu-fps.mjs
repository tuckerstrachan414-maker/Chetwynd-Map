// Clean frame-rate measurement (no profiler, no GPU timer queries): average fps over a window at one or
// more views, plus optional on/off experiments measured the same way.
// Usage: node e2e/gpu-fps.mjs [baseUrl] "<query>" [experiments.json]   (WIN_MS=6000, ROUNDS=2, VIEWS='x,z,yaw;...')
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [base = 'http://localhost:4173', q = 'q=ultra', file = ''] = process.argv.slice(2);
const exps = file ? JSON.parse(readFileSync(file, 'utf8')) : [];
const WIN = Number(process.env.WIN_MS || 6000);
const ROUNDS = Number(process.env.ROUNDS || 2);
const ctx = await chromium.launchPersistentContext(process.env.PROFILE_DIR || '', {
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: !process.env.HEADED,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-gpu-vsync', '--disable-frame-rate-limit',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'],
  viewport: { width: Number(process.env.W || 1280), height: Number(process.env.H || 720) },
  deviceScaleFactor: Number(process.env.DPR || 1.5),
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('pageerror', (e) => console.log('pageerror', e.message));
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'log') console.log('console.' + m.type(), m.text().slice(0, 300)); });
await page.goto(`${base.replace(/\/$/, '')}/?${q}`);
const t0 = Date.now();
while (Date.now() - t0 < 600000) {
  const r = await page.evaluate(() => window.__cw?.ready).catch(() => false);
  if (r) break;
  await new Promise((res) => setTimeout(res, 3000));
}
// DYNRES=1 keeps dynamic resolution on (as players run it); otherwise it is off so views compare at a fixed size.
if (!process.env.DYNRES) await page.evaluate(() => { window.__cw.app.dynRes = null; });
if (process.env.PRE) await page.evaluate(process.env.PRE);
await new Promise((res) => setTimeout(res, Number(process.env.SETTLE_MS || 6000)));
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
// Main-thread CPU time per frame over the last window (profiler sections, ms), for telling CPU- from GPU-bound frames.
let lastCpu = '';
const fps = async () => {
  await sleep(500);
  const a = await page.evaluate(() => { window.__cw.app.prof.summary(true); return [window.__cw.stats().frame, performance.now()]; });
  await sleep(WIN);
  const b = await page.evaluate(() => [window.__cw.stats().frame, performance.now()]);
  lastCpu = await page.evaluate(() => {
    const c = window.__cw.app.prof.summary(true).cpu;
    return `cpu ${(c.frame ?? 0).toFixed(1)} [${Object.entries(c).filter(([k]) => k !== 'frame').slice(0, 5).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}]`;
  });
  return (b[1] - a[1]) / Math.max(1, b[0] - a[0]);
};
// After a teleport, wait for the streaming around the new view to finish (up to 45 s).
const settle = async () => {
  const t = Date.now();
  while (Date.now() - t < 45000) {
    const done = await page.evaluate(() => {
      const w = window.__cw.app.world;
      return w.ready && !w.chunks.busy && !w.forest.busy;
    });
    if (done) break;
    await sleep(1000);
  }
  await sleep(Number(process.env.VIEW_SETTLE_MS || 3000));
  return ((Date.now() - t) / 1000).toFixed(0);
};
const views = (process.env.VIEWS || '').split(';').filter(Boolean).map((v) => v.split(',').map(Number));
if (views.length) {
  for (const [x, z, yaw, h = 1.7] of views) {
    await page.evaluate(([x, z, yaw, h]) => {
      const a = window.__cw.app;
      a.setMode('fly');
      const g = a.world.groundHeight(x, z);
      a.camera.position.set(x, (Number.isFinite(g) ? g : 600) + h, z);
      a.fly.yaw = (-yaw * Math.PI) / 180;
      a.fly.pitch = 0;
    }, [x, z, yaw, h]);
    const waited = await settle();
    const ms = await fps();
    const rs = await page.evaluate(() => `${window.__cw.app.post.renderWidth}x${window.__cw.app.post.renderHeight}`);
    console.log(`view ${x},${z} yaw ${yaw} h ${h}: ${ms.toFixed(1)} ms/frame (${(1000 / ms).toFixed(1)} fps)  render ${rs}  ${lastCpu}  (settled ${waited} s)`);
  }
} else {
  const ms = await fps();
  console.log(`baseline: ${ms.toFixed(1)} ms/frame (${(1000 / ms).toFixed(1)} fps)`);
}
for (const e of exps) {
  const A = [], B = [];
  for (let r = 0; r < ROUNDS; r++) {
    A.push(await fps());
    await page.evaluate(e.on).catch((err) => console.log('on failed', e.name, err.message));
    B.push(await fps());
    await page.evaluate(e.off).catch((err) => console.log('off failed', e.name, err.message));
  }
  const a = A.reduce((s, x) => s + x, 0) / A.length, b = B.reduce((s, x) => s + x, 0) / B.length;
  console.log(`${e.name.padEnd(30)} ${a.toFixed(1)} -> ${b.toFixed(1)} ms/frame   (${(1000 / a).toFixed(1)} -> ${(1000 / b).toFixed(1)} fps)`);
}
await ctx.close();
