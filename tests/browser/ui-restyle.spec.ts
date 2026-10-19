import {test,expect,type Page} from '@playwright/test';
import {boardOptions,boardPlan,boardSvg,boardPdf} from '../../web/backend/src/boards';
import {generateBoards} from '../../web/shared/boards';
const boards=generateBoards({gridSize:2,groupSizeMm:140,groupCount:3,startId:0});
async function mock(page:Page){
 const errors:string[]=[],pdfRequests:any[]=[],planRequests:any[]=[];page.on('pageerror',e=>errors.push(e.message));
 const status={connected:false,state:'OFFLINE',running:false,paused:false,pose:null,chassis:{connected:false},conditions:[],events:[],sensors:{}};
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status})));
 await page.routeWebSocket('**/ws/camera',ws=>ws.send(JSON.stringify({type:'camera',name:'HBVCAM',profiles:[],error:'无测试相机'})));
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()),path=url.pathname;
  if(path==='/api/routes')return route.fulfill({json:[]});
  if(path==='/api/surveys'||path==='/api/tasks')return route.fulfill({json:[]});
  if(path==='/api/boards')return route.fulfill({json:boards});
  if(path==='/api/robot/status')return route.fulfill({json:status});
  if(path==='/api/camera/status')return route.fulfill({json:{present:false,running:false}});
  if(path==='/api/camera/calibration')return route.fulfill({json:{session:null}});
  if(path==='/api/camera/calibration/defaults')return route.fulfill({json:{}});
  if(path==='/api/boards/options')return route.fulfill({json:boardOptions()});
  if(path==='/api/boards/plan'){const body=route.request().postDataJSON();planRequests.push(body);return route.fulfill({json:boardPlan(body)});}
  if(path==='/api/boards/preview.svg'){
   const plan=boardPlan({gridSize:Number(url.searchParams.get('gridSize')),groupSizeMm:Number(url.searchParams.get('groupSizeMm')),startId:Number(url.searchParams.get('startId')),groupCount:1});
   return route.fulfill({contentType:'image/svg+xml',body:boardSvg(plan.boards[0]!,url.searchParams.get('centerCrosshair')!=='false')});
  }
  if(path==='/api/boards/pdf'){const body=route.request().postDataJSON();pdfRequests.push(body);return route.fulfill({contentType:'application/pdf',body:await boardPdf(boardPlan(body).boards,body.centerCrosshair)});}
  errors.push('未模拟API '+path);return route.fulfill({status:404,json:{error:path}});
 });
 await page.goto('/');await expect(page.locator('.sidebar .nav-item')).toHaveCount(5);
 return {errors,pdfRequests,planRequests};
}
async function openPrint(page:Page){await page.locator('.sidebar').getByRole('button',{name:'二维码 PDF',exact:true}).click();await expect(page.getByRole('button',{name:'生成并下载 PDF',exact:true})).toBeEnabled();}

test('商业控制台：几何Logo、原选择器保留、页面及标定/记录弹窗可用',async({page})=>{
 const h=await mock(page);await expect(page.locator('.brand')).toContainText('QR 导航控制台');await expect(page.locator('.brand')).toContainText('v1.0.0');await expect(page.locator('.brand-icon')).toHaveCount(1);await expect(page.locator('.sidebar svg.lucide-leaf')).toHaveCount(0);
 await expect(page.locator('.state-card')).toBeVisible();await expect(page.locator('.state-card')).toHaveCSS('border-radius','8px');await expect(page.locator('.state-card')).toHaveCSS('box-shadow','rgba(15, 23, 42, 0.06) 0px 1px 2px 0px');
 const nav=page.locator('.sidebar');await page.screenshot({path:'logs/ui-commercial-scan-empty.png',fullPage:true});
 await page.getByRole('button',{name:'管理扫描记录',exact:true}).click();await expect(page.locator('.records-dialog')).toBeVisible();await expect(page.locator('.records-dialog')).toHaveCSS('border-radius','8px');await page.getByRole('button',{name:'关闭扫描记录',exact:true}).click();
 await nav.getByRole('button',{name:'开始导航',exact:true}).click();await expect(page.getByLabel('导航地图')).toBeVisible();await expect(page.locator('.canvas-section')).toBeVisible();await page.screenshot({path:'logs/ui-commercial-navigation-empty.png',fullPage:true});
 await nav.getByRole('button',{name:'摄像头预览',exact:true}).click();await expect(page.getByLabel('摄像头实时画面',{exact:true})).toBeVisible();await expect(page.locator('.preview-state i')).toHaveCSS('border-radius','50%');
 await page.getByRole('button',{name:'定位标定',exact:true}).click();await expect(page.locator('.calibration-dialog')).toBeVisible();await expect(page.locator('.calibration-dialog')).toHaveCSS('border-radius','8px');await page.getByRole('button',{name:'关闭定位标定',exact:true}).click();await page.screenshot({path:'logs/ui-commercial-camera.png',fullPage:true});
 await openPrint(page);await expect(page.locator('.pdf-workspace')).toBeVisible();await expect(page.locator('.board-preview')).toHaveCSS('box-shadow','rgba(15, 23, 42, 0.06) 0px 1px 2px 0px');await page.screenshot({path:'logs/ui-commercial-pdf.png',fullPage:true});expect(h.errors).toEqual([]);
});
test('PDF中心十字线：默认开启、预览与计划同步、开关控制实际下载参数',async({page})=>{
 const h=await mock(page);await openPrint(page);const toggle=page.getByRole('checkbox',{name:'整组中心十字对位线',exact:true});await expect(toggle).toBeChecked();
 const image=page.locator('.board-preview img');await expect(image).toHaveAttribute('src',/centerCrosshair=true/);
 for(const enabled of [false,true]){
  await toggle.setChecked(enabled);await expect(image).toHaveAttribute('src',new RegExp('centerCrosshair='+enabled));await expect.poll(()=>h.planRequests.at(-1)?.centerCrosshair).toBe(enabled);
  await expect(page.getByRole('button',{name:'生成并下载 PDF',exact:true})).toBeEnabled();
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'生成并下载 PDF',exact:true}).click();const download=await downloading;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);await download.saveAs('logs/ui-restyle-print/browser-'+(enabled?'on':'off')+'.pdf');expect(h.pdfRequests.at(-1)?.centerCrosshair).toBe(enabled);
  await expect(page.locator('.pdf-success')).toHaveText('PDF 已生成');
 }
 expect(h.errors).toEqual([]);
});
for(const width of [375,760])test(`商业控制台窄屏${width}：PDF表单/预览及开关不溢出`,async({page})=>{
 await page.setViewportSize({width,height:900});const h=await mock(page);await openPrint(page);await page.getByRole('checkbox',{name:'整组中心十字对位线',exact:true}).uncheck();
 for(const selector of ['.pdf-workspace','.pdf-controls','.preview-toolbar','.board-list','.crosshair-option']){
  const box=await page.locator(selector).boundingBox();expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(-1);expect(box!.x+box!.width).toBeLessThanOrEqual(width+1);
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);expect(h.errors).toEqual([]);
});
