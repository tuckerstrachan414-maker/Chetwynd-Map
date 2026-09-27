import { expect, type Page, test } from '@playwright/test';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { FIXED_NOW } from '../fixtures/tomtom';
import { mockTomTom, type TomTomMock } from './tomtomMock';

const API_KEY = 'TestKey0123456789abcdefABCDEF0123';

/** Console noise that isn't ours: WebGL driver chatter from the software renderer. */
const IGNORED_CONSOLE = [/GPU stall due to ReadPixels/, /Automatic fallback to software WebGL/];

const trackConsoleErrors = (page: Page) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
    page.on('console', (message) => {
        if (message.type() !== 'error') return;
        const text = message.text();
        if (!IGNORED_CONSOLE.some((pattern) => pattern.test(text))) errors.push(text);
    });
    return errors;
};

const openApp = async (page: Page, { withKey = true } = {}) => {
    await page.clock.setFixedTime(FIXED_NOW);
    if (withKey) {
        await page.addInitScript((key) => localStorage.setItem('chetwynd-map.tomtomApiKey', key), API_KEY);
    }
    await page.goto('/');
};

const waitForMap = (page: Page) => expect(page.locator('body')).toHaveAttribute('data-map-ready', 'true');

/** The e2e build exposes the map (see src/app.ts). */
type MapHook = { chetwyndMap: { mapLibreMap: MapLibreMap } };

/** Titles of the pins the app has put on the map (sources `places-*` belong to the SDK's PlacesModule). */
const pinTitles = (page: Page) =>
    page.evaluate(() => {
        const map = (window as unknown as MapHook).chetwyndMap.mapLibreMap;
        const titles = Object.keys(map.getStyle().sources)
            .filter((id) => id.startsWith('places-'))
            .flatMap((id) => map.querySourceFeatures(id).map((feature) => String(feature.properties.title)));
        return [...new Set(titles)].sort();
    });

/** Whether a position shows in the part of the map not covered by the panel or the toolbar. */
const isUncovered = async (page: Page, position: [number, number]) => {
    const point = await page.evaluate(
        (lngLat) => (window as unknown as MapHook).chetwyndMap.mapLibreMap.project(lngLat),
        position,
    );
    const map = await page.locator('#map').boundingBox();
    const panel = await page.locator('#panel').boundingBox();
    const toolbar = await page.locator('#map-toolbar').boundingBox();
    if (!map || !panel || !toolbar) return false;
    const x = map.x + point.x;
    const y = map.y + point.y;
    const inside = (box: typeof map) => x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
    return inside(map) && !inside(panel) && y > toolbar.y + toolbar.height;
};

/** How many features of sources starting with `prefix` are actually drawn right now. */
const drawnFeatures = (page: Page, prefix: string) =>
    page.evaluate(
        (sourcePrefix) =>
            (window as unknown as MapHook).chetwyndMap.mapLibreMap
                .queryRenderedFeatures()
                .filter((feature) => feature.source.startsWith(sourcePrefix)).length,
        prefix,
    );

let errors: string[];
let tomtom: TomTomMock;

test.beforeEach(async ({ page }) => {
    errors = trackConsoleErrors(page);
    tomtom = await mockTomTom(page);
});

test.afterEach(() => {
    expect(
        tomtom.unexpected.map((request) => request.url.pathname),
        'unmocked TomTom requests',
    ).toEqual([]);
});

