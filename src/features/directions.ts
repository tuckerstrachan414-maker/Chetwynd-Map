import type { Place, Route, Routes } from '@tomtom-org/maps-sdk/core';
import { bboxFromGeoJSON } from '@tomtom-org/maps-sdk/core';
import { RoutingModule } from '@tomtom-org/maps-sdk/map';
import { calculateRoute } from '@tomtom-org/maps-sdk/services';
import { type BBox, type LngLat, LOCAL_TIME_ZONE } from '../config';
import type { AppContext } from '../context';
import { byId, h } from '../dom';
import { httpStatusOf } from '../errors';
import { formatMeters, formatSeconds, formatZonedClock, humanizeCategory, placeTitle } from '../format';
import { pointPlace } from '../geo';
import { attachAutocomplete } from '../ui/autocomplete';
import { toast } from '../ui/toast';
import { suggestPlaces } from './search';

export type Directions = {
    /** Route lines and waypoint pins, for telling their clicks apart from background clicks. */
    readonly module: RoutingModule;
    setFrom(place: Place): void;
    setTo(place: Place): void;
    clear(): Promise<void>;
};

const SIGNIFICANT_DELAY_SECONDS = 60;

export const createDirections = async (ctx: AppContext): Promise<Directions> => {
    const routing = await RoutingModule.create(ctx.map);
    const fromInput = byId<HTMLInputElement>('route-from');
    const toInput = byId<HTMLInputElement>('route-to');
    const avoidUnpaved = byId<HTMLInputElement>('route-avoid-unpaved');
    const status = byId('route-status');
    const options = byId('route-options');
    const steps = byId<HTMLOListElement>('route-steps');
    const myLocation = byId<HTMLButtonElement>('route-my-location');

    let from: Place | undefined;
    let to: Place | undefined;
    let routes: Routes | undefined;
    let selected = 0;
    let controller: AbortController | undefined;

    const onError = (error: unknown) => ctx.reportError(error, 'looking up suggestions');
    const fromBox = attachAutocomplete<Place>({
        input: fromInput,
        listbox: byId<HTMLUListElement>('route-from-suggestions'),
        fetchSuggestions: suggestPlaces,
        onPick: (place) => {
            from = place;
            void update();
        },
        onError,
    });
    const toBox = attachAutocomplete<Place>({
        input: toInput,
        listbox: byId<HTMLUListElement>('route-to-suggestions'),
        fetchSuggestions: suggestPlaces,
        onPick: (place) => {
            to = place;
            void update();
        },
        onError,
    });

    const resetResults = (message: string) => {
        routes = undefined;
        status.textContent = message;
        options.replaceChildren();
        steps.replaceChildren();
    };

    const renderOptions = () => {
        if (!routes) return;
        options.replaceChildren(
            ...routes.features.map((route, index) => {
                const { lengthInMeters, travelTimeInSeconds, trafficDelayInSeconds, arrivalTime } =
                    route.properties.summary;
                return h(
                    'button',
                    {
                        class: 'route-option',
                        attrs: { type: 'button', 'aria-pressed': String(index === selected) },
                        on: { click: () => void select(index) },
                    },
                    [
                        h('span', { class: 'route-option__time' }, [formatSeconds(travelTimeInSeconds)]),
                        h('span', { class: 'route-option__meta' }, [
                            `${formatMeters(lengthInMeters)} · arrive ${formatZonedClock(arrivalTime, LOCAL_TIME_ZONE)}`,
                        ]),
                        h('span', { class: 'route-option__label' }, [
                            index === 0 ? 'Fastest' : `Alternative ${index}`,
                            trafficDelayInSeconds >= SIGNIFICANT_DELAY_SECONDS
                                ? h('span', { class: 'route-option__delay' }, [
                                      ` · +${formatSeconds(trafficDelayInSeconds)} traffic`,
                                  ])
                                : null,
                        ]),
                    ],
                );
            }),
        );
    };

    const renderSteps = (route: Route) => {
        const instructions = route.properties.guidance?.instructions ?? [];
        steps.replaceChildren(
            ...instructions.map((instruction, index) => {
                const next = instructions[index + 1];
                const legMeters = next ? next.routeOffsetInMeters - instruction.routeOffsetInMeters : 0;
                const [lng = 0, lat = 0] = instruction.maneuverPoint;
                return h('li', {}, [
                    h(
                        'button',
                        {
                            class: 'step',
                            attrs: { type: 'button' },
                            on: { click: () => ctx.flyTo([lng, lat], 16) },
                        },
                        [
                            h('span', { class: 'step__text' }, [
                                instruction.message ?? humanizeCategory(instruction.maneuver),
                            ]),
                            legMeters > 0 ? h('span', { class: 'step__distance' }, [formatMeters(legMeters)]) : null,
                        ],
                    ),
                ]);
            }),
        );
    };

    const select = async (index: number) => {
        const route = routes?.features[index];
        if (!route) return;
        selected = index;
        await routing.selectRoute(index);
        renderOptions();
        renderSteps(route);
    };

    const update = async () => {
        // A newer update supersedes this one: take the controller before the first await.
        controller?.abort();
        controller = new AbortController();
        const { signal } = controller;
        await routing.showWaypoints([from ?? null, to ?? null]);
        if (signal.aborted) return;
        if (!from || !to) {
            await routing.clearRoutes();
            resetResults(from || to ? `Choose ${from ? 'a destination' : 'a starting point'}.` : '');
            return;
        }
        resetResults('Finding the best route…');
        steps.setAttribute('aria-busy', 'true');
        try {
            const result = await calculateRoute({
                locations: [from, to],
                costModel: {
                    traffic: 'live',
                    routeType: 'fast',
                    ...(avoidUnpaved.checked && { avoid: ['unpavedRoads'] }),
                },
                guidance: { type: 'coded' },
                maxAlternatives: 2,
                signal,
            });
            if (signal.aborted) return;
            if (!result.features.length) {
                await routing.clearRoutes();
                resetResults('No drivable route found between these places.');
                return;
            }
            routes = result;
            selected = 0;
            await routing.showRoutes(result, { selectedIndex: 0 });
            status.textContent = `${placeTitle(from)} → ${placeTitle(to)}`;
            renderOptions();
            const firstRoute = result.features[0];
            if (firstRoute) renderSteps(firstRoute);
            const bbox = bboxFromGeoJSON(result) as BBox | undefined;
            if (bbox) ctx.fitBounds(bbox);
        } catch (error) {
            if (signal.aborted) return;
            await routing.clearRoutes();
            // TomTom answers 400 when the places can't be connected by road.
            const noRoute = httpStatusOf(error) === 400;
            resetResults(noRoute ? 'No drivable route found between these places.' : '');
            if (!noRoute) ctx.reportError(error, 'finding a route');
        } finally {
            if (!signal.aborted) steps.removeAttribute('aria-busy');
        }
    };

    const setFrom = (place: Place) => {
        from = place;
        fromBox.setValue(placeTitle(place));
        void update();
    };
    const setTo = (place: Place) => {
        to = place;
        toBox.setValue(placeTitle(place));
        void update();
    };

    // Typing over a chosen place un-chooses it until a new suggestion is picked.
    fromInput.addEventListener('input', () => {
        if (from) {
            from = undefined;
            void update();
        }
    });
    toInput.addEventListener('input', () => {
        if (to) {
            to = undefined;
            void update();
        }
    });

    byId('route-swap').addEventListener('click', () => {
        [from, to] = [to, from];
        fromBox.setValue(from ? placeTitle(from) : '');
        toBox.setValue(to ? placeTitle(to) : '');
        void update();
    });
    avoidUnpaved.addEventListener('change', () => void update());

    myLocation.addEventListener('click', () => {
        if (!('geolocation' in navigator)) {
            toast('This browser can’t share its location.', 'error');
            return;
        }
        myLocation.disabled = true;
        navigator.geolocation.getCurrentPosition(
            ({ coords }) => {
                myLocation.disabled = false;
                const position: LngLat = [coords.longitude, coords.latitude];
                setFrom(pointPlace(position, 'My location', 'my-location'));
            },
            (error) => {
                myLocation.disabled = false;
                toast(
                    error.code === error.PERMISSION_DENIED
                        ? 'Location access was denied. Allow it in your browser settings, or type a starting point.'
                        : 'Couldn’t get your location. Type a starting point instead.',
                    'error',
                );
            },
            { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
        );
    });

    routing.events.mainLines.on('click', (route) => void select(route.properties.index));

    const clear = async () => {
        controller?.abort();
        from = undefined;
        to = undefined;
        fromBox.clear();
        toBox.clear();
        resetResults('');
        steps.removeAttribute('aria-busy');
        await routing.clearRoutes();
        await routing.clearWaypoints();
    };
    byId('route-clear').addEventListener('click', () => void clear());

    return { module: routing, setFrom, setTo, clear };
};
