import { clearStoredApiKey, isPlausibleApiKey, normalizeApiKey, storeApiKey } from '../apiKey';
import { byId } from '../dom';

export type KeyDialogOptions = {
    /** Why the dialog is shown, e.g. a rejected key. Omitted on first run. */
    reason?: string;
    /** Whether the build ships its own key (lets the visitor go back to it). */
    hasBuildKey: boolean;
};

/**
 * Asks for a TomTom API key. Resolves with the key the visitor entered (already stored in
 * this browser), or with `null` if they chose to fall back to the site's built-in key.
 */
export const promptForApiKey = ({ reason, hasBuildKey }: KeyDialogOptions): Promise<string | null> => {
    const dialog = byId<HTMLDialogElement>('key-dialog');
    const form = byId<HTMLFormElement>('key-form');
    const input = byId<HTMLInputElement>('key-input');
    const error = byId('key-error');
    const reasonText = byId('key-reason');
    const useBuildKey = byId<HTMLButtonElement>('key-use-default');

    reasonText.textContent = reason ?? '';
    reasonText.hidden = !reason;
    useBuildKey.hidden = !hasBuildKey;
    error.textContent = '';
    input.value = '';
    input.removeAttribute('aria-invalid');

    return new Promise((resolve) => {
        const finish = (result: string | null) => {
            form.removeEventListener('submit', onSubmit);
            useBuildKey.removeEventListener('click', onUseBuildKey);
            dialog.removeEventListener('cancel', onCancel);
            dialog.close();
            resolve(result);
        };
        const onSubmit = (event: SubmitEvent) => {
            event.preventDefault();
            const key = normalizeApiKey(input.value);
            if (!key || !isPlausibleApiKey(key)) {
                error.textContent =
                    'That doesn’t look like a TomTom API key. Keys are long strings of letters and digits.';
                input.setAttribute('aria-invalid', 'true');
                input.focus();
                return;
            }
            storeApiKey(key);
            finish(key);
        };
        const onUseBuildKey = () => {
            clearStoredApiKey();
            finish(null);
        };
        // The map can't work without a key, so Escape doesn't dismiss the dialog.
        const onCancel = (event: Event) => event.preventDefault();

        form.addEventListener('submit', onSubmit);
        useBuildKey.addEventListener('click', onUseBuildKey);
        dialog.addEventListener('cancel', onCancel);
        dialog.showModal();
        input.focus();
    });
};
