import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';

// 自包含：vite dev 只服务 tests/browser/canvas-modes 夹具（只挂 MapCanvas.vue），
// 不启动后端、不连设备、不写 DB。端口用一个非常用端口避免和别人冲突。
const root=fileURLToPath(new URL('../../../',import.meta.url));
const browserCache=fileURLToPath(new URL('../../../.browser-cache',import.meta.url));
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&existsSync(browserCache))process.env.PLAYWRIGHT_BROWSERS_PATH=browserCache;
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost'].filter(Boolean).join(',');

const PORT=Number(process.env.CANVAS_MODES_PORT??4291);
const BASE=`http://127.0.0.1:${PORT}`;

export default defineConfig({
 testDir:'.',testMatch:'canvas-interaction-modes.spec.ts',timeout:30000,workers:1,
 use:{baseURL:BASE,browserName:'chromium',viewport:{width:1280,height:800},launchOptions:{args:['--no-sandbox','--disable-dev-shm-usage']}},
 reporter:'list',outputDir:'/tmp/canvas-modes-results',
 webServer:{
  cwd:root,
  command:`node_modules/.bin/vite --config tests/browser/canvas-modes/vite.config.ts --host 127.0.0.1 --port ${PORT} --strictPort`,
  url:`${BASE}/tests/browser/canvas-modes/index.html`,
  reuseExistingServer:false,
  timeout:120000,
 },
});
