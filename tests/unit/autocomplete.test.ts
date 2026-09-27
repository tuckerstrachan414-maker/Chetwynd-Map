import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachAutocomplete, type Suggestion } from '../../src/ui/autocomplete';

type Item = { id: string };
const suggestion = (id: string): Suggestion<Item> => ({ item: { id }, title: `Title ${id}`, subtitle: `Sub ${id}` });

const setup = (overrides: Partial<Parameters<typeof attachAutocomplete<Item>>[0]> = {}) => {
    document.body.innerHTML = '<input id="q" /><ul id="q-list"></ul>';
    const input = document.getElementById('q') as HTMLInputElement;
    const listbox = document.getElementById('q-list') as HTMLUListElement;
    const onPick = vi.fn();
    const signals: AbortSignal[] = [];
    const fetchSuggestions = vi.fn(async (query: string, signal: AbortSignal) => {
        signals.push(signal);
        return [suggestion(`${query}-1`), suggestion(`${query}-2`)];
    });
    const autocomplete = attachAutocomplete<Item>({ input, listbox, fetchSuggestions, onPick, ...overrides });
    const type = (value: string) => {
        input.value = value;
        input.dispatchEvent(new Event('input'));
    };
    const key = (name: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: name, cancelable: true }));
    const options = () => [...listbox.querySelectorAll<HTMLElement>('[role="option"]')];
    return { input, listbox, onPick, fetchSuggestions, signals, autocomplete, type, key, options };
};

/** Lets the debounce timer fire and the (mocked) fetch settle. */
const settle = async () => {
    await vi.advanceTimersByTimeAsync(250);
};

describe('attachAutocomplete', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        Element.prototype.scrollIntoView = vi.fn();
    });
    afterEach(() => vi.useRealTimers());

    it('wires up the ARIA combobox pattern', () => {
        const { input, listbox } = setup();
        expect(input.getAttribute('role')).toBe('combobox');
        expect(input.getAttribute('aria-controls')).toBe('q-list');
        expect(input.getAttribute('aria-expanded')).toBe('false');
        expect(listbox.getAttribute('role')).toBe('listbox');
        expect(listbox.hidden).toBe(true);
    });

    it('debounces typing and shows suggestions', async () => {
        const { type, fetchSuggestions, listbox, input, options } = setup();
        type('s');
        await settle();
        expect(fetchSuggestions).not.toHaveBeenCalled(); // below minChars
        type('sa');
        type('sam');
        await settle();
        expect(fetchSuggestions).toHaveBeenCalledTimes(1);
        expect(fetchSuggestions.mock.calls[0]?.[0]).toBe('sam');
        expect(listbox.hidden).toBe(false);
        expect(input.getAttribute('aria-expanded')).toBe('true');
        expect(options().map((option) => option.textContent)).toEqual(['Title sam-1Sub sam-1', 'Title sam-2Sub sam-2']);
    });

    it('moves through suggestions with the arrow keys and picks with Enter', async () => {
        const { type, key, input, onPick, listbox, options } = setup();
        type('sam');
        await settle();
        key('ArrowDown');
        key('ArrowDown');
        expect(input.getAttribute('aria-activedescendant')).toBe('q-list-option-1');
        expect(options()[1]?.getAttribute('aria-selected')).toBe('true');
        key('ArrowDown'); // wraps around
        expect(input.getAttribute('aria-activedescendant')).toBe('q-list-option-0');
        key('Enter');
        expect(onPick).toHaveBeenCalledWith({ id: 'sam-1' }, suggestion('sam-1'));
        expect(input.value).toBe('Title sam-1');
        expect(listbox.hidden).toBe(true);
    });

    it('picks with the mouse without losing focus first', async () => {
        const { type, onPick, options } = setup();
        type('sam');
        await settle();
        const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
        options()[1]?.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(onPick).toHaveBeenCalledWith({ id: 'sam-2' }, suggestion('sam-2'));
    });

    it('aborts superseded requests and ignores their results', async () => {
        let resolveFirst: (value: Suggestion<Item>[]) => void = () => {};
        const { type, signals, options } = setup({
            fetchSuggestions: vi.fn((query: string, signal: AbortSignal) => {
                signals.push(signal);
                if (query === 'first') return new Promise<Suggestion<Item>[]>((resolve) => (resolveFirst = resolve));
                return Promise.resolve([suggestion(query)]);
            }),
        });
        type('first');
        await settle();
        type('second');
        await settle();
        expect(signals[0]?.aborted).toBe(true);
        resolveFirst([suggestion('stale')]);
        await vi.advanceTimersByTimeAsync(0);
        expect(options().map((option) => option.querySelector('.suggestion__title')?.textContent)).toEqual([
            'Title second',
        ]);
    });

    it('Enter before suggestions arrive picks the best match once they do', async () => {
        const { type, key, onPick } = setup();
        type('sam');
        key('Enter');
        await vi.advanceTimersByTimeAsync(0);
        expect(onPick).toHaveBeenCalledWith({ id: 'sam-1' }, suggestion('sam-1'));
    });

    it('hands Enter to onEnter when given', async () => {
        const onEnter = vi.fn();
        const { type, key, onPick } = setup({ onEnter });
        type('sam');
        await settle();
        key('Enter');
        expect(onEnter).toHaveBeenCalledWith('sam');
        expect(onPick).not.toHaveBeenCalled();
    });

    it('shows a message when nothing matches and closes on Escape', async () => {
        const { type, key, listbox, options } = setup({ fetchSuggestions: vi.fn(async () => []) });
        type('zzz');
        await settle();
        expect(options()).toHaveLength(1);
        expect(options()[0]?.textContent).toBe('No matches');
        expect(options()[0]?.getAttribute('aria-disabled')).toBe('true');
        key('Escape');
        expect(listbox.hidden).toBe(true);
    });

    it('reports failures and closes', async () => {
        const onError = vi.fn();
        const failure = new Error('HTTP 500');
        const { type, listbox } = setup({ fetchSuggestions: vi.fn(async () => Promise.reject(failure)), onError });
        type('sam');
        await settle();
        expect(onError).toHaveBeenCalledWith(failure);
        expect(listbox.hidden).toBe(true);
    });

    it('sets and clears the value without searching', async () => {
        const { autocomplete, input, fetchSuggestions } = setup();
        autocomplete.setValue('Downtown Chetwynd');
        expect(input.value).toBe('Downtown Chetwynd');
        autocomplete.clear();
        expect(input.value).toBe('');
        await settle();
        expect(fetchSuggestions).not.toHaveBeenCalled();
    });
});
