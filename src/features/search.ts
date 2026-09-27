import type { Place } from '@tomtom-org/maps-sdk/core';
import { search } from '@tomtom-org/maps-sdk/services';
import { CHETWYND_CENTER } from '../config';
import type { AppContext } from '../context';
import { byId } from '../dom';
import { placeSubtitle, placeTitle } from '../format';
import { attachAutocomplete, type Suggestion } from '../ui/autocomplete';

/** Typeahead place suggestions from TomTom, biased towards Chetwynd. Shared by every place input. */
export const suggestPlaces = async (query: string, signal: AbortSignal): Promise<Suggestion<Place>[]> => {
    const response = await search({
        query,
        typeahead: true,
        limit: 7,
        geoBias: { position: CHETWYND_CENTER },
        // Picked suggestions open straight into the place card, hours included.
        openingHours: 'nextSevenDays',
        timeZone: 'iana',
        signal,
    });
    return response.features.map((place) => ({
        item: place,
        title: placeTitle(place),
        subtitle: placeSubtitle(place),
    }));
};

/** The main search box: suggestions as you type; Enter lists every match (see Explore). */
export const createSearchBox = (ctx: AppContext, searchText: (query: string) => Promise<void>): void => {
    const input = byId<HTMLInputElement>('search-input');
    const clearButton = byId<HTMLButtonElement>('search-clear');

    const syncClearButton = () => {
        clearButton.hidden = input.value.length === 0;
    };

    const autocomplete = attachAutocomplete<Place>({
        input,
        listbox: byId<HTMLUListElement>('search-suggestions'),
        fetchSuggestions: suggestPlaces,
        onPick: (place) => {
            syncClearButton();
            void ctx.showPlace(place, { fly: 'always' });
        },
        onEnter: (query) => void searchText(query),
        onError: (error) => ctx.reportError(error, 'looking up suggestions'),
    });

    input.addEventListener('input', syncClearButton);
    clearButton.addEventListener('click', () => {
        autocomplete.clear();
        syncClearButton();
        input.focus();
    });
    syncClearButton();
};
