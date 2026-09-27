import type { Place } from '@tomtom-org/maps-sdk/core';
import { bboxFromGeoJSON } from '@tomtom-org/maps-sdk/core';
import { GeometriesModule, PlacesModule, reachableRangeGeometryConfig } from '@tomtom-org/maps-sdk/map';
import { calculateReachableRanges } from '@tomtom-org/maps-sdk/services';
import {
    type BBox,
    CHETWYND_CENTER,
    DRIVE_TIME_PRESETS_MINUTES,
    type DriveTimePreset,
    ringMinutes,
    TOWN_CENTRE_LABEL,
} from '../config';
import type { AppContext } from '../context';
import { byId, h } from '../dom';
import { placeTitle } from '../format';
import { closeRings, pointPlace } from '../geo';
import { attachAutocomplete } from '../ui/autocomplete';
import { suggestPlaces } from './search';

export type DriveTime = {
    /** The origin pin. The areas themselves stay click-through, so the map under them remains clickable. */
    readonly module: PlacesModule;
    /** Shows drive-time areas around `place` (switches to the Drive time tab). */
    showFrom(place: Place): void;
    /** Computes the areas for the current origin if nothing is shown yet. */
    ensureShown(): void;
    clear(): Promise<void>;
};

export const createDriveTime = async (ctx: AppContext): Promise<DriveTime> => {
    const areas = await GeometriesModule.create(
        ctx.map,
        reachableRangeGeometryConfig('fadedRainbow', 'filled', 'lowestLabel'),
    );
    const originPin = await PlacesModule.create(ctx.map, { theme: 'pin' });
    const originInput = byId<HTMLInputElement>('drive-origin');
    const presets = byId('drive-presets');
    const status = byId('drive-status');

    let origin: Place = pointPlace(CHETWYND_CENTER, TOWN_CENTRE_LABEL, 'town-centre');
    let budget: DriveTimePreset = 30;
    let shown = false;
    let controller: AbortController | undefined;

    const originBox = attachAutocomplete<Place>({
        input: originInput,
        listbox: byId<HTMLUListElement>('drive-origin-suggestions'),
        fetchSuggestions: suggestPlaces,
        onPick: (place) => {
            origin = place;
            void calculate();
        },
        onError: (error) => ctx.reportError(error, 'looking up suggestions'),
    });
    originBox.setValue(placeTitle(origin));

    const renderPresets = () => {
        for (const button of presets.querySelectorAll<HTMLButtonElement>('[data-minutes]')) {
            button.setAttribute('aria-pressed', String(Number(button.dataset.minutes) === budget));
        }
    };

    const calculate = async () => {
        controller?.abort();
        controller = new AbortController();
        const { signal } = controller;
        shown = true;
        const rings = ringMinutes(budget);
        status.textContent = `Calculating how far you can drive in ${budget} minutes…`;
        try {
            const ranges = await calculateReachableRanges(
                rings.map((minutes) => ({
                    origin,
                    budget: { type: 'timeMinutes', value: minutes },
                    costModel: { traffic: 'live' },
                })),
                { signal },
            );
            if (signal.aborted) return;
            await originPin.show(origin);
            // The SDK skips rings TomTom can't compute (no road network nearby) instead of failing.
            if (!ranges.features.length) {
                await areas.clear();
                status.textContent = 'Drive times need a starting point on or near a road.';
                return;
            }
            // The SDK copies the request parameters into each area's properties, AbortSignal and
            // API key included. MapLibre can't hand a signal to its web worker (the areas would
            // silently not draw) and the key doesn't belong in map data, so keep only the budget,
            // which labels the rings.
            await areas.show({
                ...ranges,
                features: ranges.features.map((range) => ({
                    ...range,
                    geometry: closeRings(range.geometry),
                    properties: { budget: range.properties.budget },
                })),
            });
            const shownMinutes = ranges.features.map((range) => range.properties.budget.value);
            status.textContent = `Areas reachable by car within ${shownMinutes.join(', ')} minutes of ${placeTitle(origin)}, with current traffic.`;
            const bbox = bboxFromGeoJSON(ranges) as BBox | undefined;
            if (bbox) ctx.fitBounds(bbox);
        } catch (error) {
            if (signal.aborted) return;
            shown = false;
            status.textContent = '';
            ctx.reportError(error, 'calculating drive times');
        }
    };

    presets.replaceChildren(
        ...DRIVE_TIME_PRESETS_MINUTES.map((minutes) =>
            h(
                'button',
                {
                    class: 'segment',
                    attrs: { type: 'button', 'aria-pressed': String(minutes === budget) },
                    dataset: { minutes: String(minutes) },
                    on: {
                        click: () => {
                            budget = minutes;
                            renderPresets();
                            void calculate();
                        },
                    },
                },
                [`${minutes} min`],
            ),
        ),
    );

    const clear = async () => {
        controller?.abort();
        shown = false;
        status.textContent = '';
        await areas.clear();
        await originPin.clear();
    };
    byId('drive-clear').addEventListener('click', () => void clear());
    byId('drive-reset-origin').addEventListener('click', () => {
        origin = pointPlace(CHETWYND_CENTER, TOWN_CENTRE_LABEL, 'town-centre');
        originBox.setValue(placeTitle(origin));
        void calculate();
    });

    return {
        module: originPin,
        showFrom(place) {
            origin = place;
            originBox.setValue(placeTitle(place));
            ctx.panel.showTab('drivetime');
            void calculate();
        },
        ensureShown() {
            if (!shown) void calculate();
        },
        clear,
    };
};
