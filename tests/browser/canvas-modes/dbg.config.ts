import {defineConfig} from '@playwright/test';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../../../',import.meta.url));
process.env.PLAYWRIGHT_BROWSERS_PATH=root+'/.browser-cache';
process.env.NO_PROXY='127.0.0.1,localhost';
export default defineConfig({testDir:root+'tests/browser/canvas-modes',testMatch:'debug.spec.ts',timeout:30000,workers:1,reporter:'list',use:{baseURL:'http://127.0.0.1:4291',browserName:'chromium',launchOptions:{args:['--no-sandbox']}},webServer:{cwd:root,command:'node_modules/.bin/vite --config tests/browser/canvas-modes/vite.config.ts --host 127.0.0.1 --port 4291 --strictPort',url:'http://127.0.0.1:4291/tests/browser/canvas-modes/index.html',reuseExistingServer:false,timeout:120000}});
