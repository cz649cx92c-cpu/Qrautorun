import {test,expect,type Page} from '@playwright/test';
import {generateBoards} from '../../web/shared/boards';
import {mapSchema,type Point} from '../../web/shared/model';
import {compileDesignedRoute} from '../../web/backend/src/route-design';
const positions:Point[]=[{x:0,y:0},{x:2,y:0},{x:2,y:1.5},{x:0,y:1.5}];
const groups=generateBoards({gridSize:2,groupSizeMm:140,groupCount:4,startId:0});
const source=mapSchema.parse({schemaVersion:1,id:'scan-console-demo',name:'仓储 A 区 · 正交作业地图',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'reviewed',routeMode:'waypoints',rows:[],tags:positions.map((p,i)=>({id:groups[i]!.referenceId,groupId:groups[i]!.id,...p,angle:0,size:.14,rowId:'',kind:'waypoint',rules:[]})),groups,order:[],zone:[{x:-.5,y:-.5},{x:2.5,y:-.5},{x:2.5,y:2},{x:-.5,y:2}],vehicle:{width:.4,length:.8,margin:.05},notes:''});
const field=compileDesignedRoute(source,positions,0).map;
const sample={pose:{x:0,y:0,yaw:0},tags:[]};
const record={id:'console-demo',name:'仓储 A 区 · 示教采集',state:'stopped',created:'2026-10-18T01:00:00Z',boards:groups,samples:[sample],counts:{0:18,4:24,8:19,12:22},visibility:{},anchors:[],captureQuality:'verified',result:{tags:field.tags,poses:positions.map(p=>[p.x,p.y,0]),rmsM:.008},sampleCount:1,groupCount:4,mapId:field.id,deletable:false,protectedReason:'已生成地图'};
async function mock(page:Page,{withMap=false,accepted=false,url='/'}:{withMap?:boolean;accepted?:boolean;url?:string}={}){
 const calls:string[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const task={id:'task-scan-console-demo',name:'A 区巡检任务',mapId:field.id,mapVersion:7,rowOrder:field.order,forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true};
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:false,running:false,paused:false,state:'OFFLINE',chassis:{connected:false},conditions:[],events:[],pose:null,sensors:{}}})));
 await page.route('**/api/**',route=>{
  const request=route.request(),path=new URL(request.url()).pathname;calls.push(request.method()+' '+path);
  if(path==='/api/surveys')return route.fulfill({json:withMap?[record]:[]});
  if(path==='/api/surveys/'+record.id)return route.fulfill({json:record});
  if(path==='/api/tasks')return route.fulfill({json:withMap?[task]:[]});
  if(path==='/api/boards')return route.fulfill({json:groups});
  if(path==='/api/maps/'+field.id)return route.fulfill({json:{map:field,version:7,acceptance:{accepted,digestValid:accepted,kind:accepted?'office_test':null}}});
  if(path==='/api/camera/status')return route.fulfill({json:{present:false,running:false}});
  errors.push('非预期API '+path);return route.fulfill({status:404,json:{error:path}});
 });
 await page.goto(url);await expect(page.locator('.sidebar .nav-item')).toHaveCount(5);await expect(page.getByTestId('global-status')).toContainText('网页服务 · 在线');
 return {calls,errors};
}
async function readyFonts(page:Page){await page.evaluate(()=>document.fonts.ready);}

