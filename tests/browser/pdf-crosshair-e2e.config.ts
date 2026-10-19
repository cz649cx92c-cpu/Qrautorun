import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../',import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH=root+'.browser-cache';
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');
export default defineConfig({testDir:'.',testMatch:'pdf-crosshair-e2e.spec.ts',timeout:180000,workers:1,
 use:{baseURL:'http://127.0.0.1:3080',viewport:{width:1600,height:1000},browserName:'chromium',launchOptions:{args:['--no-sandbox','--disable-dev-shm-usage']}},
 reporter:'list',outputDir:root+'logs/editor-ux-v3-pdf-e2e-results',
 webServer:{cwd:root,command:'node --import tsx tests/fixtures/pdf-server.ts',url:'http://127.0.0.1:4183/api/health',reuseExistingServer:false}
});
