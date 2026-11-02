import {test,expect,type Page} from '@playwright/test';
import {compileDesignedRoute} from '../../web/backend/src/route-design';
import {mapSchema} from '../../web/shared/model';
import {topologyFromSegments} from '../../web/shared/route-topology';

// 第4项验收：稳定 tagId 的有向路线拓扑在真实界面上可读、可改、可保存、可恢复，
// 且「保存拓扑 ≠ 解锁实车执行」。所有 /api/** 都被拦截，拓扑存在内存里，不写生产库。
const points=[{x:0,y:0},{x:1,y:0},{x:1,y:1}];
const source=mapSchema.parse({schemaVersion:1,id:'scan-browser-topology',name:'拓扑核验地图',frame:'map',family:'tag36h11',
 source:'survey',coordinateStatus:'draft',routeMode:'waypoints',
 rows:[{id:'route',name:'原路线',width:.6,exitDistance:.8,start:points[0],points:points.slice(1)}],order:['route'],
 tags:points.map((p,id)=>({id,...p,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]})),
 zone:[{x:-.5,y:-.5},{x:1.5,y:-.5},{x:1.5,y:1.5},{x:-.5,y:1.5}],vehicle:{width:.4,length:.8,margin:.05},notes:''});

type Ctx={
 errors:string[];
 requests:{method:string;path:string;body:any}[];
 topologies:any[];
 startCalls:number;
};

