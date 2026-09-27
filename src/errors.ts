import { SDKAbortError, SDKServiceError } from '@tomtom-org/maps-sdk/services';

/** A superseded request (search-as-you-type, a newer route) — expected, never reported. */
export const isAbortError = (error: unknown): boolean =>
    error instanceof SDKAbortError || (error instanceof DOMException && error.name === 'AbortError');

export const httpStatusOf = (error: unknown): number | undefined => {
    if (error instanceof SDKServiceError) return error.status;
    if (typeof error === 'object' && error !== null && 'status' in error && typeof error.status === 'number') {
        return error.status;
    }
    return undefined;
};

/** TomTom answers 401/403 when the API key is missing, wrong, revoked or not allowed on this domain. */
export const isAuthError = (error: unknown): boolean => {
    const status = httpStatusOf(error);
    return status === 401 || status === 403;
};

/**
 * A short, human explanation of a failed TomTom call.
 * @param doing what the app was doing, as a gerund phrase: "searching", "finding a route".
 */
export const describeError = (error: unknown, doing: string): string => {
    const status = httpStatusOf(error);
    if (status === 401 || status === 403) return `TomTom rejected the API key while ${doing}.`;
    if (status === 429) return `TomTom is receiving too many requests. Wait a moment and try again.`;
    if (status !== undefined && status >= 500) {
        return `TomTom had a problem while ${doing} (HTTP ${status}). Try again shortly.`;
    }
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        return `You appear to be offline, so ${doing} isn't possible right now.`;
    }
    return `Something went wrong while ${doing}. Please try again.`;
};
