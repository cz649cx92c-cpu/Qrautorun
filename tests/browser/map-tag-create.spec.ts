import {test,expect} from '@playwright/test';
// 空地图场景：建图阶段从零铺码
const mkBoard=(id:string,ref:number)=>({id,referenceId:ref,gridSize:2,sizeMm:80,gapMm:2,members:[
 {id:ref,x:-0.0205,y:0.0205,angle:0,size:0.0308},{id:ref+1,x:0.0205,y:0.0205,angle:0,size:0.0308},
 {id:ref+2,x:-0.0205,y:-0.0205,angle:0,size:0.0308},{id:ref+3,x:0.0205,y:-0.0205,angle:0,size:0.0308}]});
const emptyMap={schemaVersion:1,id:'design-test',name:'空白铺码图',frame:'map',family:'tag36h11',source:'design',coordinateStatus:'draft',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],tags:[],groups:[],zone:[{x:-10,y:-10},{x:10,y:-10},{x:10,y:10},{x:-10,y:10}],vehicle:{width:0.4,length:0.8,margin:0.05},notes:''};

async function boot(page:any){
 await page.route('**/api/maps',(r:any)=>r.fulfill({json:[{id:'design-test',name:'空白铺码图',version:1}]}));
 await page.route('**/api/maps/design-test',(r:any)=>r.fulfill({json:{map:emptyMap,version:1,acceptance:{kind:null,accepted:false,digestValid:false}}}));
 await page.route('**/api/routes',(r:any)=>r.fulfill({json:[]}));
 for(const p of ['tasks','surveys','boards'])await page.route('**/api/'+p,(r:any)=>r.fulfill({json:[]}));
 await page.route('**/api/camera/status',(r:any)=>r.fulfill({json:{running:false,present:false}}));
 await page.route('**/api/robot/status',(r:any)=>r.fulfill({json:{connected:true,state:'IDLE',running:false,speed:0,conditions:[],localization:{}}}));
 await page.goto('/');
 await page.waitForTimeout(800);
 await page.getByRole('button',{name:'路径编辑',exact:true}).click();
 await page.waitForTimeout(1400);
}

test('空地图可以从零铺码：矩形阵列预览并保存',async({page})=>{
 let body:any;
 await page.route('**/api/maps/design-test/tags/grid',async (r:any)=>{body=r.request().postDataJSON();
  const tags=[] as any[];
  let id=0;
  for(let row=0;row<body.rows;row++)for(let col=0;col<body.columns;col++){
   tags.push({id:id++,x:body.originX+col*body.spacingXM,y:body.originY-row*body.spacingYM,angle:body.angleDeg??0,size:body.sizeM??0.06,rowId:'',kind:'waypoint',rules:[]});
  }
  return r.fulfill({json:{version:1,previousVersion:1,map:{...emptyMap,tags},created:tags.length,tags,reasons:[],validation:{errors:[],warnings:[]}}});
 });
 await boot(page);
 const panel=page.getByTestId('map-tag-create');
 await expect(panel).toBeVisible();
 await panel.getByTestId('map-tag-create-start').click();
 await page.waitForTimeout(300);
 // 空地图上应显示最小间距提示（与 validate 同源的 10cm）
 await expect(panel.getByTestId('map-tag-create-min-distance')).toContainText('cm');
 await panel.getByTestId('map-tag-create-mode-grid').click();
 await page.waitForTimeout(200);
 // 4 列 × 3 行，列距 0.6 行距 0.6
 const set=async(id:string,v:string)=>{await panel.getByTestId(id).fill(v);await page.waitForTimeout(120);};
 await set('map-tag-create-grid-origin-x','0');
 await set('map-tag-create-grid-origin-y','0');
 await set('map-tag-create-grid-cols','4');
 await set('map-tag-create-grid-rows','3');
 await set('map-tag-create-grid-pitch-x','0.6');
 await set('map-tag-create-grid-pitch-y','0.6');
 await page.waitForTimeout(400);
 const previewText=await panel.getByTestId('map-tag-create-preview').innerText();
 expect(previewText).toMatch(/12|新建/);
 // ghost 预览应出现在画布
 const ghostCount=await page.getByTestId('map-canvas').getAttribute('data-konva-ghost-tags');
 expect(Number(ghostCount)).toBeGreaterThan(0);
 await panel.getByTestId('map-tag-create-save').click();
 await expect.poll(()=>body?.columns).toBe(4);
 expect(body.rows).toBe(3);
 expect(body.spacingXM).toBeCloseTo(0.6,3);
 expect(body.spacingYM).toBeCloseTo(0.6,3);
});

test('铺码参数非法时给出拒绝原因且不能保存',async({page})=>{
 await boot(page);
 const panel=page.getByTestId('map-tag-create');
 await panel.getByTestId('map-tag-create-start').click();
 await panel.getByTestId('map-tag-create-mode-grid').click();
 await page.waitForTimeout(200);
 // 间距过小（<10cm 下限）
 await panel.getByTestId('map-tag-create-grid-pitch-x').fill('0.02');
 await panel.getByTestId('map-tag-create-grid-pitch-y').fill('0.02');
 await page.waitForTimeout(500);
 await expect(panel.getByTestId('map-tag-create-save')).toBeDisabled();
});

test('空地图没有码时，路径编辑给出明确提示而不是崩溃',async({page})=>{
 await boot(page);
 await page.waitForTimeout(500);
 const body=await page.locator('body').innerText();
 expect(body).toContain('二维码');
});
