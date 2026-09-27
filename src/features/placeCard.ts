import type { Place } from '@tomtom-org/maps-sdk/core';
import { CHETWYND_CENTER, LOCAL_TIME_ZONE } from '../config';
import { h } from '../dom';
import {
    formatMeters,
    openStatus,
    placeCategory,
    placeSubtitle,
    placeTitle,
    safeExternalUrl,
    telHref,
    urlLabel,
} from '../format';
import { distanceMeters, formatCoordinates, placePosition } from '../geo';

export type PlaceCardActions = {
    back(): void;
    directionsTo(place: Place): void;
    directionsFrom(place: Place): void;
    driveTimeFrom(place: Place): void;
};

const actionButton = (label: string, icon: string, onClick: () => void, primary = false) =>
    h(
        'button',
        { class: `button${primary ? ' button--primary' : ''}`, attrs: { type: 'button' }, on: { click: onClick } },
        [h('span', { attrs: { 'aria-hidden': 'true' } }, [icon]), ` ${label}`],
    );

/** Renders a place's details (POI or address) with its actions into `container`. */
export const renderPlaceCard = (container: HTMLElement, place: Place, actions: PlaceCardActions): void => {
    const { poi } = place.properties;
    const position = placePosition(place);
    const category = placeCategory(place);
    const subtitle = placeSubtitle(place);
    const website = safeExternalUrl(poi?.url);
    const phone = telHref(poi?.phone);
    const hours = poi?.openingHours ? openStatus(poi.openingHours, poi.timeZone?.ianaId ?? LOCAL_TIME_ZONE) : undefined;
    const fromDowntown = distanceMeters(CHETWYND_CENTER, position);

    container.replaceChildren(
        h('button', { class: 'link-button place__back', attrs: { type: 'button' }, on: { click: actions.back } }, [
            '← Back',
        ]),
        h('article', { class: 'place', attrs: { 'aria-labelledby': 'place-title' } }, [
            category ? h('p', { class: 'place__category' }, [category]) : null,
            h('h2', { class: 'place__title', attrs: { id: 'place-title', tabindex: '-1' } }, [placeTitle(place)]),
            subtitle ? h('p', { class: 'place__address' }, [subtitle]) : null,
            hours
                ? h('p', { class: `place__hours ${hours.isOpen ? 'is-open' : 'is-closed'}` }, [
                      h('strong', {}, [hours.label]),
                      hours.today ? h('span', { class: 'place__hours-today' }, [`Today: ${hours.today}`]) : null,
                  ])
                : null,
            h('dl', { class: 'place__facts' }, [
                phone && poi?.phone
                    ? h('div', {}, [
                          h('dt', {}, ['Phone']),
                          h('dd', {}, [h('a', { attrs: { href: phone } }, [poi.phone])]),
                      ])
                    : null,
                website
                    ? h('div', {}, [
                          h('dt', {}, ['Website']),
                          h('dd', {}, [
                              h('a', { attrs: { href: website, target: '_blank', rel: 'noopener noreferrer' } }, [
                                  urlLabel(website),
                              ]),
                          ]),
                      ])
                    : null,
                h('div', {}, [
                    h('dt', {}, ['Distance']),
                    h('dd', {}, [
                        fromDowntown < 50
                            ? 'Downtown'
                            : `${formatMeters(fromDowntown)} from downtown, as the crow flies`,
                    ]),
                ]),
                h('div', {}, [h('dt', {}, ['Coordinates']), h('dd', {}, [formatCoordinates(position)])]),
            ]),
            h('div', { class: 'place__actions' }, [
                actionButton('Directions', '➜', () => actions.directionsTo(place), true),
                actionButton('Start here', '⦿', () => actions.directionsFrom(place)),
                actionButton('Drive time', '◎', () => actions.driveTimeFrom(place)),
            ]),
        ]),
    );
    container.querySelector<HTMLElement>('#place-title')?.focus({ preventScroll: true });
};
