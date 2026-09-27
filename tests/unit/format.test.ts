import type { OpeningHours, Place } from '@tomtom-org/maps-sdk/core';
import { describe, expect, it } from 'vitest';
import { LOCAL_TIME_ZONE } from '../../src/config';
import {
    formatClock,
    formatSeconds,
    formatZonedClock,
    humanizeCategory,
    openStatus,
    placeCategory,
    placeSubtitle,
    placeTitle,
    safeExternalUrl,
    telHref,
    urlLabel,
    zonedParts,
} from '../../src/format';
import { pointPlace } from '../../src/geo';

const poiPlace: Place = {
    type: 'Feature',
    id: 'poi',
    geometry: { type: 'Point', coordinates: [-121.6295, 55.6962] },
    properties: {
        type: 'POI',
        address: {
            streetNumber: '5100',
            streetName: '50th Street Southwest',
            municipality: 'Chetwynd',
            countrySubdivision: 'BC',
            freeformAddress: '5100 50th Street Southwest, Chetwynd BC V0C 1J0',
        },
        poi: { name: 'Sample Diner', categories: ['SUSHI_RESTAURANT'], localizedCategories: ['sushi'] },
    },
};

const addressPlace: Place = {
    type: 'Feature',
    id: 'address',
    geometry: { type: 'Point', coordinates: [-121.6333, 55.6975] },
    properties: {
        type: 'Point Address',
        address: {
            streetNumber: '4733',
            streetName: '51st Street Northwest',
            municipality: 'Chetwynd',
            countrySubdivision: 'BC',
            freeformAddress: '4733 51st Street Northwest, Chetwynd BC V0C 1J0',
        },
    },
};

describe('place labels', () => {
    it('uses the POI name as title and the address as subtitle', () => {
        expect(placeTitle(poiPlace)).toBe('Sample Diner');
        expect(placeSubtitle(poiPlace)).toBe('5100 50th Street Southwest, Chetwynd BC V0C 1J0');
    });

    it('splits an address into street line and locality', () => {
        expect(placeTitle(addressPlace)).toBe('4733 51st Street Northwest');
        expect(placeSubtitle(addressPlace)).toBe('Chetwynd BC V0C 1J0');
    });

    it('handles bare points', () => {
        const pin = pointPlace([-121.63, 55.69], 'Dropped pin');
        expect(placeTitle(pin)).toBe('Dropped pin');
        expect(placeSubtitle(pin)).toBe('');
    });

    it('humanizes category codes', () => {
        expect(placeCategory(poiPlace)).toBe('Sushi restaurant');
        expect(placeCategory(addressPlace)).toBeUndefined();
        expect(humanizeCategory('B_B_GUEST_HOUSE')).toBe('B&B / guest house');
        expect(humanizeCategory('GAS_STATION')).toBe('Gas station');
        expect(humanizeCategory('TOURIST_INFORMATION_OFFICE')).toBe('Visitor information');
    });
});

describe('links', () => {
    it('adds a scheme to bare hostnames and keeps http(s) only', () => {
        expect(safeExternalUrl('www.sample-diner.example')).toBe('https://www.sample-diner.example/');
        expect(safeExternalUrl('http://example.com/a?b=1')).toBe('http://example.com/a?b=1');
        expect(safeExternalUrl('javascript:alert(1)')).toBeUndefined();
        expect(safeExternalUrl('data:text/html,hi')).toBeUndefined();
        expect(safeExternalUrl('   ')).toBeUndefined();
        expect(safeExternalUrl(undefined)).toBeUndefined();
    });

    it('labels links by host', () => {
        expect(urlLabel('https://WWW.Example.COM/path')).toBe('example.com');
    });

    it('makes dialable tel: links', () => {
        expect(telHref('+1 250-555-0101')).toBe('tel:+12505550101');
        expect(telHref('(250) 555 0101')).toBe('tel:2505550101');
        expect(telHref('n/a')).toBeUndefined();
        expect(telHref(undefined)).toBeUndefined();
    });
});

