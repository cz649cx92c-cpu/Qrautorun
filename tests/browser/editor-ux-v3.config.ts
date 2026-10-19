import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH=root+'.browser-cache';
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');
export default defineConfig({testDir:'.',testMatch:'editor-ux-v3.spec.ts',timeout:30000,workers:1,
 use:{baseURL:'http://127.0.0.1:4181',browserName:'chromium',launchOptions:{args:['--no-sandbox','--disable-dev-shm-usage']}},
 reporter:'list',outputDir:root+'logs/editor-ux-v3-browser-results',
 webServer:{cwd:root,command:'node_modules/.bin/vite preview --config web/frontend/vite.config.ts --host 127.0.0.1 --port 4181 --strictPort',url:'http://127.0.0.1:4181',reuseExistingServer:false}
});