test.describe('with a TomTom API key', () => {
    test.beforeEach(async ({ page }) => {
        await openApp(page);
        await waitForMap(page);
    });

    test('loads the TomTom map of Chetwynd', async ({ page }) => {
        await expect(page.getByRole('heading', { name: 'Chetwynd Map' })).toBeVisible();
        const styleRequest = tomtom.calls(/\/maps\/orbis\/assets\/styles\//)[0];
        expect(styleRequest?.url.searchParams.get('key')).toBe(API_KEY);
        expect(styleRequest?.url.searchParams.get('map')).toMatch(/^basic_street-(light|dark)$/);
        await expect(page.getByRole('group', { name: 'Browse by category' }).getByRole('button')).toHaveCount(8);
        await expect(page.getByLabel('Map style').locator('option')).toHaveCount(7);
        expect(errors).toEqual([]);
    });

    test('explores a category, nearest first, and opens a place', async ({ page }) => {
        await page.getByRole('button', { name: 'Eat & drink' }).click();
        await expect(page.getByRole('status').filter({ hasText: '2 places · Eat & drink' })).toBeVisible();

        const [search] = tomtom.calls(/\/maps\/orbis\/places\/geometrySearch\//);
        expect(search?.url.searchParams.get('categorySet')).toBe('7315,9376');
        expect(search?.url.searchParams.get('openingHours')).toBe('nextSevenDays');
        expect(JSON.parse(search?.body ?? '{}')).toEqual({
            geometryList: [{ type: 'CIRCLE', radius: 15000, position: '55.6967,-121.6297' }],
        });

        await expect.poll(() => pinTitles(page)).toEqual(['Sample Café', 'Sample Diner']);
        await expect.poll(() => isUncovered(page, [-121.6295, 55.6962])).toBe(true);
        await expect.poll(() => isUncovered(page, [-121.6104, 55.7032])).toBe(true);

        // The API returned the café first; the list shows the nearer diner first.
        const results = page.getByRole('list', { name: 'Places' }).getByRole('button');
        await expect(results).toHaveCount(2);
        await expect(results.nth(0)).toContainText('Sample Diner');
        await expect(results.nth(0)).toContainText('Restaurant');
        await expect(results.nth(0)).toContainText('Open · closes 9 PM');
        await expect(results.nth(1)).toContainText('Sample Café');
        await expect(results.nth(1)).toContainText('Closed · opens 1 PM');

        await results.nth(0).click();
        const details = page.getByRole('article');
        await expect(details.getByRole('heading', { name: 'Sample Diner' })).toBeVisible();
        await expect.poll(() => isUncovered(page, [-121.6295, 55.6962])).toBe(true);
        await expect(details).toContainText('5100 50th Street Southwest, Chetwynd BC V0C 1J0');
        await expect(details).toContainText('Today: 7 AM – 9 PM');
        await expect(details.getByRole('link', { name: '+1 250-555-0101' })).toHaveAttribute(
            'href',
            'tel:+12505550101',
        );
        const website = details.getByRole('link', { name: 'sample-diner.example' });
        await expect(website).toHaveAttribute('href', 'https://www.sample-diner.example/');
        await expect(website).toHaveAttribute('rel', 'noopener noreferrer');

        await page.getByRole('button', { name: '← Back' }).click();
        await expect(details).toBeHidden();
        await expect(results).toHaveCount(2);

        // Pressing the active chip again clears the results.
        await page.getByRole('button', { name: 'Eat & drink' }).click();
        await expect(results).toHaveCount(0);
        expect(errors).toEqual([]);
    });

    test('searches with typeahead suggestions and the keyboard', async ({ page }) => {
        const search = page.getByRole('combobox', { name: 'Search places in and around Chetwynd' });
        await search.fill('sample');
        const suggestions = page.getByRole('listbox').getByRole('option');
        await expect(suggestions).toHaveCount(3);
        const typeahead = tomtom.calls(/\/maps\/orbis\/places\/search\//).at(-1);
        expect(typeahead?.url.searchParams.get('typeahead')).toBe('true');
        expect(typeahead?.url.searchParams.get('openingHours')).toBe('nextSevenDays');
        expect(typeahead?.url.searchParams.get('timeZone')).toBe('iana');

        await search.press('ArrowDown');
        await search.press('ArrowDown');
        await expect(suggestions.nth(1)).toHaveAttribute('aria-selected', 'true');
        await search.press('Enter');
        await expect(page.getByRole('article').getByRole('heading', { name: 'Sample Café' })).toBeVisible();
        await expect(search).toHaveValue('Sample Café');

        // Enter without choosing a suggestion lists every match.
        await search.fill('sample');
        await search.press('Enter');
        await expect(page.getByRole('status').filter({ hasText: '3 results for “sample”' })).toBeVisible();
        await expect(page.getByRole('list', { name: 'Places' }).getByRole('button')).toHaveCount(3);
        expect(errors).toEqual([]);
    });

    test('plans a drive with live traffic, alternatives and turn-by-turn steps', async ({ page }) => {
        await page.getByRole('button', { name: 'Eat & drink' }).click();
        await page
            .getByRole('list', { name: 'Places' })
            .getByRole('button', { name: /Sample Café/ })
            .click();
        await page.getByRole('button', { name: /Directions/ }).click();

        await expect(page.getByRole('tab', { name: 'Directions' })).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByRole('combobox', { name: 'To', exact: true })).toHaveValue('Sample Café');
        const from = page.getByRole('combobox', { name: 'From', exact: true });
        await expect(from).toBeFocused();
        await from.fill('sample');
        await page.getByRole('option', { name: /Sample Diner/ }).click();

        const routeOptions = page.getByRole('group', { name: 'Route options' }).getByRole('button');
        await expect(routeOptions).toHaveCount(2);
        await expect(routeOptions.nth(0)).toContainText('4 min');
        await expect(routeOptions.nth(0)).toContainText('2.4 km');
        await expect(routeOptions.nth(0)).toContainText('arrive 11:04 AM');
        await expect(routeOptions.nth(0)).toContainText('Fastest');
        await expect(routeOptions.nth(1)).toContainText('+2 min traffic');

        const [request] = tomtom.calls(/\/maps\/orbis\/routing\/routes\/calculate/);
        const body = JSON.parse(request?.body ?? '{}');
        expect(body).toMatchObject({ traffic: 'live', routeType: 'fast', maxPathAlternativeRoutes: 2 });
        expect(body.routePlanningLocations.origin.coordinates).toEqual([-121.6295, 55.6962]);
        expect(body.routePlanningLocations.destination.coordinates).toEqual([-121.6104, 55.7032]);

        await expect.poll(() => drawnFeatures(page, 'routes-0-mainLines')).toBeGreaterThan(0);
        // The camera fits the whole route into the part of the map the panel doesn't cover.
        await expect.poll(() => isUncovered(page, [-121.6295, 55.6962])).toBe(true);
        await expect.poll(() => isUncovered(page, [-121.6104, 55.7032])).toBe(true);

        const steps = page.getByRole('list', { name: 'Turn-by-turn directions' }).getByRole('button');
        await expect(steps).toHaveCount(3);
        await expect(steps.nth(1)).toContainText('Turn right onto North Access Road');
        // 850 m to the next maneuver, in the SDK's rounding for display.
        await expect(steps.nth(0)).toContainText('900 m');

        await routeOptions.nth(1).click();
        await expect(routeOptions.nth(1)).toHaveAttribute('aria-pressed', 'true');
        await expect(routeOptions.nth(0)).toHaveAttribute('aria-pressed', 'false');

        // Avoiding unpaved roads recalculates with the avoid option.
        await page.getByLabel('Avoid unpaved roads').check();
        await expect.poll(() => tomtom.calls(/\/maps\/orbis\/routing\/routes\/calculate/).length).toBe(2);
        const avoiding = JSON.parse(tomtom.calls(/\/maps\/orbis\/routing\/routes\/calculate/)[1]?.body ?? '{}');
        expect(body.avoids).toBeUndefined();
        expect(avoiding.avoids).toEqual(['unpavedRoads']);

        await page.getByRole('button', { name: 'Swap start and destination' }).click();
        await expect(page.getByRole('combobox', { name: 'From', exact: true })).toHaveValue('Sample Café');
        await expect(page.getByRole('combobox', { name: 'To', exact: true })).toHaveValue('Sample Diner');

        await page.getByRole('button', { name: 'Clear', exact: true }).click();
        await expect(routeOptions).toHaveCount(0);
        await expect(page.getByRole('combobox', { name: 'From', exact: true })).toHaveValue('');
        expect(errors).toEqual([]);
    });

    test('shows drive-time areas around downtown', async ({ page }) => {
        await page.getByRole('tab', { name: 'Drive time' }).click();
        await expect(page.getByLabel('Starting from')).toHaveValue('Downtown Chetwynd');
        await expect(page.getByRole('status').filter({ hasText: 'within 10, 20, 30 minutes' })).toBeVisible();
        const budgets = tomtom
            .calls(/\/maps\/orbis\/routing\/calculateReachableRange\//)
            .map((request) => request.url.searchParams.get('timeBudgetInSec'));
        expect(budgets.sort()).toEqual(['1200', '1800', '600']);
        // All three rings are drawn (the SDK's own request metadata used to stop them rendering).
        await expect.poll(() => drawnFeatures(page, 'geometry-')).toBeGreaterThanOrEqual(3);

        await page.getByRole('button', { name: '60 min' }).click();
        await expect(page.getByRole('status').filter({ hasText: 'within 20, 40, 60 minutes' })).toBeVisible();
        await expect(page.getByRole('button', { name: '60 min' })).toHaveAttribute('aria-pressed', 'true');
        expect(errors).toEqual([]);
    });

    test('clicking the map drops a pin and looks up the address', async ({ page }) => {
        const map = page.locator('#map canvas');
        const box = await map.boundingBox();
        if (!box) throw new Error('map canvas not rendered');
        // Somewhere clear of the panel, toolbar and controls.
        await page.mouse.click(box.x + box.width * 0.75, box.y + box.height * 0.3);

        const details = page.getByRole('article');
        await expect(details.getByRole('heading', { name: '47th Avenue Northwest' })).toBeVisible();
        await expect(details).toContainText('Chetwynd BC V0C 1J0');
        const [lookup] = tomtom.calls(/\/maps\/orbis\/places\/reverseGeocode/);
        expect(lookup?.url.searchParams.get('position')).toMatch(/^-121\.\d+,55\.\d+$/);

        await details.getByRole('button', { name: /Drive time/ }).click();
        await expect(page.getByLabel('Starting from')).toHaveValue('47th Avenue Northwest');
        expect(errors).toEqual([]);
    });

    test('toggles live traffic layers', async ({ page }) => {
        const visibility = (layer: string) =>
            page.evaluate(
                (id) => (window as unknown as MapHook).chetwyndMap.mapLibreMap.getLayoutProperty(id, 'visibility'),
                layer,
            );
        expect(await visibility('Traffic flow - line')).toBe('none');
        await page.getByLabel('Traffic', { exact: true }).check();
        expect(await visibility('Traffic flow - line')).toBe('visible');
        await page.getByLabel('Incidents').check();
        expect(await visibility('Traffic incidents - line')).toBe('visible');
        await page.getByLabel('Traffic', { exact: true }).uncheck();
        expect(await visibility('Traffic flow - line')).toBe('none');
        expect(errors).toEqual([]);
    });

    test('remembers the chosen map style', async ({ page }) => {
        await page.getByLabel('Map style').selectOption('satellite');
        await expect
            .poll(() =>
                tomtom
                    .calls(/\/maps\/orbis\/assets\/styles\//)
                    .at(-1)
                    ?.url.searchParams.get('map'),
            )
            .toBe('basic_street-satellite');
        await page.reload();
        await waitForMap(page);
        await expect(page.getByLabel('Map style')).toHaveValue('satellite');
        expect(errors).toEqual([]);
    });
});

test.describe('API key handling', () => {
    test('asks for a key on first visit, validates it, then loads the map', async ({ page }) => {
        await openApp(page, { withKey: false });
        const dialog = page.getByRole('dialog', { name: 'Connect TomTom Maps' });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByRole('link', { name: /free TomTom developer account/ })).toHaveAttribute(
            'href',
            'https://developer.tomtom.com/',
        );

        await dialog.getByLabel('TomTom API key').fill('not a key');
        await dialog.getByRole('button', { name: 'Load map' }).click();
        await expect(dialog).toContainText('doesn’t look like a TomTom API key');
        await expect(dialog.getByLabel('TomTom API key')).toHaveAttribute('aria-invalid', 'true');

        await dialog.getByLabel('TomTom API key').fill(`  ${API_KEY}  `);
        await dialog.getByRole('button', { name: 'Load map' }).click();
        await expect(dialog).toBeHidden();
        await waitForMap(page);
        expect(await page.evaluate(() => localStorage.getItem('chetwynd-map.tomtomApiKey'))).toBe(API_KEY);
        expect(tomtom.calls(/\/maps\/orbis\/assets\/styles\//)[0]?.url.searchParams.get('key')).toBe(API_KEY);
        expect(errors).toEqual([]);
    });

    test('explains a rejected key and asks for a new one', async ({ page }) => {
        await page.unrouteAll();
        tomtom = await mockTomTom(page, { failures: [{ path: /\/maps\/orbis\/places\//, status: 403 }] });
        await openApp(page);
        await waitForMap(page);

        await page.getByRole('button', { name: 'Eat & drink' }).click();
        const dialog = page.getByRole('dialog', { name: 'Connect TomTom Maps' });
        await expect(dialog).toBeVisible();
        await expect(dialog).toContainText('TomTom rejected the saved API key (HTTP 403)');
    });
});

test('the latest request wins when searches overlap', async ({ page }) => {
    await page.unrouteAll();
    tomtom = await mockTomTom(page, { delays: [{ path: /\/maps\/orbis\/places\/search\//, ms: 1500 }] });
    await openApp(page);
    await waitForMap(page);

    const search = page.getByRole('combobox', { name: 'Search places in and around Chetwynd' });
    await search.fill('sample');
    await search.press('Enter');
    // Changed their mind before the slow text search answered.
    await page.getByRole('button', { name: 'Stay' }).click();
    await expect(page.getByRole('status').filter({ hasText: '2 places · Stay' })).toBeVisible();
    await expect.poll(() => tomtom.calls(/\/maps\/orbis\/places\/search\//).length).toBeGreaterThan(0);
    await page.waitForTimeout(2000);
    await expect(page.getByRole('status').filter({ hasText: '2 places · Stay' })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Places' }).getByRole('button')).toHaveCount(2);
    expect(errors).toEqual([]);
});

test.describe('when TomTom can’t help', () => {
    test('says so when no drivable route exists', async ({ page }) => {
        await page.unrouteAll();
        tomtom = await mockTomTom(page, { failures: [{ path: /\/maps\/orbis\/routing\//, status: 400 }] });
        await openApp(page);
        await waitForMap(page);

        await page.getByRole('tab', { name: 'Directions' }).click();
        await page.getByRole('combobox', { name: 'From', exact: true }).fill('sample');
        await page.getByRole('option', { name: /Sample Diner/ }).click();
        await page.getByRole('combobox', { name: 'To', exact: true }).fill('sample');
        await page.getByRole('option', { name: /Sample Café/ }).click();
        await expect(page.getByText('No drivable route found between these places.')).toBeVisible();

        await page.getByRole('tab', { name: 'Drive time' }).click();
        await expect(page.getByText('Drive times need a starting point on or near a road.')).toBeVisible();
        // Only the browser's own log of the mocked 400 responses; nothing from the app.
        expect(errors.filter((error) => !error.includes('status of 400 (Bad Request)'))).toEqual([]);
    });

    test('shows a clear message when the map can’t load', async ({ page }) => {
        await page.unrouteAll();
        tomtom = await mockTomTom(page, { failures: [{ path: /\/maps\/orbis\/assets\/styles\//, status: 503 }] });
        await openApp(page);
        await expect(page.getByRole('alert').filter({ hasText: 'Couldn’t load the TomTom map' })).toBeVisible();
        await expect(page.locator('body')).not.toHaveAttribute('data-map-ready', 'true');
    });
});

test.describe('on a phone', () => {
    test.skip(({ isMobile }) => !isMobile, 'phone layout only');

    test('the panel is a bottom sheet that collapses', async ({ page }) => {
        await openApp(page);
        await waitForMap(page);
        const toggle = page.getByRole('button', { name: 'Collapse panel' });
        await expect(toggle).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Explore' })).toBeVisible();
        await toggle.click();
        await expect(page.getByRole('button', { name: 'Expand panel' })).toHaveAttribute('aria-expanded', 'false');
        await expect(page.getByRole('tab', { name: 'Explore' })).toBeHidden();
        // Search stays available while collapsed.
        await expect(page.getByRole('combobox', { name: 'Search places in and around Chetwynd' })).toBeVisible();
        expect(errors).toEqual([]);
    });
});
