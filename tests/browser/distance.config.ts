import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const browserCache=fileURLToPath(new URL('../../.browser-cache',import.meta.url));
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&existsSync(browserCache))process.env.PLAYWRIGHT_BROWSERS_PATH=browserCache;
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');

export default defineConfig({
 testDir:'.',testMatch:'distance.spec.ts',timeout:20000,workers:1,
 use:{baseURL:'http://127.0.0.1:4177',browserName:'chromium',viewport:{width:1440,height:960},launchOptions:{args:['--no-sandbox']}},
 reporter:'list',outputDir:'/tmp/qr-distance-browser-results',
 webServer:{cwd:root,command:'node_modules/.bin/vite preview --config web/frontend/vite.config.ts --host 127.0.0.1 --port 4177 --strictPort',url:'http://127.0.0.1:4177',reuseExistingServer:false},
});
