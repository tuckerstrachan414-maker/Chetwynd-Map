// Run the in-game benchmark (?bench) in a local Chrome on the real GPU and print the report.
// Usage: node e2e/gpu-bench.mjs [baseUrl] ["<extra query>"]   (run through e2e/with-preview.mjs)
//   CHROME=path/to/chrome  HEADED=1 (show the window)  BENCH_S=70  W=1280 H=720 DPR=1.5
//   VSYNC=1     pace frames like a normal browser (otherwise uncapped: shows headroom, but the page
//               can queue several frames ahead of the GPU, which inflates the 1 % lows)
//   LITE=1      GPU timing as in play (one whole-frame query for dynamic resolution, not one per pass)
//   NODYN=1     no dynamic resolution (always the full render size)
//   PROFILE_DIR keep a browser profile (and its GPU shader cache) between runs
// As players run it: VSYNC=1 LITE=1 PROFILE_DIR=...
import { chromium } from 'playwright-core';

const [base = 'http://localhost:4173', extra = 'q=ultra'] = process.argv.slice(2);
const secs = Number(process.env.BENCH_S || 70);
// PROFILE_DIR keeps a browser profile between runs: its GPU shader cache, as a player's browser has
// after the first visit (a fresh profile compiles Direct3D shader variants during the route).
const opts = {
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: !process.env.HEADED,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    // VSYNC=1 paces frames like a normal browser; otherwise frames are uncapped (shows headroom above the display rate).
    ...(process.env.VSYNC ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit'])],
};
const view = { viewport: { width: Number(process.env.W || 1280), height: Number(process.env.H || 720) }, deviceScaleFactor: Number(process.env.DPR || 1.5) };
const browser = process.env.PROFILE_DIR ? await chromium.launchPersistentContext(process.env.PROFILE_DIR, { ...opts, ...view }) : await chromium.launch(opts);
const page = process.env.PROFILE_DIR ? (browser.pages()[0] ?? (await browser.newPage())) : await browser.newPage(view);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); if (m.text().startsWith('shaders ready')) console.log(m.text()); });
const t0 = Date.now();
await page.goto(`${base.replace(/\/$/, '')}/?bench=${secs}&${extra}`);
const gpu = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return { renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER), timer: !!gl.getExtension('EXT_disjoint_timer_query_webgl2') };
});
console.log('GPU', JSON.stringify(gpu));
// LITE=1: GPU timing as in normal play (one whole-frame query feeding dynamic resolution), not per pass.
if (process.env.LITE) {
  while (!(await page.evaluate(() => !!window.__cw?.app?.prof).catch(() => false))) await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => { window.__cw.app.prof.detailed = false; });
}
// NODYN=1: no dynamic resolution (the scene always renders at the output size).
if (process.env.NODYN) {
  while (!(await page.evaluate(() => !!window.__cw?.app?.post).catch(() => false))) await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => { const a = window.__cw.app; a.dynRes = null; a.post.setRenderScale(1); });
  await new Promise((r) => setTimeout(r, 5000));
  await page.evaluate(() => { const a = window.__cw.app; a.dynRes = null; a.post.setRenderScale(1); });
}
let res = null;
let lastLog = 0;
while (Date.now() - t0 < Number(process.env.TIMEOUT_S || 900) * 1000) {
  res = await page.evaluate(() => window.__cw?.app?.bench?.result ?? null).catch(() => null);
  if (res) break;
  if (Date.now() - lastLog > 10000) {
    lastLog = Date.now();
    const st = await page.evaluate(() => {
      const s = window.__cw?.stats();
      return s ? { frame: s.frame, fps: s.fps, calls: s.calls, cam: s.cam, chunks: s.chunks, forest: s.forest, terrain: s.terrain } : null;
    }).catch((e) => e.message);
    console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, JSON.stringify(st));
  }
  await new Promise((r) => setTimeout(r, 2000));
}
if (!res) {
  console.log('timeout', JSON.stringify(await page.evaluate(() => window.__cw?.stats()).catch(() => null)));
} else {
  console.log(`load+bench ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const p = res.profile;
  const top = (o, n = 14) => Object.entries(o ?? {}).slice(0, n).map(([k, v]) => `${k} ${(+v).toFixed(2)}`).join(', ');
  console.log(`${res.avgFps} fps avg, ${res.low1} 1% low, ${res.low01} 0.1% low, worst ${res.worstMs} ms, ${res.frames} frames, ${res.resolution}, ${res.quality}`);
  console.log('legs', JSON.stringify(res.legs));
  if (p) {
    console.log(`CPU ${top(p.cpu)}`);
    if (p.gpu) console.log(`GPU total ${Object.values(p.gpu).reduce((a, b) => a + b, 0).toFixed(2)}: ${top(p.gpu)}`);
    console.log(`draws ${Math.round(Object.values(p.draws).reduce((a, b) => a + b, 0))}: ${top(p.draws, 20)}`);
    console.log(`tris ${(p.tris / 1e6).toFixed(2)} M: ${Object.entries(p.trisBy ?? {}).slice(0, 14).map(([k, v]) => `${k} ${Math.round(v / 1000)}k`).join(', ')}`);
    console.log(`programs ${p.programs}; long frames ${p.hitches.length}: ${p.hitches.slice(0, 12).map((h) => `${h.ms}ms@${h.t}s(${h.what})`).join('; ')}`);
  }
}
if (errors.length) console.log('errors:\n' + errors.slice(0, 20).join('\n'));
await browser.close();
