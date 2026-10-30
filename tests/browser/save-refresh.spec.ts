import {test,expect} from '@playwright/test';
const X=0.26630615568732113;
const startY=-1.368174;
const refs=[96,144,128,112];
const ys=Object.fromEntries(refs.map((id,i)=>[id,startY-i*0.532]));
const mkBoard=(id:string,ref:number)=>({id,referenceId:ref,gridSize:2,sizeMm:60,gapMm:2,members:[
 {id:ref,x:-0.0155,y:0.0155,angle:0,size:0.0232},{id:ref+1,x:0.0155,y:0.0155,angle:0,size:0.0232},
 {id:ref+2,x:-0.0155,y:-0.0155,angle:0,size:0.0232},{id:ref+3,x:0.0155,y:-0.0155,angle:0,size:0.0232}]});
const build=(spacing:number)=>({schemaVersion:1,id:'m',name:'M',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],
 tags:refs.map((id,i)=>({id,x:X,y:startY-i*spacing,angle:0,size:0.06,groupId:'B'+String(id).padStart(3,'0'),rowId:'',kind:'waypoint',rules:[]})),
 groups:refs.map(r=>mkBoard('B'+String(r).padStart(3,'0'),r)),
 zone:[{x:-0.6,y:-3.6},{x:1.2,y:-3.6},{x:1.2,y:-0.6},{x:-0.6,y:-0.6}],vehicle:{width:0.4,length:0.8,margin:0.05},notes:''});

test('保存后保持调整模式，间距与标注立即变成新值',async({page})=>{
 let version=6;
 let spacing=0.532;
 let calls=0;
 const currentMap=()=>build(spacing);
 await page.route('**/api/maps',(r:any)=>r.fulfill({json:[{id:'m',name:'M',version}]}));
 await page.route('**/api/maps/m',(r:any)=>r.fulfill({json:{map:currentMap(),version,acceptance:{kind:null,accepted:false,digestValid:false}}}));
 await page.route('**/api/routes',(r:any)=>r.fulfill({json:[]}));
 for(const p of ['tasks','surveys','boards'])await page.route('**/api/'+p,(r:any)=>r.fulfill({json:[]}));
 await page.route('**/api/camera/status',(r:any)=>r.fulfill({json:{running:false,present:false}}));
 await page.route('**/api/robot/status',(r:any)=>r.fulfill({json:{connected:true,state:'IDLE',running:false,speed:0,conditions:[],localization:{}}}));
 await page.route('**/api/maps/m/tag-equal-spacing',async (r:any)=>{
  calls++;spacing=0.55;/* 原地覆盖：version 保持 6 */
  return r.fulfill({json:{version:6,previousVersion:6,map:currentMap(),changedTags:[],maxDisplacementM:0.037,disclaimer:'x',validation:{errors:[],warnings:[]}}});
 });
 await page.goto('/');
 await page.waitForTimeout(800);
 await page.getByRole('button',{name:'路径编辑',exact:true}).click();
 await page.waitForTimeout(1400);
 await page.getByTestId('map-spacing-start').click();
 await page.waitForTimeout(300);
 for(const id of refs){await page.getByTestId('map-spacing-add').selectOption(String(id));await page.waitForTimeout(200);}
 // 保存前：约 53 cm（自动填值会取整到厘米，因此不写死 53.2）
 const before=await page.getByTestId('map-spacing-gaps').innerText();
 expect(before).toMatch(/53(\.\d)? cm/);
 await page.getByTestId('map-spacing-target').fill('0.55');
 await page.waitForTimeout(250);
 await page.getByTestId('map-spacing-save').click();
 await page.waitForTimeout(1500);
 expect(calls).toBe(1);
 // 保存后仍在调整模式
 await expect(page.getByTestId('map-spacing-count')).toContainText('已选 4');
 await expect(page.getByTestId('map-spacing-save')).toBeVisible();
 // 间距必须立即变成 55.0 cm
 const after=await page.getByTestId('map-spacing-gaps').innerText();
 expect(after).toContain('55.0 cm');
 expect(after).not.toMatch(/53(\.\d)? cm/);
 await expect(page.getByTestId('map-spacing-uniform')).toContainText('55.0 cm');
 // 画布标注也要刷新
 const labelsRaw=await page.getByTestId('map-canvas').getAttribute('data-gap-labels');
 const labels=JSON.parse(labelsRaw||'[]');
 expect(labels.length).toBe(3);
 for(const l of labels)expect(l.m).toBeCloseTo(0.55,2);
});
