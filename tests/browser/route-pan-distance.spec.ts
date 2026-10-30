import {test,expect} from '@playwright/test';
const map={
 schemaVersion:1,id:'m',name:'M',frame:'map',family:'tag36h11',source:'survey',routeMode:'waypoints',
 rows:[],order:[],
 tags:[{id:0,x:0,y:0,angle:0,size:.08,kind:'waypoint',rules:[]},{id:1,x:1,y:0,angle:0,size:.08,kind:'waypoint',rules:[]},{id:2,x:1,y:1,angle:0,size:.08,kind:'waypoint',rules:[]}],
 zone:[{x:-1,y:-1},{x:2,y:-1},{x:2,y:2},{x:-1,y:2}],
 vehicle:{width:.4,length:.8,margin:.05},notes:''
};
const route={routeId:'r',mapId:'m',name:'R',mapVersion:1,mapDigest:'0'.repeat(64),
 points:[{x:0,y:0},{x:1,y:0}],motionSegments:[],bodyYawDeg:0,
 created:'2026-10-30T00:00:00.000Z',updated:'2026-10-30T00:00:00.000Z'};

async function openEditor(page:any){
 await page.route('**/api/maps',(r:any)=>r.fulfill({json:[{id:'m',name:'M',version:1}]}));
 await page.route('**/api/maps/m',(r:any)=>r.fulfill({json:{map,version:1,acceptance:{kind:null,accepted:false,digestValid:false}}}));
 await page.route('**/api/routes',(r:any)=>r.fulfill({json:[route]}));
 for(const p of ['tasks','surveys','boards'])await page.route('**/api/'+p,(r:any)=>r.fulfill({json:[]}));
 await page.route('**/api/camera/status',(r:any)=>r.fulfill({json:{running:false,present:false}}));
 await page.goto('/');
 await page.getByRole('button',{name:'开始导航',exact:true}).click();
 await page.getByTestId('map-select').selectOption('m');
 await page.waitForTimeout(300);
 await page.getByTestId('route-select').selectOption('r');
 await page.getByRole('button',{name:'路径编辑',exact:true}).click();
 await page.waitForTimeout(600);
}
const metric=(page:any)=>page.evaluate(()=>{
 const el=[...document.querySelectorAll('[data-testid="route-tools-panel"] *')].find((e:any)=>e.textContent?.startsWith('路点 / 长度'));
 return el?.textContent?.trim()??'';
});

test('路径编辑平移：单击不平移地图，超过阈值才平移，拖动结束不新增路点',async({page})=>{
 await openEditor(page);
 const canvas=page.getByTestId('map-canvas');
 const box=(await canvas.boundingBox())!;
 const cx=box.x+box.width/2,cy=box.y+box.height/2;
 const stageAtStart=await canvas.getAttribute('data-stage-pos');
 // 1) 单击：地图不动
 await page.mouse.click(cx,cy);
 await page.waitForTimeout(400);
 expect(await canvas.getAttribute('data-stage-pos'),'单击不得平移地图').toBe(stageAtStart);
 const afterFirstClick=await metric(page);
 // 2) 真正拖动超过阈值：地图平移
 await page.mouse.move(cx,cy);await page.mouse.down();
 await page.mouse.move(cx+60,cy+40,{steps:10});
 await page.mouse.move(cx+140,cy+90,{steps:10});
 await page.mouse.up();
 await page.waitForTimeout(500);
 expect(await canvas.getAttribute('data-stage-pos'),'拖动应平移地图').not.toBe(stageAtStart);
 expect(await metric(page),'拖动结束不得新增路点').toBe(afterFirstClick);
 // 3) 松开后可以继续加点
 await page.mouse.click(cx+180,cy+130);
 await page.waitForTimeout(500);
 expect(await metric(page),'松开后单击应能继续加点').not.toBe(afterFirstClick);
});

test('路径编辑二维码间距：相邻两码中心距离可读可改，保存 route-level override 且无X/Y输入',async({page})=>{
 let body:any;
 await openEditor(page);
 await page.route('**/api/route/design',async (r:any)=>{body=r.request().postDataJSON();return r.fulfill({json:{version:2,route:{routeId:'r',updated:new Date().toISOString()},map:{},task:{}}});});
 await page.getByRole('button',{name:/路径参数设置/}).click();
 const panel=page.getByTestId('route-distance-editor');
 await expect(panel).toBeVisible();
 await expect(panel).toContainText('二维码间距');
 await panel.getByRole('button',{name:'选择相邻'}).click();
 await expect(panel).toContainText('中心欧氏距离');
 await expect(panel).toContainText('cm');
 await expect(panel).toContainText('mm');
 await expect(page.getByTestId('tag-position-panel')).toHaveCount(0);
 await panel.getByLabel('目标距离（米）').fill('1.5');
 await panel.getByRole('button',{name:'预览间距'}).click();
 await expect(page.getByTestId('route-distance-preview')).toContainText('1.500');
 await page.getByRole('button',{name:'保存路径',exact:true}).click();
 await expect.poll(()=>body?.distanceModel).toBe('center-euclidean');
 expect(body.spacingOverrides?.[0]?.targetM).toBe(1.5);
 expect(typeof body.spacingOverrides?.[0]?.fromId).toBe('number');
 expect(typeof body.spacingOverrides?.[0]?.toId).toBe('number');
 expect(body.spacingOverrides[0].fromId+'>'+body.spacingOverrides[0].toId).toBe('0>1');
});
