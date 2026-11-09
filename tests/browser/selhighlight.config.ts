import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const browserCache=fileURLToPath(new URL('../../.browser-cache',import.meta.url));
const isolatedBuild='/home/orangepi/ugv/QRautorun/qr_navigation_ws/_backup_5fix_build';
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&existsSync(browserCache))process.env.PLAYWRIGHT_BROWSERS_PATH=browserCache;
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');

export default defineConfig({
 testDir:'.',testMatch:'selhighlight.spec.ts',timeout:60000,workers:1,
 use:{baseURL:'http://127.0.0.1:4199',browserName:'chromium',viewport:{width:1280,height:800},launchOptions:{args:['--no-sandbox']}},
 reporter:'list',outputDir:'/tmp/qr-selhighlight',
 webServer:{cwd:root,command:`node_modules/.bin/vite preview --config web/frontend/vite.config.ts --outDir ${isolatedBuild} --host 127.0.0.1 --port 4199 --strictPort`,url:'http://127.0.0.1:4199',reuseExistingServer:false},
});
