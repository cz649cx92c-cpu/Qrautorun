import {test,expect,type Page} from '@playwright/test';

// 第1项验收：EditorShell 真的挂在 App 里，左/右/底三栏可收起、可拖拽改尺寸、
// 右栏可浮动/停靠，布局刷新后保持，且「恢复默认」能一键回到默认。
// 所有 /api/** 都被拦截，不写生产库。
const tags=[
 {id:0,x:0,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:1,x:1,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:2,x:2,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
];
const map:any={schemaVersion:1,id:'layout-map',name:'布局核验图',frame:'map',family:'tag36h11',source:'survey',
 coordinateStatus:'draft',routeMode:'waypoints',
 rows:[{id:'route',name:'原路线',width:.6,exitDistance:.8,start:{x:0,y:0},points:[{x:1,y:0},{x:2,y:0}]}],order:['route'],
 tags,zone:[{x:-.5,y:-.5},{x:2.5,y:-.5},{x:2.5,y:1.5},{x:-.5,y:1.5}],vehicle:{width:.4,length:.8,margin:.05},notes:''};
const route:any={routeId:'route-layout',mapId:map.id,name:'原路线',mapVersion:1,mapDigest:'d',
 points:[{x:0,y:0},{x:1,y:0},{x:2,y:0}],
 motionSegments:[{id:'a',fromId:0,toId:1,mode:'4t4d',direction:'forward',points:[{x:0,y:0},{x:1,y:0}]},
  {id:'b',fromId:1,toId:2,mode:'4t4d',direction:'forward',points:[{x:1,y:0},{x:2,y:0}]}],
 bodyYawDeg:0,initialHeadingRad:null,distanceModel:'center-euclidean',spacingOverrides:[],
 created:new Date(0).toISOString(),updated:new Date(0).toISOString()};

async function boot(page:Page){
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],events:[],detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:true,quality:'draft',localEpoch:'layout',reason:''}}})));
 await page.routeWebSocket('**/ws/camera',()=>{});
 await page.route('**/api/**',async r=>{
  const path=new URL(r.request().url()).pathname;
  if(path==='/api/maps')return r.fulfill({json:[{id:map.id,name:map.name,version:1}]});
  if(path==='/api/maps/'+map.id)return r.fulfill({json:{map,version:1,acceptance:{kind:'office_test',accepted:true,digestValid:true}}});
  if(path==='/api/maps/'+map.id+'/tag-aliases')return r.fulfill({json:{mapId:map.id,mapVersion:1,aliases:[],disclaimer:'x'}});
  if(path==='/api/routes')return r.fulfill({json:[route]});
  if(path==='/api/tasks')return r.fulfill({json:[{id:'t',name:'t',mapId:map.id,mapVersion:1,routeId:route.routeId,rowOrder:['route'],forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true}]});
  if(path==='/api/surveys'||path==='/api/boards')return r.fulfill({json:[]});
  if(path==='/api/camera/status')return r.fulfill({json:{running:false,present:false}});
  if(path==='/api/localization/map')return r.fulfill({json:{phase:'anchored'}});
  if(path==='/api/localization/scope')return r.fulfill({json:{phase:'anchored'}});
  if(path==='/api/routes/'+route.routeId)return r.fulfill({json:{...route,route,map,version:1,acceptance:{kind:'office_test',accepted:true,digestValid:true}}});
  if(path==='/api/routes/'+route.routeId+'/topology')return r.fulfill({json:{routeId:route.routeId,mapId:map.id,mapVersion:1,stored:false,topology:{nodes:[{tagId:0},{tagId:1},{tagId:2}],edges:[{fromId:0,toId:1,occurrence:1,mode:'4t4d',direction:'forward'},{fromId:1,toId:2,occurrence:1,mode:'4t4d',direction:'forward'}]},summary:[],issues:[],strategyChoices:{choices:[],issues:[]},disclaimer:'保存拓扑不会解锁实车执行。'}});
  return r.fulfill({json:{}});
 });
 await page.goto('/');
 await page.waitForTimeout(800);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(400);
 await page.getByTestId('map-select').selectOption(map.id);
 await page.waitForTimeout(600);
 return errors;
}

const layout=(page:Page)=>page.evaluate(()=>JSON.parse(localStorage.getItem('qrautorun.editor.layout.v1')||'null'));
const shellLeft=async(page:Page)=>page.evaluate(()=>{
 const el=document.querySelector('.editor-shell__left') as HTMLElement|null;
 return el?el.getBoundingClientRect().width:0;
});

