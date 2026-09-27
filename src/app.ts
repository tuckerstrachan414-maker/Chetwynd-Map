import type { Place } from '@tomtom-org/maps-sdk/core';
import { TomTomConfig } from '@tomtom-org/maps-sdk/core';
import { PlacesModule, POIsModule, poiLayerIDs, TomTomMap } from '@tomtom-org/maps-sdk/map';
import { placeById, reverseGeocode } from '@tomtom-org/maps-sdk/services';
import { GeolocateControl, type LngLat as MapLibreLngLat, NavigationControl, ScaleControl } from 'maplibre-gl';
import type { ResolvedApiKey } from './apiKey';
import { type BBox, CHETWYND_BOUNDS, LANGUAGE, type LngLat } from './config';
import type { AppContext, ShowPlaceOptions } from './context';
import { byId } from './dom';
import { describeError, httpStatusOf, isAbortError, isAuthError } from './errors';
import { createDirections } from './features/directions';
import { createDriveTime } from './features/driveTime';
import { createExplore } from './features/explore';
import { initialMapStyle, setupStyleSwitcher, setupTrafficToggles } from './features/mapControls';
import { renderPlaceCard } from './features/placeCard';
import { createSearchBox } from './features/search';
import { placePosition, pointPlace } from './geo';
import { promptForApiKey } from './ui/keyDialog';
import { createPanel } from './ui/panel';
import { toast } from './ui/toast';

type StartOptions = { apiKey: ResolvedApiKey; hasBuildKey: boolean };
type Padding = { top: number; right: number; bottom: number; left: number };

/** Any SDK map module: each one owns the MapLibre sources it draws from. */
type MapModule = { readonly sourceAndLayerIDs: Record<string, { sourceID: string }> };

/** Pixels around a click in which a pin or route counts as hit (the SDK's own default is 5). */
const HIT_TOLERANCE_PX = 6;
const PHONE_LAYOUT = '(max-width: 720px)';

