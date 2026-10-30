import {test,expect,type Page} from '@playwright/test';

// 自包含夹具：只挂载 MapCanvas.vue（tests/browser/canvas-modes/main.ts）。
// 不加载 App.vue、不连后端、不连 WebSocket、不写任何 DB。
// 每个 test 都从默认的「选择/调整」态开始。

const HARNESS='/tests/browser/canvas-modes/index.html';

type CanvasState={scale:number;x:number;y:number;mode:string;tool:string;panning:boolean;selected:string};

async function open(page:Page){
 await page.goto(HARNESS);
 await expect(page.getByTestId('map-canvas')).toBeVisible();
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-canvas-mode','select');
 await page.waitForFunction(()=>{
  const el=document.querySelector('[data-testid="map-canvas"]') as HTMLElement|null;
  return !!el&&!!el.dataset.konvaScale&&!!el.getAttribute('data-stage-pos');
 });
}

async function state(page:Page):Promise<CanvasState>{
 return page.evaluate(()=>{
  const el=document.querySelector('[data-testid="map-canvas"]') as HTMLElement;
  return {scale:Number(el.dataset.konvaScale),x:Number(el.dataset.konvaX),y:Number(el.dataset.konvaY),mode:el.dataset.canvasMode??'',tool:el.dataset.canvasTool??'',panning:el.hasAttribute('data-canvas-panning'),selected:el.dataset.canvasSelected??''};
 });
}

/** 把 world 坐标（米）换算成屏幕坐标，用 data-konva* 上已暴露的 stage 变换。 */
async function screenAt(page:Page,world:{x:number;y:number}){
 const box=(await page.getByTestId('map-canvas').boundingBox())!;
 const view=await page.evaluate(()=>{const el=document.querySelector('[data-testid="map-canvas"]') as HTMLElement;return {scale:Number(el.dataset.konvaScale),x:Number(el.dataset.konvaX),y:Number(el.dataset.konvaY)};});
 return {x:box.x+view.x+world.x*100*view.scale,y:box.y+view.y-world.y*100*view.scale};
}

async function setState(page:Page,value:{tool?:string;editable?:boolean;panEnabled?:boolean;drawMode?:boolean}){
 await page.evaluate(v=>window.__setState!(v as Record<string,unknown>),value);
 await page.waitForTimeout(60);
}

const events=(page:Page)=>page.evaluate(()=>window.__events.slice());
const blankCount=async(page:Page)=>(await events(page)).filter(line=>line.startsWith('blank ')).length;
const inspectCount=async(page:Page)=>(await events(page)).filter(line=>line.startsWith('inspect ')).length;
const selectCount=async(page:Page)=>(await events(page)).filter(line=>line.startsWith('select ')).length;

const centerOf=(box:{x:number;y:number;width:number;height:number})=>({x:box.x+box.width/2,y:box.y+box.height/2});

test('1) 默认可选中二维码：点击 emit select，空白单击不平移也不产生事件',async({page})=>{
 await open(page);
 const canvas=page.getByTestId('map-canvas');
 const before=await state(page);
 // 点 tag id=1（world 0.6,0）
 const tag1=await screenAt(page,{x:.6,y:0});
 await page.mouse.click(tag1.x,tag1.y);
 await page.waitForTimeout(120);
 expect(await selectCount(page),'单击二维码必须 emit select').toBeGreaterThan(0);
 expect(await inspectCount(page),'route-design 之外的 select 态不应 emit inspect').toBe(0);
 const afterTag=await state(page);
 expect(afterTag.selected).toBe('1');
 expect(afterTag.x,'选中二维码不得平移画布').toBe(before.x);
 expect(afterTag.y,'选中二维码不得平移画布').toBe(before.y);
 // 单击空白
 const box=(await canvas.boundingBox())!;
 const blank=centerOf(box);
 await page.mouse.click(blank.x,blank.y);
 await page.waitForTimeout(120);
 const afterBlank=await state(page);
 expect(afterBlank.x,'选择态空白单击绝不平移').toBe(before.x);
 expect(afterBlank.y,'选择态空白单击绝不平移').toBe(before.y);
 expect(afterBlank.panning).toBe(false);
 expect(await blankCount(page),'选择态空白单击不得新增路点').toBe(0);
});

test('2) 选择态按住左键拖动也不平移（没有 pan 意图）',async({page})=>{
 await open(page);
 const before=await state(page);
 const box=(await page.getByTestId('map-canvas').boundingBox())!;
 const c=centerOf(box);
 await page.mouse.move(c.x,c.y);
 await page.mouse.down();
 await page.mouse.move(c.x+120,c.y+90,{steps:12});
 await page.mouse.up();
 await page.waitForTimeout(200);
 const after=await state(page);
 expect(after.x,'选择态拖动绝不平移').toBe(before.x);
 expect(after.y,'选择态拖动绝不平移').toBe(before.y);
 expect(after.mode).toBe('select');
});

