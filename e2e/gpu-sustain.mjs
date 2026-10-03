// Sustained frame rate at one view: ms/frame in consecutive windows for DURATION_S seconds (shows clock
// throttling under continuous load). Usage: node e2e/gpu-sustain.mjs [baseUrl] "<query>"   (VIEW, WIN_MS=5000, DURATION_S=240, PRE)
import { chromium } from 'playwright-core';

const [base = 'http://localhost:4173', q = 'q=ultra'] = process.argv.slice(2);
const WIN = Number(process.env.WIN_MS || 5000);
const DURATION = Number(process.env.DURATION_S || 240) * 1000;
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
await page.goto(`${base.replace(/\/$/, '')}/?${q}`);
const t0 = Date.now();
while (Date.now() - t0 < 600000) {
  if (await page.evaluate(() => window.__cw?.ready).catch(() => false)) break;
  await new Promise((res) => setTimeout(res, 2000));
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
await page.evaluate(([x, z, yaw, h = 1.7]) => {
  const a = window.__cw.app;
  a.dynRes = null;
  a.setMode('fly');
  const g = a.world.groundHeight(x, z);
  a.camera.position.set(x, (Number.isFinite(g) ? g : 600) + h, z);
  a.fly.yaw = (-yaw * Math.PI) / 180;
  a.fly.pitch = 0;
}, (process.env.VIEW || '-1034,-508,0,1.7').split(',').map(Number));
if (process.env.PRE) await page.evaluate(process.env.PRE);
console.log(`loaded in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
const start = Date.now();
while (Date.now() - start < DURATION) {
  const a = await page.evaluate(() => [window.__cw.stats().frame, performance.now()]);
  await sleep(WIN);
  const b = await page.evaluate(() => [window.__cw.stats().frame, performance.now()]);
  const ms = (b[1] - a[1]) / Math.max(1, b[0] - a[0]);
  console.log(`${new Date().toTimeString().slice(0, 8)} t=${((Date.now() - start) / 1000).toFixed(0)}s ${ms.toFixed(1)} ms/frame (${(1000 / ms).toFixed(1)} fps)`);
}
await ctx.close();
