import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';
const browserCache=fileURLToPath(new URL('../../.browser-cache',import.meta.url));
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&existsSync(browserCache))process.env.PLAYWRIGHT_BROWSERS_PATH=browserCache;
// Browser setup and readiness checks stay on loopback even with host proxies.
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');
export default defineConfig({
 testDir:'.',testMatch:'sensor-status.spec.ts',timeout:20000,workers:1,
 use:{baseURL:'http://127.0.0.1:4176',browserName:'chromium',launchOptions:{args:['--no-sandbox']}},
 reporter:'list',outputDir:'/tmp/qr-sensor-browser-results',
 webServer:{cwd:fileURLToPath(new URL('../../',import.meta.url)),command:'node_modules/.bin/vite preview --config web/frontend/vite.config.ts --host 127.0.0.1 --port 4176 --strictPort',url:'http://127.0.0.1:4176',reuseExistingServer:false}
});
