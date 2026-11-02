import {test,expect,type Page} from '@playwright/test';

// 第1项验收（drawio 形态）：顶部菜单栏、左侧分组工具面板都是**真实可操作**的，
// 不是静态文字；菜单项真的会改变界面状态。所有 /api/** 都被拦截，不写生产库。
const tags=[
 {id:0,x:0,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:1,x:1,y:0,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
 {id:2,x:1,y:1,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]},
];
const map:any={schemaVersion:1,id:'chrome-map',name:'外壳核验图',frame:'map',family:'tag36h11',source:'survey',
 coordinateStatus:'draft',routeMode:'waypoints',
 rows:[{id:'route',name:'原路线',width:.6,exitDistance:.8,start:{x:0,y:0},points:[{x:1,y:0},{x:1,y:1}]}],order:['route'],
 tags,zone:[{x:-.5,y:-.5},{x:1.5,y:-.5},{x:1.5,y:1.5},{x:-.5,y:1.5}],vehicle:{width:.4,length:.8,margin:.05},notes:''};
const route:any={routeId:'route-chrome',mapId:map.id,name:'原路线',mapVersion:1,mapDigest:'d',
 points:[{x:0,y:0},{x:1,y:0},{x:1,y:1}],
 motionSegments:[{id:'a',fromId:0,toId:1,mode:'4t4d',direction:'forward',points:[{x:0,y:0},{x:1,y:0}]},
  {id:'b',fromId:1,toId:2,mode:'4t4d',direction:'crab',points:[{x:1,y:0},{x:1,y:1}]}],
 bodyYawDeg:0,initialHeadingRad:null,distanceModel:'center-euclidean',spacingOverrides:[],
 created:new Date(0).toISOString(),updated:new Date(0).toISOString()};

async function boot(page:Page){
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],events:[],detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:true,quality:'draft',localEpoch:'chrome',reason:''}}})));
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
  if(path==='/api/routes/'+route.routeId+'/topology')return r.fulfill({json:{routeId:route.routeId,mapId:map.id,mapVersion:1,stored:false,topology:{nodes:[{tagId:0},{tagId:1},{tagId:2}],edges:[{fromId:0,toId:1,occurrence:1,mode:'4t4d',direction:'forward'},{fromId:1,toId:2,occurrence:1,mode:'crab',direction:'lateral'}]},summary:[],issues:[],strategyChoices:{choices:[],issues:[]},disclaimer:'保存拓扑不会解锁实车执行。'}});
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

test('第1项：顶部菜单栏真实存在，点开是真下拉菜单，Esc 关闭',async({page})=>{
 const errors=await boot(page);
 await expect(page.getByTestId('editor-menubar')).toBeVisible();
 // 五个菜单都在
 for(const id of ['file','edit','view','layout','help']){
  await expect(page.getByTestId('editor-menu-'+id)).toBeVisible();
 }
 // 点开「文件」：出现真实下拉面板与可点击项
 await page.getByTestId('editor-menu-file').click();
 await expect(page.getByTestId('editor-menu-panel-file')).toBeVisible();
 await expect(page.getByTestId('editor-command-file-new-map')).toBeVisible();
 await expect(page.getByTestId('editor-menu-file')).toHaveAttribute('aria-expanded','true');
 // Esc 关闭
 await page.keyboard.press('Escape');
 await expect(page.getByTestId('editor-menu-panel-file')).toHaveCount(0);
 // 点外部也关闭
 await page.getByTestId('editor-menu-view').click();
 await expect(page.getByTestId('editor-menu-panel-view')).toBeVisible();
 // 点「画布」本身（下拉菜单覆盖不到的区域）验证点外部关闭
 await page.getByTestId('map-canvas').click({position:{x:120,y:120}});
 await expect(page.getByTestId('editor-menu-panel-view')).toHaveCount(0);
 expect(errors).toEqual([]);
});

test('第1项：菜单项真的改变界面——布局菜单收起/展开左栏',async({page})=>{
 await boot(page);
 const leftWidth=async()=>page.evaluate(()=>document.querySelector('.editor-shell__left')?.getBoundingClientRect().width??0);
 const before=await leftWidth();
 expect(before).toBeGreaterThan(120);

 await page.getByTestId('editor-menu-layout').click();
 await page.getByTestId('editor-command-layout-toggle-left').click();
 await page.waitForTimeout(400);
 expect(await leftWidth(),'菜单点「收起左栏」必须真的收起').toBeLessThan(60);

 await page.getByTestId('editor-menu-layout').click();
 await page.getByTestId('editor-command-layout-toggle-left').click();
 await page.waitForTimeout(400);
 expect(await leftWidth(),'再点必须真的展开').toBeGreaterThan(120);
});

