import {test,expect,type Page} from '@playwright/test';
import {compileDesignedRoute} from '../../web/backend/src/route-design';
import {mapSchema,type Point} from '../../web/shared/model';
const points=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
const source=mapSchema.parse({schemaVersion:1,id:'scan-browser-path-editor',name:'路径编辑测试地图',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',routeMode:'waypoints',
 rows:[{id:'route',name:'原路线',width:.6,exitDistance:.8,start:points[0],points:points.slice(1,3)}],order:['route'],
 tags:points.map((p,id)=>({id,...p,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]})),zone:[{x:-.5,y:-.5},{x:1.5,y:-.5},{x:1.5,y:1.5},{x:-.5,y:1.5}],vehicle:{width:.4,length:.8,margin:.05},notes:''});
async function setup(page:Page,intermediate=false,offAxis=false,shifted=false){
 const errors:string[]=[],requests:any[]=[];page.on('pageerror',e=>errors.push(e.message));
 let version=1,map=structuredClone(source),reject=false;
 if(intermediate)map.tags.push(...[{x:.5,y:0},{x:1,y:.5}].map((point,i)=>({...map.tags[0]!,...point,id:4+i})));
 if(offAxis)map.tags.push({...map.tags[0]!,id:6,x:.65,y:.09});
 if(shifted)map.tags=map.tags.map(tag=>({...tag,y:tag.id===6?-.08:tag.y+.08}));
 const task=()=>({id:'task-scan-browser-path-editor',name:'路径编辑测试任务',mapId:map.id,mapVersion:version,rowOrder:['route'],forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true});
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:false,state:'OFFLINE',running:false,paused:false,pose:null,chassis:{connected:false},conditions:[],events:[],sensors:{}}})));
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/routes')return route.fulfill({json:[]});if(path==='/api/tasks')return route.fulfill({json:[task()]});
  if(path==='/api/maps')return route.fulfill({json:[{id:map.id,name:map.name,version}]});
  if(path==='/api/surveys'||path==='/api/boards')return route.fulfill({json:[]});
  if(path==='/api/camera/status')return route.fulfill({json:{running:false,present:false}});
  if(path==='/api/maps/'+map.id)return route.fulfill({json:{map,version}});
  if(path==='/api/route/design'){
   const body=route.request().postDataJSON();requests.push(body);
   if(reject)return route.fulfill({status:409,json:{error:'地图已被其他页面保存，请重新加载最新版本后再修改'}});
   try{const result=compileDesignedRoute(map,body.points,body.bodyYawDeg);map=result.map;version++;return route.fulfill({json:{...result,version,task:task(),acceptance:{accepted:true,digestValid:true,kind:'office_test'}}});}
   catch(error){return route.fulfill({status:400,json:{error:String(error)}});}
  }
  errors.push('未预期的 API: '+path);return route.fulfill({status:404,json:{error:path}});
 });
 await page.goto('/');await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await expect(page.getByTestId('edit-route')).toBeEnabled();await page.getByTestId('edit-route').click();await expect(page.getByTestId('route-editor')).toBeVisible();
 return {errors,requests,reject:(value:boolean)=>{reject=value;}};
}
async function location(page:Page,p:Point){
 const state=await page.evaluate(()=>{const canvas=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;return {box:canvas?.getBoundingClientRect().toJSON(),scale:Number(canvas?.dataset.konvaScale),x:Number(canvas?.dataset.konvaX),y:Number(canvas?.dataset.konvaY)};});
 if(!state.box||!Number.isFinite(state.scale)||state.scale<=0)throw new Error('缺少真实 Konva 视口状态');
 return {x:state.box.x+state.x+p.x*100*state.scale,y:state.box.y+state.y-p.y*100*state.scale};
}

async function clickPoint(page:Page,p:Point){const at=await location(page,p);await page.mouse.click(at.x,at.y);}
// 路点列表已并入底部「路径指令列表」，一行一个路点
const anchors=(page:Page)=>page.locator('.route-commands-table tbody tr');

test('路径编辑：点击吸附、自动正交、拖动、删除、撤销、清空、取消',async({page})=>{
 const h=await setup(page);await page.getByRole('button',{name:'清空',exact:true}).click();await expect(anchors(page)).toHaveCount(0);
 await clickPoint(page,{x:.013,y:.012});await clickPoint(page,{x:1.024,y:.012});await clickPoint(page,{x:1,y:1});await expect(anchors(page)).toHaveCount(3);const coords=await page.locator('.route-commands-table tbody tr td:nth-child(5)').allTextContents();expect(coords).toEqual(['0.00, 0.00','1.00, 0.00','1.00, 1.00']);
 await expect(anchors(page).nth(0)).toContainText('0.00, 0.00');await expect(anchors(page).nth(1)).toContainText('1.00, 0.00');
 const from=await location(page,{x:1,y:1}),to=await location(page,{x:.72,y:.38});await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});await page.mouse.up();
 await expect(anchors(page).nth(2)).toContainText('0.70, 0.40');
 await page.getByRole('button',{name:'删除路点',exact:true}).click();await expect(anchors(page)).toHaveCount(2);
 await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(anchors(page)).toHaveCount(3);
 await page.getByRole('button',{name:'清空',exact:true}).click();await expect(anchors(page)).toHaveCount(0);
 await page.keyboard.press('Control+z');await expect(anchors(page)).toHaveCount(3);
 await page.getByRole('button',{name:'退出',exact:true}).click();await expect(page.getByTestId('route-editor')).toHaveCount(0);expect(h.requests).toHaveLength(0);expect(h.errors).toEqual([]);
});

