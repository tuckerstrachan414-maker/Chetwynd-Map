import type { StandardStyleID, TomTomMap } from '@tomtom-org/maps-sdk/map';
import { standardStyleIDs, TrafficFlowModule, TrafficIncidentsModule } from '@tomtom-org/maps-sdk/map';
import { MAP_STYLE_LABELS, STORAGE_KEYS } from '../config';
import { byId, h } from '../dom';

const isStyleId = (value: string | null | undefined): value is StandardStyleID =>
    (standardStyleIDs as readonly string[]).includes(value ?? '');

/** The saved style, else light or dark to match the operating system. */
export const initialMapStyle = (): StandardStyleID => {
    try {
        const saved = localStorage.getItem(STORAGE_KEYS.mapStyle);
        if (isStyleId(saved)) return saved;
    } catch {
        // Storage unavailable: fall through to the system preference.
    }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'standardDark' : 'standardLight';
};

export const setupStyleSwitcher = (map: TomTomMap, current: StandardStyleID): void => {
    const select = byId<HTMLSelectElement>('map-style');
    select.replaceChildren(
        ...standardStyleIDs.map((id) =>
            h('option', { attrs: { value: id, selected: id === current } }, [MAP_STYLE_LABELS[id]]),
        ),
    );
    select.value = current;
    select.addEventListener('change', () => {
        if (!isStyleId(select.value)) return;
        void map.setStyle(select.value);
        try {
            localStorage.setItem(STORAGE_KEYS.mapStyle, select.value);
        } catch {
            // Not remembered across visits; the switch itself still works.
        }
    });
};

/** Live traffic flow (congestion colours) and incidents (closures, roadworks, accidents). */
export const setupTrafficToggles = async (map: TomTomMap): Promise<void> => {
    const flowToggle = byId<HTMLInputElement>('traffic-flow');
    const incidentsToggle = byId<HTMLInputElement>('traffic-incidents');
    const [flow, incidents] = await Promise.all([
        TrafficFlowModule.get(map, { visible: flowToggle.checked }),
        TrafficIncidentsModule.get(map, {
            visible: incidentsToggle.checked,
            icons: { visible: incidentsToggle.checked },
        }),
    ]);
    flowToggle.addEventListener('change', () => flow.setVisible(flowToggle.checked));
    incidentsToggle.addEventListener('change', () => {
        incidents.setVisible(incidentsToggle.checked);
        incidents.setIconsVisible(incidentsToggle.checked);
    });
};
