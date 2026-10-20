import {test,expect,type Page} from '@playwright/test';
import {writeFileSync} from 'node:fs';
const api='http://127.0.0.1:4187',folder='/home/orangepi/ugv/QRautorun/qr_navigation_ws/logs/map-only-20261019';
async function open(page:Page,count=10){
 const fixture=await (await page.request.get(api+'/__fixture')).json(),id=fixture.cases[String(count)],writes:string[]=[],errors:string[]=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:false,state:'OFFLINE',running:false,paused:false,pose:null,chassis:{connected:false},conditions:[],events:[],sensors:{}}})));
 await page.routeWebSocket('**/ws/camera',()=>{});
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url());if(route.request().method()!=='GET')writes.push(url.pathname);
  if(url.pathname==='/api/surveys'){const records=await (await page.request.get(api+'/api/surveys')).json();return route.fulfill({json:records.filter((record:any)=>record.id===id)});}
  if(url.pathname==='/api/camera/status')return route.fulfill({json:{running:false,present:false}});
  if(url.pathname==='/api/camera/calibration')return route.fulfill({json:{busy:false}});
  return route.fulfill({response:await route.fetch({url:api+url.pathname+url.search})});
 });
 await page.goto('/');await expect(page.getByTestId('capture-count')).toHaveText('已采集 '+count+' 个定位点 · '+count*3+' 帧');
 return {fixture,id,writes,errors};
}
test('实际十组往返记录→只存地图→刷新→手动命名路线→原路径与显式补打入口',async({page})=>{
 const h=await open(page),routesBefore=await (await page.request.get(api+'/api/routes')).json(),tasksBefore=await (await page.request.get(api+'/api/tasks')).json();
 await expect(page.getByTestId('capture-trail-toggle')).not.toBeChecked();
 await page.getByRole('button',{name:'整理记录并保存地图',exact:true}).click();
 await expect(page.locator('.message')).toHaveText('地图已保存 · 10 个定位组 · 未创建路径');
 const mapId='scan-'+h.id.replaceAll('-',''),saved=await (await page.request.get(api+'/api/maps/'+mapId)).json();
 expect(saved.map.routeMode).toBe('map-only');expect(saved.map.tags).toHaveLength(10);expect(saved.map.rows).toEqual([]);expect(saved.map.motionSegments).toBeUndefined();expect(saved.acceptance.accepted).toBe(false);
 expect(await (await page.request.get(api+'/api/routes')).json()).toEqual(routesBefore);expect(await (await page.request.get(api+'/api/tasks')).json()).toEqual(tasksBefore);
 await expect(page.getByTestId('new-route')).toBeVisible();await expect(page.getByTestId('edit-route')).toHaveCount(0);await expect(page.locator('.navigation-actions').getByRole('button',{name:'开始导航',exact:true})).toBeDisabled();
 await page.reload();await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();await page.getByTestId('map-select').selectOption(mapId);
 await expect(page.getByTestId('route-select')).toHaveValue('');await page.getByTestId('view-tag-reprint').click();await expect(page.getByTestId('tag-inspector')).toContainText('tag36h11');await expect(page.getByTestId('tag-inspector')).toContainText('B000');await page.getByRole('button',{name:'关闭二维码预览'}).click();
 await page.getByTestId('new-route').click();await expect(page.getByTestId('route-draw-tool')).toHaveAttribute('aria-pressed','true');
 const canvas=page.getByTestId('map-canvas'),box=(await canvas.boundingBox())!,view=await canvas.evaluate(node=>({scale:Number((node as HTMLElement).dataset.konvaScale),x:Number((node as HTMLElement).dataset.konvaX),y:Number((node as HTMLElement).dataset.konvaY)}));
 for(const x of [0,9])await page.mouse.click(box.x+view.x+x*100*view.scale,box.y+view.y);
 await page.getByTestId('route-properties-toggle').click();await page.getByTestId('route-more').locator('summary').click();await page.getByLabel('路径名称',{exact:true}).fill('手动巡检A');await page.getByRole('button',{name:'关闭路径属性'}).click();await page.getByRole('button',{name:'保存路径',exact:true}).click();
 await expect(page.getByTestId('route-editor')).toHaveCount(0);const routes=await (await page.request.get(api+'/api/routes')).json(),manual=routes.find((route:any)=>route.name==='手动巡检A');expect(manual).toBeTruthy();expect(manual.mapId).toBe(mapId);expect((await (await page.request.get(api+'/api/maps/'+mapId)).json()).map).toEqual(saved.map);
 await page.reload();await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();await page.getByTestId('map-select').selectOption(mapId);await page.getByTestId('route-select').selectOption(manual.routeId);await expect(page.getByTestId('edit-route')).toBeVisible();
 await page.getByTestId('map-select').selectOption('old-route-map');await page.getByTestId('route-select').selectOption('old-route');await page.getByTestId('edit-route').click();await expect(page.getByTestId('route-editor')).toBeVisible();
 expect(h.writes).toEqual(['/api/survey/map','/api/route/design']);expect(h.errors).toEqual([]);await page.screenshot({path:folder+'/browser-manual-route.png',fullPage:true});writeFileSync(folder+'/browser-map-only.json',JSON.stringify({baseURL:page.url(),mapId,points:10,routeId:manual.routeId,writes:h.writes,errors:h.errors},null,2));
});
test('单个定位板可保存无路线地图，仍禁止直接导航',async({page})=>{
 const h=await open(page,1);await page.getByRole('button',{name:'整理记录并保存地图',exact:true}).click();await expect(page.locator('.message')).toHaveText('地图已保存 · 1 个定位组 · 未创建路径');await expect(page.getByTestId('new-route')).toBeVisible();await expect(page.locator('.navigation-actions').getByRole('button',{name:'开始导航',exact:true})).toBeDisabled();expect(h.writes).toEqual(['/api/survey/map']);expect(h.errors).toEqual([]);await page.screenshot({path:folder+'/browser-single-map.png',fullPage:true});
});
