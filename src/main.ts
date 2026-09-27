import { setWorkerUrl } from 'maplibre-gl';
import maplibreCss from 'maplibre-gl/dist/maplibre-gl.css?inline';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './styles.css';
import { normalizeApiKey, resolveApiKey } from './apiKey';
import { startApp } from './app';
import { byId } from './dom';
import { promptForApiKey } from './ui/keyDialog';

// MapLibre GL v6 finds its web worker next to its own module at runtime, a path bundlers
// can't see. Bundle the worker explicitly and hand MapLibre its URL instead.
setWorkerUrl(maplibreWorkerUrl);

// MapLibre's stylesheet ships with the app instead of from a CDN. It goes in as an inline
// <style> ahead of our own CSS: the TomTom SDK looks for it there and otherwise fetches a
// copy from unpkg.com at runtime.
const maplibreStyle = document.createElement('style');
maplibreStyle.dataset.source = 'maplibre-gl';
maplibreStyle.textContent = maplibreCss;
document.head.prepend(maplibreStyle);

const buildKey = normalizeApiKey(import.meta.env.VITE_TOMTOM_API_KEY);
const hasBuildKey = buildKey !== undefined;

const boot = async () => {
    let apiKey = resolveApiKey(buildKey);
    if (!apiKey) {
        const entered = await promptForApiKey({ hasBuildKey });
        apiKey = entered ? { key: entered, source: 'user' } : resolveApiKey(buildKey);
    }
    if (!apiKey) return;
    await startApp({ apiKey, hasBuildKey });
};

boot().catch((error: unknown) => {
    console.error(error);
    const message = byId('fatal-error');
    message.hidden = false;
    message.textContent =
        'The map couldn’t start. Check your connection and reload the page. If it keeps happening, your browser may not support WebGL.';
});