test('第1项：菜单项按当前上下文增减，不可用项置灰且点了不生效',async({page})=>{
 await boot(page);
 // 非路径编辑态：「文件」菜单只有「新建/编辑路径」，没有「保存路径/撤销/退出」。
 // 这是有意的上下文菜单——不把用不上的动作摆出来，避免用户点了没反应。
 await page.getByTestId('editor-menu-file').click();
 await expect(page.getByTestId('editor-command-route-new')).toBeEnabled();
 await expect(page.getByTestId('editor-command-route-edit')).toBeEnabled();
 await expect(page.getByTestId('editor-command-route-save')).toHaveCount(0);
 await expect(page.getByTestId('editor-command-route-exit')).toHaveCount(0);
 await page.keyboard.press('Escape');

 // 「编辑」菜单里撤销/重做在非编辑态是置灰的（不是消失），点了不 emit
 await page.getByTestId('editor-menu-edit').click();
 const undo=page.getByTestId('editor-command-edit-undo');
 await expect(undo).toBeVisible();
 await expect(undo).toBeDisabled();
 await expect(undo).toHaveAttribute('aria-disabled','true');
 // 强制点也不会产生任何界面变化（仍是选择态、未进入路径编辑）
 await undo.click({force:true});
 await page.waitForTimeout(300);
 await expect(page.getByTestId('route-editor')).toHaveCount(0);
 await page.keyboard.press('Escape');
});

test('第1项：左侧工具面板分组可折叠且状态持久化',async({page})=>{
 await boot(page);
 const palette=page.getByTestId('editor-tool-palette');
 await expect(palette).toBeVisible();
 // 五组都在，且默认展开
 for(const id of ['tag','array','path','select','view']){
  await expect(page.getByTestId('editor-palette-group-'+id)).toBeVisible();
  await expect(page.getByTestId('editor-palette-group-'+id)).toHaveAttribute('data-collapsed','0');
 }
 // 折叠「阵列与铺码」：组内条目消失，存储里记住
 await page.getByTestId('editor-palette-toggle-array').click();
 await page.waitForTimeout(300);
 await expect(page.getByTestId('editor-palette-group-array')).toHaveAttribute('data-collapsed','1');
 await expect(page.getByTestId('editor-palette-array-grid')).toBeHidden();
 const stored=await page.evaluate(()=>localStorage.getItem('qrautorun.editor.palette.v1'));
 expect(stored,'折叠状态必须落盘').toContain('array');

 // 刷新后仍然是折叠的
 await page.reload();
 await page.waitForTimeout(900);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(400);
 await page.getByTestId('map-select').selectOption(map.id);
 await page.waitForTimeout(600);
 await expect(page.getByTestId('editor-palette-group-array')).toHaveAttribute('data-collapsed','1');
 await expect(page.getByTestId('editor-palette-array-grid')).toBeHidden();
 // 其它组仍展开
 await expect(page.getByTestId('editor-palette-group-path')).toHaveAttribute('data-collapsed','0');
});

test('第1项：工具面板项真的执行——「编辑路径」进入路径编辑态',async({page})=>{
 await boot(page);
 await page.getByTestId('editor-palette-path-edit').click();
 await expect(page.getByTestId('route-editor')).toBeVisible({timeout:15000});
 await page.waitForTimeout(400);
 // 进入编辑后「文件」菜单才出现保存/撤销/退出这三项（上下文菜单）
 await expect(page.getByTestId('editor-menu-file')).toBeVisible();
 await page.getByTestId('editor-menu-file').click();
 await expect(page.getByTestId('editor-command-route-save')).toBeVisible();
 await expect(page.getByTestId('editor-command-route-exit')).toBeEnabled();
 // 用菜单项本身关闭下拉，不要按 Esc —— Esc 在这里是「退出路径编辑」，
 // 会把刚进入的编辑态关掉，那样后面的断言就没有意义了。
 await page.getByTestId('editor-menu-file').click();
 await expect(page.getByTestId('editor-menu-panel-file')).toHaveCount(0);
 // 工具面板在路径编辑态仍可用，并且选中态高亮当前工具
 await expect(page.getByTestId('editor-tool-palette')).toBeVisible();
 await expect(page.getByTestId('editor-palette-select-select')).toHaveAttribute('aria-pressed','true');
});