test('第1项：EditorShell 真的挂载，左/右栏可见且可收起',async({page})=>{
 const errors=await boot(page);
 await expect(page.getByTestId('editor-layout-tools')).toBeVisible();
 await expect(page.locator('.editor-shell')).toBeVisible();
 const before=await shellLeft(page);
 expect(before,'左栏必须有真实宽度（曾经整栏宽度为 0 导致画布点不中）').toBeGreaterThan(120);

 // 收起左栏：宽度归零、画布变宽
 const canvasBefore=await page.evaluate(()=>document.querySelector('.editor-shell__canvas')?.getBoundingClientRect().width??0);
 await page.getByTestId('layout-toggle-left').click();
 await page.waitForTimeout(400);
 await expect.poll(()=>shellLeft(page)).toBeLessThan(60);
 const canvasAfter=await page.evaluate(()=>document.querySelector('.editor-shell__canvas')?.getBoundingClientRect().width??0);
 expect(canvasAfter,'收起左栏后画布应变宽').toBeGreaterThan(canvasBefore);

 // 再展开：宽度回来
 await page.getByTestId('layout-toggle-left').click();
 await page.waitForTimeout(400);
 await expect.poll(()=>shellLeft(page)).toBeGreaterThan(120);
 expect(errors).toEqual([]);
});

test('第1项：拖动分隔条改宽度，刷新后仍是拖动后的宽度',async({page})=>{
 await boot(page);
 const before=await shellLeft(page);
 const splitter=page.locator('.editor-shell__splitter').first();
 await expect(splitter).toBeVisible();
 const box=(await splitter.boundingBox())!;
 await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
 await page.mouse.down();
 await page.mouse.move(box.x+box.width/2+120,box.y+box.height/2,{steps:10});
 await page.mouse.up();
 await page.waitForTimeout(400);
 const dragged=await shellLeft(page);
 expect(dragged,'拖动后左栏应变宽').toBeGreaterThan(before+60);

 // 布局必须真的落盘
 const stored=await layout(page);
 expect(stored,'布局必须写入 usePanelLayout 的存储键').not.toBeNull();
 expect(stored.leftWidth,'存储宽度应等于拖动后的宽度').toBeGreaterThan(before+60);

 // 刷新后恢复
 await page.reload();
 await page.waitForTimeout(900);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(400);
 await page.getByTestId('map-select').selectOption(map.id);
 await page.waitForTimeout(600);
 const restored=await shellLeft(page);
 expect(Math.abs(restored-dragged),'刷新后宽度必须保持').toBeLessThan(6);
});

test('第1项：右栏可浮动/停靠并持久化，恢复默认一键回到默认',async({page})=>{
 await boot(page);
 await expect(page.locator('.editor-shell__right')).toBeVisible();
 await page.getByTestId('layout-toggle-float').click();
 await page.waitForTimeout(400);
 const floating=await layout(page);
 expect(floating.rightFloating,'浮动状态必须落盘').toBe(true);

 await page.reload();
 await page.waitForTimeout(900);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(400);
 await page.getByTestId('map-select').selectOption(map.id);
 await page.waitForTimeout(600);
 expect((await layout(page)).rightFloating,'刷新后仍应浮动').toBe(true);

 // 恢复默认：内存布局回到 DEFAULT_PANEL_LAYOUT，存储键被清掉
 await page.getByTestId('layout-reset').click();
 await page.waitForTimeout(400);
 expect(await layout(page),'恢复默认必须清掉存储里的自定义布局').toBeNull();
 const effective=await page.evaluate(()=>{
  const shell=document.querySelector('.editor-shell') as HTMLElement|null;
  const left=document.querySelector('.editor-shell__left') as HTMLElement|null;
  return {floating:shell?.classList.contains('is-right-floating')??null,leftWidth:left?left.getBoundingClientRect().width:0};
 });
 expect(effective.floating,'恢复默认后右栏应回到停靠').toBe(false);
 expect(Math.abs(effective.leftWidth-280),'恢复默认后左栏应为默认宽度').toBeLessThan(6);
});

test('第1项：进入路径编辑后底部步骤栏可收起/展开，且与画布互不遮挡',async({page})=>{
 await boot(page);
 await page.getByTestId('route-select').selectOption(route.routeId);
 await page.waitForTimeout(500);
 await page.getByTestId('edit-route').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await page.waitForTimeout(600);

 // 画布必须有真实宽度：这是「面板挤掉画布」的回归守卫
 const canvasWidth=await page.evaluate(()=>document.querySelector('.editor-shell__canvas')?.getBoundingClientRect().width??0);
 expect(canvasWidth,'路径编辑态画布宽度必须 > 600px').toBeGreaterThan(600);

 await expect(page.getByTestId('layout-toggle-bottom')).toBeVisible();
 await page.getByTestId('layout-toggle-bottom').click();
 await page.waitForTimeout(400);
 expect((await layout(page)).bottomCollapsed,'底部收起状态必须落盘').toBe(true);
 await page.getByTestId('layout-toggle-bottom').click();
 await page.waitForTimeout(400);
 expect((await layout(page)).bottomCollapsed).toBe(false);
});
