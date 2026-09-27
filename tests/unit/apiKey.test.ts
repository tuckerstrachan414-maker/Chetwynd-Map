import { describe, expect, it } from 'vitest';
import {
    clearStoredApiKey,
    isPlausibleApiKey,
    normalizeApiKey,
    readStoredApiKey,
    resolveApiKey,
    storeApiKey,
} from '../../src/apiKey';
import { STORAGE_KEYS } from '../../src/config';

const memoryStorage = (initial: Record<string, string> = {}) => {
    const values = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => void values.set(key, value),
        removeItem: (key: string) => void values.delete(key),
        values,
    };
};

const throwingStorage = {
    getItem: () => {
        throw new Error('SecurityError');
    },
    setItem: () => {
        throw new Error('QuotaExceededError');
    },
    removeItem: () => {
        throw new Error('SecurityError');
    },
};

const KEY = 'AbCdEf0123456789AbCdEf0123456789';

describe('normalizeApiKey', () => {
    it('trims and treats blank as missing', () => {
        expect(normalizeApiKey(`  ${KEY}\n`)).toBe(KEY);
        expect(normalizeApiKey('   ')).toBeUndefined();
        expect(normalizeApiKey(undefined)).toBeUndefined();
        expect(normalizeApiKey(null)).toBeUndefined();
    });
});

describe('isPlausibleApiKey', () => {
    it('accepts TomTom-style tokens and rejects obvious mistakes', () => {
        expect(isPlausibleApiKey(KEY)).toBe(true);
        expect(isPlausibleApiKey('short')).toBe(false);
        expect(isPlausibleApiKey('has spaces in the middle of it')).toBe(false);
        expect(isPlausibleApiKey('https://api.tomtom.com/?key=abc')).toBe(false);
    });
});

describe('resolveApiKey', () => {
    it('prefers a key entered in this browser over the build key', () => {
        const storage = memoryStorage({ [STORAGE_KEYS.apiKey]: 'user-key-0123456789abcdef' });
        expect(resolveApiKey(KEY, storage)).toEqual({ key: 'user-key-0123456789abcdef', source: 'user' });
    });

    it('falls back to the build key', () => {
        expect(resolveApiKey(` ${KEY} `, memoryStorage())).toEqual({ key: KEY, source: 'build' });
    });

    it('returns nothing without any key', () => {
        expect(resolveApiKey(undefined, memoryStorage())).toBeUndefined();
        expect(resolveApiKey('', undefined)).toBeUndefined();
    });

    it('survives storage that throws (privacy modes)', () => {
        expect(resolveApiKey(KEY, throwingStorage)).toEqual({ key: KEY, source: 'build' });
        expect(readStoredApiKey(throwingStorage)).toBeUndefined();
        expect(storeApiKey(KEY, throwingStorage)).toBe(false);
        expect(() => clearStoredApiKey(throwingStorage)).not.toThrow();
    });
});

describe('storeApiKey / clearStoredApiKey', () => {
    it('round-trips the key', () => {
        const storage = memoryStorage();
        expect(storeApiKey(KEY, storage)).toBe(true);
        expect(readStoredApiKey(storage)).toBe(KEY);
        clearStoredApiKey(storage);
        expect(readStoredApiKey(storage)).toBeUndefined();
    });
});
