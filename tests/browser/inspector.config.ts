import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
const browserCache=fileURLToPath(new URL('../../.browser-cache',import.meta.url));
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&existsSync(browserCache))process.env.PLAYWRIGHT_BROWSERS_PATH=browserCache;
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');

export default defineConfig({
 // 只消费本次隔离构建：vite preview 服务的是刚构建出的 web/frontend/dist。
 testDir:'.',testMatch:'inspector.spec.ts',timeout:30000,workers:1,
 use:{baseURL:'http://127.0.0.1:4199',browserName:'chromium',viewport:{width:1440,height:960},launchOptions:{args:['--no-sandbox']}},
 reporter:'list',outputDir:'/tmp/qr-ui2-browser-results',
 webServer:{cwd:root,command:'node_modules/.bin/vite preview --config web/frontend/vite.config.ts --outDir /home/orangepi/ugv/QRautorun/qr_navigation_ws/_backup_inspector_20261102-1552/build-dist --host 127.0.0.1 --port 4199 --strictPort',url:'http://127.0.0.1:4199',reuseExistingServer:false},
});
