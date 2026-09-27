import type { StyleSpecification, SymbolLayerSpecification } from 'maplibre-gl';

export const MOCK_ORIGIN = 'https://api.tomtom.com';

/**
 * A minimal stand-in for TomTom's Orbis map style: the same source IDs the SDK modules
 * look for (`vectorTiles`, `vectorTilesFlow`, `vectorTilesIncidents`) and the layer IDs it
 * anchors its own layers to (`mapStyleLayerIDs`, the POI layers), with empty tiles behind them.
 */
export const mockStyle = (): StyleSpecification => {
    const tiles = (name: string) => [`${MOCK_ORIGIN}/mock/tiles/${name}/{z}/{x}/{y}.pbf`];
    const label = (id: string): SymbolLayerSpecification => ({
        id,
        type: 'symbol',
        source: 'vectorTiles',
        'source-layer': 'place_labels',
        layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto-Regular'] },
    });
    return {
        version: 8,
        name: 'Mock Orbis style',
        glyphs: `${MOCK_ORIGIN}/mock/glyphs/{fontstack}/{range}.pbf`,
        sources: {
            vectorTiles: { type: 'vector', tiles: tiles('base'), maxzoom: 14 },
            vectorTilesFlow: { type: 'vector', tiles: tiles('flow'), maxzoom: 14 },
            vectorTilesIncidents: { type: 'vector', tiles: tiles('incidents'), maxzoom: 14 },
        },
        layers: [
            { id: 'background', type: 'background', paint: { 'background-color': '#e9efe6' } },
            {
                id: 'Buildings - Underground',
                type: 'fill',
                source: 'vectorTiles',
                'source-layer': 'buildings',
                paint: { 'fill-color': '#d4d4d4' },
            },
            {
                id: 'Tunnel - Railway outline',
                type: 'line',
                source: 'vectorTiles',
                'source-layer': 'railways',
                paint: { 'line-color': '#999999' },
            },
            {
                id: 'Traffic flow - line',
                type: 'line',
                source: 'vectorTilesFlow',
                'source-layer': 'Traffic flow',
                layout: { visibility: 'none' },
                paint: { 'line-color': '#e53935' },
            },
            {
                id: 'Traffic incidents - line',
                type: 'line',
                source: 'vectorTilesIncidents',
                'source-layer': 'Traffic incidents',
                layout: { visibility: 'none' },
                paint: { 'line-color': '#fb8c00' },
            },
            {
                id: 'Traffic incidents - icon',
                type: 'symbol',
                source: 'vectorTilesIncidents',
                'source-layer': 'Traffic incidents POI',
                layout: { visibility: 'none', 'icon-image': ['get', 'icon_category'] },
            },
            label('Borders - Treaty label'),
            label('Places - Village / Hamlet'),
            label('Places - Country name'),
            {
                id: 'POI',
                type: 'symbol',
                source: 'vectorTiles',
                'source-layer': 'poi',
                layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto-Regular'] },
            },
            {
                id: 'POI - Micro',
                type: 'symbol',
                source: 'vectorTiles',
                'source-layer': 'poi',
                layout: { 'text-field': ['get', 'name'], 'text-font': ['Noto-Regular'] },
            },
        ],
    };
};
