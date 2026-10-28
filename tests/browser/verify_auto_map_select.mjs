// 真实浏览器验收「切图即生效」：不点任何"启用此地图"，选图即切图。
// 切换前才装 page.route 拦截 POST /api/localization/map，只记录请求体、不落盘，
// 因此不会改写线上 maps/office-confirmed.json，也不会真的把定位切到别的图。
import {chromium} from '@playwright/test';

const BASE = 'http://127.0.0.1:3080';
const CURRENT = 'scan-20d66e9525fd417a9c0c2592714e8f7a';

const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1440, height: 960}});

await page.goto(BASE, {waitUntil: 'domcontentloaded'});
await page.waitForSelector('nav[aria-label="主导航"]', {timeout: 20000});
await page.click('nav[aria-label="主导航"] button[title="开始导航"]');
await page.waitForTimeout(2500);

const enableButton = await page.$('[data-testid="enable-map"]');
const bodyHtml = await page.content();
const hasEnableText = bodyHtml.includes('启用此地图') || bodyHtml.includes('确认启用地图');
const options = await page.$$eval('[data-testid="map-select"] option', nodes => nodes.map(n => ({value: n.value, text: n.textContent.trim()})));

const switchCalls = [];
await page.route('**/api/localization/map', async route => {
  let body = null;
  try { body = route.request().postDataJSON(); } catch { body = '(非JSON)'; }
  switchCalls.push(body);
  const mapId = body && body.mapId ? body.mapId : '';
  const version = body && body.version ? body.version : 0;
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({mapId, version, coordinateStatus: 'draft', reviewed: false, switched: true, localization: {mapId: '', mapVersion: null}})
  });
});

const target = options.find(option => option.value && option.value !== CURRENT);
await page.selectOption('[data-testid="map-select"]', target.value);
await page.waitForTimeout(3000);
const blockReason = String(await page.textContent('[data-testid="navigation-block-reason"]').catch(() => '(无)')).trim();
await page.screenshot({path: '/tmp/auto-map-select.png'});

console.log(JSON.stringify({
  enableButtonPresent: !!enableButton,
  enableTextPresent: hasEnableText,
  options,
  switchedTo: target,
  switchCalls,
  blockReason
}, null, 2));

await browser.close();
