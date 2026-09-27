import type { Place } from '@tomtom-org/maps-sdk/core';
import { bboxFromGeoJSON } from '@tomtom-org/maps-sdk/core';
import { PlacesModule } from '@tomtom-org/maps-sdk/map';
import { search } from '@tomtom-org/maps-sdk/services';
import {
    type BBox,
    CHETWYND_CENTER,
    EXPLORE_CATEGORIES,
    EXPLORE_RADIUS_METERS,
    EXPLORE_RESULT_LIMIT,
    type ExploreCategory,
    LOCAL_TIME_ZONE,
} from '../config';
import type { AppContext } from '../context';
import { byId, h } from '../dom';
import { formatMeters, openStatus, placeCategory, placeTitle } from '../format';
import { distanceMeters, placePosition, sortByDistance } from '../geo';

export type Explore = {
    /** The results' pins, for telling pin clicks apart from background clicks. */
    readonly module: PlacesModule;
    /** Lists every place matching free text (search box Enter). */
    searchText(query: string): Promise<void>;
    clear(): Promise<void>;
    highlight(place: Place | undefined): void;
};

type Listing = {
    loading: string;
    /** What the app was doing, for error messages: "finding stay places". */
    doing: string;
    fetch(signal: AbortSignal): Promise<Place[]>;
    summary(count: number): string;
    category?: ExploreCategory;
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export const createExplore = async (ctx: AppContext): Promise<Explore> => {
    const results = await PlacesModule.create(ctx.map, { theme: 'pin' });
    const chips = byId('category-chips');
    const status = byId('results-status');
    const clearButton = byId<HTMLButtonElement>('results-clear');
    const list = byId<HTMLOListElement>('results-list');

    let activeCategory: ExploreCategory | undefined;
    let shown: Place[] = [];
    let controller: AbortController | undefined;

    const renderChips = () => {
        for (const chip of chips.querySelectorAll<HTMLButtonElement>('[data-category]')) {
            chip.setAttribute('aria-pressed', String(chip.dataset.category === activeCategory?.id));
        }
    };

    const setStatus = (text: string, showClear: boolean) => {
        status.textContent = text;
        clearButton.hidden = !showClear;
    };

    const resultItem = (place: Place) => {
        const { poi } = place.properties;
        const hours = poi?.openingHours
            ? openStatus(poi.openingHours, poi.timeZone?.ianaId ?? LOCAL_TIME_ZONE)
            : undefined;
        const fromDowntown = distanceMeters(CHETWYND_CENTER, placePosition(place));
        const meta = [placeCategory(place), `${formatMeters(fromDowntown)} from downtown`].filter(Boolean).join(' · ');
        return h('li', { dataset: { placeId: place.id } }, [
            h(
                'button',
                {
                    class: 'result',
                    attrs: { type: 'button' },
                    on: {
                        click: () => void ctx.showPlace(place, { fromResults: true, fly: 'if-hidden' }),
                        mouseenter: () => results.putEventState({ id: place.id, state: 'hover', mode: 'put' }),
                        mouseleave: () => results.cleanEventStates({ states: ['hover'] }),
                        focus: () => results.putEventState({ id: place.id, state: 'hover', mode: 'put' }),
                        blur: () => results.cleanEventStates({ states: ['hover'] }),
                    },
                },
                [
                    h('span', { class: 'result__title' }, [placeTitle(place)]),
                    h('span', { class: 'result__meta' }, [meta]),
                    hours
                        ? h('span', { class: `result__hours ${hours.isOpen ? 'is-open' : 'is-closed'}` }, [hours.label])
                        : null,
                ],
            ),
        ]);
    };

    /** Fills the list and the map. Whatever the visitor asked for last wins; older requests are cancelled. */
    const load = async (listing: Listing) => {
        controller?.abort();
        controller = new AbortController();
        const { signal } = controller;
        activeCategory = listing.category;
        renderChips();
        ctx.panel.showTab('explore');
        setStatus(listing.loading, false);
        list.setAttribute('aria-busy', 'true');
        try {
            const places = await listing.fetch(signal);
            if (signal.aborted) return;
            await ctx.clearSelection();
            await results.show(places);
            if (signal.aborted) return;
            shown = places;
            list.replaceChildren(...places.map(resultItem));
            setStatus(listing.summary(places.length), true);
            const bbox = places.length ? (bboxFromGeoJSON(places) as BBox | undefined) : undefined;
            if (bbox) ctx.fitBounds(bbox, { maxZoom: 16 });
        } catch (error) {
            if (signal.aborted) return;
            activeCategory = undefined;
            renderChips();
            setStatus('', false);
            ctx.reportError(error, listing.doing);
        } finally {
            if (!signal.aborted) list.removeAttribute('aria-busy');
        }
    };

    const clear = async () => {
        controller?.abort();
        activeCategory = undefined;
        shown = [];
        renderChips();
        list.replaceChildren();
        list.removeAttribute('aria-busy');
        setStatus('', false);
        await results.clear();
    };

    const exploreCategory = (category: ExploreCategory) =>
        load({
            category,
            loading: `Finding ${category.label.toLowerCase()} places…`,
            doing: `finding ${category.label.toLowerCase()} places`,
            fetch: async (signal) => {
                const response = await search({
                    poiCategories: category.codes,
                    geometries: [{ type: 'Circle', coordinates: CHETWYND_CENTER, radius: EXPLORE_RADIUS_METERS }],
                    limit: EXPLORE_RESULT_LIMIT,
                    openingHours: 'nextSevenDays',
                    timeZone: 'iana',
                    signal,
                });
                return sortByDistance(response.features, CHETWYND_CENTER);
            },
            summary: (count) =>
                count
                    ? `${plural(count, 'place', 'places')} · ${category.label}`
                    : `No ${category.label.toLowerCase()} places found within ${EXPLORE_RADIUS_METERS / 1000} km.`,
        });

    chips.replaceChildren(
        ...EXPLORE_CATEGORIES.map((category) =>
            h(
                'button',
                {
                    class: 'chip',
                    attrs: { type: 'button', 'aria-pressed': 'false' },
                    dataset: { category: category.id },
                    on: {
                        click: () => void (activeCategory?.id === category.id ? clear() : exploreCategory(category)),
                    },
                },
                [h('span', { attrs: { 'aria-hidden': 'true' } }, [category.icon]), ` ${category.label}`],
            ),
        ),
    );
    clearButton.addEventListener('click', () => void clear());

    // A pin on the map was clicked: open the matching result (the list holds the full data).
    results.events.places.on('click', (pin) => {
        const place = shown.find((candidate) => candidate.id === pin.id);
        if (place) void ctx.showPlace(place, { fromResults: true, fly: 'never' });
    });

    return {
        module: results,
        searchText: (query) =>
            load({
                loading: `Searching for “${query}”…`,
                doing: 'searching',
                fetch: async (signal) => {
                    const response = await search({
                        query,
                        limit: 30,
                        geoBias: { position: CHETWYND_CENTER },
                        openingHours: 'nextSevenDays',
                        timeZone: 'iana',
                        signal,
                    });
                    return response.features;
                },
                summary: (count) =>
                    count ? `${plural(count, 'result', 'results')} for “${query}”` : `No results for “${query}”.`,
            }),
        clear,
        highlight(place) {
            results.cleanEventStates();
            if (place) results.putEventState({ id: place.id, state: 'click', mode: 'put' });
            for (const item of list.querySelectorAll<HTMLElement>('li[data-place-id]')) {
                item.classList.toggle('is-selected', item.dataset.placeId === place?.id);
            }
        },
    };
};