test('使用指南：侧栏分组、五步流程、铺设与朝向规则、FAQ及页面返回',async({page})=>{
 const h=await mock(page);await expect(page.locator('.nav-group-label')).toHaveText(['作业','资源']);
 await page.locator('.sidebar').getByRole('button',{name:'使用指南',exact:true}).click();await expect(page.getByRole('heading',{name:'使用指南',exact:true})).toBeVisible();
 await expect(page.getByTestId('user-guide')).toBeVisible();await expect(page.locator('.guide-flow>li')).toHaveCount(5);await expect(page.locator('.sidebar .nav-item.active')).toHaveText('使用指南');
 await expect(page.getByTestId('user-guide')).toContainText('同一行共线');await expect(page.getByTestId('user-guide')).toContainText('至少相距 8 cm');await expect(page.getByTestId('user-guide')).toContainText('约 5.7°');
 await page.getByText('地图点位草稿已保存，为什么没有导航地图？',{exact:true}).click();await expect(page.locator('.guide-faq')).toContainText('只保存点位草稿');
 await page.locator('.guide-page').evaluate(el=>{el.scrollTop=0;});await readyFonts(page);await page.screenshot({path:'logs/ui-commercial-guide.png',fullPage:true});
 await page.getByRole('button',{name:'前往扫描',exact:true}).click();await expect(page.locator('.left-panel .panel-title')).toHaveText('扫描控制');await expect(page.getByTestId('workflow-steps')).toBeVisible();
 expect(h.calls.filter(c=>c.startsWith('POST'))).toEqual([]);expect(h.errors).toEqual([]);
});
test('商业控制台：步骤与真实统计同步、高级诊断默认隐藏、路径编辑状态、截图',async({page})=>{
 const h=await mock(page,{withMap:true,accepted:true});await expect(page.getByTestId('overview-stats')).toContainText('4 组');await expect(page.getByTestId('overview-stats')).toContainText('5.50');
 await expect(page.locator('.workflow-steps [aria-current="step"]')).toContainText('扫描建图');await expect(page.getByTestId('map-canvas')).toBeVisible();await readyFonts(page);await page.screenshot({path:'logs/ui-commercial-scan.png',fullPage:true});
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();await expect(page.getByTestId('overview-stats')).toContainText('v7');await expect(page.getByTestId('global-status')).toContainText('地图 v7');
 await expect(page.locator('.workflow-steps [aria-current="step"]')).toContainText('开始导航');await expect(page.getByTestId('advanced-diagnostics')).not.toHaveAttribute('open','');await expect(page.locator('[data-sensor="detector"]')).toBeHidden();await expect(page.getByTestId('execution-errors')).toBeHidden();
 await page.getByTestId('advanced-diagnostics').locator('summary').first().click();await expect(page.locator('[data-sensor="detector"]')).toBeVisible();await expect(page.getByTestId('execution-errors')).toBeVisible();await page.getByTestId('advanced-diagnostics').locator('summary').first().click();
 await page.getByTestId('edit-route').click();await expect(page.locator('.workflow-steps [aria-current="step"]')).toContainText('编辑路径');await expect(page.getByTestId('overview-stats')).toContainText('编辑预览');
 await page.getByRole('button',{name:'取消编辑',exact:true}).click();await expect(page.locator('.workflow-steps [aria-current="step"]')).toContainText('开始导航');await expect(page.locator('.navigation-actions').getByRole('button',{name:'停止',exact:true})).toBeInViewport();await readyFonts(page);await page.screenshot({path:'logs/ui-commercial-navigation.png',fullPage:true});
 expect(h.calls.filter(c=>c.startsWith('POST'))).toEqual([]);expect(h.errors).toEqual([]);
});
test('无地图引导：从这里开始可到指南及扫描，首次进入诊断折叠',async({page})=>{
 const h=await mock(page);await expect(page.getByTestId('getting-started')).toContainText('从这里开始');await expect(page.locator('[data-sensor="preview"]')).toBeHidden();
 await page.getByRole('button',{name:'查看使用指南',exact:true}).click();await expect(page.getByTestId('user-guide')).toBeVisible();
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();await expect(page.getByTestId('getting-started')).toBeVisible();await expect(page.getByTestId('overview-stats')).toContainText('0 组');
 await page.getByRole('button',{name:'前往扫描建图',exact:true}).click();await expect(page.locator('.left-panel .panel-title')).toHaveText('扫描控制');expect(h.errors).toEqual([]);
});
for(const width of [375,760])test(`使用指南${width}px：直接访问、五页导航及内容无横向溢出`,async({page})=>{
 await page.setViewportSize({width,height:900});const h=await mock(page,{url:'/?page=guide'});await expect(page.getByTestId('user-guide')).toBeVisible();
 for(const selector of ['.guide-page','.guide-intro','.guide-columns','.guide-faq','.global-status']){
  const box=await page.locator(selector).boundingBox();expect(box).not.toBeNull();expect(box!.x).toBeGreaterThanOrEqual(-1);expect(box!.x+box!.width).toBeLessThanOrEqual(width+1);
 }
 expect(await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth)).toBeLessThanOrEqual(1);expect(h.errors).toEqual([]);
});