async function setup(page:Page):Promise<Ctx>{
 const ctx:Ctx={errors:[],requests:[],topologies:[],startCalls:0};
 page.on('pageerror',e=>ctx.errors.push(e.message));
 let version=1,map=structuredClone(source);
 let storedTopology:any=null;
 const routeId='route-topology-browser';
 const segments=()=>compileDesignedRoute(map,points,0).map.motionSegments!;
 const route=()=>({routeId,mapId:map.id,name:'原路线',mapVersion:version,mapDigest:'digest',
  points:points.map(p=>({...p})),motionSegments:segments(),bodyYawDeg:0,initialHeadingRad:null,
  distanceModel:'center-euclidean',spacingOverrides:[],created:new Date(0).toISOString(),updated:new Date(0).toISOString()});
 const task=()=>({id:'task-topology',name:'拓扑任务',mapId:map.id,mapVersion:version,routeId,
  rowOrder:['route'],forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true});

 await page.routeWebSocket('**/ws',ws=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],events:[],detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:true,quality:'draft',localEpoch:'topo',reason:''}}})));
 await page.routeWebSocket('**/ws/camera',()=>{});
 await page.route('**/api/**',async r=>{
  const req=r.request();
  const url=new URL(req.url());
  const path=url.pathname;
  const method=req.method();
  let body:any=null;
  try{body=req.postDataJSON();}catch{body=null;}
  ctx.requests.push({method,path,body});

  if(path==='/api/maps')return r.fulfill({json:[{id:map.id,name:map.name,version}]});
  if(path==='/api/maps/'+map.id)return r.fulfill({json:{map,version,acceptance:{kind:'office_test',accepted:true,digestValid:true}}});
  // 现场名称：真实 tagId 不变，只影响显示（画布 / 表格 / 路径步骤共用同一份别名）
  if(path==='/api/maps/'+map.id+'/tag-aliases')return r.fulfill({json:{mapId:map.id,mapVersion:version,
   aliases:[{tagId:0,name:'东头桩',updated:new Date(0).toISOString()},{tagId:2,name:'西头桩',updated:new Date(0).toISOString()}],
   disclaimer:'名称只影响显示，不改真实二维码编号。'}});
  if(path==='/api/routes')return r.fulfill({json:[route()]});
  if(path==='/api/tasks')return r.fulfill({json:[task()]});
  if(path==='/api/surveys'||path==='/api/boards')return r.fulfill({json:[]});
  if(path==='/api/camera/status')return r.fulfill({json:{running:false,present:false}});
  // 真实接口形状：GET /api/routes/:id 带 map 快照与地图版本，selectMap 靠它填 field
  if(path==='/api/routes/'+routeId)return r.fulfill({json:{...route(),route:route(),map,version,
   acceptance:{kind:'office_test',accepted:true,digestValid:true}}});

  if(path==='/api/routes/'+routeId+'/topology'){
   const restored=topologyFromSegments(segments());
   if(method==='GET'){
    const topology=storedTopology??restored.topology;
    return r.fulfill({json:{routeId,mapId:map.id,mapVersion:version,stored:!!storedTopology,
     topology,summary:['第 1 段：Q0 → Q1 · 前进 · 4T4D · 1.00 m'],issues:[],strategyChoices:{choices:[],issues:[]},
     disclaimer:'拓扑只描述码与码之间的有向经过关系；保存拓扑不会解锁实车执行，能否导航仍由路径编译安全门、定位锚定与设备就绪条件决定。'}});
   }
   if(method==='PUT'){
    ctx.topologies.push(body);
    storedTopology=body.topology;
    let written=route();
    if(body.savePoints){
     const flat:any[]=[];
     for(const edge of body.topology.edges){
      const from=map.tags.find(t=>t.id===edge.fromId)!,to=map.tags.find(t=>t.id===edge.toId)!;
      for(const p of [from,...(edge.waypoints??[]),to])if(!flat.length||Math.abs(flat.at(-1).x-p.x)>1e-6||Math.abs(flat.at(-1).y-p.y)>1e-6)flat.push({x:p.x,y:p.y});
     }
     try{
      const compiled=compileDesignedRoute(map,flat,0);
      map=compiled.map;version++;
      written={...route(),points:flat,motionSegments:compiled.map.motionSegments!,updated:new Date(Date.now()).toISOString()};
     }catch(e){return r.fulfill({status:400,json:{error:String(e)}});}
    }
    return r.fulfill({json:{routeId,mapId:map.id,mapVersion:version,stored:true,topology:storedTopology,
     summary:[],issues:[],strategyChoices:{choices:[],issues:[]},route:written,points:written.points,
     segments:written.motionSegments,disclaimer:'拓扑只描述码与码之间的有向经过关系；保存拓扑不会解锁实车执行。'}});
   }
   if(method==='DELETE'){storedTopology=null;return r.fulfill({json:{routeId,removed:1}});}
  }
  // App 在切换地图时会同步定位作用域，这是只读/切换请求，不是运动指令；
  // 拦成 404 会让界面停在「定位未锚定」，与拓扑无关。
  if(path==='/api/localization/map')return r.fulfill({json:{mapId:map.id,version,phase:'anchored'}});
  if(path==='/api/localization/scope')return r.fulfill({json:{phase:'anchored',mapId:map.id,version}});
  if(path==='/api/navigation/start'){ctx.startCalls++;return r.fulfill({status:423,json:{error:'地图尚未完成路径编辑，禁止启动导航'}});}
  ctx.errors.push('未预期的 API: '+method+' '+path);
  return r.fulfill({status:404,json:{error:path}});
 });

 await page.goto('/');
 await page.waitForTimeout(700);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(400);
 await page.getByTestId('map-select').selectOption(map.id);
 await page.waitForTimeout(600);
 await page.getByTestId('route-select').selectOption(routeId);
 await page.waitForTimeout(500);
 await expect(page.getByTestId('edit-route')).toBeEnabled();
 await page.getByTestId('edit-route').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 return ctx;
}

test('第4项：拓扑面板可见、免责声明原样展示、从未调用导航启动',async({page})=>{
 const ctx=await setup(page);
 const panel=page.getByTestId('route-topology-panel');
 await expect(panel).toBeVisible();
 // 未保存过 → 由运动区间还原，旧路径也能打开
 await expect(panel).toHaveAttribute('data-topology-stored','0');
 await expect(page.getByTestId('route-topology-restored')).toBeVisible();
 await expect(page.getByTestId('route-topology-edge-0')).toHaveAttribute('data-from','0');
 await expect(page.getByTestId('route-topology-edge-0')).toHaveAttribute('data-to','1');
 await expect(page.getByTestId('route-topology-edge-1')).toHaveAttribute('data-from','1');
 await expect(page.getByTestId('route-topology-edge-1')).toHaveAttribute('data-to','2');
 await expect(panel).toContainText('不会解锁实车执行');
 expect(ctx.startCalls,'保存/读取拓扑绝不能触发导航启动').toBe(0);
 expect(ctx.errors).toEqual([]);
});

