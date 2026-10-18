import {pointDraftMap} from './survey';
import {appendMotionRecords} from './survey';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import staticPlugin from '@fastify/static';
import {readFileSync,writeFileSync,rmSync,mkdirSync,existsSync,renameSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {mapSchema,generate,generationSchema,validate,paths,distance} from '../../shared/model';
import {taskSchema} from '../../shared/task';
import {Store} from './store';
import {printPdf,tagSvg,manifest,layoutSvg,gridPrintOptions} from './tags';
import {RobotLink} from './robot';
import {surveyTables,createSurvey,getSurvey,listSurveys,deleteSurvey,appendSamples,appendLiveSamples,anchorSchema,optimizeSurvey,optimizationSamples} from './survey';
import {zipSync,strToU8} from 'fflate';
import {batchPlan,exportBatch} from './batch-print';
import {compileScan,scanSettings} from './scan-map';
import {compileDesignedRoute,routeDesignSchema} from './route-design';
import {boardOptions,boardPlan,boardSvg,boardPdf,boardTables,listBoards,checkBoardRegistration,registerBoards} from './boards';
import {boardPrintSchema} from '../../shared/boards';
import {CameraPreview} from './camera';
import {CameraCalibration} from './calibration';
export const root=fileURLToPath(new URL('../../../',import.meta.url));
const mapConfirmationSchema=z.object({mapId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),version:z.number().int().positive(),confirm:z.literal(true),operator:z.string().trim().min(1).max(80),updateTasks:z.boolean().default(false)}).strict();
const mapConfirmationEvidenceSchema=mapConfirmationSchema.extend({kind:z.literal('user_confirmation'),acceptedVersion:z.number().int().positive(),created:z.string().datetime()}).strict();
const mapMeasurementSchema=z.object({mapId:z.string(),version:z.number().int().positive(),measurements:z.array(anchorSchema).min(3).max(587),operator:z.string().min(1).max(80)});
const mapMeasurementEvidenceSchema=mapMeasurementSchema.extend({kind:z.literal('measurement').optional(),residuals:z.array(z.number().finite().min(0).max(.03)).min(3).max(587),created:z.string().datetime()}).strict();
export async function createApp(database?:string) {
 const config=JSON.parse(readFileSync(resolve(root,'config/web.json'),'utf8'));mkdirSync(resolve(root,'maps'),{recursive:true});
 const keyFile=resolve(root,config.bridgeKeyFile);if(!existsSync(keyFile))writeFileSync(keyFile,randomBytes(32).toString('hex'),{mode:0o600});const bridgeKey=readFileSync(keyFile,'utf8').trim();
 const app=Fastify({logger:!database,disableRequestLogging:true,bodyLimit:8*1024*1024});const store=new Store(database??resolve(root,config.database));surveyTables(store);boardTables(store);
 store.db.exec('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,body TEXT,updated TEXT); CREATE TABLE IF NOT EXISTS acceptances(map_id TEXT,version INTEGER,digest TEXT,body TEXT,PRIMARY KEY(map_id,version)); CREATE TABLE IF NOT EXISTS runtime_log(stamp TEXT,event TEXT);');
 const robot=new RobotLink();const clients=new Set<{send:(data:string)=>void,readyState:number,close:()=>void}>();let surveyId:string|null=((store.db.prepare("SELECT id FROM survey_sessions WHERE state='collecting' ORDER BY created DESC LIMIT 1").get() as {id:string}|undefined)?.id??null);
 const broadcast=()=>{const msg=JSON.stringify({type:'robot',status:robot.status()});for(const c of clients)if(c.readyState===1)c.send(msg);};
 function authorized(req:{headers:Record<string,unknown>}){const key=String(req.headers['x-bridge-key']??'');if(key.length!==bridgeKey.length||!timingSafeEqual(Buffer.from(key),Buffer.from(bridgeKey)))throw Object.assign(new Error('ROS2桥身份认证失败'),{statusCode:401});}
 function log(event:string){store.db.prepare('INSERT INTO runtime_log VALUES(?,?)').run(new Date().toISOString(),event);}
 function mapApproval(item:NonNullable<ReturnType<Store['get']>>){
  const acceptance=store.db.prepare('SELECT digest,body FROM acceptances WHERE map_id=? AND version=?').get(item.map.id,item.version) as {digest:string,body:string}|undefined;
  const digestValid=!!acceptance&&acceptance.digest===store.digest(item.map);
  const denied={kind:null,digestValid,accepted:false};if(!digestValid||item.map.coordinateStatus!=='reviewed'||store.get(item.map.id)?.version!==item.version)return denied;
  try{
   const raw=JSON.parse(acceptance!.body);if(raw.kind==='office_test'&&item.map.routeMode==='waypoints'&&raw.version===item.version)return {kind:'office_test',digestValid,accepted:true};const confirmation=mapConfirmationEvidenceSchema.safeParse(raw);
   if(confirmation.success){const evidence=confirmation.data;
    if(evidence.mapId===item.map.id&&evidence.acceptedVersion===item.version&&evidence.version===item.version-1)return {kind:'user_confirmation',digestValid,accepted:true};
   }
   const measurement=mapMeasurementEvidenceSchema.safeParse(raw);
   if(item.map.captureQuality!=='draft'&&measurement.success){const evidence=measurement.data;
    if(evidence.mapId===item.map.id&&evidence.version===item.version-1&&evidence.measurements.length===evidence.residuals.length)return {kind:'measurement',digestValid,accepted:true};
   }
  }catch{/* 不接纳损坏的审计记录。 */}
  return denied;
 }
 function saveMap(map:z.infer<typeof mapSchema>,baseVersion:number){
  if(map.routeMode==='waypoints')map.coordinateStatus='reviewed';
  return store.db.transaction(()=>{
   const saved=store.save(map,baseVersion);
   if(map.routeMode==='waypoints'){const evidence={kind:'office_test',version:saved.version,created:new Date().toISOString()};store.db.prepare('INSERT INTO acceptances VALUES(?,?,?,?)').run(map.id,saved.version,store.digest(saved.map),JSON.stringify(evidence));log('保存办公室测试路线（无需坐标审核） '+map.id+' v'+saved.version);}
   return {...saved,acceptance:mapApproval(saved)};
  })();
 }
 app.setErrorHandler((err,_req,reply)=>{const error=err as Error & {statusCode?:number};reply.code(err instanceof z.ZodError?400:error.statusCode??400).send({error:error.message});});
 await app.register(websocket);
 const camera=new CameraPreview(root);
 const calibration=new CameraCalibration(root,camera,()=>listBoards(store));
 app.get('/ws/camera',{websocket:true},socket=>camera.add(socket));
 app.get('/api/camera/status',()=>camera.status());
 app.post('/api/camera/profile',req=>camera.setProfile(z.object({id:z.string()}).parse(req.body).id));
 app.get('/api/camera/calibration',()=>calibration.status());
 app.post('/api/camera/calibration/defaults',req=>calibration.defaults(req.body));
 app.post('/api/camera/calibration/start',req=>calibration.start(req.body));
 app.post('/api/camera/calibration/probe',req=>calibration.probe(req.body));
 app.post('/api/camera/calibration/capture',()=>calibration.capture());
 app.post('/api/camera/calibration/solve',req=>calibration.solve(req.body));
 app.post('/api/camera/calibration/mount',req=>calibration.mount(req.body));
 app.get<{Params:{id:string,file:string}}>('/api/camera/calibration/:id/photos/:file',(req,reply)=>reply.type('image/jpeg').header('Cache-Control','no-store').send(calibration.photo(req.params.id,req.params.file)));
 app.delete<{Params:{id:string,file:string}}>('/api/camera/calibration/:id/photos/:file',req=>calibration.removePhoto(req.params.id,req.params.file));
 app.delete<{Params:{id:string}}>('/api/camera/calibration/:id/photos',req=>calibration.clearPhotos(req.params.id));
 app.addHook('onClose',()=>camera.close());
 app.get('/ws',{websocket:true},socket=>{clients.add(socket);socket.send(JSON.stringify({type:'robot',status:robot.status()}));socket.on('close',()=>clients.delete(socket));});
 app.get('/api/health',()=>({ok:true,mode:'greenhouse',version:'1.0.0',cameraIntegration:'last',hardwareControl:false,robotConnected:robot.status().connected}));
 app.get('/api/robot/status',()=>robot.status());
 app.post('/api/robot/telemetry',req=>{authorized(req);robot.update(req.body);broadcast();return {ok:true};});
 app.get('/api/robot/commands',req=>{authorized(req);return robot.poll();});
 app.get<{Params:{id:string}}>('/api/robot/commands/:id',(req,reply)=>{reply.header('Cache-Control','no-store');const result=robot.commandResult(req.params.id);return result??reply.code(404).send({error:'命令结果不存在或已过期'});});
 app.post('/api/robot/ack',req=>{authorized(req);const b=z.object({id:z.string(),ok:z.boolean().optional(),message:z.string().max(1000).optional()}).parse(req.body);robot.ack(b.id,b.ok,b.message);log(`${b.id} ${b.ok===undefined?'UNCONFIRMED':b.ok?'OK':'REJECTED'} ${b.message??''}`);return {ok:true};});
 app.get('/api/maps',()=>store.list());
 app.get('/api/boards/options',()=>boardOptions());
 app.get('/api/boards',()=>listBoards(store));
 app.post('/api/boards/plan',req=>boardPlan(req.body));
 const boardCrosshairQuery=z.object({centerCrosshair:z.enum(['true','false']).default('true').transform(value=>value==='true')});
 app.get('/api/boards/preview.svg',(req,reply)=>{
  const query=z.object({gridSize:z.coerce.number().int().min(1).max(6),groupSizeMm:z.coerce.number().finite().min(20).max(180),startId:z.coerce.number().int().min(0).max(586).default(0)}).merge(boardCrosshairQuery).parse(req.query);
  const plan=boardPlan({...query,groupCount:1});return reply.type('image/svg+xml').send(boardSvg(plan.boards[0]!,query.centerCrosshair));
 });
 app.get<{Params:{id:string}}>('/api/boards/:id.svg',(req,reply)=>{const options=boardCrosshairQuery.parse(req.query),board=listBoards(store).find(item=>item.id===req.params.id);return board?reply.type('image/svg+xml').send(boardSvg(board,options.centerCrosshair)):reply.code(404).send({error:'定位板不存在'});});
 app.post('/api/boards/pdf',async(req,reply)=>{
  const request=boardPrintSchema.parse(req.body),plan=boardPlan(request);checkBoardRegistration(store,plan.boards);
  const data=await boardPdf(plan.boards,request.centerCrosshair);registerBoards(store,plan.boards);
  return reply.type('application/pdf').header('Content-Disposition',`attachment; filename="${plan.filename}"`).send(data);
 });
 app.get('/api/print/options',()=>({family:'tag36h11',paper:'A4',minId:0,maxId:586,grids:[1,2,3,4].map(gridPrintOptions)}));
 app.post('/api/print/plan',req=>batchPlan(req.body));
 app.post('/api/print/export',async(req,reply)=>{const result=await exportBatch(req.body);return reply.type(result.type).header('Content-Disposition',`attachment; filename="${result.filename}"`).send(result.data);});
 app.get('/api/print/all.pdf',async(_req,reply)=>{const result=await exportBatch({source:'range',startId:0,endId:586,sizeMm:80,layout:'packed',format:'pdf'});return reply.type(result.type).header('Content-Disposition',`inline; filename="${result.filename}"`).send(result.data);});
 app.get<{Params:{id:string}}>('/api/print/tag/:id.svg',(req,reply)=>{const id=z.coerce.number().int().min(0).max(586).parse(req.params.id);const q=z.object({sizeMm:z.coerce.number().min(20).max(150).default(80),x:z.coerce.number().finite().min(-10000).max(10000).optional(),y:z.coerce.number().finite().min(-10000).max(10000).optional(),angle:z.coerce.number().finite().min(-10000).max(10000).optional()}).parse(req.query);return reply.type('image/svg+xml').send(tagSvg({id,size:q.sizeMm/1000,x:q.x,y:q.y,angle:q.angle}));});
 app.post('/api/maps/generate',req=>({map:generate(generationSchema.parse(req.body))}));
 app.post('/api/maps/validate',req=>validate(mapSchema.parse(req.body)));
 app.post('/api/maps',req=>{const body=z.object({map:mapSchema,baseVersion:z.number().int().nonnegative()}).parse(req.body);return saveMap(body.map,body.baseVersion);});
 app.post('/api/route/design',req=>{
  const parsed=routeDesignSchema.safeParse(req.body);
  if(!parsed.success)throw new Error('路径参数无效：mapId、正整数 baseVersion、2–501 个有限坐标 points、-180 到 180 度 bodyYawDeg 必须完整填写');
  const body=parsed.data,status=robot.status();
  if(status.running||robot.poll().some(c=>c.type==='start'))throw new Error('请先停止导航并等待启动指令处理完成，再编辑路径');
  return store.db.transaction(()=>{
   const item=store.get(body.mapId);if(!item)throw Object.assign(new Error('地图不存在'),{statusCode:404});
   if(item.version!==body.baseVersion)throw Object.assign(new Error('地图已被其他页面保存，请重新加载最新版本后再修改'),{statusCode:409});
   const compiled=compileDesignedRoute(item.map,body.points,body.bodyYawDeg),saved=saveMap(compiled.map,body.baseVersion);
   const existing=(store.db.prepare('SELECT body FROM tasks ORDER BY updated DESC').all() as {body:string}[]).map(row=>taskSchema.parse(JSON.parse(row.body))).filter(task=>task.mapId===item.map.id);
   const updatedTasks=(existing.length?existing:[taskSchema.parse({id:'task-scan-design-'+randomBytes(12).toString('hex'),name:item.map.name.slice(0,95)+'任务',mapId:item.map.id,mapVersion:saved.version,rowOrder:saved.map.order,forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2})]).map(task=>taskSchema.parse({...task,mapVersion:saved.version,rowOrder:saved.map.order}));
   for(const task of updatedTasks)store.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated=excluded.updated').run(task.id,JSON.stringify(task),new Date().toISOString());
   log('保存自定义正交路径 '+saved.map.id+' v'+saved.version);
   return {...saved,task:updatedTasks[0],updatedTasks,trimmed:compiled.trimmed,lengthM:compiled.lengthM};
  })();
 });
 app.get<{Params:{id:string},Querystring:{version?:string}}>('/api/maps/:id',(req,reply)=>{const version=req.query.version===undefined?undefined:z.coerce.number().int().positive().parse(req.query.version);const item=store.get(req.params.id,version);return item?{...item,acceptance:mapApproval(item)}:reply.code(404).send({error:'地图不存在'});});
 app.get<{Params:{id:string}}>('/api/maps/:id/versions',req=>store.versions(req.params.id));
 app.post('/api/maps/accept',req=>{
  const body=mapMeasurementSchema.parse(req.body);const item=store.get(body.mapId);
  if(!item||item.version!==body.version)throw new Error('请先保存并使用最新地图版本进行验收');const map=structuredClone(item.map);if(map.captureQuality==='draft')throw new Error('临时融合采集地图仅供草稿，完成正式定位验证后需新建扫描');const check=validate(map);if(check.errors.length)throw new Error(check.errors.join('；'));
  if(new Set(body.measurements.map(m=>m.id)).size!==body.measurements.length)throw new Error('测量标记ID重复');
  let maxBaseline=0;for(const a of body.measurements)for(const b of body.measurements)maxBaseline=Math.max(maxBaseline,distance(a,b));if(maxBaseline<1)throw new Error('实测基准点需覆盖至少1m基线');
  const residuals=body.measurements.map(m=>{const tag=map.tags.find(t=>t.id===m.id);if(!tag)throw new Error(`ID ${m.id} 不在地图中`);return distance(m,tag);});if(residuals.some(e=>e>.03))throw new Error('实测坐标与地图偏差超过3cm，请先校准地图');
  map.coordinateStatus='reviewed';const saved=store.save(map,item.version);const evidence={...body,residuals,created:new Date().toISOString()};store.db.prepare('INSERT INTO acceptances VALUES(?,?,?,?)').run(map.id,saved.version,store.digest(map),JSON.stringify(evidence));log('温室地图坐标验收 '+map.id);return {...saved,evidence};
 });
 app.post('/api/maps/confirm',req=>{
  const body=mapConfirmationSchema.parse(req.body);
  return store.db.transaction(()=>{
   const item=store.get(body.mapId);if(!item)throw Object.assign(new Error('地图不存在'),{statusCode:404});
   if(item.version!==body.version)throw Object.assign(new Error('请使用最新地图版本进行用户确认'),{statusCode:409});
   const map=structuredClone(item.map),check=validate(map);if(check.errors.length)throw new Error(check.errors.join('；'));
   // 用户确认只改变坐标接纳状态，保留采集质量和原始历史版本。
   map.coordinateStatus='reviewed';const saved=store.save(map,item.version);
   const evidence=mapConfirmationEvidenceSchema.parse({...body,kind:'user_confirmation',acceptedVersion:saved.version,created:new Date().toISOString()});
   store.db.prepare('INSERT INTO acceptances VALUES(?,?,?,?)').run(map.id,saved.version,store.digest(saved.map),JSON.stringify(evidence));
   const updatedTasks=[];
   if(body.updateTasks){
    for(const row of store.db.prepare('SELECT body FROM tasks').all() as {body:string}[]){
     const task=taskSchema.parse(JSON.parse(row.body));if(task.mapId!==map.id||task.mapVersion!==item.version)continue;
     const updated={...task,mapVersion:saved.version};store.db.prepare('UPDATE tasks SET body=?,updated=? WHERE id=?').run(JSON.stringify(updated),evidence.created,task.id);updatedTasks.push(updated);
    }
   }
   log('用户确认接纳地图 '+map.id+' v'+saved.version+'，确认人 '+body.operator);
   return {...saved,evidence,acceptance:mapApproval(saved),previousVersion:item.version,updatedTasks};
  })();
 });
 app.post('/api/localization/map',req=>{
  const body=z.object({mapId:z.string(),version:z.number().int().positive()}).strict().parse(req.body),item=store.get(body.mapId);
  if(!item||item.version!==body.version||!mapApproval(item).accepted)throw new Error('请使用已确认的最新导航地图');
  const status=robot.status();if(!status.connected||status.running||Math.abs(status.speed)>.001||!status.chassis.connected||typeof status.chassis.feedback?.vx!=='number'||Math.abs(status.chassis.feedback.vx)>.001||robot.poll().some(c=>c.type==='start'))throw new Error('请在小车停止且底盘反馈在线时切换定位地图');
  const path=resolve(root,'maps/office-confirmed.json'),content=JSON.stringify({map:item.map,version:item.version});
  if(!existsSync(path)||readFileSync(path,'utf8')!==content){writeFileSync(path+'.tmp',content);renameSync(path+'.tmp',path);log('切换定位地图 '+item.map.id+' v'+item.version);}
  return {mapId:item.map.id,version:item.version};
 });
 app.get('/api/tasks',()=> (store.db.prepare('SELECT body FROM tasks ORDER BY updated DESC').all() as {body:string}[]).map(t=>JSON.parse(t.body)));
 app.post<{Params:{id:string}}>('/api/tasks/:id/speeds',(req,reply)=>{
  if(robot.status().running)throw new Error('请在停止导航后调整速度');
  const speeds=taskSchema.pick({forwardSpeed:true,reverseSpeed:true,lateralSpeed:true}).strict().parse(req.body);
  const row=store.db.prepare('SELECT body FROM tasks WHERE id=?').get(req.params.id) as {body:string}|undefined;
  if(!row)return reply.code(404).send({error:'导航任务不存在'});
  const task=taskSchema.parse({...JSON.parse(row.body),...speeds});
  store.db.prepare('UPDATE tasks SET body=?,updated=? WHERE id=?').run(JSON.stringify(task),new Date().toISOString(),task.id);
  log('保存导航速度 '+task.id);return task;
 });
 app.post('/api/tasks',req=>{const task=taskSchema.parse(req.body);const item=store.get(task.mapId,task.mapVersion);if(!item||task.rowOrder.some(id=>!item.map.rows.some(r=>r.id===id))||new Set(task.rowOrder).size!==task.rowOrder.length)throw new Error('任务引用地图或行顺序无效');store.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated=excluded.updated').run(task.id,JSON.stringify(task),new Date().toISOString());return task;});
 app.post('/api/navigation/start',req=>{
  const {taskId}=z.object({taskId:z.string()}).parse(req.body);const row=store.db.prepare('SELECT body FROM tasks WHERE id=?').get(taskId) as {body:string}|undefined;if(!row)throw new Error('请先保存导航任务');const task=taskSchema.parse(JSON.parse(row.body));const item=store.get(task.mapId);if(!item||task.mapVersion!==item.version)throw new Error('地图已有修改，请重新验收并更新任务绑定版本');
  const approval=mapApproval(item);
  if(item.map.captureQuality==='draft'&&!(approval.accepted&&(approval.kind==='user_confirmation'||approval.kind==='office_test')))throw Object.assign(new Error('此地图来自草稿采集，需显式用户确认后才能接纳导航地图'),{statusCode:423});
  const reasons=robot.status().conditions.filter(c=>!c.ready).map(c=>c.label);if(!approval.accepted)reasons.push('温室地图实测坐标验收或用户确认');
  if(!task.enabled)reasons.push('任务启用');if(!robot.status().connected)reasons.push('ROS2节点连接');if(reasons.length)throw Object.assign(new Error('尚未满足：'+[...new Set(reasons)].join('、')),{statusCode:423});
  if(!database&&item.map.routeMode==='waypoints'&&(robot.status().localization?.mapId!==item.map.id||robot.status().localization?.mapVersion!==item.version))throw new Error('定位地图正在切换，请等待当前地图定位');const check=validate({...item.map,order:task.rowOrder});if(check.errors.length)throw new Error(check.errors.join('；'));log('请求启动任务 '+taskId);return robot.enqueue('start',{map:item.map,task});
 });
 for(const command of ['pause','resume','stop'])app.post('/api/navigation/'+command,()=>{log('请求'+command);return robot.enqueue(command);});
 app.get('/api/logs',()=>store.db.prepare('SELECT stamp,event FROM runtime_log ORDER BY rowid DESC LIMIT 200').all());
 app.post('/api/survey/resume',req=>{const {sessionId}=z.object({sessionId:z.string()}).parse(req.body);if(surveyId&&surveyId!==sessionId)throw new Error('先停止当前采集记录');const existing=getSurvey(store,sessionId);if(existing.samples[0]?.localEpoch&&existing.samples[0].localEpoch!==robot.status().mapping?.localEpoch)throw new Error('局部定位原点已变化，请新建扫描');store.db.prepare('UPDATE survey_sessions SET state=? WHERE id=?').run('collecting',sessionId);surveyId=sessionId;return getSurvey(store,sessionId);});
 app.get('/api/surveys',()=>listSurveys(store));
 app.delete<{Params:{id:string}}>('/api/surveys/:id',req=>{const result=deleteSurvey(store,req.params.id);log('删除扫描记录 '+result.name+' '+result.id);return result;});
 app.post('/api/survey/start',req=>{const {name}=z.object({name:z.string().min(1).max(100)}).parse(req.body);if(surveyId)throw new Error('已有采集任务，请先停止');const session=createSurvey(store,name,listBoards(store));surveyId=session.id;return session;});
 app.get<{Params:{id:string}}>('/api/surveys/:id',req=>getSurvey(store,req.params.id));
 app.post('/api/survey/stop',async req=>{
  const {sessionId}=z.object({sessionId:z.string().optional()}).parse(req.body??{});
  const targetId=sessionId??surveyId;
  if(!targetId)return null;
  getSurvey(store,targetId);
  if(!database)await new Promise(resolve=>setTimeout(resolve,300));
  store.db.prepare('UPDATE survey_sessions SET state=? WHERE id=?').run('stopped',targetId);
  if(surveyId===targetId)surveyId=null;
  return getSurvey(store,targetId);
 });
 app.post('/api/survey/import',req=>{const body=z.object({sessionId:z.string(),samples:z.array(z.unknown()).min(1).max(500)}).parse(req.body);return appendSamples(store,body.sessionId,body.samples);});
 app.post('/api/robot/motion-records',req=>{
  authorized(req);if(!surveyId)return {stored:0};
  const body=z.object({records:z.array(z.unknown()).max(200)}).parse(req.body);
  return appendMotionRecords(store,surveyId,body.records);
 });
 app.post('/api/robot/observations',req=>{
  authorized(req);if(!surveyId)return {stored:0};
  const body=z.object({samples:z.array(z.unknown()).max(10)}).parse(req.body),status=robot.status();
  const result=appendLiveSamples(store,surveyId,body.samples,status.mapping?.localEpoch||undefined);
  surveyId=result.stopped?null:result.sessionId;
  if(result.stopped)log(result.reason);
  if(result.continuedFrom)log('自动保存扫描段 '+result.continuedFrom+'，继续扫描 '+result.sessionId);
  return result;
 });
 app.post('/api/survey/draft',req=>{
  const body=z.object({sessionId:z.string(),tagSizeMm:z.number().min(20).max(180).default(80)}).parse(req.body),session=getSurvey(store,body.sessionId);
  if(session.state!=='stopped')throw new Error('请先停止扫描，再保存地图草稿');
  const map=pointDraftMap(session,body.tagSizeMm),existing=store.get(map.id);
  const saved=saveMap(map,existing?.version??0);log('保存扫描点位草稿 '+session.id);return saved;
 });
 app.post('/api/survey/optimize',async req=>{const body=z.object({sessionId:z.string(),anchors:z.array(anchorSchema).max(587)}).parse(req.body);const session=getSurvey(store,body.sessionId);if(session.state==='collecting')throw new Error('请先停止扫描再整理记录');const samples=optimizationSamples(session.samples);const result=await optimizeSurvey(root,{samples,anchors:body.anchors});const latest=getSurvey(store,body.sessionId);if(latest.state!=='stopped'||latest.samples.length!==session.samples.length||latest.samples.at(-1)?.stamp!==session.samples.at(-1)?.stamp)throw new Error('整理期间扫描记录发生变化，请重新停止并整理');store.db.prepare('UPDATE survey_sessions SET anchors=?,result=? WHERE id=?').run(JSON.stringify(body.anchors),JSON.stringify(result),body.sessionId);return getSurvey(store,body.sessionId);});
 app.post('/api/workflow/finalize',req=>{
  const body=scanSettings.parse(req.body),session=getSurvey(store,body.sessionId);
  if(session.state!=='stopped')throw new Error('请先停止扫描，再生成地图');
  if(!session.result)throw new Error('没有已整理的扫描记录');
  if(!session.motionValidation.ready)throw new Error('区间模式校验未通过，请重新录制：'+[...session.motionValidation.reasons,...session.motionValidation.segments.flatMap(s=>s.reasons)].filter((v,i,a)=>a.indexOf(v)===i).join('；'));

  const compiled=compileScan(session.result,body,session.boards,session.samples.flatMap(sample=>sample.tags.map((tag:{id:number})=>tag.id)),session.motionRecords.length?{samples:session.samples,optimizedSamples:optimizationSamples(session.samples),records:session.motionRecords}:undefined);compiled.map.captureQuality=session.captureQuality as 'draft'|'verified';const existing=store.get(compiled.map.id);
  if(existing)throw Object.assign(new Error('此扫描已生成地图，请加载原地图进行确认'),{statusCode:409});
  return store.db.transaction(()=>{
   const saved=saveMap(compiled.map,0),task={...compiled.task,mapVersion:saved.version};
   store.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.id,JSON.stringify(task),new Date().toISOString());
   log('扫描生成地图草稿 '+saved.map.id);return {...saved,task};
  })();
 });
 app.post('/api/export',async(req,reply)=>{const {map,format,ids}=z.object({map:mapSchema,format:z.enum(['pdf','svg','layout','csv','json']),ids:z.array(z.number().int()).optional()}).parse(req.body);
  if(('groups' in map)&&Array.isArray(map.groups)&&map.groups.length&&(format==='pdf'||format==='svg'))throw new Error('此地图使用多码定位板，请从生成二维码页面按原规格重印定位板');
  const check=validate(map);if(check.errors.some(e=>e.includes('ID 重复')))throw new Error('ID冲突，不能打印');
  const tags=ids?map.tags.filter(t=>ids.includes(t.id)):map.tags;if(ids&&tags.length!==new Set(ids).size)throw new Error('选中的标记ID不存在');
  if(format==='pdf')return reply.type('application/pdf').header('Content-Disposition','attachment; filename="apriltags.pdf"').send(await printPdf(tags));
  if(format==='svg'){if(!tags.length)throw new Error('没有可导出的标记');if(tags.length===1)return reply.type('image/svg+xml').send(tagSvg(tags[0]!));const files=Object.fromEntries(tags.map(t=>[`Q${String(t.id).padStart(3,'0')}.svg`,strToU8(tagSvg(t))]));files['placement.csv']=strToU8(manifest(map,tags));return reply.type('application/zip').header('Content-Disposition','attachment; filename="apriltags-svg.zip"').send(Buffer.from(zipSync(files)));}
  if(format==='layout')return reply.type('image/svg+xml').send(layoutSvg(map));if(format==='csv')return reply.type('text/csv; charset=utf-8').send(manifest(map,tags));return {map,routes:check.errors.length?[]:paths(map),validation:check};
 });
 const dist=resolve(root,'web/frontend/dist');if(existsSync(dist)){await app.register(staticPlugin,{root:dist});app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({error:'接口不存在'}):reply.sendFile('index.html'));}
 const timer=setInterval(broadcast,500);app.addHook('onClose',async()=>{clearInterval(timer);for(const c of clients)c.close();store.close();});return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const config=JSON.parse(readFileSync(resolve(root,'config/web.json'),'utf8'));const app=await createApp();mkdirSync(resolve(root,'logs'),{recursive:true});const pidFile=resolve(root,'logs/web.pid');app.addHook('onClose',async()=>{if(existsSync(pidFile)&&readFileSync(pidFile,'utf8').trim()===String(process.pid))rmSync(pidFile);});await app.listen({host:config.host,port:config.port});writeFileSync(pidFile,String(process.pid));for(const sig of ['SIGINT','SIGTERM'])process.on(sig,async()=>{await app.close();process.exit(0);});
}
