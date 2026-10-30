import {test,expect} from '@playwright/test';
const mkBoard=(id:string,ref:number)=>({id,referenceId:ref,gridSize:2,sizeMm:60,gapMm:2,members:[
 {id:ref,x:-0.0155,y:0.0155,angle:0,size:0.0232},{id:ref+1,x:0.0155,y:0.0155,angle:0,size:0.0232},
 {id:ref+2,x:-0.0155,y:-0.0155,angle:0,size:0.0232},{id:ref+3,x:0.0155,y:-0.0155,angle:0,size:0.0232}]});
const refs=[0,4,8];
const tags=refs.map((id,i)=>({id,x:i*0.6,y:0,angle:0,size:0.06,groupId:'B'+String(id).padStart(3,'0'),rowId:'',kind:'waypoint',rules:[]}));
const map={schemaVersion:1,id:'m',name:'M',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'reviewed',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],tags,groups:refs.map(r=>mkBoard('B'+String(r).padStart(3,'0'),r)),zone:[{x:-0.5,y:-0.5},{x:1.9,y:-0.5},{x:1.9,y:0.5},{x:-0.5,y:0.5}],vehicle:{width:0.4,length:0.8,margin:0.05},notes:''};

async function boot(page:any,m={}){
 await page.route('**/api/maps',(r:any)=>r.fulfill({json:[{id:'m',name:'M',version:5}]}));
 await page.route('**/api/maps/m',(r:any)=>r.fulfill({json:{map:{...map,...m},version:5,acceptance:{kind:null,accepted:false,digestValid:false}}}));
 await page.route('**/api/routes',(r:any)=>r.fulfill({json:[]}));
 for(const p of ['tasks','surveys','boards'])await page.route('**/api/'+p,(r:any)=>r.fulfill({json:[]}));
 await page.route('**/api/camera/status',(r:any)=>r.fulfill({json:{running:false,present:false}}));
 await page.route('**/api/robot/status',(r:any)=>r.fulfill({json:{connected:true,state:'IDLE',running:false,speed:0,conditions:[],localization:{}}}));
 await page.goto('/');
 await page.waitForTimeout(800);
 // 关键：从「路径编辑」进入，而不是「开始导航」
 await page.getByRole('button',{name:'路径编辑',exact:true}).click();
 await page.waitForTimeout(1400);
}
async function addTags(page:any,ids:number[]){
 for(const id of ids){await page.getByTestId('map-spacing-add').selectOption(String(id));await page.waitForTimeout(150);}
}

test('间距入口在路径编辑：侧栏存在且可开始，开始导航里没有',async({page})=>{
 await boot(page);
 const picker=page.getByTestId('map-qr-spacing');
 await expect(picker, '路径编辑里应有二维码间距面板').toBeVisible();
 // verify it is inside the route tools panel
 const inRoutePanel=await page.locator('[data-testid="route-tools-panel"] [data-testid="map-qr-spacing"]').count();
 expect(inRoutePanel,'面板必须在路径工具面板内').toBe(1);
 await page.getByTestId('map-spacing-start').click();
 await expect(page.getByTestId('map-spacing-count')).toContainText('已选 0');
 // 回到开始导航：面板不应出现在那里
 await page.getByRole('button',{name:'开始导航',exact:true}).click();
 await page.waitForTimeout(700);
 await expect(page.getByTestId('map-qr-spacing')).toHaveCount(0);
});

test('路径编辑内图内改间距：点 cm 标注就地输入并保存',async({page})=>{
 let body:any;
 await page.route('**/api/maps/m/tag-distance',async (r:any)=>{body=r.request().postDataJSON();return r.fulfill({json:{version:6,previousVersion:5,map,changedTags:[],maxDisplacementM:0.08,disclaimer:'x',validation:{errors:[],warnings:[]}}});});
 await boot(page);
 await page.getByTestId('map-spacing-start').click();
 await addTags(page,[0,4,8]);
 const canvas=page.getByTestId('map-canvas');
 const box=(await canvas.boundingBox())!;
 // 画布把标注屏幕坐标写到 data-gap-labels，直接点第一个标注
 const labels=await page.getByTestId('map-canvas').getAttribute('data-gap-labels');
 const list=JSON.parse(labels||'[]');
 expect(list.length,'画布应渲染 cm 标注').toBeGreaterThan(0);
 await page.mouse.click(box.x+list[0].x,box.y+list[0].y);
 await page.waitForTimeout(300);
 const opened=await page.getByTestId('gap-inline-editor').count()>0;
 expect(opened,'画布 cm 标注应可点开就地输入').toBe(true);
 await page.getByTestId('gap-inline-input').fill('46.0');
 await page.getByTestId('gap-inline-input').press('Enter');
 await expect.poll(()=>body?.targetM).toBe(0.46);
 expect(body.baseVersion).toBe(5);
});

test('路径编辑内的批量等间距：整排预览与保存',async({page})=>{
 let body:any;
 await page.route('**/api/maps/m/tag-equal-spacing',async (r:any)=>{body=r.request().postDataJSON();return r.fulfill({json:{version:6,previousVersion:5,map,changedTags:[],maxDisplacementM:0.1,disclaimer:'x',validation:{errors:[],warnings:[]}}});});
 await boot(page);
 await page.getByTestId('map-spacing-start').click();
 await addTags(page,[0,4,8]);
 await expect(page.getByTestId('map-spacing-line')).toContainText('同一水平线');
 await expect(page.getByTestId('map-spacing-gaps')).toContainText('60.0 cm');
 await page.getByTestId('map-spacing-target').fill('0.5');
 await expect(page.getByTestId('map-spacing-preview')).toContainText('统一等间距');
 await page.getByTestId('map-spacing-save').click();
 await expect.poll(()=>body?.targetM).toBe(0.5);
 expect(body.ids.length).toBe(3);
});
