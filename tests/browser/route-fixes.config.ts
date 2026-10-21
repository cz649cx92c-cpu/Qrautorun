import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH=root+'.browser-cache';
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');

// 前置步骤：npx vite build --config tests/browser/route-fixes-vite.config.ts
// 产物写入 logs/route-fixes-dist，preview 只读该目录，不触碰生产 web/frontend/dist。
export default defineConfig({
 testDir:'.',
 testMatch:'route-fixes.spec.ts',
 timeout:60000,
 workers:1,
 reporter:'list',
 outputDir:root+'logs/route-fixes-results',
 use:{baseURL:'http://127.0.0.1:4192',viewport:{width:1600,height:1100},browserName:'chromium',launchOptions:{args:['--no-sandbox','--disable-dev-shm-usage']}},
 webServer:{cwd:root,command:'node_modules/.bin/vite preview --config tests/browser/route-fixes-vite.config.ts --host 127.0.0.1 --port 4192 --strictPort',url:'http://127.0.0.1:4192',reuseExistingServer:false},
});
