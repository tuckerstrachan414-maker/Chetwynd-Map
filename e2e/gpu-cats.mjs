// GPU cost per scene part and per post pass, measured with GPU timer queries while the frame loop is
// stopped: each configuration is rendered K times, each in its own query; disjoint results are dropped
// and the median is reported (ms). "alone" draws only that part (main pass), "shadow" its shadow-map cost.
// Usage: node e2e/gpu-cats.mjs [baseUrl] "<query>"   (PARTS=terrain,forest,... ; K=9)
import { chromium } from 'playwright-core';

const [base = 'http://localhost:4173', q = 'q=ultra'] = process.argv.slice(2);
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
page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 200)); });
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
const out = await page.evaluate(async ({ partsCsv, K }) => {
  const app = window.__cw.app;
  const r = app.renderer;
  const gl = r.getContext();
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
  const scene = app.scene;
  const cam = app.camera;
  const post = app.post;
  r.setAnimationLoop(null);
  await new Promise((res) => setTimeout(res, 300));
  const wait = (ms) => new Promise((res) => setTimeout(res, ms));
  // Time `fn` K times on the GPU; returns the median of the non-disjoint samples (ms).
  const gpuTime = async (fn) => {
    const samples = [];
    for (let attempt = 0; attempt < 4 && samples.length < Math.ceil(K / 2); attempt++) {
      const qs = [];
      for (let k = 0; k < K; k++) {
        const qq = gl.createQuery();
        gl.beginQuery(ext.TIME_ELAPSED_EXT, qq);
        fn();
        gl.endQuery(ext.TIME_ELAPSED_EXT);
        qs.push(qq);
        gl.flush();
      }
      let tries = 0;
      while (!gl.getQueryParameter(qs[qs.length - 1], gl.QUERY_RESULT_AVAILABLE) && tries++ < 400) await wait(10);
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
      for (const qq of qs) {
        if (!disjoint && gl.getQueryParameter(qq, gl.QUERY_RESULT_AVAILABLE)) samples.push(gl.getQueryParameter(qq, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(qq);
      }
    }
    if (!samples.length) return NaN;
    samples.sort((a, b) => a - b);
    return Math.round(samples[Math.floor(samples.length / 2)] * 100) / 100;
  };
  const sceneOnly = () => {
    r.setRenderTarget(post.sceneRT);
    r.clear(true, true, false);
    r.render(scene, cam);
  };
  const res = {};
  r.shadowMap.autoUpdate = true;
  res.fullFrame = await gpuTime(() => post.render(scene, cam, 0.016, 1));
  res.sceneWithShadow = await gpuTime(sceneOnly);
  r.shadowMap.autoUpdate = false;
  res.sceneNoShadow = await gpuTime(sceneOnly);
  // Each shadow cascade on its own (the frame loop redraws 0-1 every frame, 2 every second, 3 every fourth).
  const csm = app.world.csm;
  const dueSaved = [...csm.due];
  res.cascade = [];
  for (let i = 0; i < 4; i++) {
    csm.due.length = 0;
    csm.due.push(i);
    r.shadowMap.autoUpdate = true;
    res.cascade.push(Math.round((await gpuTime(sceneOnly) - res.sceneNoShadow) * 100) / 100);
  }
  csm.due.length = 0;
  csm.due.push(...dueSaved);
  res.dueLastFrame = dueSaved.join(',');
  r.shadowMap.autoUpdate = false;
  // Post passes one by one.
  const label = (m, n) => { if (m) m.name = n; };
  label(post.composite, 'composite');
  label(post.final, 'final');
  for (const [k, n] of [['mAO', 'ao'], ['mAOBlur', 'aoBlur'], ['mLum', 'lum'], ['mAdapt', 'adapt'], ['mDown', 'bloomDown'], ['mUp', 'bloomUp'], ['mFxaa', 'fxaa'], ['mCopyColor', 'copyColor'], ['mCopyDepth', 'copyDepth'], ['mDof', 'dof']]) label(post[k], n);
  const passList = [];
  const origPass = post.pass.bind(post);
  post.pass = (mat, target) => { passList.push([mat, target]); origPass(mat, target); };
  post.render(scene, cam, 0.016, 1);
  post.pass = origPass;
  const passT = {};
  // Resolve once, then time each pass in isolation (the inputs are already in place).
  for (const [mat, target] of passList) {
    const t = await gpuTime(() => origPass(mat, target));
    passT[mat.name || '?'] = Math.round(((passT[mat.name || '?'] ?? 0) + t) * 100) / 100;
  }
  res.postPasses = passT;
  // MSAA resolve of the scene target (colour + depth), as the first read after a scene render does.
  res.resolve = await gpuTime(() => {
    r.setRenderTarget(post.sceneRT);
    r.clear(true, true, false);
    r.setRenderTarget(null);
  });
  // Each part alone, main pass then its shadow casters.
  const kids = scene.children;
  const nameOf = (o) => o.name || o.type;
  const saved = kids.map((o) => o.visible);
  const alone = {};
  const shadow = {};
  r.shadowMap.autoUpdate = false;
  kids.forEach((o) => (o.visible = false));
  alone.empty = await gpuTime(sceneOnly);
  for (const name of partsCsv.split(',')) {
    kids.forEach((o, i) => (o.visible = nameOf(o) === name ? saved[i] : false));
    kids.forEach((o) => { if (o.isDirectionalLight || o.isLight || o === app.world.sun || o === app.world.sun.target) o.visible = true; });
    r.shadowMap.autoUpdate = false;
    const a = await gpuTime(sceneOnly);
    r.shadowMap.autoUpdate = true;
    const b = await gpuTime(sceneOnly);
    alone[name] = Math.round((a - alone.empty) * 100) / 100;
    shadow[name] = Math.round((b - a) * 100) / 100;
  }
  kids.forEach((o, i) => (o.visible = saved[i]));
  res.alone = alone;
  res.children = kids.map((o) => `${nameOf(o)}${o.visible ? '' : '(hidden)'}`).join(',');
  res.shadow = shadow;
  res.px = `${post.pixelWidth}x${post.pixelHeight}`;
  r.info.reset();
  r.shadowMap.autoUpdate = true;
  sceneOnly();
  res.info = { calls: r.info.render.calls, tris: r.info.render.triangles };
  return res;
}, { partsCsv: process.env.PARTS || 'terrain,chunks,roads,props,fences,carvings,forest,grass,water,sky', K: Number(process.env.K || 9) });
console.log(JSON.stringify(out, null, 1));
await ctx.close();
