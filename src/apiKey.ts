import { STORAGE_KEYS } from './config';

/** Where the active API key came from: baked in at build time, or entered in this browser. */
export type ApiKeySource = 'build' | 'user';

export type ResolvedApiKey = { key: string; source: ApiKeySource };

type KeyStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** TomTom keys are opaque tokens of letters and digits (32 characters today). */
const PLAUSIBLE_KEY = /^[A-Za-z0-9_-]{16,128}$/;

export const normalizeApiKey = (raw: string | null | undefined): string | undefined => {
    const key = raw?.trim();
    return key ? key : undefined;
};

export const isPlausibleApiKey = (key: string): boolean => PLAUSIBLE_KEY.test(key);

/** `localStorage` can be missing or throw (privacy modes, sandboxed frames), so every access is guarded. */
export const browserStorage = (): KeyStorage | undefined => {
    try {
        return globalThis.localStorage ?? undefined;
    } catch {
        return undefined;
    }
};

export const readStoredApiKey = (storage: KeyStorage | undefined = browserStorage()): string | undefined => {
    try {
        return normalizeApiKey(storage?.getItem(STORAGE_KEYS.apiKey));
    } catch {
        return undefined;
    }
};

/** Returns whether the key could be persisted; it still works for this page load either way. */
export const storeApiKey = (key: string, storage: KeyStorage | undefined = browserStorage()): boolean => {
    try {
        if (!storage) return false;
        storage.setItem(STORAGE_KEYS.apiKey, key);
        return true;
    } catch {
        return false;
    }
};

export const clearStoredApiKey = (storage: KeyStorage | undefined = browserStorage()): void => {
    try {
        storage?.removeItem(STORAGE_KEYS.apiKey);
    } catch {
        // Nothing stored, nothing to clear.
    }
};

/**
 * A key entered in this browser wins over the one baked into the build, so a visitor can
 * recover from a missing or revoked site key without a rebuild.
 */
export const resolveApiKey = (
    buildKey: string | undefined,
    storage: KeyStorage | undefined = browserStorage(),
): ResolvedApiKey | undefined => {
    const userKey = readStoredApiKey(storage);
    if (userKey) return { key: userKey, source: 'user' };
    const bakedKey = normalizeApiKey(buildKey);
    if (bakedKey) return { key: bakedKey, source: 'build' };
    return undefined;
};
