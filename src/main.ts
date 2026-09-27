import { App } from './app/App';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLDivElement;

function fatal(msg: string): void {
  const box = document.createElement('div');
  box.style.cssText = 'position:absolute;inset:0;display:grid;place-items:center;padding:24px;text-align:center;font:16px/1.5 system-ui,sans-serif;color:#eee;background:#111';
  box.innerHTML = '<div style="max-width:560px"><h2 style="margin:0 0 8px">Chetwynd 3D could not start</h2><p class="m"></p></div>';
  (box.querySelector('.m') as HTMLElement).textContent = msg;
  ui.replaceChildren(box);
}

// WebGL 2 is required (every current desktop browser has it, unless hardware acceleration is off).
if (!document.createElement('canvas').getContext('webgl2')) {
  fatal('Your browser did not provide WebGL 2. Turn on hardware acceleration (Chrome/Edge: Settings > System > "Use graphics acceleration when available"), update the browser, then reload.');
} else {
  let app: App | null = null;
  try {
    app = new App(canvas, ui);
  } catch (err) {
    console.error(err);
    fatal(`The 3D renderer could not be created: ${String(err)}`);
  }
  if (app) {
    const a = app;
    window.addEventListener('error', (e) => a.showError(e.error ?? e.message));
    window.addEventListener('unhandledrejection', (e) => a.showError(e.reason));
    a.start().catch((err) => {
      console.error(err);
      fatal(`Loading failed: ${String(err)}`);
    });
  }
}
