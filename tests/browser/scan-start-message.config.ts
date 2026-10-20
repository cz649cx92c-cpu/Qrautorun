import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH=root+'.browser-cache';
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');
export default defineConfig({testDir:'.',testMatch:['scan-start-message.spec.ts'],workers:1,timeout:25000,reporter:'list',outputDir:root+'logs/mapping-blocker-20261019/browser-results',use:{baseURL:'http://127.0.0.1:4186',viewport:{width:1600,height:1000},browserName:'chromium',launchOptions:{args:['--no-sandbox','--disable-dev-shm-usage']}},webServer:{cwd:root,command:'node_modules/.bin/vite preview --config web/frontend/vite.config.ts --outDir '+root+'logs/mapping-blocker-20261019/dist --host 127.0.0.1 --port 4186 --strictPort',url:'http://127.0.0.1:4186',reuseExistingServer:false}});
