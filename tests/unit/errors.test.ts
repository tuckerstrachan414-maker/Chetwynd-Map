import { SDKAbortError, SDKServiceError } from '@tomtom-org/maps-sdk/services';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeError, httpStatusOf, isAbortError, isAuthError } from '../../src/errors';

const serviceError = (status: number) => new SDKServiceError(`HTTP ${status}`, 'search', status);

describe('error classification', () => {
    afterEach(() => vi.restoreAllMocks());

    it('reads HTTP statuses from SDK and MapLibre errors', () => {
        expect(httpStatusOf(serviceError(403))).toBe(403);
        expect(httpStatusOf({ status: 401, url: 'https://api.tomtom.com/style.json' })).toBe(401);
        expect(httpStatusOf(new Error('boom'))).toBeUndefined();
        expect(httpStatusOf(undefined)).toBeUndefined();
    });

    it('recognises rejected keys', () => {
        expect(isAuthError(serviceError(401))).toBe(true);
        expect(isAuthError(serviceError(403))).toBe(true);
        expect(isAuthError(serviceError(404))).toBe(false);
    });

    it('recognises superseded requests', () => {
        expect(isAbortError(new DOMException('aborted', 'AbortError'))).toBe(true);
        expect(isAbortError(new SDKAbortError('search', 'superseded'))).toBe(true);
        expect(isAbortError(serviceError(500))).toBe(false);
    });

    it('explains failures in plain language', () => {
        expect(describeError(serviceError(403), 'searching')).toBe('TomTom rejected the API key while searching.');
        expect(describeError(serviceError(429), 'searching')).toMatch(/too many requests/);
        expect(describeError(serviceError(503), 'finding a route')).toBe(
            'TomTom had a problem while finding a route (HTTP 503). Try again shortly.',
        );
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        expect(describeError(new TypeError('Failed to fetch'), 'searching')).toMatch(/offline/);
    });
});
