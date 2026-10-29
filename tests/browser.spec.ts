import {test,expect} from '@playwright/test';
test('标定采集布局：滚动参数/照片时画面与采集按钮保持可见，桌面和平板手机可直接采集',async({page})=>{
 const target={type:'aprilgrid',family:'auto',layoutMode:'auto',rows:6,columns:6,tagSizeMm:22,gapMm:6.6,firstId:0,idOrder:'row-major'};
 let count=6;const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const status=()=>({defaults:{target},session:{id:'9392ee11-05e0-4b61-b682-9221b26868e6',target,sampleCount:count,samples:Array.from({length:count},(_,i)=>({file:`frame-${String(i).padStart(3,'0')}.jpg`,stamp:1000+i*1000,width:1280,height:720}))},busy:false,intrinsics:null,mount:{heightMm:140,forwardMm:0,leftMm:0,imageTopForward:true,verified:true}});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=','base64');
 await page.route('**/api/camera/calibration**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('.jpg'))return route.fulfill({status:200,contentType:'image/png',body:png});
  if(path.endsWith('/capture'))count++;
  await route.fulfill({status:200,json:status()});
 });
 await page.goto('http://127.0.0.1:3080/?page=camera');await page.getByRole('button',{name:'定位标定',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'定位标定',exact:true});const preview=dialog.locator('.calibration-live .preview-screen');const capture=dialog.getByRole('button',{name:'采集当前画面',exact:true});const settings=dialog.locator('.calibration-settings');
 for(const viewport of [{width:1440,height:900},{width:1366,height:768},{width:1024,height:768},{width:390,height:844}]){
  await page.setViewportSize(viewport);await expect(capture).toBeEnabled();
  const before=await preview.boundingBox();expect(before).not.toBeNull();expect(before!.height).toBeGreaterThan(60);
  await settings.evaluate(el=>{el.scrollTop=el.scrollHeight;});
  const after=await preview.boundingBox(),button=await capture.boundingBox();expect(after).not.toBeNull();expect(button).not.toBeNull();
  expect(Math.abs(after!.y-before!.y)).toBeLessThan(1);expect(Math.abs(after!.height-before!.height)).toBeLessThan(1);
  expect(button!.y).toBeGreaterThan(after!.y);expect(button!.y+button!.height).toBeLessThan(viewport.height);expect(after!.y).toBeGreaterThan(0);expect(after!.y+after!.height).toBeLessThan(viewport.height);
  const previous=count;await capture.click();await expect(dialog.locator('.calibration-count')).toContainText(String(previous+1));
  expect(await dialog.evaluate(el=>el.scrollTop)).toBe(0);expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  if(viewport.width===1440||viewport.width===390){await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:`logs/calibration-fixed-${viewport.width}.png`,fullPage:true});}
 }
 await page.keyboard.press('Escape');expect(errors).toEqual([]);
});
test('标定默认参数：自动恢复22/6.6、立即关闭后保存、刷新恢复且不改采集规格',async({page})=>{
 let saved:any={type:'aprilgrid',family:'auto',layoutMode:'auto',rows:6,columns:6,tagSizeMm:22,gapMm:6.6,firstId:0,idOrder:'row-major'};
 const session={id:'21b6ac28-69e3-4c81-b92d-67f22efffdc9',target:{...saved},sampleCount:0,samples:[]};const changes:any[]=[];
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/camera/calibration**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/defaults')){saved=route.request().postDataJSON().target;changes.push(saved);}
  await route.fulfill({status:200,json:{defaults:{target:saved},session,busy:false,intrinsics:null,mount:null}});
 });
 await page.goto('http://127.0.0.1:3080/?page=camera');await page.getByRole('button',{name:'定位标定',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'定位标定',exact:true});await expect(dialog.getByLabel('单码黑框边长 / mm')).toHaveValue('22');await expect(dialog.getByLabel('相邻黑框间距 / mm')).toHaveValue('6.6');
 await expect(dialog.getByRole('combobox',{name:'编号方式',exact:true})).toHaveValue('auto');await expect(dialog.getByLabel('已核对标定板实际尺寸与参数一致')).not.toBeChecked();
 await dialog.getByLabel('相邻黑框间距 / mm').fill('6.8');await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();
 await page.getByRole('button',{name:'定位标定',exact:true}).click();await expect(dialog.getByLabel('相邻黑框间距 / mm')).toHaveValue('6.8');await expect(dialog.getByText('参数已修改，请新建采集')).toBeVisible();
 await expect(dialog.locator('.defaults-note')).toContainText('已恢复上次参数');expect(changes.length).toBeGreaterThan(0);expect(saved.gapMm).toBe(6.8);expect(session.target.gapMm).toBe(6.6);
 await page.reload();await page.getByRole('button',{name:'定位标定',exact:true}).click();await expect(dialog.getByLabel('单码黑框边长 / mm')).toHaveValue('22');await expect(dialog.getByLabel('相邻黑框间距 / mm')).toHaveValue('6.8');expect(errors).toEqual([]);
});
test('专用6×6标定板：规格选择、实测尺寸、识别检查、会话锁定和棋盘格角点换算',async({page})=>{
 const id='bd8cc4ad-9d1e-43a0-ab2a-3a4d8e7b5030';let session:any=null;let requested:any=null;
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const status=()=>({session,busy:false,intrinsics:null,mount:null});
 await page.route('**/api/camera/calibration**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/start')){requested=route.request().postDataJSON().target;session={id,target:requested,sampleCount:0,samples:[]};}
  if(path.endsWith('/probe'))return route.fulfill({status:200,json:{valid:true,family:'tag36h11',matchedCount:36,detectedIds:Array.from({length:36},(_,i)=>i)}});
  await route.fulfill({status:200,json:status()});
 });
 await page.goto('http://127.0.0.1:3080/?page=camera');await page.getByRole('button',{name:'定位标定',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'定位标定',exact:true});
 await dialog.getByRole('button',{name:'专用 AprilGrid 板',exact:true}).click();
 await expect(dialog.getByLabel('码列数',{exact:true})).toHaveValue('6');await expect(dialog.getByLabel('码行数',{exact:true})).toHaveValue('6');
 await expect(dialog.getByRole('combobox',{name:'编号方式',exact:true})).toHaveValue('auto');await expect(dialog.getByLabel('起始 ID',{exact:true})).toHaveCount(0);await expect(dialog.getByLabel('编号排列',{exact:true})).toHaveCount(0);
 await expect(dialog.getByRole('button',{name:'新建采集',exact:true})).toBeDisabled();
 await dialog.getByLabel('单码黑框边长 / mm').fill('25');await dialog.getByLabel('相邻黑框间距 / mm').fill('7.5');
 await dialog.getByRole('button',{name:'检查当前画面',exact:true}).click();await expect(dialog.getByRole('status')).toContainText('36 个子码');
 await dialog.getByRole('button',{name:'新建采集',exact:true}).click();await expect(dialog.getByRole('button',{name:'采集当前画面',exact:true})).toBeEnabled();
 expect(requested).toEqual({type:'aprilgrid',family:'auto',rows:6,columns:6,tagSizeMm:25,gapMm:7.5,layoutMode:'auto',firstId:0,idOrder:'row-major'});
 await dialog.getByRole('combobox',{name:'编号方式',exact:true}).selectOption('manual');await expect(dialog.getByLabel('起始 ID',{exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'采集当前画面',exact:true})).toBeDisabled();await dialog.getByRole('combobox',{name:'编号方式',exact:true}).selectOption('auto');
 await dialog.getByLabel('相邻黑框间距 / mm').fill('8');await expect(dialog.getByRole('button',{name:'采集当前画面',exact:true})).toBeDisabled();await expect(dialog.getByText('参数已修改，请新建采集')).toBeVisible();
 await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'logs/aprilgrid-calibration-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'logs/aprilgrid-calibration-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 await dialog.getByRole('button',{name:'黑白棋盘格',exact:true}).click();await dialog.getByLabel('单格边长 / mm').fill('20');
 await dialog.getByRole('button',{name:'新建采集',exact:true}).click();expect(requested).toEqual({type:'checkerboard',columns:5,rows:5,squareSizeMm:20});
 await dialog.getByLabel('数量填写方式').selectOption('corners');await dialog.getByRole('button',{name:'新建采集',exact:true}).click();expect(requested).toEqual({type:'checkerboard',columns:6,rows:6,squareSizeMm:20});expect(errors).toEqual([]);
});
test('标定照片管理：大图、单张删除、清空取消/确认与移动布局（隔离照片数据）',async({page})=>{
 const id='8b845c42-2b0a-4ca5-8b48-9f672ab87aa2';
 let samples=[0,1,2].map(i=>({file:`frame-00${i}.jpg`,stamp:1000+i*1000,width:1280,height:720}));
 const calls:string[]=[];const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const status=()=>({session:{id,boardId:'B016',sampleCount:samples.length,samples,width:1280,height:720},busy:false,intrinsics:null,mount:null});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=','base64');
 await page.route('**/api/camera/calibration**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(req.method()==='GET'&&path.endsWith('.jpg'))return route.fulfill({status:200,contentType:'image/png',body:png});
  if(req.method()==='DELETE'){
   calls.push(path);
   if(path.endsWith('/photos'))samples=[];
   else samples=samples.filter(p=>!path.endsWith('/'+p.file));
  }
  await route.fulfill({status:200,json:status()});
 });
 await page.goto('http://127.0.0.1:3080/?page=camera');await page.getByRole('button',{name:'定位标定',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'定位标定',exact:true});await expect(dialog.locator('.photo-card')).toHaveCount(3);
 await dialog.getByRole('button',{name:'查看标定照片 1',exact:true}).click();await expect(dialog.getByAltText('标定照片大图')).toBeVisible();
 await dialog.getByRole('button',{name:'删除标定照片 1',exact:true}).click();await expect(dialog.locator('.photo-card')).toHaveCount(2);await expect(dialog.getByAltText('标定照片大图')).toHaveCount(0);
 await expect(dialog.locator('[data-photo-file="frame-002.jpg"]')).toHaveCount(1);
 await dialog.getByRole('button',{name:'清空照片',exact:true}).click();await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog.locator('.photo-card')).toHaveCount(2);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 await dialog.getByRole('button',{name:'清空照片',exact:true}).click();await dialog.getByRole('button',{name:'确认清空',exact:true}).click();await expect(dialog.getByText('暂无照片',{exact:true})).toBeVisible();await expect(dialog.getByRole('button',{name:'清空照片',exact:true})).toBeDisabled();
 expect(calls).toEqual([`/api/camera/calibration/${id}/photos/frame-000.jpg`,`/api/camera/calibration/${id}/photos`]);expect(errors).toEqual([]);
});
test('定位标定：采集入口、安装参数、实测确认与移动端弹窗',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const response=await page.request.get('http://127.0.0.1:3080/api/camera/calibration');
 const current=await response.json();expect(response.ok()).toBe(true);
 await page.goto('http://127.0.0.1:3080/?page=camera');
 await page.getByRole('button',{name:'定位标定',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'定位标定',exact:true});await expect(dialog).toBeVisible();
 await expect(dialog.getByLabel('镜头离地 / mm')).toHaveValue(String(current.mount?.heightMm??140));
 await expect(dialog.getByLabel('相对车体中心前移 / mm')).toHaveValue(String(current.mount?.forwardMm??0));
 await expect(dialog.getByRole('button',{name:'计算并验证内参'})).toBeDisabled();
 if(!current.mount?.verified)await expect(dialog.getByRole('button',{name:'保存安装参数'})).toBeDisabled();
 await expect(dialog.getByRole('button',{name:'新建采集',exact:true})).toBeVisible();
 await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'logs/calibration-dialog-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.screenshot({path:'logs/calibration-dialog-mobile.png',fullPage:true});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();expect(errors).toEqual([]);
});
import {spawn} from 'node:child_process';
import {writeFileSync} from 'node:fs';
test.skip('真实HBVCAM：扫描同步预览、帧率、照片、低速客户端和释放设备（前端已移除摄像头预览入口，仅保留后端采集）',async({page})=>{
 test.skip(process.env.QR_CAMERA_TEST!=='1','仅在已接入 HBVCAM 的设备上显式运行');
 const server=spawn(process.execPath,['--import','tsx','tests/fixtures/camera-server.ts'],{stdio:['ignore','pipe','pipe']});const done=new Promise<void>(resolve=>server.once('exit',()=>resolve()));
 try{
  const {address}=await new Promise<{address:string}>((resolve,reject)=>{let output='',errors='';const timer=setTimeout(()=>reject(new Error('相机检查服务启动超时 '+errors)),10000);server.stderr.on('data',d=>errors+=d);server.on('error',e=>{clearTimeout(timer);reject(e);});server.once('exit',()=>{clearTimeout(timer);reject(new Error(errors));});server.stdout.on('data',d=>{output+=d;if(output.includes('\n')){clearTimeout(timer);resolve(JSON.parse(output.trim()));}});});
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(address);
  await page.getByRole('button',{name:'开始扫描',exact:true}).click();await expect(page.getByRole('button',{name:'实时画面',exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.locator('.preview-state')).toHaveText('实时画面',{timeout:10000});
  await expect(page.locator('.preview-image')).toHaveAttribute('width','1280');await expect(page.locator('.preview-image')).toHaveAttribute('height','720');
  // 四秒内重复读取真实采集/显示统计；不声称这是端到端相机延迟。
  const samples=[];for(let n=0;n<4;n++){await page.waitForTimeout(1000);samples.push({status:await (await page.request.get(address+'/api/camera/status')).json(),display:await page.locator('.preview-toolbar').innerText(),delay:await page.locator('.preview-footer').innerText()});}
  expect(samples.at(-1)!.status.fps).toBeGreaterThan(20);expect(samples.at(-1)!.status.running).toBe(true);
  await page.screenshot({path:'logs/camera-scan-live.png',fullPage:true});
  const slowFrames=await page.evaluate(async()=>{const ws=new WebSocket(`ws://${location.host}/ws/camera`);ws.binaryType='arraybuffer';let frames=0;ws.onmessage=e=>{if(e.data instanceof ArrayBuffer)frames++;};await new Promise(r=>setTimeout(r,1500));ws.close();return frames;});expect(slowFrames).toBe(1);
  await page.getByRole('button',{name:'摄像头预览',exact:true}).click();await expect(page.locator('.preview-state')).toHaveText('实时画面',{timeout:10000});await expect(page.getByRole('button',{name:'保存照片'})).toBeEnabled();
  await expect(page.getByText('自动对焦',{exact:true})).toHaveCount(0);await expect(page.getByText('手动对焦',{exact:true})).toHaveCount(0);await expect(page.locator('.preview-panel input[type="range"]')).toHaveCount(0);
  expect((await page.request.get(address+'/api/camera/controls')).status()).toBe(404);expect((await page.request.post(address+'/api/camera/focus',{data:{}})).status()).toBe(404);
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'保存照片'}).click();await (await download).saveAs('logs/camera-preview-real.jpg');
  await page.getByRole('button',{name:'关闭十字线'}).click();await expect(page.locator('.preview-crosshair')).toHaveCount(0);await page.getByRole('button',{name:'显示十字线'}).click();await expect(page.locator('.preview-crosshair')).toBeVisible();
  await page.getByRole('button',{name:'流畅 480P'}).click();await expect(page.locator('.preview-image')).toHaveAttribute('width','640');await expect(page.locator('.preview-state')).toHaveText('实时画面');await page.getByRole('button',{name:'高清 720P'}).click();await expect(page.locator('.preview-image')).toHaveAttribute('width','1280');await expect(page.locator('.preview-state')).toHaveText('实时画面');
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'logs/camera-preview-desktop.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'logs/camera-preview-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
  await page.getByRole('button',{name:'开始导航',exact:true}).first().click();await expect.poll(async()=>{const s=await (await page.request.get(address+'/api/camera/status')).json();return s.viewers;}).toBe(0);await expect.poll(async()=>{const s=await (await page.request.get(address+'/api/camera/status')).json();return s.running;}).toBe(false);
  writeFileSync('logs/camera-preview-test.json',JSON.stringify({samples,slowFrames,errors},null,2));expect(errors).toEqual([]);
 }finally{server.kill('SIGTERM');await done;}
});
test('扫描记录管理：搜索、同名区分、打开、取消删除、真实删除及移动布局',async({page})=>{
 const server=spawn(process.execPath,['--import','tsx','tests/fixtures/records-server.ts'],{stdio:['ignore','pipe','pipe']});
 const done=new Promise<void>(resolve=>server.once('exit',()=>resolve()));
 try{
  const sameName='温室地面标记采集';
  const {address,first,second,linked}=await new Promise<{address:string,first:{id:string},second:{id:string},linked:{id:string}}>((resolve,reject)=>{
   let output='',errors='';const timer=setTimeout(()=>reject(new Error('记录测试服务启动超时 '+errors)),10000);
   server.on('error',e=>{clearTimeout(timer);reject(e);});server.stderr.on('data',chunk=>errors+=chunk);
   server.once('exit',()=>{clearTimeout(timer);reject(new Error('记录测试服务提前退出 '+errors));});
   server.stdout.on('data',chunk=>{output+=chunk;if(output.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(output.trim()));}catch(e){reject(e);}}});
  });
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(address);
  const trigger=page.getByRole('button',{name:'管理扫描记录'});await expect(trigger).toBeEnabled();await trigger.click();
  const dialog=page.getByRole('dialog',{name:'扫描记录'});await expect(dialog).toBeVisible();await expect(dialog.locator('.record-card')).toHaveCount(3);
  await expect(dialog.locator(`[data-record-id="${linked.id}"]`).getByRole('button',{name:'删除扫描 已建图扫描'})).toBeDisabled();
  const search=dialog.getByRole('textbox',{name:'搜索扫描记录'});await search.fill(first.id);await expect(dialog.locator('.record-card')).toHaveCount(1);
  await dialog.getByRole('button',{name:'打开扫描 '+sameName}).click();await expect(dialog).not.toBeVisible();await expect(trigger).toContainText(sameName);
  await trigger.click();await expect(search).toHaveValue('');await expect(dialog.getByText('#'+first.id.slice(-8),{exact:true})).toBeVisible();await expect(dialog.getByText('#'+second.id.slice(-8),{exact:true})).toBeVisible();
  const card=dialog.locator(`[data-record-id="${first.id}"]`);await card.getByRole('button',{name:'删除扫描 '+sameName}).click();await card.getByRole('button',{name:'取消',exact:true}).click();await expect(card.getByRole('button',{name:'确认删除'})).toHaveCount(0);
  await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'logs/scan-records-desktop.png',fullPage:true});
  await card.getByRole('button',{name:'删除扫描 '+sameName}).click();await card.getByRole('button',{name:'确认删除'}).click();await expect(card).toHaveCount(0);await expect(dialog.locator('.record-card')).toHaveCount(2);
  expect((await page.request.get(address+'/api/surveys/'+first.id)).status()).toBe(404);expect((await page.request.get(address+'/api/surveys/'+second.id)).status()).toBe(200);
  await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();await expect(trigger).toBeFocused();await expect(trigger).toContainText('选择扫描记录');await expect(page.getByText('未开始',{exact:true})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'管理扫描记录'}).click();await expect(dialog.locator('.record-card')).toHaveCount(2);
  await search.fill('不存在的记录');await expect(dialog.getByText('没有匹配的记录')).toBeVisible();await dialog.getByRole('button',{name:'清空搜索'}).click();await expect(dialog.locator('.record-card')).toHaveCount(2);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:'logs/scan-records-mobile.png',fullPage:true});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);expect(errors).toEqual([]);
 }finally{server.kill('SIGTERM');await done;}
});
test('扫描界面：定位组统计与未定位禁用导航',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:3080');await page.evaluate(()=>document.fonts.ready);
 await expect(page.getByRole('heading',{name:'扫描建图'})).toBeVisible();await expect(page.getByText('暂无扫描数据',{exact:true})).toBeVisible();await expect(page.locator('.state-card strong')).toContainText('定位组');await expect(page.locator('nav button')).toHaveCount(4);
 await page.getByText('参数设置',{exact:true}).click();await expect(page.getByText(/已注册定位组/)).toBeVisible();await expect(page.getByLabel('黑边尺寸 / mm',{exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'开始导航',exact:true}).first().click();await expect(page.getByRole('heading',{name:'导航监控'})).toBeVisible();await expect(page.getByRole('button',{name:'开始导航',exact:true}).last()).toBeDisabled();expect(errors).toEqual([]);
});
test('多码定位板PDF：组内规格、整组尺寸、组数、注册与下载',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:3080');await page.getByRole('button',{name:'二维码 PDF',exact:true}).click();
 await expect(page.getByRole('button',{name:'生成并下载 PDF'})).toBeEnabled();await expect(page.getByLabel('整组尺寸 / mm')).toHaveValue('140');await expect(page.getByLabel('生成组数')).toHaveValue('3');
 for(const n of [1,2,3,4]){await page.getByRole('button',{name:`${n} × ${n}`,exact:true}).click();await expect(page.getByRole('button',{name:`${n} × ${n}`,exact:true})).toHaveAttribute('aria-pressed','true');await expect(page.getByLabel('整组尺寸 / mm')).toHaveValue('140');}
 await page.getByLabel('起始子码编号').fill('300');await page.getByLabel('生成组数').fill('2');await expect(page.locator('.pdf-summary')).toContainText('32 个');await expect(page.locator('.pdf-summary')).toContainText('2 页');await expect(page.getByRole('button',{name:'生成并下载 PDF'})).toBeEnabled();
 const downloadPromise=page.waitForEvent('download');await page.getByRole('button',{name:'生成并下载 PDF'}).click();const download=await downloadPromise;expect(download.suggestedFilename()).toBe('apriltag-boards-B300-B316-4x4-140mm.pdf');await download.saveAs('logs/browser-multicode.pdf');await expect(page.getByRole('status')).toContainText('PDF 已生成');
 await expect(page.locator('.board-row')).toHaveCount(2);await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:'logs/multicode-pdf-desktop.png',fullPage:true});
 await page.getByLabel('生成组数').fill('20');await expect(page.getByRole('alert')).toContainText('17 组');await expect(page.getByRole('button',{name:'生成并下载 PDF'})).toBeDisabled();await page.getByLabel('生成组数').fill('2');
 await page.getByLabel('整组尺寸 / mm').fill('30');await expect(page.getByRole('alert')).toContainText('56');await page.getByLabel('整组尺寸 / mm').fill('140');
 for(const width of [1024,768,390]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);await page.screenshot({path:`logs/multicode-pdf-${width}.png`,fullPage:true});}
 await page.getByRole('button',{name:'扫描建图',exact:true}).click();await page.getByText('参数设置',{exact:true}).click();await expect(page.getByText('B300 · 4×4 · 140 mm',{exact:true})).toBeVisible();expect(errors).toEqual([]);
});

