import {test,expect} from '@playwright/test';
const tags=[
 {id:0,x:0.27,y:-1.39,angle:0,size:0.06,groupId:'B000',rowId:'',kind:'waypoint',rules:[]},
 {id:4,x:0.87,y:-1.39,angle:0,size:0.06,groupId:'B004',rowId:'',kind:'waypoint',rules:[]},
 {id:8,x:0.87,y:-1.99,angle:0,size:0.06,groupId:'B008',rowId:'',kind:'waypoint',rules:[]},
];
const mkBoard=(id:string,ref:number)=>({id,referenceId:ref,gridSize:2,sizeMm:60,gapMm:2,members:[
 {id:ref,x:-0.0155,y:0.0155,angle:0,size:0.0232},{id:ref+1,x:0.0155,y:0.0155,angle:0,size:0.0232},
 {id:ref+2,x:-0.0155,y:-0.0155,angle:0,size:0.0232},{id:ref+3,x:0.0155,y:-0.0155,angle:0,size:0.0232}]});
const map={schemaVersion:1,id:'m',name:'M',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'reviewed',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],tags,groups:[mkBoard('B000',0),mkBoard('B004',4),mkBoard('B008',8)],zone:[{x:-0.5,y:-2.6},{x:2.0,y:-2.6},{x:2.0,y:-0.8},{x:-0.5,y:-0.8}],vehicle:{width:0.4,length:0.8,margin:0.05},notes:''};
// 带拐角，避免 routeCorners 把共线中间点合并掉
const route={routeId:'r',mapId:'m',name:'R',mapVersion:5,mapDigest:'0'.repeat(64),
 points:[{x:0.27,y:-1.39},{x:0.87,y:-1.39},{x:0.87,y:-1.99}],motionSegments:[],bodyYawDeg:0,
 created:'2026-10-30T00:00:00.000Z',updated:'2026-10-30T00:00:00.000Z'};

async function openSteps(page:any){
 await page.route('**/api/maps',(r:any)=>r.fulfill({json:[{id:'m',name:'M',version:5}]}));
 await page.route('**/api/maps/m',(r:any)=>r.fulfill({json:{map,version:5,acceptance:{kind:null,accepted:false,digestValid:false}}}));
 await page.route('**/api/routes',(r:any)=>r.fulfill({json:[route]}));
 for(const p of ['tasks','surveys','boards'])await page.route('**/api/'+p,(r:any)=>r.fulfill({json:[]}));
 await page.route('**/api/camera/status',(r:any)=>r.fulfill({json:{running:false,present:false}}));
 await page.route('**/api/robot/status',(r:any)=>r.fulfill({json:{connected:true,state:'IDLE',running:false,speed:0,conditions:[],localization:{}}}));
 await page.goto('/');
 await page.getByRole('button',{name:'开始导航',exact:true}).click();
 await page.getByTestId('map-select').selectOption('m');
 await page.waitForTimeout(400);
 await page.getByTestId('route-select').selectOption('r');
 await page.getByRole('button',{name:'路径编辑',exact:true}).click();
 await page.waitForTimeout(800);
 await page.getByTestId('route-steps-entry').click();
 await page.waitForTimeout(400);
}

test('路径步骤「距离/m」可编辑：改路段距离后路径点随之重算并保存',async({page})=>{
 let body:any;
 await page.route('**/api/route/design',async (r:any)=>{body=r.request().postDataJSON();return r.fulfill({json:{version:6,route:{routeId:'r',updated:new Date().toISOString()},map:{},task:{}}});});
 await openSteps(page);
 const inputs=page.getByTestId('route-leg-distance');
 const count=await inputs.count();
 expect(count,'至少有一个可编辑路段').toBeGreaterThanOrEqual(1);
 const first=inputs.first();
 const before=Number(await first.inputValue());
 expect(before).toBeCloseTo(0.6,2);
 // 输入框必须真的能显示完整数值（曾因缺样式被压成一位数字）
 const box=await first.boundingBox();
 expect(box!.width,'距离输入框宽度不得小于 70px').toBeGreaterThan(70);
 await expect(inputs.first()).toHaveValue(/^\d+\.\d{2}$/);
 // 同一行还要能看到 cm 提示
 await expect(page.getByTestId('route-steps-popover')).toContainText('cm');
 // 最右「操作」列必须完整可见（曾因表格布局被裁掉）
 const opsButtons=page.getByTestId('route-steps-popover').locator('tbody tr').first().locator('td.route-command-ops button');
 expect(await opsButtons.count()).toBe(3);
 const opsBox=await page.getByTestId('route-steps-popover').locator('td.route-command-ops').first().boundingBox();
 const popBox=await page.getByTestId('route-steps-popover').boundingBox();
 expect(opsBox!.x+opsBox!.width,'操作列不得超出浮窗').toBeLessThanOrEqual(popBox!.x+popBox!.width+1);
 // 表头不能出现缺字形的方框
 const headText=await page.getByTestId('route-steps-popover').locator('thead').innerText();
 expect(headText).not.toContain('\u25a1');
 expect(headText).toContain('距离');
 await page.screenshot({path:'/tmp/leg-ui-after.png'});
 await page.screenshot({path:'/tmp/leg-ui-before.png'});
 // 输入框右侧的 cm 提示必须与数值一致
 const rowText=await page.getByTestId('route-steps-popover').innerText();
 expect(rowText).toMatch(/\b60cm\b/i);
 const target=0.9;
 await first.fill(String(target));
 await first.dispatchEvent('change');
 await page.waitForTimeout(500);
 await expect(first).toHaveValue(/0\.9/);
 const panelText=await page.getByTestId('route-steps-popover').innerText();
 expect(panelText).not.toContain('X ');
 await expect(page.getByTestId('tag-position-panel')).toHaveCount(0);
 await page.getByRole('button',{name:'保存路径',exact:true}).click();
 await expect.poll(()=>body?.points?.length).toBeGreaterThan(1);
 const pts=body.points.map((p:any)=>({x:Number(p.x.toFixed(3)),y:Number(p.y.toFixed(3))}));
 expect(pts[0].x).toBeCloseTo(0.27,2);
 // 第一段变长 0.3 m；拐角后续点整体平移，纵向段长度保持
 const firstLeg=Math.hypot(pts[1].x-pts[0].x,pts[1].y-pts[0].y);
 expect(firstLeg).toBeCloseTo(target,1);
});

test('路径步骤距离：非法值被拒绝且不改变路径',async({page})=>{
 await openSteps(page);
 const input=page.getByTestId('route-leg-distance').first();
 const before=await input.inputValue();
 // 55 m 超过单段上限，且不会被 input 的 min 夹紧
 await input.fill('55');
 await input.dispatchEvent('change');
 await page.waitForTimeout(500);
 await expect(input).toHaveValue(before);
 await expect(page.locator('.route-toast')).toContainText('不得超过 50 米');
});
