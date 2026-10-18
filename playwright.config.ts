import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'tests',testMatch:'browser.spec.ts',timeout:60000,use:{browserName:'chromium',viewport:{width:1440,height:960},launchOptions:{args:['--no-sandbox']}},reporter:'list',outputDir:'logs/browser-results'});
