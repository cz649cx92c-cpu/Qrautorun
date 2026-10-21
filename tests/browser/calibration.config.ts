import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH=root+'.browser-cache';
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');

// 前置步骤：npx vite build --config tests/browser/calibration-vite.config.ts
// 产物在 logs/calibration-dist；preview 只读该目录，不触碰 web/frontend/dist。
export default defineConfig({
 testDir:'.',
 testMatch:'calibration.spec.ts',
 timeout:60000,
 workers:1,
 reporter:'list',
 outputDir:root+'logs/calibration-ui-results',
 use:{baseURL:'http://127.0.0.1:4190',viewport:{width:1680,height:1100},browserName:'chromium',launchOptions:{args:['--no-sandbox','--disable-dev-shm-usage']}},
 webServer:{cwd:root,command:'node_modules/.bin/vite preview --config tests/browser/calibration-vite.config.ts --host 127.0.0.1 --port 4190 --strictPort',url:'http://127.0.0.1:4190',reuseExistingServer:false},
});