test('第4项：加一段有向区间 → 保存 → 刷新后仍是从后端读回的拓扑',async({page})=>{
 const ctx=await setup(page);
 // 加一段 Q2→Q1（反向经过），occurrence 自动为 1
 await page.getByTestId('route-topology-add-from').selectOption('2');
 await page.getByTestId('route-topology-add-to').selectOption('1');
 await page.getByTestId('route-topology-add-direction').selectOption('reverse');
 await page.getByTestId('route-topology-add-confirm').click();
 await page.waitForTimeout(300);
 await expect(page.getByTestId('route-topology-edge-2')).toHaveAttribute('data-from','2');
 await expect(page.getByTestId('route-topology-edge-2')).toHaveAttribute('data-to','1');
 await expect(page.getByTestId('route-topology-panel')).toHaveAttribute('data-topology-dirty','1');

 await page.getByTestId('route-topology-save').click();
 await page.waitForTimeout(600);
 expect(ctx.topologies.length,'必须真的提交一次拓扑保存').toBe(1);
 expect(ctx.topologies[0].topology.edges.map((e:any)=>[e.fromId,e.toId,e.direction]))
  .toEqual([[0,1,'forward'],[1,2,'lateral'],[2,1,'reverse']]);
 await expect(page.getByTestId('route-topology-panel')).toHaveAttribute('data-topology-stored','1');
 await expect(page.getByTestId('route-topology-stored')).toBeVisible();

 // 刷新后重新进入编辑：拓扑必须来自后端，而不是重新从区间猜
 await page.reload();
 await page.waitForTimeout(800);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(400);
 await page.getByTestId('map-select').selectOption(source.id);
 await page.waitForTimeout(600);
 await page.getByTestId('route-select').selectOption('route-topology-browser');
 await page.waitForTimeout(400);
 await page.getByTestId('edit-route').click();
 await page.waitForTimeout(600);
 const panel=page.getByTestId('route-topology-panel');
 await expect(panel).toHaveAttribute('data-topology-stored','1');
 await expect(panel).toHaveAttribute('data-topology-edges','3');
 await expect(page.getByTestId('route-topology-edge-2')).toHaveAttribute('data-to','1');
 expect(ctx.startCalls).toBe(0);
});

test('第4项：断链拓扑被拦住，保存按钮不可用，并指出断在哪',async({page})=>{
 const ctx=await setup(page);
 // 删掉中间那段 Q1→Q2，剩下 Q0→Q1 仍是连续的单段，先验证删除本身生效
 await page.getByTestId('route-topology-remove-1').click();
 await page.waitForTimeout(300);
 await expect(page.getByTestId('route-topology-panel')).toHaveAttribute('data-topology-edges','1');
 // 再加一段不相接的 Q2→Q0：链断开，必须报错且不能保存
 await page.getByTestId('route-topology-add-from').selectOption('2');
 await page.getByTestId('route-topology-add-to').selectOption('0');
 await page.getByTestId('route-topology-add-confirm').click();
 await page.waitForTimeout(300);
 await expect(page.getByTestId('route-topology-blockers')).toBeVisible();
 await expect(page.getByTestId('route-topology-blockers')).toContainText('不连续');
 await expect(page.getByTestId('route-topology-save')).toBeDisabled();
 await page.getByTestId('route-topology-save').click({force:true});
 await page.waitForTimeout(300);
 expect(ctx.topologies.length,'被拦住的拓扑不得提交').toBe(0);
 expect(ctx.startCalls).toBe(0);
});

