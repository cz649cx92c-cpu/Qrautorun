import {test,expect} from '@playwright/test';
const X=0.26630615568732113, startY=-1.368174;
const refs=[96,144,128,112];
const mkBoard=(id:string,ref:number)=>({id,referenceId:ref,gridSize:2,sizeMm:60,gapMm:2,members:[
 {id:ref,x:-0.0155,y:0.0155,angle:0,size:0.0232},{id:ref+1,x:0.0155,y:0.0155,angle:0,size:0.0232},
 {id:ref+2,x:-0.0155,y:-0.0155,angle:0,size:0.0232},{id:ref+3,x:0.0155,y:-0.0155,angle:0,size:0.0232}]});
const build=(spacing:number)=>({schemaVersion:1,id:'m',name:'M',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],
 tags:refs.map((id,i)=>({id,x:X,y:startY-i*spacing,angle:0,size:0.06,groupId:'B'+String(id).padStart(3,'0'),rowId:'',kind:'waypoint',rules:[]})),
 groups:refs.map(r=>mkBoard('B'+String(r).padStart(3,'0'),r)),
 zone:[{x:-0.6,y:-3.6},{x:1.2,y:-3.6},{x:1.2,y:-0.6},{x:-0.6,y:-0.6}],vehicle:{width:0.4,length:0.8,margin:0.05},notes:''});
const route={routeId:'r',mapId:'m',name:'R',mapVersion:2,mapDigest:'0'.repeat(64),
 points:[{x:X,y:startY},{x:X,y:startY-0.532},{x:X+0.6,y:startY-0.532}],motionSegments:[],bodyYawDeg:0,
 created:'2026-10-30T00:00:00.000Z',updated:'2026-10-30T00:00:00.000Z'};

async function boot(page:any){
 await page.route('**/api/maps',(r:any)=>r.fulfill({json:[{id:'m',name:'M',version:2}]}));
 await page.route('**/api/maps/m',(r:any)=>r.fulfill({json:{map:build(0.532),version:2,acceptance:{kind:null,accepted:false,digestValid:false}}}));
 await page.route('**/api/routes',(r:any)=>r.fulfill({json:[route]}));
 for(const p of ['tasks','surveys','boards'])await page.route('**/api/'+p,(r:any)=>r.fulfill({json:[]}));
 await page.route('**/api/camera/status',(r:any)=>r.fulfill({json:{running:false,present:false}}));
 await page.route('**/api/robot/status',(r:any)=>r.fulfill({json:{connected:true,state:'IDLE',running:false,speed:0,conditions:[],localization:{}}}));
 await page.goto('/');
 await page.waitForTimeout(800);
 // 必须先选好路径再进编辑，否则 App 走"新建路径"分支（0 步）
 await page.getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(600);
 await page.getByTestId('map-select').selectOption('m');
 await page.waitForTimeout(400);
 await page.getByTestId('route-select').selectOption('r');
 await page.waitForTimeout(400);
 await page.getByRole('button',{name:'路径编辑',exact:true}).click();
 await page.waitForTimeout(1600);
}

test('间距调整期间，路径步骤的类型下拉仍可操作（不被锁死）',async({page})=>{
 await boot(page);
 // 先确认基线可用
 await page.getByTestId('route-steps-entry').click();
 await page.waitForTimeout(400);
 const selects=page.locator('.route-type-select');
 const baseCount=await selects.count();
 expect(baseCount).toBeGreaterThan(0);
 expect(await selects.first().isDisabled(),'基线应可操作').toBe(false);

 // 进入间距调整
 await page.getByTestId('map-spacing-start').click();
 await page.waitForTimeout(400);
 // 再打开步骤表：类型下拉必须仍然可用
 await page.getByTestId('route-steps-entry').click().catch(()=>{});
 await page.waitForTimeout(400);
 const after=page.locator('.route-type-select');
 await expect(after.first(),'间距调整期间类型下拉不得被禁用').not.toBeDisabled();
 // 路径工具按钮也应可用
 await expect(page.getByTestId('route-draw-tool')).not.toBeDisabled();
 await expect(page.getByTestId('route-pan-tool')).not.toBeDisabled();
});

test('退出路径编辑后间距模式自动退出，不再残留锁',async({page})=>{
 await boot(page);
 await page.getByTestId('map-spacing-start').click();
 await page.waitForTimeout(300);
 await expect(page.getByTestId('map-spacing-count')).toBeVisible();
 // 切到开始导航再切回路径编辑
 await page.getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(600);
 await page.getByRole('button',{name:'路径编辑',exact:true}).click();
 await page.waitForTimeout(1200);
 // 间距应已自动退出（显示"开始调整"而不是已选状态）
 await expect(page.getByTestId('map-spacing-start')).toBeVisible();
 await page.getByTestId('route-steps-entry').click();
 await page.waitForTimeout(400);
 await expect(page.locator('.route-type-select').first()).not.toBeDisabled();
});

test('间距调整期间保存路径被明确拦住并提示原因',async({page})=>{
 await boot(page);
 await page.getByTestId('map-spacing-start').click();
 await page.waitForTimeout(300);
 await page.getByRole('button',{name:'保存路径',exact:true}).click();
 await page.waitForTimeout(600);
 const toast=await page.locator('.route-toast').innerText().catch(()=>'');
 expect(toast).toContain('请先点「退出」');
});
