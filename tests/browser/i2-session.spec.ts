import {test,expect} from '@playwright/test';
import {mapSchema} from '../../web/shared/model';
const points=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
const source=mapSchema.parse({schemaVersion:1,id:'scan-i2',name:'I2',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',routeMode:'waypoints',
 rows:[{id:'route',name:'原路线',width:.6,exitDistance:.8,start:points[0],points:points.slice(1,3)}],order:['route'],
 tags:points.map((p,id)=>({id,...p,angle:0,size:.08,rowId:'route',kind:'waypoint',rules:[]})),zone:[{x:-.5,y:-.5},{x:1.5,y:-.5},{x:1.5,y:1.5},{x:-.5,y:1.5}],vehicle:{width:.4,length:.8,margin:.05},notes:''});

async function boot(page:any){
 let version=1,map=structuredClone(source);
 const task=()=>({id:'task-scan-i2',name:'T',mapId:map.id,mapVersion:version,rowOrder:['route'],forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2,enabled:true});
 await page.routeWebSocket('**/ws',(ws:any)=>ws.send(JSON.stringify({type:'robot',status:{connected:false,state:'OFFLINE',running:false,paused:false,pose:null,chassis:{connected:false},conditions:[],events:[],sensors:{}}})));
 await page.route('**/api/**',async (route:any)=>{
  const path=new URL(route.request().url()).pathname;
  if(path==='/api/routes')return route.fulfill({json:[]});
  if(path==='/api/tasks')return route.fulfill({json:[task()]});
  if(path==='/api/maps')return route.fulfill({json:[{id:map.id,name:map.name,version}]});
  if(path==='/api/surveys'||path==='/api/boards')return route.fulfill({json:[]});
  if(path==='/api/camera/status')return route.fulfill({json:{running:false,present:false}});
  if(path==='/api/maps/'+map.id)return route.fulfill({json:{map,version}});
  return route.fulfill({json:{}});
 });
 await page.goto('/');
 await page.locator('.sidebar').getByRole('button',{name:'开始导航',exact:true}).click();
 await page.getByTestId('edit-route').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await page.waitForTimeout(600);
}

test('第2项：工具互斥 / panMode 生效 / 撤销重做 / 输入框快捷键保护',async({page})=>{
 await boot(page);
 const canvas=page.getByTestId('map-canvas');

 // 1) 模式徽章存在，且默认是「选择」
 await expect(page.getByTestId('editor-mode-badge')).toBeVisible();
 await expect(page.getByTestId('editor-mode-badge')).toHaveAttribute('data-mode','select');
 await expect(canvas).toHaveAttribute('data-canvas-pan-mode','0');

 // 2) 切到平移：panMode 必须变成 pan
 await page.getByTestId('route-pan-tool').click();
 await page.waitForTimeout(300);
 await expect(page.getByTestId('editor-mode-badge')).toHaveAttribute('data-mode','pan');
 await expect(canvas).toHaveAttribute('data-canvas-pan-mode','1');
 await expect(page.getByTestId('editor-mode-pan-note')).toContainText('平移画布');

 // 3) 切回选择：panMode 必须变回 select（互斥真正生效）
 await page.getByTestId('route-select-tool').click();
 await page.waitForTimeout(300);
 await expect(canvas).toHaveAttribute('data-canvas-pan-mode','0');
 await expect(page.getByTestId('editor-mode-badge')).toHaveAttribute('data-mode','select');

 // 4) 测距工具：模式切到 measure，且平移工具不再生效
 await page.getByTestId('route-measure-tool').click();
 await page.waitForTimeout(400);
 await expect(page.getByTestId('editor-mode-badge')).toHaveAttribute('data-mode','measure');
 await expect(canvas).toHaveAttribute('data-canvas-mode','measure');
 await page.getByTestId('route-select-tool').click();
 await page.waitForTimeout(300);

 // 5) 撤销 / 重做：加点后 Ctrl+Z 必须真的回退，Ctrl+Shift+Z 必须恢复
 await page.getByTestId('route-draw-tool').click();
 await page.waitForTimeout(300);
 const rows=page.locator('.route-commands-table tbody tr');
 const beforeCount=await rows.count();
 expect(beforeCount).toBeGreaterThanOrEqual(2);

 const box=(await canvas.boundingBox())!;
 const st=await page.evaluate(()=>{const c=document.querySelector('[data-testid="map-canvas"]') as HTMLElement;return {scale:Number(c.dataset.konvaScale),x:Number(c.dataset.konvaX),y:Number(c.dataset.konvaY)};});
 const at={x:box.x+st.x+1.0*100*st.scale,y:box.y+st.y-0.5*100*st.scale};
 await page.mouse.click(at.x,at.y);
 await page.waitForTimeout(500);
 const afterAdd=await rows.count();
 expect(afterAdd,'加点后行数应增加').toBeGreaterThan(beforeCount);

 await page.getByTestId('route-select-tool').click();
 await page.waitForTimeout(200);
 await page.keyboard.press('Control+z');
 await page.waitForTimeout(500);
 expect(await rows.count(),'Ctrl+Z 必须撤销加点').toBe(beforeCount);
 const redoBtn=page.getByTestId('route-redo');
 console.log('REDO_ENABLED_AFTER_UNDO=',await redoBtn.isEnabled());
 console.log('UNDO_ENABLED_AFTER_UNDO=',await page.getByTestId('route-undo').isEnabled());

 await expect(page.getByTestId('route-redo')).toBeEnabled();
 await page.keyboard.press('Control+Shift+z');
 await page.waitForTimeout(600);
 expect(await rows.count(),'Ctrl+Shift+Z 必须重做加点').toBe(afterAdd);
 // 再撤一次、用按钮重做，确认按钮路径同样可用
 await page.keyboard.press('Control+z');
 await page.waitForTimeout(500);
 expect(await rows.count()).toBe(beforeCount);
 await page.getByTestId('route-redo').click();
 await page.waitForTimeout(500);
 expect(await rows.count(),'重做按钮必须恢复加点').toBe(afterAdd);

 // 6) 输入框快捷键保护：在距离输入框里按 Ctrl+Z 不能撤销路径
 await page.getByTestId('route-steps-trigger').click();
 await page.waitForTimeout(500);
 const legInput=page.getByTestId('route-leg-distance').first();
 await legInput.click();
 await legInput.press('Control+z');
 await page.waitForTimeout(400);
 expect(await rows.count(),'输入框内 Ctrl+Z 不得撤销路径改动').toBe(afterAdd);

 // 7) Esc 退出编辑
 await page.keyboard.press('Escape');
 await page.waitForTimeout(400);
});
