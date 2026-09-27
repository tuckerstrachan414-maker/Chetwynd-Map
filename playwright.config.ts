import { defineConfig, devices } from '@playwright/test';

const PORT = 4174;

// Headless Chromium draws WebGL with SwiftShader. PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH points
// at a preinstalled browser when `npx playwright install` isn't an option.
const launchOptions = {
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader', '--ignore-gpu-blocklist'],
    executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
};

export default defineConfig({
    testDir: 'tests/e2e',
    // Software WebGL is slow, especially at phone pixel ratios with parallel workers.
    timeout: 90_000,
    expect: { timeout: 15_000 },
    fullyParallel: true,
    forbidOnly: Boolean(process.env.CI),
    reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
    },
    projects: [
        { name: 'desktop', use: { ...devices['Desktop Chrome'], launchOptions } },
        { name: 'phone', use: { ...devices['Pixel 7'], launchOptions } },
    ],
    webServer: {
        command: `npm run build:e2e && npx vite preview --outDir dist-e2e --host 127.0.0.1 --port ${PORT} --strictPort`,
        url: `http://127.0.0.1:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
    },
});
