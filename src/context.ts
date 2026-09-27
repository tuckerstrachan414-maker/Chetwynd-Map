import type { Place } from '@tomtom-org/maps-sdk/core';
import type { TomTomMap } from '@tomtom-org/maps-sdk/map';
import type { BBox, LngLat } from './config';
import type { Panel } from './ui/panel';

export type ShowPlaceOptions = {
    /** Move the camera to the place (default: only if it's outside the visible area). */
    fly?: 'always' | 'if-hidden' | 'never';
    /** The place is one of the pins in the results list, so highlight that pin instead of adding one. */
    fromResults?: boolean;
};

/** What the features share: the map, the panel and a few cross-feature actions. */
export type AppContext = {
    map: TomTomMap;
    panel: Panel;
    showPlace(place: Place, options?: ShowPlaceOptions): Promise<void>;
    clearSelection(): Promise<void>;
    /** Fits the camera to a bbox, keeping it clear of the panel. */
    fitBounds(bbox: BBox, options?: { maxZoom?: number }): void;
    flyTo(position: LngLat, zoom?: number): void;
    /** Reports a failed TomTom call: ignores aborts, re-prompts for the key on 401/403, toasts the rest. */
    reportError(error: unknown, doing: string): void;
};
