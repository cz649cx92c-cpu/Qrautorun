import {test,expect,type Page} from '@playwright/test';
import {mkdirSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const api='http://127.0.0.1:4184',folder='/home/orangepi/ugv/QRautorun/qr_navigation_ws/logs/editor-v4';
async function open(page:Page,mapId='v4-single-map'){
 await page.routeWebSocket('**/ws',socket=>socket.send(JSON.stringify({type:'robot',status:{connected:false,running:false,paused:false,state:'OFFLINE',conditions:[],events:[],sensors:{}}})));
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());await route.fulfill({response:await route.fetch({url:api+url.pathname+url.search})});});
 await page.goto('/');await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();await page.getByTestId('map-select').selectOption(mapId);await page.getByTestId('route-select').selectOption(mapId==='v4-single-map'?'v4-single-route':'v4-board-route');await expect(page.getByTestId('edit-route')).toBeEnabled();await page.getByTestId('edit-route').click();await page.getByTestId('route-properties-toggle').click();
}
const mode=(page:Page,a:number,b:number)=>page.getByLabel('区间 Q'+a+' → Q'+b+' 第1次运动策略',{exact:true});
const state=(page:Page)=>page.getByTestId('map-canvas').evaluate(node=>({height:node.clientHeight,width:node.clientWidth,top:node.getBoundingClientRect().top,x:Number((node as HTMLElement).dataset.konvaX),y:Number((node as HTMLElement).dataset.konvaY),scale:Number((node as HTMLElement).dataset.konvaScale),plans:JSON.parse((node as HTMLElement).dataset.segmentPlans??'[]')}));
for(const grouped of [false,true])test(`v4地图实际点选${grouped?'板组和子码':'独立单码'}→真实预览→原尺寸PDF下载`,async({page})=>{
 mkdirSync(folder,{recursive:true});await page.routeWebSocket('**/ws',socket=>socket.send(JSON.stringify({type:'robot',status:{connected:false,running:false,paused:false,state:'OFFLINE',conditions:[],events:[],sensors:{}}})));
 const writes:string[]=[];await page.route('**/api/**',async route=>{const url=new URL(route.request().url());if(route.request().method()!=='GET')writes.push(url.pathname);await route.fulfill({response:await route.fetch({url:api+url.pathname+url.search})});});
 const mapId=grouped?'v4-browser-map':'v4-single-map',id=grouped?100:200;
 const beforeMap=await (await page.request.get(api+'/api/maps/'+mapId)).text(),beforeBoards=await (await page.request.get(api+'/api/boards')).text();
 await page.goto('/');await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();await page.getByTestId('map-select').selectOption(mapId);await page.getByTestId('new-route').click();
 const canvas=page.getByTestId('map-canvas');await expect(canvas).toBeVisible();const view=await state(page),box=(await canvas.boundingBox())!;
 // An empty draft leaves the real map tag at (0,0) unobscured by waypoint handles.
 await page.mouse.click(box.x+view.x,box.y+view.y);await page.getByTestId('route-properties-toggle').click();await expect(page.getByLabel('查看地图二维码')).toHaveValue(String(id));await page.getByRole('button',{name:'预览所选码',exact:true}).click();
 const inspector=page.getByTestId('tag-inspector');await expect(inspector).toContainText('tag36h11');await expect(inspector).toContainText(grouped?'整组定位板 B100':'独立单码');
 const image=page.getByTestId('original-tag-preview');await expect.poll(()=>image.evaluate((node:HTMLImageElement)=>node.complete&&node.naturalWidth>0)).toBe(true);
 if(grouped){await expect(inspector).toContainText('原板 2×2 · 100 mm');await page.getByLabel('选择原板子码').selectOption('101');await expect(image).toHaveAttribute('alt','tag36h11 Q101 真实单码预览');await expect(inspector).toContainText('黑边 39.2 mm');const svg=await (await page.request.get(api+(await page.getByTestId('original-board-preview').getAttribute('src'))!)).text();expect((svg.match(/<line /g)??[]).length).toBe(2);expect(svg).toContain('stroke-width="0.15"');}
 else await expect(inspector).toContainText('黑边 80 mm');
 const prefix=grouped?'board-member':'single';await image.screenshot({path:folder+'/'+prefix+'-preview.png'});
 const response=await page.request.get(api+(await image.getAttribute('src'))!);const svg=await response.text();expect(svg).toContain(grouped?'width="49mm"':'width="100mm"');expect(svg).toContain(grouped?'Q101':'Q200');expect(svg).toContain('tag36h11');
 for(const target of grouped?['member','board']:['member']){
  const download=page.waitForEvent('download');await page.getByTestId('reprint-'+target).click();const file=await download,path=folder+'/'+prefix+'-'+target+'.pdf';await file.saveAs(path);
  execFileSync('pdftoppm',['-f','1','-singlefile','-scale-to','1200','-png',path,path.slice(0,-4)],{env:{...process.env,TMPDIR:folder}});
  const text=execFileSync('pdftotext',[path,'-'],{encoding:'utf8'});expect(text).toContain('ACTUAL SIZE');expect(text).toContain('50 mm');expect(text).toContain(target==='board'?'B100':grouped?'Q101':'Q200');
 }
 await page.screenshot({path:folder+'/'+prefix+'-inspector.png',fullPage:true});expect(await (await page.request.get(api+'/api/maps/'+mapId)).text()).toBe(beforeMap);expect(await (await page.request.get(api+'/api/boards')).text()).toBe(beforeBoards);expect(writes).toEqual([]);
 writeFileSync(folder+'/'+prefix+'-readback.json',JSON.stringify({mapId,tagId:id,memberId:grouped?101:200,blackBorderMm:grouped?39.2:80,svg,view,after:await state(page),writes},null,2));
});
test('v4逐段策略：保存刷新恢复、转向区别和阻止、409草稿、另存、画布视角',async({page})=>{
 mkdirSync(folder,{recursive:true});await open(page);const initial=await state(page);
 await mode(page,200,201).selectOption('forward');await mode(page,201,202).selectOption('left');await mode(page,202,203).selectOption('reverse');
 await expect(page.locator('[data-segment-key="201>202#0"]')).toContainText('行进 90° · 到达朝向 0°');
 await mode(page,202,203).selectOption('turn_forward');await expect(page.locator('[data-segment-key="202>203#0"]')).toContainText('逆时针转 180°');await expect(page.locator('[data-segment-key="202>203#0"]')).toContainText('禁止执行');
 const planned=await state(page);expect(planned.plans[2].turn).toBeCloseTo(Math.PI);expect(planned.plans[2].arrivalYaw).toBeCloseTo(Math.PI);expect(planned.height).toBe(initial.height);expect(planned.scale).toBe(initial.scale);expect(planned.x).toBe(initial.x);expect(planned.y).toBe(initial.y);
 await page.getByRole('button',{name:'关闭路径属性',exact:true}).click();await page.screenshot({path:folder+'/planned-turn-map.png',fullPage:true});await page.getByRole('button',{name:'保存路径',exact:true}).click();await expect(page.getByTestId('route-editor')).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'路径规划已保存'})).toBeVisible();
 await page.reload();await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();await page.getByTestId('map-select').selectOption('v4-single-map');await page.getByTestId('route-select').selectOption('v4-single-route');await page.getByTestId('edit-route').click();await page.getByTestId('route-properties-toggle').click();await expect(mode(page,201,202)).toHaveValue('left');await expect(mode(page,202,203)).toHaveValue('turn_forward');
 await mode(page,202,203).selectOption('reverse');const route=await (await page.request.get(api+'/api/routes/v4-single-route')).json();const base=(await page.request.get(api+'/api/maps/v4-single-map'));expect(base.status()).toBe(200);const beforeMap=await base.text();
 expect((await page.request.post(api+'/api/route/design',{data:{mapId:'v4-single-map',baseVersion:1,routeId:'v4-single-route',routeUpdated:route.route.updated,routeName:route.route.name,points:route.route.points,bodyYawDeg:0}})).status()).toBe(200);
 await page.getByRole('button',{name:'保存路径',exact:true}).click();await expect(page.getByRole('alert')).toContainText('路径已被其他页面更新');await expect(mode(page,202,203)).toHaveValue('reverse');await page.screenshot({path:folder+'/strategy-conflict-draft.png',fullPage:true});
 await page.getByTestId('route-more').locator('summary').click();await page.getByLabel('路径名称',{exact:true}).fill('v4另存策略');await page.getByRole('button',{name:'另存为新路径',exact:true}).click();await expect(page.getByTestId('route-editor')).toHaveCount(0);expect(await (await page.request.get(api+'/api/maps/v4-single-map')).text()).toBe(beforeMap);
 await page.getByTestId('edit-route').click();await page.getByTestId('route-pan-tool').click();const before=await state(page),box=await page.getByTestId('map-canvas').boundingBox();await page.mouse.move(box!.x+box!.width*.5,box!.y+box!.height*.5);await page.mouse.down();await page.mouse.move(box!.x+box!.width*.5+60,box!.y+box!.height*.5+30,{steps:8});await page.mouse.up();const panned=await state(page);expect(panned.x!==before.x||panned.y!==before.y).toBe(true);await page.mouse.wheel(0,200);expect((await state(page)).scale).toBe(panned.scale);await page.keyboard.down('Control');await page.mouse.wheel(0,200);await page.keyboard.up('Control');await expect.poll(async()=>(await state(page)).scale).not.toBe(panned.scale);writeFileSync(folder+'/strategy-browser-state.json',JSON.stringify({initial,planned,panned,final:await state(page)},null,2));
});
