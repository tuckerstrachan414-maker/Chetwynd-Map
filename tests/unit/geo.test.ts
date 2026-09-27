import { describe, expect, it } from 'vitest';
import { CHETWYND_BOUNDS, CHETWYND_CENTER } from '../../src/config';
import {
    closeRings,
    distanceMeters,
    formatCoordinates,
    isWithinBBox,
    placePosition,
    pointPlace,
    sortByDistance,
} from '../../src/geo';

describe('distanceMeters', () => {
    it('is zero for the same point and symmetric', () => {
        expect(distanceMeters(CHETWYND_CENTER, CHETWYND_CENTER)).toBe(0);
        const a: [number, number] = [-121.6297, 55.6967];
        const b: [number, number] = [-120.2353, 55.7596];
        expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 6);
    });

    it('matches the known Chetwynd → Dawson Creek straight-line distance (~88 km)', () => {
        const dawsonCreek: [number, number] = [-120.2353, 55.7596];
        expect(distanceMeters(CHETWYND_CENTER, dawsonCreek) / 1000).toBeCloseTo(87.8, 0);
    });
});

describe('places at a position', () => {
    it('creates a GeoJSON point place', () => {
        const pin = pointPlace([-121.63, 55.69], 'Dropped pin');
        expect(pin).toMatchObject({
            type: 'Feature',
            id: 'point:-121.630000,55.690000',
            geometry: { type: 'Point', coordinates: [-121.63, 55.69] },
            properties: { type: 'Point Address', address: { freeformAddress: 'Dropped pin' } },
        });
        expect(placePosition(pin)).toEqual([-121.63, 55.69]);
    });

    it('sorts nearest first without mutating the input', () => {
        const far = pointPlace([-121.55, 55.72], 'far');
        const near = pointPlace([-121.63, 55.697], 'near');
        const input = [far, near];
        expect(sortByDistance(input, CHETWYND_CENTER).map((place) => place.id)).toEqual([near.id, far.id]);
        expect(input).toEqual([far, near]);
    });
});

describe('geometry helpers', () => {
    it('checks bounding boxes', () => {
        expect(isWithinBBox(CHETWYND_CENTER, CHETWYND_BOUNDS)).toBe(true);
        expect(isWithinBBox([-120.2353, 55.7596], CHETWYND_BOUNDS)).toBe(false);
    });

    it('formats coordinates with hemispheres', () => {
        expect(formatCoordinates([-121.6297, 55.6967])).toBe('55.69670° N, 121.62970° W');
    });
});

describe('closeRings', () => {
    it('closes open polygon rings and leaves closed ones alone', () => {
        const open = {
            type: 'Polygon' as const,
            coordinates: [
                [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                ],
            ],
        };
        expect(closeRings(open).coordinates).toEqual([
            [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
            ],
        ]);
        const closed = {
            type: 'Polygon' as const,
            coordinates: [
                [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 0],
                ],
            ],
        };
        expect(closeRings(closed)).toEqual(closed);
    });

    it('handles multi-polygons', () => {
        const multi = {
            type: 'MultiPolygon' as const,
            coordinates: [
                [
                    [
                        [0, 0],
                        [1, 0],
                        [1, 1],
                    ],
                ],
                [
                    [
                        [5, 5],
                        [6, 5],
                        [6, 6],
                        [5, 5],
                    ],
                ],
            ],
        };
        expect(closeRings(multi).coordinates).toEqual([
            [
                [
                    [0, 0],
                    [1, 0],
                    [1, 1],
                    [0, 0],
                ],
            ],
            [
                [
                    [5, 5],
                    [6, 5],
                    [6, 6],
                    [5, 5],
                ],
            ],
        ]);
    });
});
