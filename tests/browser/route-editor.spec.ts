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
  if(path==='/api/tasks')return route.fulfill({json:[task()]});
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
 const box=await page.getByTestId('map-canvas').boundingBox();if(!box)throw new Error('画布不可见');
 const ps=[...source.zone,...source.rows.flatMap(r=>r.points),...source.tags],xs=ps.map(p=>p.x*100),ys=ps.map(p=>-p.y*100),minX=Math.min(...xs),minY=Math.min(...ys),width=Math.max(...xs)-minX,height=Math.max(...ys)-minY;
 const scale=Math.min((box.width-140)/Math.max(width,100),(box.height-120)/Math.max(height,100));
 return {x:box.x+(box.width-width*scale)/2+(p.x*100-minX)*scale,y:box.y+(box.height-height*scale)/2+(-p.y*100-minY)*scale};
}
async function clickPoint(page:Page,p:Point){const at=await location(page,p);await page.mouse.click(at.x,at.y);}
const anchors=(page:Page)=>page.locator('.route-waypoints button');

test('路径编辑：点击吸附、自动正交、拖动、删除、撤销、清空、取消',async({page})=>{
 const h=await setup(page);await page.getByRole('button',{name:'清空',exact:true}).click();await expect(anchors(page)).toHaveCount(0);
 await clickPoint(page,{x:.013,y:.012});await clickPoint(page,{x:1.024,y:.012});await clickPoint(page,{x:1,y:1});await expect(anchors(page)).toHaveCount(3);
 await expect(anchors(page).nth(0)).toContainText('0.00, 0.00');await expect(anchors(page).nth(1)).toContainText('1.00, 0.00');
 const from=await location(page,{x:1,y:1}),to=await location(page,{x:.72,y:.38});await page.mouse.move(from.x,from.y);await page.mouse.down();await page.mouse.move(to.x,to.y,{steps:8});await page.mouse.up();
 await expect(anchors(page).nth(2)).toContainText('0.70, 0.40');
 await page.getByRole('button',{name:'删除路点',exact:true}).click();await expect(anchors(page)).toHaveCount(2);
 await page.getByRole('button',{name:'撤销',exact:true}).click();await expect(anchors(page)).toHaveCount(3);
 await page.getByRole('button',{name:'清空',exact:true}).click();await expect(anchors(page)).toHaveCount(0);
 await page.keyboard.press('Control+z');await expect(anchors(page)).toHaveCount(3);
 await page.getByRole('button',{name:'取消编辑',exact:true}).click();await expect(page.getByTestId('route-editor')).toHaveCount(0);expect(h.requests).toHaveLength(0);expect(h.errors).toEqual([]);
});

test('路径编辑：保存正交折线、刷新版本、冲突保留草稿、导航按钮禁用',async({page})=>{
 const h=await setup(page);await expect(page.locator('.left-panel').getByRole('button',{name:'开始导航',exact:true})).toBeDisabled();
 h.reject(true);await page.getByRole('button',{name:'保存路径',exact:true}).click();await expect(page.getByRole('alert')).toContainText('地图已被其他页面保存');await expect(anchors(page)).toHaveCount(3);
 h.reject(false);await page.screenshot({path:'logs/path-editor-browser.png',fullPage:true});await page.getByRole('button',{name:'保存路径',exact:true}).click();
 await expect(page.getByTestId('route-editor')).toHaveCount(0);await expect(page.getByRole('status').filter({hasText:'路径已保存'})).toContainText('版本 2');
 expect(h.requests).toHaveLength(2);const request=h.requests[1];expect(request.mapId).toBe(source.id);expect(request.baseVersion).toBe(1);expect(request.bodyYawDeg).toBe(0);
 expect(request.points.every((p:Point,i:number,ps:Point[])=>!i||p.x===ps[i-1]!.x||p.y===ps[i-1]!.y)).toBe(true);
 await page.getByTestId('edit-route').click();await expect(page.getByTestId('route-editor')).toContainText('v2');expect(h.errors).toEqual([]);
});

test('路径编辑：自动串码插入中途码、高亮、逐码纠正徽章、撤销与保存',async({page})=>{
 const h=await setup(page,true);const badge=page.getByTestId('route-group-badge');
 await expect(badge).toHaveText('经过 5 个定位组 · 每到下一码纠正一次 · 跳过 0 个偏离码');
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
 await expect(page.getByTestId('route-group-badge')).toHaveText('经过 5 个定位组 · 每到下一码纠正一次 · 跳过 1 个偏离码');
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
 await expect(page.getByTestId('route-group-badge')).toContainText('经过 5 个定位组');
 await expect(page.getByTestId('route-group-badge')).toContainText('跳过 1 个偏离码');
 await page.getByTestId('auto-chain-route').click();await expect(anchors(page).nth(0)).toContainText('0.00, 0.08');
 await expect(page.getByTestId('route-skipped-groups')).toContainText('偏离路线 16.0 cm，未串联');
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-skipped-route-group-ids','6');
 await page.getByRole('button',{name:'保存路径',exact:true}).click();await expect(page.getByTestId('route-editor')).toHaveCount(0);
 await expect(page.getByRole('status').filter({hasText:'路径已保存'})).toContainText('跳过 1 个偏离码');expect(h.errors).toEqual([]);
});