test('高误差标定照片：显示最终误差、预览、勾选、取消零删除、确认只删除所选（隔离数据）',async({page})=>{
 const id='904d27d8-87fb-476f-a51a-7c4a0e738a91',target={type:'aprilgrid',family:'auto',layoutMode:'auto',rows:6,columns:6,tagSizeMm:22,gapMm:6.6,firstId:0,idOrder:'row-major'};
 let reviewed=false,current=true;
 let samples=Array.from({length:16},(_,i)=>({file:`frame-${String(i).padStart(3,'0')}.jpg`,stamp:1000+i*1000,width:1280,height:720,detection:i===15?{valid:false,reason:'可用子码不足'}:{valid:true,matchedCount:20,reprojection:{role:i%4===3?'validation':'training',rmsPixels:i===8?6.46:i===12?3.02:.23,thresholdPixels:i%4===3?1.2:.8,excessive:i===8||i===12}}}));
 const deletes:string[]=[],errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 const status=()=>({defaults:{target},session:{id,target,sampleCount:samples.length,samples:samples.map(p=>({...p,detection:reviewed?p.detection:undefined})),calibrationReview:reviewed?{current,rmsPixels:1.55,validationMaxPixels:.23}:null},busy:false,intrinsics:{verified:true,rmsPixels:.21367},mount:null});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=','base64');
 await page.route('**/api/camera/calibration**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(req.method()==='GET'&&path.endsWith('.jpg'))return route.fulfill({status:200,contentType:'image/png',body:png});
  if(path.endsWith('/solve')){reviewed=true;return route.fulfill({status:400,json:{error:'标定误差过大：拟合1.55px，独立验证最大0.23px'}});}
  if(req.method()==='DELETE'){deletes.push(path);samples=samples.filter(p=>!path.endsWith('/'+p.file));current=false;}
  await route.fulfill({status:200,json:status()});
 });
 await page.goto('http://127.0.0.1:3080/?page=camera');await page.getByRole('button',{name:'定位标定',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'定位标定',exact:true});await dialog.getByLabel('已核对标定板实际尺寸与参数一致').check();await dialog.getByRole('button',{name:'计算并验证内参',exact:true}).click();
 const review=dialog.getByRole('region',{name:'高误差标定照片'});await expect(review.getByText('2 张照片误差过大')).toBeVisible();await expect(review.getByText('拟合 6.46 px / 0.8 px')).toBeVisible();await expect(review.getByText('拟合 3.02 px / 0.8 px')).toBeVisible();
 await review.getByRole('button',{name:'查看高误差照片 9',exact:true}).click();await expect(dialog.getByAltText('标定照片大图')).toBeVisible();
 await review.getByRole('checkbox',{name:'选择高误差照片 9',exact:true}).check();await review.getByRole('button',{name:'删除所选高误差照片',exact:true}).click();expect(deletes).toEqual([]);
 await review.getByRole('button',{name:'取消删除',exact:true}).click();expect(deletes).toEqual([]);await expect(dialog.locator('.photo-card')).toHaveCount(16);
 await review.getByRole('button',{name:'删除所选高误差照片',exact:true}).click();await review.getByRole('button',{name:'确认删除 1 张',exact:true}).click();
 await expect(dialog.locator('.photo-card')).toHaveCount(15);await expect(dialog.locator('[data-photo-file="frame-012.jpg"]')).toHaveCount(1);await expect(dialog.locator('[data-photo-file="frame-015.jpg"]')).toHaveCount(1);
 await expect(dialog.getByText('照片已变化，请重新计算照片误差。')).toBeVisible();await expect(dialog.getByLabel('已核对标定板实际尺寸与参数一致')).not.toBeChecked();
 expect(deletes).toEqual([`/api/camera/calibration/${id}/photos/frame-008.jpg`]);expect(errors).toEqual([]);
});
