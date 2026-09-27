import type { AddressProperties, OpeningHours, Place } from '@tomtom-org/maps-sdk/core';
import { formatDistance, formatDuration } from '@tomtom-org/maps-sdk/core';

type TimeParts = { year: number; month: number; day: number; hour: number; minute: number };

// ─── Places ──────────────────────────────────────────────────────────────────

const firstAddressLine = (address: AddressProperties): string => {
    if (address.streetName) return [address.streetNumber, address.streetName].filter(Boolean).join(' ');
    return address.freeformAddress.split(',')[0]?.trim() || address.freeformAddress;
};

export const placeTitle = (place: Place): string =>
    place.properties.poi?.name || firstAddressLine(place.properties.address) || 'Selected location';

export const placeSubtitle = (place: Place): string => {
    const { address, poi } = place.properties;
    if (poi) return address.freeformAddress;
    const title = firstAddressLine(address);
    const rest = address.freeformAddress.startsWith(title)
        ? address.freeformAddress.slice(title.length).replace(/^[\s,]+/, '')
        : address.freeformAddress;
    return rest || [address.municipality, address.countrySubdivision].filter(Boolean).join(', ');
};

const CATEGORY_LABELS: Record<string, string> = {
    ATM: 'ATM',
    B_B_GUEST_HOUSE: 'B&B / guest house',
    CAFE: 'Café',
    CAFE_PUB: 'Café / pub',
    CAMPING_GROUND: 'Campground',
    CARAVAN_SITE: 'RV park',
    CHILD_CARE_FACILITY: 'Child care',
    COLLEGE_OR_UNIVERSITY: 'College / university',
    COLLEGE_UNIVERSITY: 'College / university',
    COMMUNITY_CENTER: 'Community centre',
    ELECTRIC_VEHICLE_STATION: 'EV charging',
    FIRE_STATION_BRIGADE: 'Fire station',
    GENERAL_HOSPITAL_AND_POLYCLINIC: 'Hospital / clinic',
    HEALTH_CARE_SERVICE: 'Health care',
    HOTEL_MOTEL: 'Hotel / motel',
    LEISURE_SPORTS_CENTER: 'Sports centre',
    PARK_RECREATION_AREA: 'Park & recreation',
    PUBLIC_AIRPORT: 'Airport',
    RECREATIONAL_CAMPING_GROUND: 'Campground',
    SUPERMARKETS_HYPERMARKETS: 'Supermarket',
    TOURIST_INFORMATION_OFFICE: 'Visitor information',
};

/** `SUSHI_RESTAURANT` → "Sushi restaurant", with hand-written labels for the awkward codes. */
export const humanizeCategory = (code: string): string => {
    const label = CATEGORY_LABELS[code];
    if (label) return label;
    const words = code.toLowerCase().replaceAll('_', ' ').trim();
    return words.charAt(0).toUpperCase() + words.slice(1);
};

export const placeCategory = (place: Place): string | undefined => {
    const code = place.properties.poi?.categories[0];
    return code ? humanizeCategory(code) : undefined;
};

/** Only http(s) links are shown; TomTom sometimes omits the scheme ("www.example.com"). */
export const safeExternalUrl = (raw: string | undefined): string | undefined => {
    if (!raw?.trim()) return undefined;
    const candidate = /^[a-z][a-z\d+.-]*:/i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`;
    try {
        const url = new URL(candidate);
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : undefined;
    } catch {
        return undefined;
    }
};

export const urlLabel = (href: string): string => new URL(href).hostname.replace(/^www\./i, '').toLowerCase();

export const telHref = (phone: string | undefined): string | undefined => {
    const dialable = phone?.replace(/[^\d+]/g, '');
    return dialable && dialable.replace(/\D/g, '').length >= 7 ? `tel:${dialable}` : undefined;
};

// ─── Distances and times ─────────────────────────────────────────────────────

export const formatMeters = (meters: number): string => formatDistance(meters);

/** The SDK returns nothing under 30 seconds; a route is never "no time". */
export const formatSeconds = (seconds: number): string => formatDuration(seconds) ?? '< 1 min';

export const formatClock = (hour: number, minute: number): string => {
    const hour12 = ((hour + 11) % 12) + 1;
    const suffix = hour < 12 ? 'AM' : 'PM';
    return minute === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(minute).padStart(2, '0')} ${suffix}`;
};

