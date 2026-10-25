// 只读：确认在当前地图上「开始导航」按钮是否已可点（绝不点击）。
import {chromium} from '@playwright/test';
const browser = await chromium.launch();
const page = await browser.newPage({viewport: {width: 1440, height: 960}});
await page.goto('http://127.0.0.1:3080', {waitUntil: 'domcontentloaded'});
await page.waitForSelector('nav[aria-label="主导航"]', {timeout: 20000});
await page.click('nav[aria-label="主导航"] button[title="开始导航"]');
await page.waitForSelector('[data-testid="coordinate-status"]', {timeout: 20000});
await page.waitForTimeout(4000);
const badge = (await page.textContent('[data-testid="current-map"]')).trim();
const source = (await page.textContent('[data-testid="coordinate-source"]')).trim();
const routeValue = await page.$eval('[data-testid="route-select"]', el => el.options[el.selectedIndex]?.textContent?.trim() ?? '');
// 只选中路径（纯前端状态），绝不点击"开始导航"。
const routeOptions = await page.$$eval('[data-testid="route-select"] option', ns => ns.map(n => ({v: n.value, t: n.textContent.trim()})).filter(o => o.v));
if (routeOptions.length) {
  await page.selectOption('[data-testid="route-select"]', routeOptions[0].v);
  await page.waitForTimeout(2500);
}
const routeAfter = await page.$eval('[data-testid="route-select"]', el => el.options[el.selectedIndex]?.textContent?.trim() ?? '');
const startDisabled = await page.$eval('.navigation-actions button', el => el.disabled).catch(() => null);
const blockEl = await page.$('[data-testid="navigation-block-reason"]');
const blockReason = blockEl ? (await blockEl.textContent()).trim() : '(无阻断)';
const enableBtn = await page.$('[data-testid="enable-map"]');
console.log(JSON.stringify({badge, source, routeValue, routeAfter, startDisabled, blockReason, enableButtonPresent: !!enableBtn}, null, 2));
await page.screenshot({path: '/tmp/nav-ready.png'});
await browser.close();
