// Run an e2e script against a `vite preview` of the current build, started for the run and stopped after.
// Usage: node e2e/with-preview.mjs <script.mjs> [args after the base URL...]
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';

const [script, ...rest] = process.argv.slice(2);
const port = Number(process.env.PREVIEW_PORT || 4173);
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--port', String(port), '--strictPort'], {
  stdio: 'ignore',
});
const up = () => new Promise((res) => {
  const s = createConnection(port, '127.0.0.1');
  s.on('connect', () => { s.end(); res(true); });
  s.on('error', () => res(false));
});
const t0 = Date.now();
while (!(await up())) {
  if (Date.now() - t0 > 30000) { console.error('preview server did not start'); server.kill(); process.exit(1); }
  await new Promise((r) => setTimeout(r, 250));
}
const child = spawn(process.execPath, [script, `http://localhost:${port}`, ...rest], { stdio: 'inherit', env: process.env });
const code = await new Promise((res) => child.on('exit', res));
server.kill();
process.exit(code ?? 0);