/** Wall-clock parts of `date` in `timeZone`. */
export const zonedParts = (date: Date, timeZone: string): TimeParts => {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
    return {
        year: value('year'),
        month: value('month'),
        day: value('day'),
        hour: value('hour'),
        minute: value('minute'),
    };
};

export const formatZonedClock = (date: Date, timeZone: string): string => {
    const { hour, minute } = zonedParts(date, timeZone);
    return formatClock(hour, minute);
};

// ─── Opening hours ───────────────────────────────────────────────────────────

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

/** Sortable number for a wall-clock time: YYYYMMDDhhmm. */
const timeKey = (t: TimeParts): number => (((t.year * 100 + t.month) * 100 + t.day) * 100 + t.hour) * 100 + t.minute;
const dayKey = (t: TimeParts): number => (t.year * 100 + t.month) * 100 + t.day;
const weekday = (t: TimeParts): string => WEEKDAYS[new Date(Date.UTC(t.year, t.month - 1, t.day)).getUTCDay()] ?? '';

const dayLabel = (t: TimeParts, now: TimeParts): string => {
    const tomorrow = new Date(Date.UTC(now.year, now.month - 1, now.day + 1));
    const isTomorrow =
        t.year === tomorrow.getUTCFullYear() &&
        t.month === tomorrow.getUTCMonth() + 1 &&
        t.day === tomorrow.getUTCDate();
    if (dayKey(t) === dayKey(now)) return '';
    return isTomorrow ? 'tomorrow ' : `${weekday(t)} `;
};

export type OpenStatus = {
    isOpen: boolean;
    /** "Open · closes 10 PM", "Closed · opens Monday 9 AM", "Open 24 hours". */
    label: string;
    /** Today's hours, e.g. "6 AM – 2 PM, 5 PM – 10 PM"; `undefined` when closed all day. */
    today: string | undefined;
};

/**
 * Open/closed status from TomTom's opening hours, evaluated in the place's own time zone
 * (never the browser's), so a visitor planning from elsewhere sees Chetwynd time.
 */
export const openStatus = (hours: OpeningHours, timeZone: string, nowDate: Date = new Date()): OpenStatus => {
    const now = zonedParts(nowDate, timeZone);
    if (hours.alwaysOpenThisPeriod) return { isOpen: true, label: 'Open 24 hours', today: 'Open 24 hours' };

    const ranges = hours.timeRanges
        .map(({ start, end }) => ({ start, end }))
        .sort((a, b) => timeKey(a.start) - timeKey(b.start));
    const todays = ranges.filter((range) => dayKey(range.start) === dayKey(now));
    const today = todays.length
        ? todays
              .map(
                  ({ start, end }) => `${formatClock(start.hour, start.minute)} – ${formatClock(end.hour, end.minute)}`,
              )
              .join(', ')
        : undefined;

    const nowKey = timeKey(now);
    const current = ranges.find((range) => timeKey(range.start) <= nowKey && nowKey < timeKey(range.end));
    if (current) {
        const { end } = current;
        return {
            isOpen: true,
            label: `Open · closes ${dayLabel(end, now)}${formatClock(end.hour, end.minute)}`,
            today,
        };
    }
    const next = ranges.find((range) => timeKey(range.start) > nowKey);
    if (next) {
        const { start } = next;
        return {
            isOpen: false,
            label: `Closed · opens ${dayLabel(start, now)}${formatClock(start.hour, start.minute)}`,
            today,
        };
    }
    return { isOpen: false, label: 'Closed', today };
};
