import {test,expect} from '@playwright/test';

// 第3项验收：二维码现场名称可编辑、持久化、刷新恢复、画布/表格显示，且真实 tagId 不变。
// 所有 /api/** 都被拦截，别名保存在内存里，不写生产库。
const tags=[
 {id:0,x:0.27,y:-1.39,angle:0,size:0.06,groupId:'B000',rowId:'',kind:'waypoint',rules:[]},
 {id:4,x:0.87,y:-1.39,angle:0,size:0.06,groupId:'B004',rowId:'',kind:'waypoint',rules:[]},
];
const mkBoard=(id:string,ref:number)=>({id,referenceId:ref,gridSize:2,sizeMm:60,gapMm:2,members:[
 {id:ref,x:-0.0155,y:0.0155,angle:0,size:0.0232},{id:ref+1,x:0.0155,y:0.0155,angle:0,size:0.0232},
 {id:ref+2,x:-0.0155,y:-0.0155,angle:0,size:0.0232},{id:ref+3,x:0.0155,y:-0.0155,angle:0,size:0.0232}]});
const map:any={schemaVersion:1,id:'alias-map',name:'别名核验图',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'reviewed',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],tags,groups:[mkBoard('B000',0),mkBoard('B004',4)],zone:[{x:-0.5,y:-2.6},{x:2.0,y:-2.6},{x:2.0,y:-0.8},{x:-0.5,y:-0.8}],vehicle:{width:0.4,length:0.8,margin:0.05},notes:''};

test('第3项：现场名称可编辑/保存/刷新恢复，画布与表格都显示，真实 tagId 不变',async({page})=>{
 // 服务端别名存储（内存），模拟真实持久化
 let stored:any[]=[];
 const posted:any[]=[];
 await page.routeWebSocket('**/ws',(ws:any)=>ws.send(JSON.stringify({type:'robot',status:{connected:true,state:'IDLE',running:false,paused:false,pose:null,chassis:{connected:true},sensors:{},conditions:[],events:[],detector:{connected:true,positionReady:true,groups:[],reason:''},mapping:{ready:true,quality:'draft',localEpoch:'alias',reason:''}}})));
 await page.routeWebSocket('**/ws/camera',()=>{});
 await page.route('**/api/**',async (r:any)=>{
  const req=r.request();
  const path=new URL(req.url()).pathname;
  if(path==='/api/maps')return r.fulfill({json:[{id:map.id,name:map.name,version:1}]});
  if(path==='/api/maps/'+map.id)return r.fulfill({json:{map,version:1,acceptance:{kind:null,accepted:false,digestValid:false}}});
  if(path==='/api/maps/'+map.id+'/tag-aliases'){
   if(req.method()==='POST'){
    const body=req.postDataJSON();posted.push(body);
    stored=body.aliases.map((a:any,i:number)=>({tagId:a.tagId,name:a.name,updated:new Date().toISOString()}));
    return r.fulfill({json:{mapId:map.id,mapVersion:1,aliases:stored,changed:stored.length,removed:0,disclaimer:'x'}});
   }
   return r.fulfill({json:{mapId:map.id,mapVersion:1,aliases:stored,disclaimer:'x'}});
  }
  if(path==='/api/routes'||path==='/api/tasks'||path==='/api/surveys'||path==='/api/boards')return r.fulfill({json:[]});
  if(path==='/api/camera/status')return r.fulfill({json:{running:false,present:false}});
  return r.fulfill({json:{}});
 });

 await page.goto('/');
 await page.waitForTimeout(800);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(500);
 await page.getByTestId('map-select').selectOption(map.id);
 await page.waitForTimeout(600);
 await page.getByRole('button',{name:'路径编辑',exact:true}).click();
 await page.waitForTimeout(900);

 // 打开点位表格
 await page.getByTestId('map-tag-table-start').click();
 await page.waitForTimeout(500);

 // 名称输入框存在，初始为空（placeholder 是真实编号）
 const alias0=page.getByTestId('map-tag-alias-0');
 await expect(alias0).toBeVisible();
 await expect(alias0).toHaveValue('');
 await expect(alias0).toHaveAttribute('placeholder','Q000');

 // 写名称 → 保存
 await alias0.fill('东头桩');
 await page.getByTestId('map-tag-alias-4').fill('二号桩');
 await page.waitForTimeout(300);
 await page.getByTestId('map-tag-alias-save').click();
 await page.waitForTimeout(700);
 expect(posted.length,'必须真的提交一次别名保存').toBe(1);
 expect(posted[0].aliases.map((a:any)=>[a.tagId,a.name])).toEqual([[0,'东头桩'],[4,'二号桩']]);

 // 真实 tagId 不变：几何表格的编号列仍是 0 与 4
 await expect(page.getByTestId('map-tag-id-0')).toHaveValue('0');
 await expect(page.getByTestId('map-tag-id-4')).toHaveValue('4');

 // 刷新页面后名称必须恢复（持久化读回）
 await page.reload();
 await page.waitForTimeout(900);
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(500);
 await page.getByTestId('map-select').selectOption(map.id);
 await page.waitForTimeout(600);
 await page.getByRole('button',{name:'路径编辑',exact:true}).click();
 await page.waitForTimeout(900);
 await page.getByTestId('map-tag-table-start').click();
 await page.waitForTimeout(500);
 await expect(page.getByTestId('map-tag-alias-0')).toHaveValue('东头桩');
 await expect(page.getByTestId('map-tag-alias-4')).toHaveValue('二号桩');

 // 画布上必须用名称标注（Konva 文本），且 aria-label 仍带真实编号
 const canvasAliases=await page.evaluate(()=>{
  const el=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  return el?JSON.parse(el.dataset.konvaAliases||'{}'):{};
 });
 expect(canvasAliases['0'],'画布应显示现场名称').toBe('东头桩');
 expect(canvasAliases['4'],'画布应显示现场名称').toBe('二号桩');
});
