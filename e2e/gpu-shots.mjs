// Screenshots at views after streaming settles. Usage: node e2e/gpu-shots.mjs [baseUrl] "<query>" <outPrefix>   (VIEWS='x,z,yaw,h;...', PRE)
import { chromium } from 'playwright-core';

const [base = 'http://localhost:4173', q = 'q=ultra', out = 'e2e/out/shot'] = process.argv.slice(2);
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
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console.' + m.type(), m.text().slice(0, 300)); });
await page.goto(`${base.replace(/\/$/, '')}/?${q}`);
const t0 = Date.now();
while (Date.now() - t0 < 600000) {
  if (await page.evaluate(() => window.__cw?.ready).catch(() => false)) break;
  await new Promise((res) => setTimeout(res, 2000));
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
await page.evaluate(() => { window.__cw.app.dynRes = null; window.__cw.app.hud?.setVisible?.(false); });
if (process.env.PRE) await page.evaluate(process.env.PRE);
const views = (process.env.VIEWS || '-1034,-508,0,1.7').split(';').filter(Boolean).map((v) => v.split(',').map(Number));
let n = 0;
for (const [x, z, yaw, h = 1.7, pitch = 0] of views) {
  await page.evaluate(([x, z, yaw, h, pitch]) => {
    const a = window.__cw.app;
    a.setMode('fly');
    const g = a.world.groundHeight(x, z);
    a.camera.position.set(x, (Number.isFinite(g) ? g : 600) + h, z);
    a.fly.yaw = (-yaw * Math.PI) / 180;
    a.fly.pitch = (pitch * Math.PI) / 180;
  }, [x, z, yaw, h, pitch]);
  const t = Date.now();
  while (Date.now() - t < 45000) {
    if (await page.evaluate(() => { const w = window.__cw.app.world; return w.ready && !w.chunks.busy && !w.forest.busy; })) break;
    await sleep(1000);
  }
  await sleep(4000);
  const file = `${out}_${n++}.png`;
  await page.screenshot({ path: file });
  console.log('saved', file);
}
await ctx.close();
