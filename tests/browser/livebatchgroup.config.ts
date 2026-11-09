import {defineConfig} from '@playwright/test';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const browserCache=fileURLToPath(new URL('../../.browser-cache',import.meta.url));
if(!process.env.PLAYWRIGHT_BROWSERS_PATH&&existsSync(browserCache))process.env.PLAYWRIGHT_BROWSERS_PATH=browserCache;
process.env.NO_PROXY=[process.env.NO_PROXY,'127.0.0.1','localhost','192.168.101.213'].filter(Boolean).join(',');
export default defineConfig({testDir:'.',testMatch:'livebatchgroup.spec.ts',timeout:180000,workers:1,
 use:{baseURL:'http://192.168.101.213:3080',browserName:'chromium',viewport:{width:1440,height:900},launchOptions:{args:['--no-sandbox']}},
 reporter:'list',outputDir:'/tmp/qr-livebg'});
