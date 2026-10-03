// Interleaved A/B timing on a frozen frame (frame loop stopped, GPU timer queries off): each sample renders
// the full frame through the post pipeline and waits for the GPU with a 1-pixel read. Baseline and variant
// samples alternate so drift cancels; medians are reported (ms, sync overhead subtracted).
// Usage: node e2e/gpu-frozen.mjs [baseUrl] "<query>" experiments.json   (N=11 samples each, PRE=<js> after load)
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright-core';

const [base = 'http://localhost:4173', q = 'q=ultra', file = 'e2e/ab-base.json'] = process.argv.slice(2);
const exps = JSON.parse(readFileSync(file, 'utf8'));
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
page.on('console', (m) => { if (m.type() === 'log') console.log(m.text()); });
await page.goto(`${base.replace(/\/$/, '')}/?prof=0&${q}`);
const t0 = Date.now();
while (Date.now() - t0 < 600000) {
  const r = await page.evaluate(() => window.__cw?.ready).catch(() => false);
  if (r) break;
  await new Promise((res) => setTimeout(res, 3000));
}
// VIEW='x,z,yaw,h' places a fly camera there first (as gpu-fps.mjs does).
if (process.env.VIEW) {
  await page.evaluate(([x, z, yaw, h = 1.7]) => {
    const a = window.__cw.app;
    a.setMode('fly');
    const g = a.world.groundHeight(x, z);
    a.camera.position.set(x, (Number.isFinite(g) ? g : 600) + h, z);
    a.fly.yaw = (-yaw * Math.PI) / 180;
    a.fly.pitch = 0;
  }, process.env.VIEW.split(',').map(Number));
}
if (process.env.PRE) await page.evaluate(process.env.PRE);
await new Promise((res) => setTimeout(res, Number(process.env.SETTLE_MS || 8000)));
await page.evaluate(async ({ exps, N }) => {
  const app = window.__cw.app;
  const p = app.prof;
  p.gpuStop?.();
  p.gpu = function (n) { this.gpuName = n; };
  p.gpuStop = function () { this.gpuName = ''; };
  app.dynRes = null;
  const r = app.renderer;
  const gl = r.getContext();
  r.setAnimationLoop(null);
  await new Promise((res) => setTimeout(res, 500));
  const px = new Uint8Array(4);
  const sync = () => {
    r.setRenderTarget(null);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
  };
  const frame = () => app.post.render(app.scene, app.camera, 0.016, 100);
  const once = (fn) => {
    sync();
    const a = performance.now();
    fn();
    sync();
    return performance.now() - a;
  };
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  const idle = med(Array.from({ length: 9 }, () => once(() => {})));
  for (let k = 0; k < 3; k++) once(frame);
  const base = med(Array.from({ length: N }, () => once(frame))) - idle;
  console.log(`idle sync ${idle.toFixed(1)} ms; full frame ${base.toFixed(1)} ms (${(1000 / base).toFixed(1)} fps) at ${app.post.pixelWidth}x${app.post.pixelHeight}`);
  for (const e of exps) {
    const on = new Function(e.on);
    const off = new Function(e.off || '');
    const A = [], B = [];
    try {
      on(); once(frame); once(frame); off(); once(frame); once(frame);
      for (let i = 0; i < N; i++) {
        A.push(once(frame));
        on();
        B.push(once(frame));
        off();
      }
    } catch (err) {
      console.log(`${e.name}: failed ${err.message}`);
      try { off(); } catch { /* ignore */ }
      continue;
    }
    const a = med(A) - idle, b = med(B) - idle;
    console.log(`${e.name.padEnd(28)} ${a.toFixed(1).padStart(7)} -> ${b.toFixed(1).padStart(7)} ms   saves ${(a - b).toFixed(1).padStart(6)} ms`);
  }
}, { exps, N: Number(process.env.N || 11) });
await ctx.close();
