/**
 * Tiny DOM builder. Text always goes in as text nodes (never parsed as HTML), so place
 * names, addresses and other API data can't inject markup.
 */
export type Child = Node | string | number | false | null | undefined;

type EventHandlers = { [E in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[E]) => void };

export type Props = {
    class?: string;
    /** Attributes set with `setAttribute`; `undefined`/`false` skips, `true` sets an empty attribute. */
    attrs?: Record<string, string | number | boolean | undefined>;
    dataset?: Record<string, string>;
    on?: EventHandlers;
};

export const h = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Props = {},
    children: Child[] = [],
): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    if (props.class) element.className = props.class;
    for (const [name, value] of Object.entries(props.attrs ?? {})) {
        if (value === undefined || value === false) continue;
        element.setAttribute(name, value === true ? '' : String(value));
    }
    Object.assign(element.dataset, props.dataset);
    for (const [type, handler] of Object.entries(props.on ?? {})) {
        element.addEventListener(type, handler as EventListener);
    }
    append(element, children);
    return element;
};

export const append = (parent: Element, children: Child[]): void => {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        parent.append(typeof child === 'number' ? String(child) : child);
    }
};

/** Looks up a required element; a missing one is a bug in index.html, so fail loudly. */
export const byId = <T extends HTMLElement = HTMLElement>(id: string): T => {
    const element = document.getElementById(id);
    if (!element) throw new Error(`Missing #${id} in the page`);
    return element as T;
};
