import type { Page, Route } from '@playwright/test';
import { mockStyle } from '../fixtures/style';
import {
    fuzzySearchResponse,
    geometrySearchResponse,
    placeByIdResponse,
    reachableRangeResponse,
    reverseGeocodeResponse,
    routeResponse,
} from '../fixtures/tomtom';

export type RecordedRequest = { method: string; url: URL; body: string | null; headers: Record<string, string> };

export type TomTomMock = {
    requests: RecordedRequest[];
    /** Requests to api.tomtom.com that no handler recognised. */
    unexpected: RecordedRequest[];
    /** Requests whose path matches `pattern`. */
    calls(pattern: RegExp): RecordedRequest[];
};

type MockOptions = {
    /** Answer every request whose path matches with this status (e.g. a rejected key). */
    failures?: { path: RegExp; status: number }[];
    /** Hold back responses whose path matches, to test slow or superseded requests. */
    delays?: { path: RegExp; ms: number }[];
};

const CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST',
    'access-control-allow-headers':
        'accept,accept-language,attributes,content-type,tomtom-api-key,tomtom-api-version,tomtom-user-agent,tracking-id',
};

/** A transparent 1×1 PNG, for sprite sheets. */
const EMPTY_PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

const json = (route: Route, body: unknown, status = 200) =>
    route.fulfill({ status, headers: CORS_HEADERS, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Serves TomTom's endpoints from fixtures, so the real SDK and MapLibre run end to end in the
 * browser without an API key or network access.
 */
export const mockTomTom = async (page: Page, options: MockOptions = {}): Promise<TomTomMock> => {
    const requests: RecordedRequest[] = [];
    const unexpected: RecordedRequest[] = [];

    await page.route('https://api.tomtom.com/**', async (route) => {
        const request = route.request();
        if (request.method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: CORS_HEADERS });
            return;
        }
        const url = new URL(request.url());
        const recorded = { method: request.method(), url, body: request.postData(), headers: request.headers() };
        requests.push(recorded);
        const path = url.pathname;

        const delay = options.delays?.find(({ path: pattern }) => pattern.test(path));
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay.ms));

        const failure = options.failures?.find(({ path: pattern }) => pattern.test(path));
        if (failure) {
            await json(route, { detailedError: { code: 'Forbidden', message: 'Mocked failure' } }, failure.status);
            return;
        }

        if (path.startsWith('/maps/orbis/assets/styles/')) return json(route, mockStyle());
        if (path.startsWith('/maps/orbis/assets/sprites/')) {
            return path.endsWith('.json')
                ? json(route, {})
                : route.fulfill({ status: 200, headers: CORS_HEADERS, contentType: 'image/png', body: EMPTY_PNG });
        }
        if (path.startsWith('/mock/glyphs/') || path.startsWith('/mock/tiles/')) {
            return route.fulfill({
                status: 200,
                headers: CORS_HEADERS,
                contentType: 'application/x-protobuf',
                body: Buffer.alloc(0),
            });
        }
        if (path.startsWith('/maps/orbis/places/search/')) return json(route, fuzzySearchResponse);
        if (path.startsWith('/maps/orbis/places/geometrySearch/')) return json(route, geometrySearchResponse);
        if (path === '/maps/orbis/places/place.json') return json(route, placeByIdResponse);
        if (path === '/maps/orbis/places/reverseGeocode') return json(route, reverseGeocodeResponse);
        if (path === '/maps/orbis/routing/routes/calculate') return json(route, routeResponse);
        if (path.startsWith('/maps/orbis/routing/calculateReachableRange/')) return json(route, reachableRangeResponse);

        unexpected.push(recorded);
        return json(route, { detailedError: { code: 'NotFound', message: `No mock for ${path}` } }, 404);
    });

    return {
        requests,
        unexpected,
        calls: (pattern) => requests.filter((request) => pattern.test(request.url.pathname)),
    };
};