test('路径编辑：保存正交折线、刷新版本、冲突保留草稿、导航按钮禁用',async({page})=>{
 const h=await setup(page);await expect(page.locator('.route-editor')).toBeVisible();await expect(page.locator('.left-panel').getByRole('button',{name:'开始导航',exact:true})).toHaveCount(0);
 h.reject(true);await page.getByRole('button',{name:'保存路径',exact:true}).click();await expect(page.getByRole('alert')).toContainText('地图已被其他页面保存');await expect(anchors(page)).toHaveCount(3);
 h.reject(false);await page.screenshot({path:'logs/path-editor-browser.png',fullPage:true});await page.getByRole('button',{name:'保存路径',exact:true}).click();
 await expect(page.getByTestId('route-editor')).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'路径已保存'})).toBeVisible();
 expect(h.requests).toHaveLength(2);const request=h.requests[1];expect(request.mapId).toBe(source.id);expect(request.baseVersion).toBe(1);expect(request.bodyYawDeg).toBe(0);
 expect(request.points.every((p:Point,i:number,ps:Point[])=>!i||p.x===ps[i-1]!.x||p.y===ps[i-1]!.y)).toBe(true);
 await page.getByTestId('edit-route').click();await expect(page.getByTestId('route-editor')).toBeVisible();await expect(page.getByTestId('route-editor')).not.toContainText('v2');expect(h.errors).toEqual([]);
});

test('路径编辑：自动串码插入中途码、高亮、逐码纠正徽章、撤销与保存',async({page})=>{
 const h=await setup(page,true);const badge=page.getByTestId('route-group-badge');
 await expect(badge).toHaveText('经过 5 · 跳过 0');await expect(badge).toHaveAttribute('title','每到下一定位码纠正一次');
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-route-group-ids','0,4,1,5,2');
 await page.getByTestId('auto-chain-route').click();await expect(anchors(page)).toHaveCount(5);
 await expect(anchors(page).nth(1)).toContainText('0.50, 0.00');await expect(anchors(page).nth(3)).toContainText('1.00, 0.50');
 await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(anchors(page)).toHaveCount(3);
 await page.getByTestId('auto-chain-route').click();await expect(anchors(page)).toHaveCount(5);
 await page.screenshot({path:'logs/route-semantics-auto-chain.png',fullPage:true});
 await page.getByRole('button',{name:'保存路径',exact:true}).click();await expect(page.getByTestId('route-editor')).toHaveCount(0);
 await expect(page.getByRole('status').filter({hasText:'路径已保存'})).toContainText('经过 5 个定位组 · 每到下一码纠正一次');
 expect(h.requests).toHaveLength(1);expect(h.requests[0].points).toEqual([{x:0,y:0},{x:.5,y:0},{x:1,y:0},{x:1,y:.5},{x:1,y:1}]);expect(h.errors).toEqual([]);
});

test('路径编辑：偏离码橙色标记和提示，自动串码后仍跳过，保存逐码直线',async({page})=>{
 const h=await setup(page,true,true);
 await expect(page.getByTestId('route-group-badge')).toHaveText('经过 5 · 跳过 1');await expect(page.getByTestId('route-group-badge')).toHaveAttribute('title','每到下一定位码纠正一次');
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-skipped-route-group-ids','6');
 await expect(page.getByTestId('route-skipped-groups')).toContainText('Q006 · 偏离路线 9.0 cm，未串联：建议把路线画过此码或调整铺码');
 await expect(page.getByTestId('route-skipped-groups')).toHaveCSS('color','rgb(180, 83, 9)');
 await page.getByTestId('auto-chain-route').click();await expect(anchors(page)).toHaveCount(5);
 await expect(page.getByTestId('route-skipped-groups')).toContainText('偏离路线 9.0 cm，未串联');
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-route-group-ids','0,4,1,5,2');
 await page.screenshot({path:'logs/route-semantics-skipped-code.png',fullPage:true});
 await page.getByRole('button',{name:'保存路径',exact:true}).click();await expect(page.getByTestId('route-editor')).toHaveCount(0);
 await expect(page.getByRole('status').filter({hasText:'路径已保存'})).toContainText('跳过 1 个偏离码');
 const points=h.requests[0].points as Point[];expect(points.every((p,i)=>!i||p.x===points[i-1]!.x||p.y===points[i-1]!.y)).toBe(true);
 expect(points.some(p=>p.y===.09)).toBe(false);expect(h.errors).toEqual([]);
});
for(const width of [375,760])test(`自动串码${width}px：长徽章与偏离提示可读、页面无横向溢出`,async({page})=>{
 await page.setViewportSize({width,height:900});const h=await setup(page,true,true);
 await expect(page.getByTestId('route-skipped-groups')).toBeVisible();await page.getByTestId('auto-chain-route').click();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);expect(h.errors).toEqual([]);
});

