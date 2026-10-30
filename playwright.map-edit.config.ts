import {defineConfig} from '@playwright/test';
// Self-contained acceptance run for map QR position editing. The spec starts its
// own static server on an ephemeral port and stubs every /api call, so this never
// touches the live 3080 service.
export default defineConfig({testDir:'tests',testMatch:'map-tag-position.spec.ts',timeout:90000,use:{browserName:'chromium',viewport:{width:1440,height:960},launchOptions:{args:['--no-sandbox']}},reporter:'list',outputDir:'/tmp/a2-playwright-results'});
