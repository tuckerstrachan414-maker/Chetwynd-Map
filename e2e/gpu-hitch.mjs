// Long frames during the in-game benchmark, with what happened in them (CPU sections, streaming installs,
// buffer/texture uploads, new shader programs, render-size changes).
// Usage: node e2e/gpu-hitch.mjs [baseUrl] "<query>"   (through e2e/with-preview.mjs)
//   VSYNC=1 / LITE=1 as in gpu-bench.mjs; NOQUERY=1 no GPU timer queries and a fixed render scale; HITCH_MS=120
import { chromium } from 'playwright-core';
const [base = 'http://localhost:4173', extra = 'q=ultra'] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-webgl',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ...(process.env.VSYNC ? [] : ['--disable-gpu-vsync', '--disable-frame-rate-limit'])],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
page.on('console', (m) => { if (m.text().startsWith('HITCH')) console.log(m.text()); });
await page.goto(`${base}/?bench=70&${extra}`);
const t0 = Date.now();
while (Date.now() - t0 < 600000) {
  if (await page.evaluate(() => !!window.__cw?.app?.bench).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 300));
}
if (process.env.LITE) await page.evaluate(() => { window.__cw.app.prof.detailed = false; });
// NOQUERY=1: no GPU timer queries (profiler and dynamic resolution) and a fixed render scale.
if (process.env.NOQUERY) await page.evaluate(() => { const a = window.__cw.app; a.prof.ext = null; a.prof.timeFrames = false; a.dynRes = null; a.post.setRenderScale(0.75); });
await page.evaluate((ms) => { window.__hitchMs = ms; }, Number(process.env.HITCH_MS || 120));
await page.evaluate(() => {
  const a = window.__cw.app;
  const w = a.world;
  const ev = { chunk: 0, chunkVerts: 0, veg: 0, tile: 0, scale: 0, upload: 0, uploadBytes: 0, sub: 0, subBytes: 0, tex: 0, near: 0 };
  window.__ev = ev;
  const wrap = (obj, name, f) => { const o = obj[name].bind(obj); obj[name] = (...x) => f(o, x); };
  wrap(w.chunks, 'install', (o, x) => { ev.chunk++; const n = o(...x); ev.chunkVerts += n; return n; });
  wrap(w.forest, 'install', (o, x) => { ev.veg++; return o(...x); });
  wrap(w.store, 'onLoaded', (o, x) => { ev.tile++; return o(...x); });
  wrap(a.post, 'setRenderScale', (o, x) => { ev.scale++; return o(...x); });
  const gl = a.renderer.getContext();
  const bd = gl.bufferData.bind(gl);
  gl.bufferData = (t, d, u, ...r) => { ev.upload++; ev.uploadBytes += typeof d === 'number' ? d : d?.byteLength ?? 0; return bd(t, d, u, ...r); };
  const bs = gl.bufferSubData.bind(gl);
  gl.bufferSubData = (t, o, d, so, len) => { ev.sub++; ev.subBytes += len !== undefined ? len * (d.BYTES_PER_ELEMENT || 1) : d.byteLength; return len !== undefined ? bs(t, o, d, so, len) : so !== undefined ? bs(t, o, d, so) : bs(t, o, d); };
  for (const f of ['texSubImage2D', 'texSubImage3D', 'texImage2D', 'texImage3D']) { const o = gl[f].bind(gl); gl[f] = (...x) => { ev.tex++; return o(...x); }; }
  wrap(w.forest, 'updateNear', (o, x) => { ev.near++; return o(...x); });
  let last = performance.now();
  let progs = a.renderer.info.programs.length;
  const loop = () => {
    const now = performance.now();
    const ms = now - last;
    last = now;
    const p = a.renderer.info.programs.length;
    window.__nf = (window.__nf ?? 0) + 1;
    if (a.bench && a.bench.t > 0 && ms <= 120 && window.__nf % 40 === 0) console.log(`HITCH-normal ${ms.toFixed(0)} ms subData ${ev.sub} (${(ev.subBytes / 1e6).toFixed(2)} MB) tex ${ev.tex} nearRebuild ${ev.near}`);
    if (ms > window.__hitchMs && a.bench && a.bench.t > 0) {
      const cpu = [...a.prof.cpuFrame].sort((x, y) => y[1] - x[1]).slice(0, 6).map(([k, v]) => `${k} ${v.toFixed(0)}`).join(' ');
      const spd = a.bench.lastPos ? a.camera.position.distanceTo(a.bench.lastPos) / (ms / 1000) : 0;
      console.log(`HITCH ${ms.toFixed(0)} ms t=${a.bench.t.toFixed(1)} speed ${spd.toFixed(0)} m/s [${cpu}] programs+${p - progs} chunks ${ev.chunk} (${ev.chunkVerts} v) veg ${ev.veg} tiles ${ev.tile} scale ${ev.scale} bufferData ${ev.upload} (${(ev.uploadBytes / 1e6).toFixed(1)} MB) subData ${ev.sub} (${(ev.subBytes / 1e6).toFixed(2)} MB) tex ${ev.tex} nearRebuild ${ev.near} cam ${a.camera.position.toArray().map((v) => v.toFixed(0)).join(',')}`);
    }
    progs = p;
    a.bench.lastPos = (a.bench.lastPos ?? a.camera.position.clone()).copy(a.camera.position);
    for (const k in ev) ev[k] = 0;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
});
while (Date.now() - t0 < 900000) {
  if (await page.evaluate(() => !!window.__cw?.app?.bench?.result).catch(() => false)) break;
  await new Promise((r) => setTimeout(r, 2000));
}
const res = await page.evaluate(() => window.__cw.app.bench.result);
console.log(`${res.avgFps} fps avg, ${res.low1} 1% low, worst ${res.worstMs} ms`);
await browser.close();