describe('times', () => {
    it('formats 12-hour clock times', () => {
        expect(formatClock(0, 0)).toBe('12 AM');
        expect(formatClock(7, 5)).toBe('7:05 AM');
        expect(formatClock(12, 0)).toBe('12 PM');
        expect(formatClock(21, 30)).toBe('9:30 PM');
    });

    it('never reports a route as taking no time', () => {
        expect(formatSeconds(12)).toBe('< 1 min');
        expect(formatSeconds(260)).toBe('4 min');
    });

    it('reads wall-clock time in Chetwynd (UTC−7 all year)', () => {
        const summer = new Date('2026-07-01T18:00:00Z');
        const winter = new Date('2026-12-01T18:00:00Z');
        expect(zonedParts(summer, LOCAL_TIME_ZONE)).toMatchObject({ hour: 11, minute: 0 });
        expect(zonedParts(winter, LOCAL_TIME_ZONE)).toMatchObject({ hour: 11, minute: 0 });
        expect(formatZonedClock(new Date('2026-09-28T04:30:00Z'), LOCAL_TIME_ZONE)).toBe('9:30 PM');
    });
});

describe('openStatus', () => {
    const moment = (date: string, hour: number, minute = 0) => {
        const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
        return {
            date: new Date(year, month - 1, day, hour, minute),
            dateYYYYMMDD: date,
            year,
            month,
            day,
            hour,
            minute,
        };
    };
    const hours = (ranges: [string, number, string, number][]): OpeningHours => ({
        mode: 'nextSevenDays',
        alwaysOpenThisPeriod: false,
        timeRanges: ranges.map(([startDate, startHour, endDate, endHour]) => ({
            start: moment(startDate, startHour),
            end: moment(endDate, endHour),
        })),
    });
    // Monday 28 Sept 2026, 11:00 in Chetwynd.
    const now = new Date('2026-09-28T18:00:00Z');

    it('is open within a range, with the closing time', () => {
        const status = openStatus(hours([['2026-09-28', 7, '2026-09-28', 21]]), LOCAL_TIME_ZONE, now);
        expect(status).toEqual({ isOpen: true, label: 'Open · closes 9 PM', today: '7 AM – 9 PM' });
    });

    it('is closed before opening, with the opening time', () => {
        const status = openStatus(hours([['2026-09-28', 13, '2026-09-28', 17]]), LOCAL_TIME_ZONE, now);
        expect(status).toEqual({ isOpen: false, label: 'Closed · opens 1 PM', today: '1 PM – 5 PM' });
    });

    it('names tomorrow and later days', () => {
        expect(openStatus(hours([['2026-09-29', 9, '2026-09-29', 17]]), LOCAL_TIME_ZONE, now).label).toBe(
            'Closed · opens tomorrow 9 AM',
        );
        expect(openStatus(hours([['2026-10-01', 9, '2026-10-01', 17]]), LOCAL_TIME_ZONE, now).label).toBe(
            'Closed · opens Thursday 9 AM',
        );
    });

    it('handles overnight ranges', () => {
        const lateNight = new Date('2026-09-29T07:30:00Z'); // 00:30 on Tuesday in Chetwynd
        const status = openStatus(hours([['2026-09-28', 18, '2026-09-29', 2]]), LOCAL_TIME_ZONE, lateNight);
        expect(status.isOpen).toBe(true);
        expect(status.label).toBe('Open · closes 2 AM');
    });

    it('evaluates in the place’s time zone, not the viewer’s', () => {
        // 11:00 in Chetwynd is 14:00 in Toronto; a Toronto-based check would say "closed".
        const status = openStatus(hours([['2026-09-28', 7, '2026-09-28', 12]]), LOCAL_TIME_ZONE, now);
        expect(status.isOpen).toBe(true);
    });

    it('reports 24/7 places and places with no more openings', () => {
        expect(openStatus({ ...hours([]), alwaysOpenThisPeriod: true }, LOCAL_TIME_ZONE, now).label).toBe(
            'Open 24 hours',
        );
        expect(openStatus(hours([['2026-09-27', 9, '2026-09-27', 17]]), LOCAL_TIME_ZONE, now)).toEqual({
            isOpen: false,
            label: 'Closed',
            today: undefined,
        });
    });
});
