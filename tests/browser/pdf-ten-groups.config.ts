import {defineConfig} from '@playwright/test';
import base from './pdf-crosshair-e2e.config';
export default defineConfig({...base,testMatch:'pdf-ten-groups.spec.ts',use:{...base.use,baseURL:process.env.PDF_TEN_BASE_URL??'http://127.0.0.1:3080'},outputDir:'/home/orangepi/ugv/QRautorun/qr_navigation_ws/logs/editor-ux-v3-print-ten-results'});
