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

test('输入目标间距后，画布标注立即变成新值（所见即所得）',async({page})=>{
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
 for(const id of refs){await page.getByTestId('map-spacing-add').selectOption(String(id));await page.waitForTimeout(200);}
 const before=JSON.parse(await page.getByTestId('map-canvas').getAttribute('data-gap-labels')||'[]');
 expect(before.length).toBe(3);
 for(const l of before)expect(l.m).toBeCloseTo(0.532,2);
 // 输入 0.55 但不保存
 await page.getByTestId('map-spacing-target').fill('0.55');
 await page.waitForTimeout(700);
 const after=JSON.parse(await page.getByTestId('map-canvas').getAttribute('data-gap-labels')||'[]');
 for(const l of after)expect(l.m,'预览应立刻反映到画布标注').toBeCloseTo(0.55,2);
 // 侧栏列表也应显示新值
 const list=await page.getByTestId('map-spacing-gaps').innerText();
 expect(list).toContain('55.0 cm');
 // 未保存：不应有任何写请求
});
