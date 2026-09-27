import type { Language, POICategory } from '@tomtom-org/maps-sdk/core';
import type { StandardStyleID } from '@tomtom-org/maps-sdk/map';

export type LngLat = [longitude: number, latitude: number];
export type BBox = [west: number, south: number, east: number, north: number];

/** Downtown Chetwynd, British Columbia (50th Street at the Highway 97 access roads). */
export const CHETWYND_CENTER: LngLat = [-121.6297, 55.6967];

/** The town and its immediate surroundings: the map's home view. */
export const CHETWYND_BOUNDS: BBox = [-121.665, 55.683, -121.588, 55.716];

/** Label used for {@link CHETWYND_CENTER} wherever it acts as a place. */
export const TOWN_CENTRE_LABEL = 'Downtown Chetwynd';

/** Explore categories search inside this circle around the town centre. */
export const EXPLORE_RADIUS_METERS = 15_000;

/** Maximum number of results for an Explore category (the TomTom API allows up to 100). */
export const EXPLORE_RESULT_LIMIT = 100;

/**
 * Language for map labels and service responses. `en-US` is accepted by every TomTom
 * API the app calls (search, routing guidance, traffic), unlike some regional variants.
 */
export const LANGUAGE: Language = 'en-US';

/** Chetwynd keeps Mountain Standard Time all year, like the rest of the South Peace. */
export const LOCAL_TIME_ZONE = 'America/Dawson_Creek';

export type ExploreCategory = {
    id: string;
    label: string;
    icon: string;
    /** TomTom POI category codes; the Search API accepts at most 10 per request. */
    codes: POICategory[];
};

export const EXPLORE_CATEGORIES: readonly ExploreCategory[] = [
    { id: 'eat', label: 'Eat & drink', icon: '🍽️', codes: ['RESTAURANT', 'CAFE_PUB'] },
    { id: 'stay', label: 'Stay', icon: '🛏️', codes: ['HOTEL_MOTEL', 'CAMPING_GROUND'] },
    { id: 'fuel', label: 'Fuel & EV', icon: '⛽', codes: ['GAS_STATION', 'ELECTRIC_VEHICLE_STATION'] },
    {
        id: 'groceries',
        label: 'Groceries',
        icon: '🛒',
        codes: ['SUPERMARKETS_HYPERMARKETS', 'GROCERY_STORE', 'CONVENIENCE_STORE'],
    },
    {
        id: 'health',
        label: 'Health',
        icon: '🏥',
        codes: ['HOSPITAL', 'PHARMACY', 'HEALTH_CARE_SERVICE', 'DOCTOR', 'DENTIST'],
    },
    {
        id: 'see-do',
        label: 'See & do',
        icon: '🪵',
        codes: [
            'TOURIST_ATTRACTION',
            'MUSEUM',
            'TOURIST_INFORMATION_OFFICE',
            'PARK_RECREATION_AREA',
            'HIKING_TRAIL',
            'TRAIL_SYSTEM',
            'COMMUNITY_CENTER',
            'LEISURE_SPORTS_CENTER',
            'GOLF_COURSE',
            'STADIUM',
        ],
    },
    {
        id: 'services',
        label: 'Services',
        icon: '🏛️',
        codes: ['GOVERNMENT_OFFICE', 'POLICE_STATION', 'FIRE_STATION_BRIGADE', 'POST_OFFICE', 'LIBRARY', 'BANK', 'ATM'],
    },
    { id: 'schools', label: 'Schools', icon: '🎓', codes: ['SCHOOL', 'COLLEGE_UNIVERSITY', 'CHILD_CARE_FACILITY'] },
];

export const MAP_STYLE_LABELS = {
    standardLight: 'Standard',
    standardDark: 'Standard (dark)',
    drivingLight: 'Driving',
    drivingDark: 'Driving (dark)',
    monoLight: 'Mono',
    monoDark: 'Mono (dark)',
    satellite: 'Satellite',
} as const satisfies Record<StandardStyleID, string>;

/** Drive-time presets: each shows three rings at a third, two thirds and all of the budget. */
export const DRIVE_TIME_PRESETS_MINUTES = [15, 30, 60] as const;
export type DriveTimePreset = (typeof DRIVE_TIME_PRESETS_MINUTES)[number];

/** Rings at a third, two thirds and all of the budget: 15 → 5/10/15 min. */
export const ringMinutes = (budget: DriveTimePreset): number[] =>
    [1, 2, 3].map((part) => Math.round((budget * part) / 3));

export const STORAGE_KEYS = {
    apiKey: 'chetwynd-map.tomtomApiKey',
    mapStyle: 'chetwynd-map.mapStyle',
} as const;
