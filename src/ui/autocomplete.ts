import { h } from '../dom';

export type Suggestion<T> = { item: T; title: string; subtitle?: string };

export type AutocompleteOptions<T> = {
    input: HTMLInputElement;
    listbox: HTMLUListElement;
    /** Called (debounced) as the visitor types. Stale calls are aborted through `signal`. */
    fetchSuggestions: (query: string, signal: AbortSignal) => Promise<Suggestion<T>[]>;
    onPick: (item: T, suggestion: Suggestion<T>) => void;
    /** Enter without a highlighted suggestion. When omitted, Enter picks the first suggestion. */
    onEnter?: (query: string) => void;
    onError?: (error: unknown) => void;
    minChars?: number;
    debounceMs?: number;
};

export type Autocomplete = {
    /** Sets the input text without searching. */
    setValue(text: string): void;
    close(): void;
    clear(): void;
};

/**
 * An accessible combobox (WAI-ARIA 1.2 pattern) over any async suggestion source:
 * arrow keys move through the list, Enter picks, Escape closes.
 */
export const attachAutocomplete = <T>(options: AutocompleteOptions<T>): Autocomplete => {
    const { input, listbox, fetchSuggestions, onPick, onEnter, onError } = options;
    const minChars = options.minChars ?? 2;
    const debounceMs = options.debounceMs ?? 200;

    let suggestions: Suggestion<T>[] = [];
    /** The query the shown suggestions belong to. */
    let renderedQuery = '';
    let active = -1;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    let pickFirstWhenReady = false;

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', listbox.id);
    input.setAttribute('aria-expanded', 'false');
    input.autocomplete = 'off';
    listbox.setAttribute('role', 'listbox');
    listbox.hidden = true;

    const optionId = (index: number) => `${listbox.id}-option-${index}`;

    const setActive = (index: number) => {
        active = index;
        listbox.querySelectorAll<HTMLElement>('[role="option"]').forEach((option, i) => {
            option.setAttribute('aria-selected', String(i === index));
        });
        if (index >= 0) {
            input.setAttribute('aria-activedescendant', optionId(index));
            document.getElementById(optionId(index))?.scrollIntoView({ block: 'nearest' });
        } else {
            input.removeAttribute('aria-activedescendant');
        }
    };

    const open = () => {
        listbox.hidden = false;
        input.setAttribute('aria-expanded', 'true');
    };

    const close = () => {
        listbox.hidden = true;
        input.setAttribute('aria-expanded', 'false');
        setActive(-1);
    };

    const cancelPending = () => {
        window.clearTimeout(timer);
        controller?.abort();
        controller = undefined;
        pickFirstWhenReady = false;
        listbox.removeAttribute('aria-busy');
    };

    const pick = (index: number) => {
        const suggestion = suggestions[index];
        if (!suggestion) return;
        cancelPending();
        input.value = suggestion.title;
        close();
        onPick(suggestion.item, suggestion);
    };

    const showMessage = (message: string) => {
        suggestions = [];
        listbox.replaceChildren(
            h('li', { class: 'suggestion suggestion--message', attrs: { role: 'option', 'aria-disabled': 'true' } }, [
                message,
            ]),
        );
        setActive(-1);
        open();
    };

    const render = (query: string, results: Suggestion<T>[]) => {
        suggestions = results;
        renderedQuery = query;
        if (!results.length) {
            showMessage('No matches');
            return;
        }
        listbox.replaceChildren(
            ...results.map((suggestion, index) =>
                h(
                    'li',
                    {
                        class: 'suggestion',
                        attrs: { id: optionId(index), role: 'option', 'aria-selected': 'false' },
                        // mousedown (not click) so the input keeps focus and doesn't blur first.
                        on: {
                            mousedown: (event) => {
                                event.preventDefault();
                                pick(index);
                            },
                        },
                    },
                    [
                        h('span', { class: 'suggestion__title' }, [suggestion.title]),
                        suggestion.subtitle
                            ? h('span', { class: 'suggestion__subtitle' }, [suggestion.subtitle])
                            : null,
                    ],
                ),
            ),
        );
        setActive(-1);
        open();
    };

    const run = async (query: string) => {
        controller?.abort();
        controller = new AbortController();
        const { signal } = controller;
        listbox.setAttribute('aria-busy', 'true');
        try {
            const results = await fetchSuggestions(query, signal);
            if (signal.aborted) return;
            listbox.removeAttribute('aria-busy');
            render(query, results);
            if (pickFirstWhenReady) {
                pickFirstWhenReady = false;
                pick(0);
            }
        } catch (error) {
            if (signal.aborted) return;
            listbox.removeAttribute('aria-busy');
            pickFirstWhenReady = false;
            close();
            onError?.(error);
        }
    };

    input.addEventListener('input', () => {
        cancelPending();
        const query = input.value.trim();
        if (query.length < minChars) {
            suggestions = [];
            close();
            return;
        }
        timer = window.setTimeout(() => void run(query), debounceMs);
    });

    input.addEventListener('keydown', (event) => {
        const count = suggestions.length;
        switch (event.key) {
            case 'ArrowDown':
                if (!count) return;
                event.preventDefault();
                open();
                setActive((active + 1) % count);
                return;
            case 'ArrowUp':
                if (!count) return;
                event.preventDefault();
                open();
                setActive(active <= 0 ? count - 1 : active - 1);
                return;
            case 'Enter': {
                const query = input.value.trim();
                if (active >= 0 && !listbox.hidden) {
                    event.preventDefault();
                    pick(active);
                } else if (onEnter && query) {
                    event.preventDefault();
                    cancelPending();
                    close();
                    onEnter(query);
                } else if (query.length >= minChars) {
                    event.preventDefault();
                    if (count && renderedQuery === query) {
                        pick(0);
                    } else {
                        // Suggestions for the latest text aren't in yet: fetch now, then pick the best.
                        cancelPending();
                        pickFirstWhenReady = true;
                        void run(query);
                    }
                }
                return;
            }
            case 'Escape':
                if (!listbox.hidden) {
                    event.preventDefault();
                    close();
                }
                return;
            default:
        }
    });

    input.addEventListener('blur', close);
    input.addEventListener('focus', () => {
        if (suggestions.length && input.value.trim().length >= minChars) open();
    });

    return {
        setValue(text: string) {
            cancelPending();
            suggestions = [];
            input.value = text;
            close();
        },
        close,
        clear() {
            cancelPending();
            suggestions = [];
            input.value = '';
            close();
        },
    };
};
