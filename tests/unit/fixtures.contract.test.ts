// @vitest-environment node
import { customizeService } from '@tomtom-org/maps-sdk/services';
import { describe, expect, it } from 'vitest';
import {
    fuzzySearchResponse,
    geometrySearchResponse,
    placeByIdResponse,
    reachableRangeResponse,
    reverseGeocodeResponse,
    routeResponse,
} from '../fixtures/tomtom';

/**
 * The end-to-end tests serve these fixtures in place of TomTom's servers. Parsing them with
 * the SDK's own parsers proves the mocks still speak the API format the SDK expects.
 */
describe('TomTom API fixtures parse with the SDK', () => {
    it('geometry (category) search', () => {
        const places = customizeService.geometrySearch.parseGeometrySearchResponse(geometrySearchResponse);
        expect(places.features.map((place) => place.properties.poi?.name)).toEqual(['Sample Café', 'Sample Diner']);
        expect(places.features[1]?.properties.poi?.categories).toEqual(['RESTAURANT']);
        expect(places.features[1]?.properties.poi?.openingHours?.timeRanges).toHaveLength(2);
        expect(places.features[1]?.geometry.coordinates).toEqual([-121.6295, 55.6962]);
    });

    it('place by id', () => {
        const place = customizeService.placeByID.parsePlaceByIdResponse(placeByIdResponse);
        expect(place?.properties.poi?.name).toBe('Sample Motel');
        expect(place?.properties.poi?.categories).toEqual(['HOTEL_MOTEL']);
    });

    it('reverse geocoding keeps the clicked position', () => {
        const place = customizeService.reverseGeocode.parseRevGeoResponse(reverseGeocodeResponse, {
            position: [-121.637, 55.701],
        });
        expect(place.properties.address.freeformAddress).toBe('47th Avenue Northwest, Chetwynd BC V0C 1J0');
        expect(place.geometry.coordinates).toEqual([-121.637, 55.701]);
    });

    it('route with guidance and an alternative', () => {
        const routes = customizeService.calculateRoute.parseCalculateRouteResponse(routeResponse, {
            locations: [
                [-121.6295, 55.6962],
                [-121.6104, 55.7032],
            ],
            guidance: { type: 'coded' },
        });
        expect(routes.features).toHaveLength(2);
        const [fastest, alternative] = routes.features;
        expect(fastest?.properties.summary).toMatchObject({ lengthInMeters: 2350, travelTimeInSeconds: 260 });
        expect(alternative?.properties.summary.trafficDelayInSeconds).toBe(90);
        expect(fastest?.properties.guidance?.instructions.map((step) => step.message)).toEqual([
            'Leave from 50th Street Southwest',
            'Turn right onto North Access Road',
            'You have arrived at your destination',
        ]);
    });

    it('reachable range', () => {
        const range = customizeService.reachableRange.parseReachableRangeResponse(reachableRangeResponse, {
            origin: [-121.6297, 55.6967],
            budget: { type: 'timeMinutes', value: 10 },
        });
        expect(range.geometry.type).toBe('Polygon');
        expect(range.bbox).toEqual([-121.71, 55.66, -121.55, 55.73]);
    });

    it('fuzzy search results', () => {
        expect(fuzzySearchResponse.results.map((result) => result.type)).toEqual(['POI', 'POI', 'Point Address']);
    });
});
