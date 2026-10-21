import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH=root+'.browser-cache';
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');
export default defineConfig({testDir:'.',testMatch:'edit-freeze.spec.ts',timeout:40000,workers:1,
 use:{baseURL:'http://127.0.0.1:4189',browserName:'chromium',viewport:{width:1600,height:1100},launchOptions:{args:['--no-sandbox','--disable-dev-shm-usage']}},
 reporter:'list',outputDir:root+'logs/edit-freeze-browser-results',
 webServer:{cwd:root,command:'node_modules/.bin/vite preview --config web/frontend/vite.config.ts --host 127.0.0.1 --port 4189 --strictPort',url:'http://127.0.0.1:4189',reuseExistingServer:false}});
