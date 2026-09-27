import { App } from './app/App';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ui = document.getElementById('ui') as HTMLDivElement;

const app = new App(canvas, ui);
app.start().catch((err) => {
  console.error(err);
  ui.innerHTML = `<div style="padding:24px">Failed to start: ${String(err)}</div>`;
});
