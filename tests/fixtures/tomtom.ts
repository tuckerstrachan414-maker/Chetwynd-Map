/**
 * Synthetic TomTom API responses for tests, in the raw formats TomTom's servers send. They are
 * typed against the SDK's own API types, and `tests/unit/fixtures.contract.test.ts` runs them
 * through the SDK's response parsers, so a format change in a new SDK version fails the tests
 * instead of silently turning the mocks into fiction.
 *
 * The places are made up ("Sample …"); only the geography is Chetwynd's.
 */
import type {
    customizeService,
    FuzzySearchResponseAPI,
    GeometrySearchResponseAPI,
    PlaceByIdResponseAPI,
} from '@tomtom-org/maps-sdk/services';

type SearchResultAPI = FuzzySearchResponseAPI['results'][number];
type ReverseGeocodingResponseAPI = Parameters<typeof customizeService.reverseGeocode.parseRevGeoResponse>[0];
type CalculateRouteResponseAPI = Parameters<typeof customizeService.calculateRoute.parseCalculateRouteResponse>[0];
type ReachableRangeResponseAPI = Parameters<typeof customizeService.reachableRange.parseReachableRangeResponse>[0];

/** Tests pin the browser clock here: Monday 28 September 2026, 11:00 in Chetwynd (UTC−7). */
export const FIXED_NOW = new Date('2026-09-28T18:00:00Z');

const address = (streetNumber: string, streetName: string) => ({
    streetNumber,
    streetName,
    municipality: 'Chetwynd',
    countrySubdivision: 'BC',
    countrySubdivisionName: 'British Columbia',
    postalCode: 'V0C',
    countryCode: 'CA',
    country: 'Canada',
    countryCodeISO3: 'CAN',
    freeformAddress: `${streetNumber} ${streetName}, Chetwynd BC V0C 1J0`,
});

const hours = (ranges: [date: string, from: number, to: number][]) => ({
    mode: 'nextSevenDays' as const,
    timeRanges: ranges.map(([date, from, to]) => ({
        startTime: { date, hour: from, minute: 0 },
        endTime: { date, hour: to, minute: 0 },
    })),
});

export const sampleDiner: SearchResultAPI = {
    type: 'POI',
    id: 'sample-diner',
    score: 9.1,
    position: { lat: 55.6962, lon: -121.6295 },
    address: address('5100', '50th Street Southwest'),
    poi: {
        name: 'Sample Diner',
        phone: '+1 250-555-0101',
        url: 'www.sample-diner.example',
        categorySet: [{ id: 7315 }],
        categories: ['restaurant'],
        openingHours: hours([
            ['2026-09-28', 7, 21],
            ['2026-09-29', 7, 21],
        ]),
    },
};

export const sampleCafe: SearchResultAPI = {
    type: 'POI',
    id: 'sample-cafe',
    score: 8.7,
    position: { lat: 55.7032, lon: -121.6104 },
    address: address('4520', 'North Access Road'),
    poi: {
        name: 'Sample Café',
        url: 'https://cafe.example.com/menu',
        categorySet: [{ id: 9376 }],
        categories: ['café/pub'],
        openingHours: hours([['2026-09-28', 13, 17]]),
    },
};

export const sampleMotel: SearchResultAPI = {
    type: 'POI',
    id: 'sample-motel',
    score: 8.2,
    position: { lat: 55.6982, lon: -121.6347 },
    address: address('5200', 'North Access Road'),
    poi: {
        name: 'Sample Motel',
        phone: '+1 250-555-0199',
        categorySet: [{ id: 7314 }],
        categories: ['hotel/motel'],
    },
};

export const sampleAddress: SearchResultAPI = {
    type: 'Point Address',
    id: 'sample-address',
    score: 7.5,
    position: { lat: 55.6975, lon: -121.6333 },
    address: address('4733', '51st Street Northwest'),
};