export const startApp = async ({ apiKey, hasBuildKey }: StartOptions): Promise<void> => {
    TomTomConfig.instance.put({ apiKey: apiKey.key, language: LANGUAGE });

    const mapElement = byId('map');
    const panelElement = byId('panel');
    const toolbarElement = byId('map-toolbar');
    const placeView = byId('view-place');
    const panel = createPanel();

    /**
     * Room to leave around fitted content, measured from what covers the map: the panel (left on
     * desktop, a bottom sheet on phones), the toolbar along the top and MapLibre's controls.
     */
    const viewPadding = (): Padding => {
        const edge = 24;
        const map = mapElement.getBoundingClientRect();
        const covering = panelElement.getBoundingClientRect();
        const toolbar = toolbarElement.getBoundingClientRect();
        const controls = mapElement.querySelector('.maplibregl-ctrl-top-right')?.getBoundingClientRect();
        const phone = window.matchMedia(PHONE_LAYOUT).matches;
        // Pins stand above their point and are about as wide as they are tall.
        const pinHeight = 44;
        const pinHalfWidth = 24;
        const top = Math.max(0, toolbar.bottom - map.top) + edge + pinHeight;
        const right = (controls ? Math.max(0, map.right - controls.left) : 48) + edge + pinHalfWidth;
        const bottom = (phone ? Math.max(0, map.bottom - covering.top) : 0) + edge;
        const left = (phone ? 0 : Math.max(0, covering.right - map.left)) + edge + pinHalfWidth;
        // Always leave at least a fifth of the map for the content itself.
        const fitX = Math.min(1, (map.width * 0.8) / (left + right));
        const fitY = Math.min(1, (map.height * 0.8) / (top + bottom));
        return { top: top * fitY, right: right * fitX, bottom: bottom * fitY, left: left * fitX };
    };

    const style = initialMapStyle();
    const map = new TomTomMap({
        style,
        mapLibre: {
            container: mapElement,
            bounds: CHETWYND_BOUNDS,
            fitBoundsOptions: { padding: viewPadding() },
            maxPitch: 70,
        },
    });
    const mapLibre = map.mapLibreMap;
    mapLibre.addControl(new NavigationControl({ visualizePitch: true }), 'top-right');
    mapLibre.addControl(
        new GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }),
        'top-right',
    );
    mapLibre.addControl(new ScaleControl({ unit: 'metric' }), 'bottom-right');
    setupStyleSwitcher(map, style);
    let mapReady = false;

    // ── Errors and the API key ───────────────────────────────────────────────
    let keyPromptOpen = false;
    const askForNewKey = async (reason?: string) => {
        if (keyPromptOpen) return;
        keyPromptOpen = true;
        await promptForApiKey({ reason, hasBuildKey });
        // The map style and tiles were requested with the old key; start over with the new one.
        window.location.reload();
    };
    const reportError = (error: unknown, doing: string) => {
        if (isAbortError(error)) return;
        if (isAuthError(error)) {
            void askForNewKey(
                `TomTom rejected the ${apiKey.source === 'build' ? 'site’s' : 'saved'} API key (HTTP ${httpStatusOf(error)}). ` +
                    'Check that it is active and allowed for this website.',
            );
            return;
        }
        console.error(error);
        toast(describeError(error, doing), 'error');
    };
    // Leaving or reloading the page aborts in-flight tile and sprite requests; those aren't errors.
    let leavingPage = false;
    window.addEventListener('pagehide', () => {
        leavingPage = true;
    });
    window.addEventListener('pageshow', () => {
        leavingPage = false;
    });
    // Style, sprite and tile requests fail here rather than in a service call.
    mapLibre.on('error', (event) => {
        if (leavingPage) return;
        if (isAuthError(event.error)) {
            reportError(event.error, 'loading the map');
            return;
        }
        console.error('Map error:', event.error);
        if (!mapReady) {
            // Nothing loads before the style does, so an early failure means the map can't start.
            const message = byId('fatal-error');
            message.textContent = 'Couldn’t load the TomTom map. Check your internet connection, then reload the page.';
            message.hidden = false;
        }
    });
    byId('change-key').addEventListener('click', () => void askForNewKey());

    // ── Camera helpers ───────────────────────────────────────────────────────
    const fitBounds = (bbox: BBox, options: { maxZoom?: number } = {}) => {
        mapLibre.fitBounds(bbox, { padding: viewPadding(), maxZoom: options.maxZoom ?? 17, duration: 800 });
    };
    const flyTo = (position: LngLat, zoom = 16) => {
        // Centre in the uncovered area with `offset`: a `padding` option would stay on the map
        // and be added to every later fitBounds padding.
        const { top, right, bottom, left } = viewPadding();
        mapLibre.flyTo({ center: position, zoom, offset: [(left - right) / 2, (top - bottom) / 2], duration: 900 });
    };
    const isInView = (position: LngLat): boolean => {
        const point = mapLibre.project(position);
        const { top, right, bottom, left } = viewPadding();
        const { clientWidth: width, clientHeight: height } = mapLibre.getContainer();
        return point.x >= left && point.x <= width - right && point.y >= top && point.y <= height - bottom;
    };

    // Order matters: modules created later draw on top and get pointer events first.
    const pois = await POIsModule.get(map);
    const selection = await PlacesModule.create(map, { theme: 'pin' });

    let selected: Place | undefined;
    const ctx: AppContext = {
        map,
        panel,
        async showPlace(place: Place, { fly = 'if-hidden', fromResults = false }: ShowPlaceOptions = {}) {
            selected = place;
            if (fromResults) {
                await selection.clear();
                explore.highlight(place);
            } else {
                explore.highlight(undefined);
                await selection.show(place);
            }
            if (selected !== place) return;
            renderPlaceCard(placeView, place, placeActions);
            panel.showPlaceView();
            const position = placePosition(place);
            if (fly === 'always' || (fly === 'if-hidden' && !isInView(position))) {
                flyTo(position, Math.max(mapLibre.getZoom(), 15));
            }
        },
        async clearSelection() {
            selected = undefined;
            explore.highlight(undefined);
            panel.closePlaceView();
            await selection.clear();
        },
        fitBounds,
        flyTo,
        reportError,
    };

    const explore = await createExplore(ctx);
    const directions = await createDirections(ctx);
    const driveTime = await createDriveTime(ctx);
    createSearchBox(ctx, explore.searchText);
    await setupTrafficToggles(map);

    const placeActions = {
        back: () => void ctx.clearSelection(),
        directionsTo(place: Place) {
            directions.setTo(place);
            panel.showTab('directions');
            const fromInput = byId<HTMLInputElement>('route-from');
            if (!fromInput.value) fromInput.focus();
        },
        directionsFrom(place: Place) {
            directions.setFrom(place);
            panel.showTab('directions');
            const toInput = byId<HTMLInputElement>('route-to');
            if (!toInput.value) toInput.focus();
        },
        driveTimeFrom: (place: Place) => driveTime.showFrom(place),
    };

    panel.onTabChange((tab) => {
        if (tab === 'drivetime') driveTime.ensureShown();
    });

    byId('home-button').addEventListener('click', () => fitBounds(CHETWYND_BOUNDS));

    // ── Map clicks ───────────────────────────────────────────────────────────
    // A TomTom POI icon: fetch its full details (phone, website, opening hours).
    let lookup: AbortController | undefined;
    pois.events.on('click', async (feature) => {
        lookup?.abort();
        lookup = new AbortController();
        const { signal } = lookup;
        try {
            const place = await placeById({
                entityId: feature.properties.id,
                openingHours: 'nextSevenDays',
                timeZone: 'iana',
                signal,
            });
            if (signal.aborted) return;
            if (place) await ctx.showPlace(place, { fly: 'never' });
            else toast('TomTom has no details for this place.');
        } catch (error) {
            if (!signal.aborted) reportError(error, 'loading place details');
        }
    });

    // Anywhere else: drop a pin and look up the address there.
    const interactiveModules: MapModule[] = [selection, explore.module, directions.module, driveTime.module];
    const ownedSources = () =>
        new Set(
            interactiveModules.flatMap((module) =>
                Object.values(module.sourceAndLayerIDs).map(({ sourceID }) => sourceID),
            ),
        );
    const onBackgroundClick = async (lngLat: MapLibreLngLat) => {
        lookup?.abort();
        lookup = new AbortController();
        const { signal } = lookup;
        const position: LngLat = [lngLat.lng, lngLat.lat];
        const pin = pointPlace(position, 'Dropped pin');
        await ctx.showPlace(pin, { fly: 'never' });
        try {
            const address = await reverseGeocode({ position, signal });
            if (signal.aborted || selected !== pin) return;
            if (!address.properties.address?.freeformAddress) return;
            // Keep the pin where it was dropped; the geocoder snaps to the nearest address.
            await ctx.showPlace({ ...address, id: pin.id, geometry: pin.geometry }, { fly: 'never' });
        } catch (error) {
            if (!signal.aborted) reportError(error, 'looking up this address');
        }
    };
    mapLibre.on('click', (event) => {
        const { x, y } = event.point;
        const hits = mapLibre.queryRenderedFeatures([
            [x - HIT_TOLERANCE_PX, y - HIT_TOLERANCE_PX],
            [x + HIT_TOLERANCE_PX, y + HIT_TOLERANCE_PX],
        ]);
        const sources = ownedSources();
        const handledElsewhere = hits.some((hit) => sources.has(hit.source) || poiLayerIDs.includes(hit.layer.id));
        if (!handledElsewhere) void onBackgroundClick(event.lngLat);
    });

    mapReady = true;
    byId('fatal-error').hidden = true;
    document.body.dataset.mapReady = 'true';
    if (import.meta.env.MODE === 'e2e') {
        // Hook for the end-to-end tests to inspect the map; compiled out of normal builds.
        Object.assign(window, { chetwyndMap: map });
    }
};