test('3) 只有 tool=pan 才平移，且必须超过阈值；单击仍不平移',async({page})=>{
 await open(page);
 const canvas=page.getByTestId('map-canvas');
 const before=await state(page);
 const box=(await canvas.boundingBox())!;
 const c=centerOf(box);
 // 3a) 先确认 pan 模式仍未平移：只单击
 await setState(page,{tool:'pan'});
 await expect(canvas).toHaveAttribute('data-canvas-mode','pan');
 const beforeClick=await state(page);
 await page.mouse.click(c.x,c.y);
 await page.waitForTimeout(120);
 expect((await state(page)).x,'pan 模式单击也不得平移').toBe(beforeClick.x);
 // 3b) 超过阈值才平移
 await page.mouse.move(c.x,c.y);
 await page.mouse.down();
 await page.mouse.move(c.x+90,c.y+60,{steps:10});
 await page.mouse.move(c.x+160,c.y+100,{steps:10});
 await page.mouse.up();
 await page.waitForTimeout(250);
 const panned=await state(page);
 expect(panned.x!==before.x||panned.y!==before.y,'pan 模式拖动必须平移').toBe(true);
 expect(panned.panning,'平移结束后 data-canvas-panning 必须清除').toBe(false);
 expect(await blankCount(page),'pan 模式拖动不得新增路点').toBe(0);
});

test('4) 拖动距离小于阈值不平移（4px 阈值）',async({page})=>{
 await open(page);
 await setState(page,{tool:'pan'});
 const box=(await page.getByTestId('map-canvas').boundingBox())!;
 const c=centerOf(box);
 const before=await state(page);
 await page.mouse.move(c.x,c.y);
 await page.mouse.down();
 await page.mouse.move(c.x+2,c.y+2);
 await page.mouse.up();
 await page.waitForTimeout(200);
 const after=await state(page);
 expect(Math.abs(after.x-before.x),'2px 位移不得触发平移').toBeLessThanOrEqual(1);
 expect(Math.abs(after.y-before.y),'2px 位移不得触发平移').toBeLessThanOrEqual(1);
});

test('5) 空格是显式 pan 意图：select 态按住空格拖动才平移',async({page})=>{
 await open(page);
 const box=(await page.getByTestId('map-canvas').boundingBox())!;
 const c=centerOf(box);
 const before=await state(page);
 // panEnabled=false 时空格不给权限
 await page.keyboard.down('Space');
 expect((await state(page)).mode,'panEnabled=false 时空格不应进入 pan').toBe('select');
 await page.keyboard.up('Space');
 // panEnabled=true 后空格进入 pan
 await setState(page,{panEnabled:true});
 await page.keyboard.down('Space');
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-canvas-mode','pan');
 await page.mouse.move(c.x,c.y);
 await page.mouse.down();
 await page.mouse.move(c.x+80,c.y+50,{steps:10});
 await page.mouse.up();
 await page.keyboard.up('Space');
 await page.waitForTimeout(200);
 const after=await state(page);
 expect(after.x!==before.x||after.y!==before.y,'空格+拖动应平移').toBe(true);
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-canvas-mode','select');
});

test('6) 二维码可拖动：select 态拖动 tag 1 产生 move，且拖动后不误加点',async({page})=>{
 await open(page);
 await setState(page,{tool:'select',editable:true});
 const from=await screenAt(page,{x:.6,y:0});
 const before=await state(page);
 const blanksBefore=await blankCount(page);
 await page.mouse.move(from.x,from.y);
 await page.mouse.down();
 await page.mouse.move(from.x+60,from.y+40,{steps:12});
 await page.mouse.up();
 await page.waitForTimeout(250);
 const list=await events(page);
 const move=list.filter(line=>line.startsWith('move '));
 expect(move.length,'拖动二维码必须 emit move').toBeGreaterThan(0);
 const payload=JSON.parse(move[0]!.slice('move '.length)) as [number[],number,number];
 expect(payload[0]).toContain(1);
 expect(Math.abs(payload[1]),'dx 应为非零位移').toBeGreaterThan(0);
 expect(await blankCount(page),'拖动二维码后不得误新增路点').toBe(blanksBefore);
 const after=await state(page);
 expect(after.x,'拖动二维码不得平移画布').toBe(before.x);
 expect(after.y,'拖动二维码不得平移画布').toBe(before.y);
 // 释放后立刻点选恢复正常
 const tag0=await screenAt(page,{x:0,y:0});
 await page.mouse.click(tag0.x,tag0.y);
 await page.waitForTimeout(150);
 expect(await state(page)).toMatchObject({selected:'0'});
});