const summary = (query: string, numResults: number) => ({
    query,
    queryType: 'NON_NEAR' as const,
    queryTime: 12,
    numResults,
    offset: 0,
    totalResults: numResults,
    fuzzyLevel: 1,
});

/** Typeahead and full-text search ("sample"). */
export const fuzzySearchResponse: FuzzySearchResponseAPI = {
    summary: summary('sample', 3),
    results: [sampleDiner, sampleCafe, sampleAddress],
};

/** Category search around downtown, deliberately *not* sorted by distance. */
export const geometrySearchResponse: GeometrySearchResponseAPI = {
    summary: summary('', 2),
    results: [sampleCafe, sampleDiner],
};

export const placeByIdResponse: PlaceByIdResponseAPI = {
    summary: summary('', 1),
    results: [sampleMotel],
};

export const reverseGeocodeResponse: ReverseGeocodingResponseAPI = {
    results: [
        {
            id: 'sample-street',
            type: 'street',
            title: '47th Avenue Northwest, Chetwynd BC V0C 1J0',
            position: { type: 'Point', coordinates: [-121.6365, 55.7011] },
            address: {
                street: '47th Avenue Northwest',
                countryCodeIso2: 'CA',
                countrySubdivision: 'BC',
                municipality: 'Chetwynd',
                postalCode: 'V0C 1J0',
                country: 'Canada',
            },
        },
    ],
};

const routeSummary = (lengthInMeters: number, seconds: number, delay: number) => ({
    lengthInMeters,
    travelDurationInSeconds: seconds,
    trafficDelayDurationInSeconds: delay,
    trafficLengthInMeters: 0,
    departureDateTime: '2026-09-28T11:00:00-07:00',
    arrivalDateTime: new Date(Date.parse('2026-09-28T11:00:00-07:00') + seconds * 1000).toISOString(),
});

const routeFrom = (path: [number, number][], lengthInMeters: number, seconds: number, delay: number) => ({
    legs: [
        {
            path: { type: 'LineString' as const, coordinates: path },
            summary: routeSummary(lengthInMeters, seconds, delay),
        },
    ],
    summary: routeSummary(lengthInMeters, seconds, delay),
    sections: {},
    instructions: [
        {
            routeOffsetInMeters: 0,
            maneuver: 'DEPART',
            maneuverPoint: { type: 'Point' as const, coordinates: path[0] ?? [0, 0] },
            message: 'Leave from 50th Street Southwest',
        },
        {
            routeOffsetInMeters: 850,
            maneuver: 'TURN_RIGHT',
            maneuverPoint: { type: 'Point' as const, coordinates: path[1] ?? [0, 0] },
            message: 'Turn right onto North Access Road',
        },
        {
            routeOffsetInMeters: lengthInMeters,
            maneuver: 'ARRIVE',
            maneuverPoint: { type: 'Point' as const, coordinates: path.at(-1) ?? [0, 0] },
            message: 'You have arrived at your destination',
        },
    ],
});

/** Downtown → Sample Café: a main route and one alternative with a traffic delay. */
export const routeResponse: CalculateRouteResponseAPI = {
    routes: [
        routeFrom(
            [
                [-121.6295, 55.6962],
                [-121.6258, 55.6975],
                [-121.6104, 55.7032],
            ],
            2350,
            260,
            0,
        ),
        routeFrom(
            [
                [-121.6295, 55.6962],
                [-121.6231, 55.6948],
                [-121.6104, 55.7032],
            ],
            2780,
            395,
            90,
        ),
    ],
};

/** A small blob around downtown; each drive-time ring is served this same shape. */
export const reachableRangeResponse: ReachableRangeResponseAPI = {
    reachableRange: {
        center: { latitude: 55.6967, longitude: -121.6297 },
        boundary: [
            { latitude: 55.73, longitude: -121.63 },
            { latitude: 55.7, longitude: -121.55 },
            { latitude: 55.66, longitude: -121.62 },
            { latitude: 55.69, longitude: -121.71 },
        ],
    },
};
