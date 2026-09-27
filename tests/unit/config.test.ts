import { poiCategoriesToID } from '@tomtom-org/maps-sdk/core';
import { describe, expect, it } from 'vitest';
import {
    CHETWYND_BOUNDS,
    CHETWYND_CENTER,
    DRIVE_TIME_PRESETS_MINUTES,
    EXPLORE_CATEGORIES,
    MAP_STYLE_LABELS,
} from '../../src/config';
import { isWithinBBox } from '../../src/geo';

describe('Explore categories', () => {
    it('have unique ids', () => {
        const ids = EXPLORE_CATEGORIES.map((category) => category.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('stay within the Search API limit of 10 categories per request', () => {
        for (const category of EXPLORE_CATEGORIES) expect(category.codes.length).toBeLessThanOrEqual(10);
    });

    it('only use category codes TomTom knows', () => {
        for (const category of EXPLORE_CATEGORIES) {
            for (const code of category.codes) expect(poiCategoriesToID[code], code).toBeTypeOf('number');
        }
    });
});

describe('Chetwynd geography', () => {
    it('frames the town centre in the home view', () => {
        expect(isWithinBBox(CHETWYND_CENTER, CHETWYND_BOUNDS)).toBe(true);
        const [west, south, east, north] = CHETWYND_BOUNDS;
        expect(west).toBeLessThan(east);
        expect(south).toBeLessThan(north);
    });
});

describe('map styles and drive-time presets', () => {
    it('label every TomTom style', () => {
        expect(Object.keys(MAP_STYLE_LABELS)).toHaveLength(7);
    });

    it('offer increasing drive times', () => {
        expect([...DRIVE_TIME_PRESETS_MINUTES]).toEqual([...DRIVE_TIME_PRESETS_MINUTES].sort((a, b) => a - b));
    });
});
