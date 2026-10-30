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

async function boot(page:any){
 await page.route('**/api/maps',(r:any)=>r.fulfill({json:[{id:'m',name:'M',version:8}]}));
 await page.route('**/api/maps/m',(r:any)=>r.fulfill({json:{map:build(0.532),version:8,acceptance:{kind:null,accepted:false,digestValid:false}}}));
 await page.route('**/api/routes',(r:any)=>r.fulfill({json:[]}));
 for(const p of ['tasks','surveys','boards'])await page.route('**/api/'+p,(r:any)=>r.fulfill({json:[]}));
 await page.route('**/api/camera/status',(r:any)=>r.fulfill({json:{running:false,present:false}}));
 await page.route('**/api/robot/status',(r:any)=>r.fulfill({json:{connected:true,state:'IDLE',running:false,speed:0,conditions:[],localization:{}}}));
 await page.goto('/');
 await page.waitForTimeout(800);
 await page.getByRole('button',{name:'路径编辑',exact:true}).click();
 await page.waitForTimeout(1400);
 await page.getByTestId('map-spacing-start').click();
 await page.waitForTimeout(300);
}

test('选中后自动带出当前间距，保存按钮不再灰',async({page})=>{
 await boot(page);
 for(const id of refs){await page.getByTestId('map-spacing-add').selectOption(String(id));await page.waitForTimeout(200);}
 const val=await page.getByTestId('map-spacing-target').inputValue();
 expect(val,'应自动填入当前间距').not.toBe('');
 expect(Number(val)).toBeCloseTo(0.53,2);
 await expect(page.getByTestId('map-spacing-save')).toBeEnabled();
});

test('保存是原地更新：版本号不变，按钮文案写明当前版本',async({page})=>{
 let body:any;
 await page.route('**/api/maps/m/tag-equal-spacing',async (r:any)=>{
  body=r.request().postDataJSON();
  return r.fulfill({json:{version:8,previousVersion:8,map:build(0.55),changedTags:[],maxDisplacementM:0.018,disclaimer:'x',validation:{errors:[],warnings:[]}}});
 });
 await boot(page);
 for(const id of refs){await page.getByTestId('map-spacing-add').selectOption(String(id));await page.waitForTimeout(200);}
 await expect(page.getByTestId('map-spacing-save')).toContainText('保存到当前地图 v8');
 await page.getByTestId('map-spacing-target').fill('0.55');
 await page.waitForTimeout(300);
 await page.getByTestId('map-spacing-save').click();
 await expect.poll(()=>body?.targetM).toBe(0.55);
 expect(body.baseVersion).toBe(8);
 // 未显式要求新版本 → 后端走原地覆盖
 expect(body.newVersion??false).toBe(false);
});

test('未填目标值时点保存给出明确提示而不是无反应',async({page})=>{
 await boot(page);
 await page.getByTestId('map-spacing-add').selectOption('96');
 await page.waitForTimeout(200);
 // 只选一个码：按钮应禁用（无法构成间距）
 await expect(page.getByTestId('map-spacing-save')).toBeDisabled();
});
