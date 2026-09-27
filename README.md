# Chetwynd Map

An interactive map of **Chetwynd, British Columbia**, built on [TomTom Maps](https://developer.tomtom.com/):
search the town, browse places by category, get directions with live traffic, and see how far you can drive.

## What it does

- **TomTom map of Chetwynd** in seven styles: standard, driving and mono (each light or dark), plus satellite. Your choice is remembered.
- **Search as you type**, biased towards Chetwynd. Press Enter to list every match.
- **Explore by category** within 15 km of downtown, nearest first, showing whether each place is open right now:
  Eat & drink, Stay, Fuel & EV, Groceries, Health, See & do, Services, Schools.
- **Place details**: address, phone, website, today's hours (always in Chetwynd time) and distance from downtown.
- **Click anywhere** to drop a pin and see the address there, or click one of TomTom's POI icons for its details.
- **Directions with live traffic**: the fastest route plus up to two alternatives, traffic delays, arrival time,
  turn-by-turn steps, "avoid unpaved roads" and "use my location".
- **Drive-time areas**: how far you can drive in 15, 30 or 60 minutes from downtown or from any place.
- **Live traffic** flow and incident layers.
- Works on phones (the panel becomes a bottom sheet) and with the keyboard and screen readers.

## Run it on your computer

You need [Node.js 24](https://nodejs.org/) or newer and a TomTom API key.

1. **Get a TomTom API key.** Create a free account on the [TomTom Developer Portal](https://developer.tomtom.com/)
   and copy the key from your dashboard.
2. **Install and configure:**

   ```bash
   npm install
   cp .env.example .env.local   # then paste your key after VITE_TOMTOM_API_KEY=
   ```

3. **Start it:** `npm run dev`, then open the address it prints (usually http://localhost:5173).

No `.env.local`? The map asks for a key in the browser instead and keeps it in that browser only.
The **API key** button at the bottom of the panel changes it later.

## Publish it on GitHub Pages

The repository deploys itself to GitHub Pages on every push to `main`
([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)):

1. In the repository on GitHub, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
2. Under **Settings → Secrets and variables → Actions**, add a repository secret named `TOMTOM_API_KEY`
   holding your key. (Optional: without it, visitors are asked for their own key.)
3. Push to `main`, or run the **Deploy to GitHub Pages** workflow by hand. The map appears at
   `https://<your-user>.github.io/Chetwynd-Map/`.

### Keep the key safe

A map that runs in the browser has to send its key from the browser, so anyone visiting the site can see it.
In the TomTom Developer Portal ([key management](https://docs.tomtom.com/platform/documentation/my-tomtom/api-key-management)):

- limit the key to the products this map uses: maps, search, routing and traffic;
- turn on the key's **domain whitelist** and add only your site's domain (for example `your-user.github.io`).
  Use a separate key, whitelisted for `localhost`, for development.

Never commit `.env.local`; it is already in `.gitignore`.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server with live reload |
| `npm run build` | Type-checks, then builds the site into `dist/` |
| `npm run preview` | Serves the built site locally |
| `npm run typecheck` | TypeScript checks for the app and the tests |
| `npm run lint` | [Biome](https://biomejs.dev/) lint and format check (`npm run lint:fix` fixes what it can) |
| `npm test` | Unit tests ([Vitest](https://vitest.dev/)) |
| `npm run test:e2e` | End-to-end tests in Chromium, desktop and phone ([Playwright](https://playwright.dev/)) |

## How it's built

- **[TomTom Maps SDK for JavaScript](https://docs.tomtom.com/maps-sdk-js/introduction/overview)**
  (`@tomtom-org/maps-sdk`, on MapLibre GL JS 6). Its map modules draw places, routes, drive-time areas and
  traffic; its services call TomTom's Search, Routing and Traffic APIs.
- **Vite and TypeScript**, no UI framework. All text from TomTom is inserted as text, never as HTML.

```
src/
  main.ts           boot: stylesheet, MapLibre worker, API key
  app.ts            the map, camera, map clicks, error handling
  config.ts         Chetwynd's location, categories, styles, presets
  features/         explore, search, place card, directions, drive time, map controls
  ui/               panel, autocomplete, API key dialog, notifications
  format.ts         labels, links, distances, opening hours
tests/
  unit/             Vitest
  e2e/              Playwright, with a mock of TomTom's API
  fixtures/         TomTom API responses and a stand-in map style
```

### Tests

The end-to-end tests run the real SDK and MapLibre in Chromium against fixtures shaped exactly like TomTom's
API responses, so they need neither an API key nor network access.
`tests/unit/fixtures.contract.test.ts` parses those fixtures with the SDK's own parsers, so an SDK upgrade that
changes the API format fails the tests instead of quietly turning the mocks into fiction.

If Playwright can't download its browser, point `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` at an installed Chromium.

### Things the SDK needed help with

- MapLibre 6 finds its web worker next to its own file at runtime, which bundlers can't follow. `src/main.ts`
  bundles the worker and hands MapLibre its URL, otherwise the built site shows a blank map.
- MapLibre's stylesheet is bundled rather than fetched from unpkg.com at runtime.
- The SDK copies each reachable-range request, including its `AbortSignal` and the API key, into the resulting
  areas. MapLibre can't pass a signal to its worker, so the areas silently never draw.
  `src/features/driveTime.ts` keeps only the budget. It also closes boundary rings that arrive open (as in the
  SDK's own recorded responses), which otherwise leave notches where MapLibre cuts the area into tiles.

## Attribution

Maps, search, routing and traffic data © TomTom. The TomTom Maps SDK is proprietary software under
[TomTom's license](https://github.com/tomtom-international/maps-sdk-js/blob/main/LICENSE.txt); using it requires a
TomTom API key and acceptance of TomTom's terms.
