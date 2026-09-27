import { byId, h } from '../dom';

type ToastKind = 'info' | 'error';

const DEFAULT_TIMEOUT_MS = 5000;

/** Brief, non-blocking feedback. Errors are announced assertively to screen readers. */
export const toast = (message: string, kind: ToastKind = 'info', timeoutMs = DEFAULT_TIMEOUT_MS): void => {
    const region = byId(kind === 'error' ? 'toasts-alert' : 'toasts-status');
    const item = h('div', { class: `toast toast--${kind}` }, [message]);
    const dismiss = () => item.remove();
    item.append(
        h(
            'button',
            {
                class: 'toast__close',
                attrs: { type: 'button', 'aria-label': 'Dismiss notification' },
                on: { click: dismiss },
            },
            ['×'],
        ),
    );
    region.append(item);
    window.setTimeout(dismiss, timeoutMs);
};
