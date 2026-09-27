import { byId } from '../dom';

export const TAB_IDS = ['explore', 'directions', 'drivetime'] as const;
export type TabId = (typeof TAB_IDS)[number];

export type Panel = {
    showTab(tab: TabId): void;
    currentTab(): TabId;
    /** Shows the place details view in place of the active tab's content. */
    showPlaceView(): void;
    closePlaceView(): void;
    isPlaceViewOpen(): boolean;
    /** On small screens, makes sure the bottom sheet is expanded. */
    expand(): void;
    onTabChange(listener: (tab: TabId) => void): void;
};

/** The side panel (a bottom sheet on phones): tabs, their views and the place details view. */
export const createPanel = (): Panel => {
    const panel = byId('panel');
    const toggle = byId<HTMLButtonElement>('panel-toggle');
    const placeView = byId('view-place');
    const tabs = TAB_IDS.map((id) => ({ id, tab: byId<HTMLButtonElement>(`tab-${id}`), view: byId(`view-${id}`) }));
    const listeners: ((tab: TabId) => void)[] = [];
    let current: TabId = 'explore';

    const render = () => {
        const placeOpen = !placeView.hidden;
        for (const { id, tab, view } of tabs) {
            const selected = id === current;
            tab.setAttribute('aria-selected', String(selected));
            tab.tabIndex = selected ? 0 : -1;
            view.hidden = !selected || placeOpen;
        }
    };

    const setCollapsed = (collapsed: boolean) => {
        panel.classList.toggle('panel--collapsed', collapsed);
        toggle.setAttribute('aria-expanded', String(!collapsed));
        toggle.setAttribute('aria-label', collapsed ? 'Expand panel' : 'Collapse panel');
    };

    const api: Panel = {
        showTab(tab) {
            const changed = tab !== current;
            current = tab;
            placeView.hidden = true;
            render();
            api.expand();
            if (changed) for (const listener of listeners) listener(tab);
        },
        currentTab: () => current,
        showPlaceView() {
            placeView.hidden = false;
            render();
            api.expand();
        },
        closePlaceView() {
            placeView.hidden = true;
            render();
        },
        isPlaceViewOpen: () => !placeView.hidden,
        expand: () => setCollapsed(false),
        onTabChange(listener) {
            listeners.push(listener);
        },
    };

    tabs.forEach(({ id, tab }, index) => {
        tab.addEventListener('click', () => api.showTab(id));
        // Roving focus between tabs with the arrow keys (WAI-ARIA tabs pattern).
        tab.addEventListener('keydown', (event) => {
            const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
            const target =
                event.key === 'Home'
                    ? tabs[0]
                    : event.key === 'End'
                      ? tabs.at(-1)
                      : step
                        ? tabs.at((index + step) % tabs.length)
                        : undefined;
            if (!target) return;
            event.preventDefault();
            target.tab.focus();
            api.showTab(target.id);
        });
    });
    toggle.addEventListener('click', () => setCollapsed(!panel.classList.contains('panel--collapsed')));

    render();
    return api;
};