test('自动串码：端点吸附后偏离码超过10cm仍保留橙色提示，保存不丢失提示',async({page})=>{
 const h=await setup(page,true,true,true);
 await expect(page.getByTestId('route-group-badge')).toHaveText('经过 5 · 跳过 1');
 await page.getByTestId('auto-chain-route').click();await expect(anchors(page).nth(0)).toContainText('0.00, 0.08');
 await expect(page.getByTestId('route-skipped-groups')).toContainText('偏离路线 16.0 cm，未串联');
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-skipped-route-group-ids','6');
 await page.getByRole('button',{name:'保存路径',exact:true}).click();await expect(page.getByTestId('route-editor')).toHaveCount(0);
 await expect(page.getByRole('status').filter({hasText:'路径已保存'})).toContainText('跳过 1 个偏离码');expect(h.errors).toEqual([]);
});

test('路径步骤浮窗：拖动标题移动、手柄缩小后尺寸保持不回弹、再缩可继续、拖动不改宽高',async({page})=>{
 const h=await setup(page);
 await page.getByTestId('route-steps-trigger').click();
 const pop=page.getByTestId('route-steps-popover');
 await expect(pop).toBeVisible();
 const box=async()=>{const b=await pop.boundingBox();return b!;};
 const vp=page.viewportSize()!;
 const inView=(r:{x:number;y:number;width:number;height:number})=>r.x>=0&&r.y>=0&&r.x+r.width<=vp.width+1&&r.y+r.height<=vp.height+1;

 const r0=await box();
 expect(Math.round(r0.width)).toBe(760);
 expect(Math.round(r0.height)).toBe(520);

 // 只剩一个浮窗实例，且不使用原生 resize 机制
 const info=await page.evaluate(()=>{const p=document.querySelector('[data-testid=route-steps-popover]')!;const cs=getComputedStyle(p);
  return {count:document.querySelectorAll('[data-testid=route-steps-popover]').length,resize:cs.resize,boxSizing:cs.boxSizing};});
 expect(info.count).toBe(1);
 expect(info.resize).toBe('none');
 expect(info.boxSizing).toBe('border-box');

 // 缩小 -180/-220
 const hb=await page.getByTestId('route-steps-resize-handle').boundingBox();
 await page.mouse.move(hb!.x+hb!.width/2,hb!.y+hb!.height/2);
 await page.mouse.down();
 await page.mouse.move(hb!.x+hb!.width/2-180,hb!.y+hb!.height/2-220,{steps:20});
 await page.mouse.up();
 const r1=await box();
 expect(Math.round(r1.width)).toBe(580);
 expect(Math.round(r1.height)).toBe(300);
 expect(inView(r1)).toBe(true);

 // 一秒后不得回弹
 await page.waitForTimeout(1000);
 const r2=await box();
 expect(Math.abs(r2.width-r1.width)).toBeLessThanOrEqual(1);
 expect(Math.abs(r2.height-r1.height)).toBeLessThanOrEqual(1);

 // 再次向内仍可继续缩小
 const hb2=await page.getByTestId('route-steps-resize-handle').boundingBox();
 await page.mouse.move(hb2!.x+hb2!.width/2,hb2!.y+hb2!.height/2);
 await page.mouse.down();
 await page.mouse.move(hb2!.x+hb2!.width/2-80,hb2!.y+hb2!.height/2-60,{steps:12});
 await page.mouse.up();
 await page.waitForTimeout(1000);
 const r3=await box();
 expect(Math.round(r3.width)).toBe(500);
 expect(Math.round(r3.height)).toBe(240);

 // 拖动标题只改位置，不改宽高
 const db=await page.getByTestId('route-steps-drag-handle').boundingBox();
 await page.mouse.move(db!.x+db!.width/2,db!.y+db!.height/2);
 await page.mouse.down();
 await page.mouse.move(db!.x+db!.width/2-100,db!.y+db!.height/2-80,{steps:14});
 await page.mouse.up();
 await page.waitForTimeout(800);
 const r4=await box();
 expect(Math.round(r4.x-r3.x)).toBe(-100);
 expect(Math.round(r4.y-r3.y)).toBe(-80);
 expect(Math.round(r4.width)).toBe(Math.round(r3.width));
 expect(Math.round(r4.height)).toBe(Math.round(r3.height));
 expect(inView(r4)).toBe(true);

 // 关闭重开保留本次尺寸；Escape 可关闭
 await page.getByRole('button',{name:'关闭路径步骤'}).click();
 await expect(pop).toBeHidden();
 await page.getByTestId('route-steps-trigger').click();
 await expect(pop).toBeVisible();
 const r5=await box();
 expect(Math.abs(r5.width-r4.width)).toBeLessThanOrEqual(1);
 expect(Math.abs(r5.height-r4.height)).toBeLessThanOrEqual(1);
 await page.keyboard.press('Escape');
 await expect(pop).toBeHidden();
 expect(h.errors).toEqual([]);
});
