import {test,expect} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
test('网页十组：冲突提前显示、显式选择Q113、实际十页下载和同批重打',async({page})=>{
 const folder=process.env.PDF_TEN_EVIDENCE_DIR??'/home/orangepi/ugv/QRautorun/qr_navigation_ws/logs/editor-ux-v3-print-ten';mkdirSync(folder,{recursive:true});
 const api='http://127.0.0.1:4183',batch={gridSize:4,groupSizeMm:100,groupCount:10,startId:0};const requests:any[]=[];
 for(const seed of [{...batch,groupCount:3},{...batch,groupCount:4,startId:49},{...batch,groupSizeMm:140,groupCount:2,startId:300}])expect((await page.request.post(api+'/api/boards/pdf',{data:seed})).status()).toBe(200);
 const original=await (await page.request.get(api+'/api/boards')).json();
 await page.routeWebSocket('**/ws',socket=>socket.send(JSON.stringify({type:'robot',status:{connected:false,state:'OFFLINE',running:false,paused:false,conditions:[],events:[],sensors:{}}})));
 await page.route('**/api/**',async route=>{const req=route.request(),url=new URL(req.url());const response=await route.fetch({url:api+url.pathname+url.search});requests.push({path:url.pathname,payload:req.postData()?req.postDataJSON():null,status:response.status()});await route.fulfill({response});});
 await page.goto('/');await page.locator('.sidebar').getByRole('button',{name:'二维码 PDF',exact:true}).click();await page.getByRole('button',{name:'4 × 4',exact:true}).click();await page.getByLabel('整组尺寸 / mm',{exact:true}).fill('100');await page.getByLabel('生成组数',{exact:true}).fill('10');
 const button=page.getByRole('button',{name:'生成并下载 PDF',exact:true});await expect(page.getByRole('alert')).toContainText('Q049已属于B049');await expect(button).toBeDisabled();
 await expect(page.getByRole('button',{name:'使用可用编号 Q113',exact:true})).toBeVisible();expect(await (await page.request.get(api+'/api/boards')).json()).toEqual(original);await page.screenshot({path:folder+'/conflict.png',fullPage:true});
 const bad=await page.request.post(api+'/api/boards/pdf',{data:batch});expect(bad.status()).toBe(409);expect(await bad.text()).toContain('Q049已属于B049');expect(await (await page.request.get(api+'/api/boards')).json()).toEqual(original);
 await page.getByRole('button',{name:'使用可用编号 Q113',exact:true}).click();await expect(page.getByLabel('起始子码编号',{exact:true})).toHaveValue('113');await expect(button).toBeEnabled();await expect(page.getByRole('alert')).toHaveCount(0);await expect(page.locator('.board-row')).toHaveCount(10);await expect(page.getByTestId('crosshair-note')).toContainText('全长 8 mm');expect(await (await page.request.get(api+'/api/boards')).json()).toEqual(original);
 let saved:any;
 for(const name of ['ten-groups','ten-groups-reprint']){const event=page.waitForEvent('download');await button.click();await (await event).saveAs(folder+'/'+name+'.pdf');const info=execFileSync('pdfinfo',[folder+'/'+name+'.pdf'],{encoding:'utf8'});expect(info).toMatch(/Pages:\s+10\b/);writeFileSync(folder+'/'+name+'-pdfinfo.txt',info);const boards=await (await page.request.get(api+'/api/boards')).json();expect(boards).toHaveLength(19);for(const b of original)expect(boards.find((item:any)=>item.id===b.id)).toEqual(b);if(saved)expect(boards).toEqual(saved);saved=boards;}
 expect((await page.request.post(api+'/api/boards/pdf',{data:{...batch,groupCount:4,startId:49}})).status()).toBe(200);expect(await (await page.request.get(api+'/api/boards')).json()).toEqual(saved);
 execFileSync('pdftoppm',['-png','-r','100','-f','1','-singlefile',folder+'/ten-groups.pdf',folder+'/ten-groups']);await page.screenshot({path:folder+'/success.png',fullPage:true});writeFileSync(folder+'/requests.json',JSON.stringify(requests,null,2));writeFileSync(folder+'/result.json',JSON.stringify({pages:10,startId:113,originalCount:9,afterCount:19,reprintUnchanged:true},null,2));
});
