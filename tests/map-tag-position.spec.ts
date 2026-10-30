import {test,expect} from '@playwright/test';
import {createServer,type Server} from 'node:http';
import {readFile} from 'node:fs/promises';
import {extname,join} from 'node:path';
import {generateBoards} from '../web/shared/boards';
import {mapSchema,validate,type FieldMap} from '../web/shared/model';
import {previewTagPositions} from '../web/shared/map-tag-position';

const DIST=process.env.MAP_EDIT_DIST??'/tmp/a2-dist';
const MAP_ID='scan-tag-position-browser';
const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.woff2':'font/woff2'};
let server:Server,baseURL='';
test.beforeAll(async()=>{
 server=createServer(async(req,res)=>{
  try{
   const path=new URL(req.url??'/',baseURL).pathname;
   const file=path==='/'||!extname(path)?'index.html':path.slice(1);
   const data=await readFile(join(DIST,file));
   res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':'no-store'});
   res.end(data);
  }catch{res.writeHead(404,{'Content-Type':'text/plain'});res.end('not found');}
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const address=server.address();if(!address||typeof address==='string')throw new Error('server not listening');
 baseURL=`http://127.0.0.1:${address.port}`;
});
test.afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});

function pointMap():FieldMap{
 const groups=generateBoards({gridSize:2,groupSizeMm:120,groupCount:2,startId:0});
 return mapSchema.parse({schemaVersion:1,id:MAP_ID,name:'扫描初始地图',frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',captureQuality:'verified',routeMode:'map-only',rows:[],order:[],tags:groups.map((group,index)=>({id:group.referenceId,x:index*.6,y:0,angle:index?12:0,size:group.sizeMm/1000,groupId:group.id,rowId:'',kind:'waypoint',rules:[]})),groups,zone:[{x:-1,y:-1},{x:2,y:-1},{x:2,y:1},{x:-1,y:1}],vehicle:{width:.4,length:.8,margin:.05},notes:'浏览器验收用扫描定位码地图'});
}
interface ApiState{map:FieldMap;version:number;versions:Record<number,FieldMap>;saves:any[]}
async function mockApi(page:import('@playwright/test').Page){
 const state:ApiState={map:pointMap(),version:1,versions:{},saves:[]};
 state.versions[1]=state.map;
 const boards=state.map.groups??[];
 await page.routeWebSocket('**/ws',ws=>{ws.onMessage(()=>{});});
 await page.route('**/api/**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
  const json=(body:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  if(path==='/api/surveys'||path==='/api/tasks')return json([]);
  if(path==='/api/routes')return json([]);
  if(path==='/api/boards')return json(boards);
  if(path==='/api/maps'&&method==='GET')return json([{id:MAP_ID,name:state.map.name,version:state.version,created:new Date().toISOString()}]);
  if(path===`/api/maps/${MAP_ID}`&&method==='GET')return json({map:state.versions[state.version]??state.map,version:state.version,acceptance:{kind:null,accepted:false,digestValid:false}});
  if(path===`/api/maps/${MAP_ID}/tag-positions`&&method==='POST'){
   const body=request.postDataJSON() as {baseVersion:number;tags:{id:number;x:number;y:number;angle?:number}[]};
   state.saves.push(body);
   if(body.baseVersion!==state.version)return json({error:'地图已有新版本，请重新加载后再调整二维码位置'},409);
   const preview=previewTagPositions(state.map,body.tags);
   if(!preview.ready||!preview.map)return json({error:'二维码位置无效：'+preview.reasons.map(reason=>reason.message).join('；')},400);
   state.map=preview.map;state.version+=1;state.versions[state.version]=state.map;
   return json({map:state.map,version:state.version,previousVersion:body.baseVersion,maxDisplacementM:preview.maxDisplacementM,disclaimer:preview.disclaimer});
  }
  return json({error:'未打桩的接口 '+method+' '+path},404);
 });
 return state;
}
test('地图二维码位置调整：拖动/输入→逐点预览→保存新地图版本、旧版本不变、刷新恢复、409 与路径编辑独立',async({page})=>{
 const state=await mockApi(page);
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(baseURL+'/');
 await page.getByRole('button',{name:'开始导航',exact:true}).click();
 const panel=page.getByTestId('tag-position-panel');
 await expect(panel).toBeVisible();
 await expect(panel.getByText('基准版本 v1')).toBeVisible();
 // v1 is the immutable scan evidence and the only version at this point.
 expect(state.version).toBe(1);
 await panel.getByTestId('tag-position-toggle').click();
 await expect(panel.getByTestId('tag-position-fields')).toBeVisible();
 // No changedIds => no save: an empty edit must never create another empty version.
 await expect(panel.getByTestId('tag-position-save')).toBeDisabled();
 const canvas=page.getByTestId('map-canvas');
 await expect(canvas).toHaveAttribute('data-konva-tags','2');
 // 1) Real canvas drag: move the selected group centre by roughly +5cm right and down.
 const box=await canvas.boundingBox();expect(box).not.toBeNull();
 const scale=Number(await canvas.getAttribute('data-konva-scale')),stageX=Number(await canvas.getAttribute('data-konva-x')),stageY=Number(await canvas.getAttribute('data-konva-y'));
 expect(scale).toBeGreaterThan(0);
 const startX=box!.x+stageX,startY=box!.y+stageY;
 await page.mouse.move(startX,startY);await page.mouse.down();await page.mouse.move(startX+40,startY+20,{steps:6});await page.mouse.up();
 await expect(panel.getByTestId('tag-position-preview')).toBeVisible();
 await expect(panel.getByTestId('tag-position-max-displacement')).not.toHaveText('0.0 cm');
 const draggedX=Number(await panel.getByTestId('tag-position-x').inputValue()),draggedY=Number(await panel.getByTestId('tag-position-y').inputValue());
 expect(draggedX).toBeGreaterThan(0);expect(draggedY).toBeLessThan(0);
 // 2) Undo the drag, then enter exact coordinates (the other accepted input path).
 await panel.getByTestId('tag-position-undo').click();
 await expect(panel.getByTestId('tag-position-x')).toHaveValue('0');
 await expect(panel.getByTestId('tag-position-save')).toBeDisabled();
 expect(await panel.getByTestId('tag-position-preview').count()).toBe(0);
 await panel.getByTestId('tag-position-x').fill('0.25');await panel.getByTestId('tag-position-x').press('Tab');
 await panel.getByTestId('tag-position-y').fill('-0.15');await panel.getByTestId('tag-position-y').press('Tab');
 await panel.getByTestId('tag-position-angle').fill('10');await panel.getByTestId('tag-position-angle').press('Tab');
 await expect(panel.getByTestId('tag-position-max-displacement')).toHaveText((Math.hypot(.25,.15)*100).toFixed(1)+' cm');
 await expect(panel.getByTestId('tag-position-point')).toContainText('整组4码');
 await expect(panel.getByTestId('tag-position-point')).toContainText('(0.000, 0.000) → (0.250, -0.150)');
 await expect(panel.getByTestId('tag-position-status')).toContainText('可以保存为新地图版本');
 // 3) Save => v2, while v1 (scan evidence) stays untouched.
 await panel.getByTestId('tag-position-save').click();
 await expect(page.getByText('已保存地图二维码位置 · 地图版本 v2')).toBeVisible();
 await expect(panel.getByText('基准版本 v2')).toBeVisible();
 expect(state.version).toBe(2);
 expect(state.saves.length).toBe(1);
 expect(state.saves[0]!.baseVersion).toBe(1);
 expect(state.saves[0]!.tags).toEqual([{id:0,x:.25,y:-.15,angle:10}]);
 expect(state.versions[1]).toEqual(pointMap());
 expect(state.map.tags.find(tag=>tag.id===0)!.x).toBe(.25);
 expect(state.map.groups).toEqual(pointMap().groups);
 // 4) Reload the page: latest version and new coordinates must be restored.
 await page.reload();
 await page.getByRole('button',{name:'开始导航',exact:true}).click();
 await expect(page.getByTestId('tag-position-panel').getByText('基准版本 v2')).toBeVisible();
 await page.getByTestId('tag-position-toggle').click();
 await expect(page.getByTestId('tag-position-x')).toHaveValue('0.25');
 await expect(page.getByTestId('tag-position-y')).toHaveValue('-0.15');
 await expect(page.getByTestId('tag-position-angle')).toHaveValue('10');
 await page.getByTestId('tag-position-exit').click();
 // 5) A stale baseVersion must surface a 409 and never create a version.
 await page.getByTestId('tag-position-toggle').click();
 await page.getByTestId('tag-position-x').fill('0.3');await page.getByTestId('tag-position-x').press('Tab');
 const versionBeforeConflict=state.version;
 state.version=versionBeforeConflict+1; // another page saved meanwhile
 await page.getByTestId('tag-position-save').click();
 await expect(page.getByTestId('tag-position-error')).toContainText('地图版本已变化');
 expect(state.saves.at(-1)!.baseVersion).toBe(versionBeforeConflict);
 state.version=versionBeforeConflict;
 await page.getByTestId('tag-position-exit').click();
 // 6) Path editing remains a separate entry and is not blocked by the saved map version.
 await page.getByTestId('new-route').click();
 await expect(page.getByTestId('route-editor')).toBeVisible();
 await expect(page.getByTestId('tag-position-panel')).toHaveCount(0);
 await page.getByRole('button',{name:'退出',exact:true}).click();
 await expect(page.getByTestId('tag-position-panel')).toBeVisible();
 expect(errors).toEqual([]);
});