test('第4项：中间点与策略可编辑，保存后出现在提交体里',async({page})=>{
 const ctx=await setup(page);
 // 给第 1 段加一个正交中间点：(0,0) → (0,0.3) → (1,0) 会斜，所以用两段式折线
 await page.getByTestId('route-topology-waypoint-x-0').fill('0');
 await page.getByTestId('route-topology-waypoint-y-0').fill('0.3');
 await page.getByTestId('route-topology-waypoint-add-0').click();
 await page.waitForTimeout(300);
 await expect(page.getByTestId('route-topology-panel')).toHaveAttribute('data-topology-dirty','1');
 // 单个中间点造成斜线 → 必须立刻报错（不能等到保存）
 await expect(page.getByTestId('route-topology-blockers')).toBeVisible();
 await expect(page.getByTestId('route-topology-blockers')).toContainText('水平');
 // 删掉它，恢复合法
 await page.getByTestId('route-topology-waypoint-remove-0-0').click();
 await page.waitForTimeout(300);
 await expect(page.getByTestId('route-topology-blockers')).toHaveCount(0);

 // 策略：把第 1 段设为「保持朝向倒车」
 await page.getByTestId('route-topology-strategy-0').selectOption('reverse');
 await page.waitForTimeout(300);
 await page.getByTestId('route-topology-save').click();
 await page.waitForTimeout(600);
 expect(ctx.topologies.length).toBe(1);
 expect(ctx.topologies[0].topology.edges[0].strategy).toBe('reverse');
 expect(ctx.startCalls).toBe(0);
});

test('第3项+第4项：现场名称同时出现在路径步骤里，真实 tagId 仍是 0/1/2',async({page})=>{
 const ctx=await setup(page);
 await page.getByTestId('route-topology-save-points').check();
 await page.getByTestId('route-topology-save').click();
 await page.waitForTimeout(700);
 expect(ctx.topologies.length).toBe(1);
 expect(ctx.topologies[0].savePoints,'必须显式带上 savePoints').toBe(true);
 expect(ctx.topologies[0].topology.edges.map((e:any)=>[e.fromId,e.toId])).toEqual([[0,1],[1,2]]);
 // 折线由真实码心展平而来，端点坐标就是地图里的 tag 坐标
 const routeCall=ctx.requests.filter(r=>r.path==='/api/routes/route-topology-browser'&&r.method==='GET');
 expect(routeCall.length).toBeGreaterThan(0);
 expect(ctx.startCalls).toBe(0);
 expect(ctx.errors).toEqual([]);
});

test('第3项：现场名称同时出现在路径步骤与画布，真实 tagId 仍是 0/1/2',async({page})=>{
 await setup(page);
 // 路径步骤是底部浮窗，默认收起：先展开再断言
 await page.getByTestId('route-steps-trigger').click();
 await expect(page.getByTestId('route-steps-popover')).toBeVisible();
 // 路径步骤表：有别名显示「名称 (Q000)」，没有别名保持既有 Q001
 const first=page.getByTestId('route-step-qr-0');
 await expect(first).toBeVisible();
 await expect(first).toContainText('东头桩');
 await expect(first).toContainText('Q000');
 const last=page.getByTestId('route-step-qr-2');
 await expect(last).toContainText('西头桩');
 await expect(last).toContainText('Q002');
 // 中间那个码没有名称 → 与旧显示完全一致，不被别名机制改写
 await expect(page.getByTestId('route-step-qr-1')).toContainText('Q001');

 // 画布用同一份别名（Konva 文本），真实编号仍在 aria-label 里
 const canvasAliases=await page.evaluate(()=>{
  const el=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  return el?JSON.parse(el.dataset.konvaAliases||'{}'):{};
 });
 expect(canvasAliases['0']).toBe('东头桩');
 expect(canvasAliases['2']).toBe('西头桩');
 // 拓扑顶点依旧是真实 tagId，别名绝不进入拓扑
 await expect(page.getByTestId('route-topology-edge-0')).toHaveAttribute('data-from','0');
 await expect(page.getByTestId('route-topology-edge-1')).toHaveAttribute('data-to','2');
});