test('7) 拖动地图后不误加点，释放后立刻恢复正常点选',async({page})=>{
 await open(page);
 await setState(page,{tool:'pan'});
 const box=(await page.getByTestId('map-canvas').boundingBox())!;
 const c=centerOf(box);
 await page.mouse.move(c.x,c.y);
 await page.mouse.down();
 await page.mouse.move(c.x+120,c.y+80,{steps:12});
 await page.mouse.up();
 await page.waitForTimeout(200);
 expect(await blankCount(page),'平移结束不得误新增路点').toBe(0);
 // 切回 select，立刻点选恢复
 await setState(page,{tool:'select'});
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-canvas-mode','select');
 const tag2=await screenAt(page,{x:.6,y:.6});
 await page.mouse.click(tag2.x,tag2.y);
 await page.waitForTimeout(150);
 expect(await state(page)).toMatchObject({selected:'2'});
 expect(await selectCount(page)).toBeGreaterThan(0);
});

test('8) route-design 选择态：单击选中且不追加路点，平移工具才平移',async({page})=>{
 await open(page);
 // 进入路径编辑的「选择」态：tool=route-design, editable=true, drawMode=false
 await setState(page,{tool:'route-design',editable:true,drawMode:false,panEnabled:true});
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-canvas-mode','select');
 const canvas=page.getByTestId('map-canvas');
 const box=(await canvas.boundingBox())!;
 const c=centerOf(box);
 const before=await state(page);
 // 单击二维码 → inspect，不空白加点
 const tag1=await screenAt(page,{x:.6,y:0});
 await page.mouse.click(tag1.x,tag1.y);
 await page.waitForTimeout(200);
 expect(await inspectCount(page),'选择态点击二维码应 emit inspect').toBeGreaterThan(0);
 expect(await blankCount(page),'选择态点击二维码不得追加路点').toBe(0);
 // 单击空白 → 不平移、不追加路点
 await page.mouse.click(c.x,c.y);
 await page.waitForTimeout(200);
 expect(await blankCount(page),'选择态空白单击不得追加路点').toBe(0);
 expect((await state(page)).x).toBe(before.x);
 // 选择态拖动空白也不平移
 await page.mouse.move(c.x,c.y);
 await page.mouse.down();
 await page.mouse.move(c.x+100,c.y+70,{steps:10});
 await page.mouse.up();
 await page.waitForTimeout(200);
 expect((await state(page)).x,'选择态拖动空白不得平移').toBe(before.x);
 // 切到平移工具（App 的语义：tool 仍 route-design，editable=false）→ 才平移
 await setState(page,{tool:'route-design',editable:false,drawMode:false,panEnabled:true});
 await expect(canvas).toHaveAttribute('data-canvas-mode','pan');
 const beforePan=await state(page);
 await page.mouse.move(c.x,c.y);
 await page.mouse.down();
 await page.mouse.move(c.x+110,c.y+80,{steps:10});
 await page.mouse.up();
 await page.waitForTimeout(250);
 const panned=await state(page);
 expect(panned.x!==beforePan.x||panned.y!==beforePan.y,'平移工具下拖动必须平移').toBe(true);
 expect(await blankCount(page),'平移工具拖动不得追加路点').toBe(0);
});

test('9) 加点态（route-design+drawMode）空白单击加点，拖动不平移',async({page})=>{
 await open(page);
 await setState(page,{tool:'route-design',editable:true,drawMode:true,panEnabled:true});
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-canvas-mode','select');
 const box=(await page.getByTestId('map-canvas').boundingBox())!;
 const c=centerOf(box);
 const before=await state(page);
 await page.mouse.click(c.x,c.y);
 await page.waitForTimeout(200);
 expect(await blankCount(page),'加点态空白单击必须追加路点').toBeGreaterThan(0);
 // 加点态拖动不追加第二个点、也不平移
 const blanksAfterClick=await blankCount(page);
 await page.mouse.move(c.x+40,c.y+30);
 await page.mouse.down();
 await page.mouse.move(c.x+140,c.y+100,{steps:10});
 await page.mouse.up();
 await page.waitForTimeout(250);
 expect(await blankCount(page),'加点态拖动不得再追加路点').toBe(blanksAfterClick);
 expect((await state(page)).x,'加点态拖动不得平移').toBe(before.x);
});

test('10) tool=measure 是显式 pan 意图：可平移但不加点',async({page})=>{
 await open(page);
 await setState(page,{tool:'measure'});
 await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-canvas-mode','measure');
 const box=(await page.getByTestId('map-canvas').boundingBox())!;
 const c=centerOf(box);
 const before=await state(page);
 await page.mouse.move(c.x,c.y);
 await page.mouse.down();
 await page.mouse.move(c.x+90,c.y+60,{steps:10});
 await page.mouse.up();
 await page.waitForTimeout(200);
 const after=await state(page);
 expect(after.x!==before.x||after.y!==before.y,'measure 模式拖动应平移').toBe(true);
 expect(await blankCount(page),'measure 模式不得追加路点').toBe(0);
});
