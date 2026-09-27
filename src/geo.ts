import type { Place, PolygonFeature } from '@tomtom-org/maps-sdk/core';
import type { BBox, LngLat } from './config';

type AreaGeometry = PolygonFeature['geometry'];
type Ring = number[][];

const EARTH_RADIUS_METERS = 6_371_008.8;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Great-circle (haversine) distance between two positions, in meters. */
export const distanceMeters = ([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number => {
    const dLat = toRadians(lat2 - lat1);
    const dLng = toRadians(lng2 - lng1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(a)));
};

export const placePosition = (place: Place): LngLat => {
    const [lng = 0, lat = 0] = place.geometry.coordinates;
    return [lng, lat];
};

export const isWithinBBox = ([lng, lat]: LngLat, [west, south, east, north]: BBox): boolean =>
    lng >= west && lng <= east && lat >= south && lat <= north;

/** A place at a bare position — a dropped pin, the user's location, the town centre. */
export const pointPlace = (position: LngLat, label: string, id?: string): Place => ({
    type: 'Feature',
    id: id ?? `point:${position[0].toFixed(6)},${position[1].toFixed(6)}`,
    geometry: { type: 'Point', coordinates: [position[0], position[1]] },
    properties: { type: 'Point Address', address: { freeformAddress: label } },
});

export const formatCoordinates = ([lng, lat]: LngLat): string =>
    `${Math.abs(lat).toFixed(5)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(5)}° ${lng >= 0 ? 'E' : 'W'}`;

const closeRing = (ring: Ring): Ring => {
    const first = ring[0];
    const last = ring.at(-1);
    if (!first || !last || (first[0] === last[0] && first[1] === last[1])) return ring;
    return [...ring, first];
};

/**
 * Ends every ring where it starts, as GeoJSON requires. Reachable-range boundaries can arrive
 * open (the SDK passes TomTom's point list through as is), and MapLibre loses the missing closing
 * edge where it cuts a polygon into tiles, leaving notches in the drawn area.
 */
export const closeRings = (geometry: AreaGeometry): AreaGeometry =>
    geometry.type === 'Polygon'
        ? { ...geometry, coordinates: geometry.coordinates.map(closeRing) }
        : { ...geometry, coordinates: geometry.coordinates.map((polygon) => polygon.map(closeRing)) };

/** Sorts places nearest-first from `origin`, without mutating the input. */
export const sortByDistance = <T extends Place>(places: readonly T[], origin: LngLat): T[] =>
    places
        .map((place) => ({ place, meters: distanceMeters(origin, placePosition(place)) }))
        .sort((a, b) => a.meters - b.meters)
        .map(({ place }) => place);
