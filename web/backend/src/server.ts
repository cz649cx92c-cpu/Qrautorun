import {pointDraftMap} from './survey';
import {mapOnlyRequestSchema,createSurveyPointMap} from './map-only';
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
import {routeTaskSchema as taskSchema} from '../../shared/task';
import type {Route} from '../../shared/route';
import {Store,legacyRouteId} from './store';
import {printPdf,tagSvg,manifest,layoutSvg,gridPrintOptions} from './tags';
import {RobotLink} from './robot';
import {surveyTables,createSurvey,getSurvey,listSurveys,deleteSurvey,appendSamples,appendLiveSamples,anchorSchema,optimizeSurvey,optimizationSamples} from './survey';
import {zipSync,strToU8} from 'fflate';
import {batchPlan,exportBatch} from './batch-print';
import {compileScan,scanSettings} from './scan-map';
import {compileDesignedRoute,routeDesignSchema} from './route-design';
import {registerRouteGeometryRoutes} from './route-geometry';
import {segmentExecutionBlockers} from '../../shared/segment-strategy';
import {registerTagReprintRoutes} from './tag-reprint';
import {boardOptions,boardPlan,boardRegistrationPlan,boardSvg,boardPdf,boardTables,listBoards,checkBoardRegistration,registerBoards} from './boards';
import {boardPrintSchema,boardLabel} from '../../shared/boards';
import {CameraPreview} from './camera';
import {CameraCalibration} from './calibration';
import {CalibrationStore,calibrationDatabasePath,imuCalibrationFromSnapshot} from './calibration-store';
import {registerCalibrationRoutes} from './calibration-routes';
import {previewTagPositions,TAG_POSITION_DISCLAIMER} from '../../shared/map-tag-position';
import {previewTagDistance,previewEqualSpacing,TAG_DISTANCE_DISCLAIMER,MIN_TAG_DISTANCE_M} from '../../shared/map-tag-distance';
import {checkTagAliasName,tagAliasNameKey,TAG_ALIAS_DISCLAIMER} from '../../shared/tag-naming';
import {routeTopologySchema,topologyFromSegments,topologyToPoints,validateTopology,topologyStrategyChoices,topologySummary,TOPOLOGY_DISCLAIMER} from '../../shared/route-topology';
import {routeTopologyTables,listRouteTopology,saveRouteTopology,deleteRouteTopology,deleteRouteTopologiesForMap} from './route-topology-store';
import {previewTagUpdates,TAG_UPDATE_DISCLAIMER,type TagUpdateEdit} from '../../shared/map-tag-update';
import {createTag,createTagGrid,createTagLine,removeTags,alignTags,MAX_TAG_ID,MAX_TAG_COUNT,MAX_GRID_POINTS,MIN_TAG_SIZE_M,MAX_TAG_SIZE_M,MIN_CREATION_DISTANCE_M,TAG_ALIGN_MODES,TAG_CREATION_DISCLAIMER} from '../../shared/map-tag-creation';
import {createBlankMap,BLANK_MAP_DISCLAIMER} from '../../shared/map-design';
export const root=fileURLToPath(new URL('../../../',import.meta.url));
const mapConfirmationSchema=z.object({mapId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),version:z.number().int().positive(),confirm:z.literal(true),operator:z.string().trim().max(80).optional().default(''),updateTasks:z.boolean().default(false)}).strict();
const mapConfirmationEvidenceSchema=mapConfirmationSchema.extend({kind:z.literal('user_confirmation'),acceptedVersion:z.number().int().positive(),created:z.string().datetime()}).strict();
const mapMeasurementSchema=z.object({mapId:z.string(),version:z.number().int().positive(),measurements:z.array(anchorSchema).min(3).max(587),operator:z.string().trim().max(80).optional().default('')});
const mapUnifyAnglesSchema=z.object({mapId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),version:z.number().int().positive(),confirm:z.literal(true),operator:z.string().trim().max(80).optional().default(''),updateTasks:z.boolean().default(false)}).strict();
const mapMeasurementEvidenceSchema=mapMeasurementSchema.extend({kind:z.literal('measurement').optional(),residuals:z.array(z.number().finite().min(0).max(.03)).min(3).max(587),created:z.string().datetime()}).strict();
// Operator-entered map point corrections. Only existing IDs are accepted and every
// coordinate must already satisfy the same map schema range used by the scanner.
const tagPositionEditSchema=z.object({id:z.number().int().min(0).max(586),x:z.number().finite().min(-10000).max(10000),y:z.number().finite().min(-10000).max(10000),angle:z.number().finite().min(-3600).max(3600).optional()}).strict();
const tagPositionRequestSchema=z.object({baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false),tags:z.array(tagPositionEditSchema).min(1).max(587)}).strict().superRefine((value,ctx)=>{
  const ids=new Set<number>();
  for(const tag of value.tags){if(ids.has(tag.id))ctx.addIssue({code:z.ZodIssueCode.custom,message:`Q${tag.id} 的位置被重复提交`});ids.add(tag.id);}
});
// Spacing edits are distance-only: the operator names two points (or a straight
// run) and a wanted centre-to-centre pitch, never raw coordinates.
const tagDistanceRequestSchema=z.object({baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false),fromId:z.number().int().min(0).max(586),toId:z.number().int().min(0).max(586),targetM:z.number().finite().min(MIN_TAG_DISTANCE_M).max(100)}).strict();
// 新建空白地图的请求形状。语义校验（名称长度、四点范围、退化面积、车辆包络）
// 一律交给纯函数 createBlankMap，这里只保证"形状与类型"是 strict 的：未知字段
// 直接 400，免得前端把点位数组之类的东西误发进来被静默忽略。
const blankMapZonePointSchema=z.object({x:z.number().finite().min(-10000).max(10000),y:z.number().finite().min(-10000).max(10000)}).strict();
const blankMapRequestSchema=z.object({
 name:z.string(),
 id:z.string().optional(),
 zone:z.array(blankMapZonePointSchema).optional(),
 vehicle:z.object({width:z.number().finite().optional(),length:z.number().finite().optional(),margin:z.number().finite().optional()}).strict().optional(),
 tagSizeMm:z.number().finite().optional(),
 notes:z.string().optional(),
}).strict();
const tagEqualSpacingRequestSchema=z.object({baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false),ids:z.array(z.number().int().min(0).max(586)).min(2).max(587),targetM:z.number().finite().min(MIN_TAG_DISTANCE_M).max(100)}).strict().superRefine((value,ctx)=>{
  const ids=new Set<number>();
  for(const id of value.ids){if(ids.has(id))ctx.addIssue({code:z.ZodIssueCode.custom,message:`Q${id} 被重复提交`});ids.add(id);}
});
function routeMapSnapshot(source:z.infer<typeof mapSchema>,route:Route){
 const path=route.motionSegments.length?[route.motionSegments[0]!.points[0]!,...route.motionSegments.flatMap(segment=>segment.points.slice(1))]:route.points;
 const sourceRow=source.rows[0];
 const row={id:sourceRow?.id??'route-1',name:route.name,width:sourceRow?.width??.6,exitDistance:sourceRow?.exitDistance??.8,start:path[0]!,points:path.slice(1)};
 const snapshot=mapSchema.parse({...source,routeMode:'waypoints',rows:[row],order:[row.id],motionSegments:route.motionSegments,tags:source.tags.map(tag=>({...tag,rowId:row.id}))});
 const validation=validate(snapshot);if(validation.errors.length)throw new Error('路径快照校验失败：'+validation.errors.join('；'));
 return snapshot;
}
// 多张地图共用同一批物理二维码时，定位作用域必须跟着"当前选中的 mapId+mapVersion"走。
// 这里把判定抽成纯函数，导航放行与前端状态展示共用同一套口径，避免只改提示或误放行。
export function localizationScopeBlock(mapId:string,mapVersion:number,localization:{mapId?:string,mapVersion?:number,poseAvailable?:boolean}|null|undefined){
 const loc=localization;
 if(!loc||!loc.mapId)return '等待定位服务上报当前地图';
 if(loc.mapId!==mapId||loc.mapVersion!==mapVersion)return '定位地图正在切换：当前锚定 '+(loc.mapId||'未知')+(loc.mapVersion?' v'+loc.mapVersion:'')+'，请等待所选地图 '+mapId+' v'+mapVersion+' 重新锚定';
 if(loc.poseAvailable!==true)return '定位已切换到当前地图，等待二维码重新锚定';
 return null;
}
export type LocalizationScopePhase='unknown'|'switching'|'waiting-anchor'|'anchored';
export function localizationScopePhase(exists:boolean,mapId:string,mapVersion:number,localization:{mapId?:string,mapVersion?:number,poseAvailable?:boolean}|null|undefined):LocalizationScopePhase{
 if(!exists)return 'unknown';
 const loc=localization;
 if(!loc||loc.mapId!==mapId||loc.mapVersion!==mapVersion)return 'switching';
 return loc.poseAvailable===true?'anchored':'waiting-anchor';
}
export async function createApp(database?:string) {
 const config=JSON.parse(readFileSync(resolve(root,'config/web.json'),'utf8'));mkdirSync(resolve(root,'maps'),{recursive:true});
 const keyFile=resolve(root,config.bridgeKeyFile);if(!existsSync(keyFile))writeFileSync(keyFile,randomBytes(32).toString('hex'),{mode:0o600});const bridgeKey=readFileSync(keyFile,'utf8').trim();
 const app=Fastify({logger:!database,disableRequestLogging:true,bodyLimit:8*1024*1024});const store=new Store(database??resolve(root,config.database));surveyTables(store);boardTables(store);routeTopologyTables(store.db);
 store.db.exec('CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,body TEXT,updated TEXT); CREATE TABLE IF NOT EXISTS acceptances(map_id TEXT,version INTEGER,digest TEXT,body TEXT,PRIMARY KEY(map_id,version)); CREATE TABLE IF NOT EXISTS runtime_log(stamp TEXT,event TEXT);');
 const robot=new RobotLink();const clients=new Set<{send:(data:string)=>void,readyState:number,close:()=>void}>();let surveyId:string|null=((store.db.prepare("SELECT id FROM survey_sessions WHERE state='collecting' ORDER BY created DESC LIMIT 1").get() as {id:string}|undefined)?.id??null);
 const broadcast=()=>{const msg=JSON.stringify({type:'robot',status:robot.status()});for(const c of clients)if(c.readyState===1)c.send(msg);};
 function authorized(req:{headers:Record<string,unknown>}){const key=String(req.headers['x-bridge-key']??'');if(key.length!==bridgeKey.length||!timingSafeEqual(Buffer.from(key),Buffer.from(bridgeKey)))throw Object.assign(new Error('ROS2桥身份认证失败'),{statusCode:401});}
 function log(event:string){store.db.prepare('INSERT INTO runtime_log VALUES(?,?)').run(new Date().toISOString(),event);}
 // 融合标定使用独立 SQLite 文件：绝不写地图数据库，也不受地图事务回滚影响。
 const calibrationStore=new CalibrationStore(calibrationDatabasePath(database,root,config.database),(mapId,version)=>{
  const item=store.get(mapId,version);
  return item?{map:{id:item.map.id,name:item.map.name},version:item.version,digest:store.digest(item.map),tags:item.map.tags.map(tag=>({id:tag.id,x:tag.x,y:tag.y,angle:tag.angle}))}:null;
 },()=>imuCalibrationFromSnapshot(root));
 registerCalibrationRoutes(app,{calibration:calibrationStore,store,robot,root,authorized,log});
 app.addHook('onClose',async()=>{calibrationStore.close();});
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
 // 常规编辑的保存入口：默认"就在当前版本上改"，不生成 vN+1。
 // 只有两种情况才写新版本行：
 //   1) 这张图还没有任何版本（baseVersion 0 首次落库）——那是 v1，不是"多一个版本"；
 //   2) 调用方显式传 newVersion:true——确实想要一份可回滚的历史版本时才用。
 // 版本冲突（baseVersion 过期 409）、mapSchema、validate() 三道门完全沿用
 // store.saveInPlace / store.save 的内部实现，一处都没有放宽。
 function saveMapCurrent(map:z.infer<typeof mapSchema>,baseVersion:number,newVersion=false){
  if(map.routeMode==='waypoints')map.coordinateStatus='reviewed';
  return store.db.transaction(()=>{
   const saved=newVersion||store.get(map.id)===null?store.save(map,baseVersion):store.saveInPlace(map,baseVersion);
   if(map.routeMode==='waypoints'){
    // 原地覆盖时版本号不变，验收行必须跟着改摘要，否则会撞 (map_id,version) 主键。
    const evidence={kind:'office_test',version:saved.version,created:new Date().toISOString()};
    store.db.prepare('INSERT INTO acceptances VALUES(?,?,?,?) ON CONFLICT(map_id,version) DO UPDATE SET digest=excluded.digest,body=excluded.body').run(map.id,saved.version,store.digest(saved.map),JSON.stringify(evidence));
    log('保存办公室测试路线（无需坐标审核） '+map.id+' v'+saved.version);
   }
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
 registerTagReprintRoutes(app,store);
 // 路径几何编辑：严格 schema + 纯函数几何运算，编译仍然走 compileDesignedRoute 的全部安全门。
 registerRouteGeometryRoutes(app,{store,robot,log});
 app.get('/api/boards/options',()=>boardOptions());
 app.get('/api/boards',()=>listBoards(store));
 app.post('/api/boards/plan',req=>boardRegistrationPlan(store,req.body));
 const boardCrosshairQuery=z.object({centerCrosshair:z.enum(['true','false']).default('true').transform(value=>value==='true')});
 app.get('/api/boards/preview.svg',(req,reply)=>{
  // 旧参数 gridSize/groupSizeMm 可单独使用；新参数 rows/cols/widthMm/heightMm 存在时按新参数生效。
  const query=z.object({gridSize:z.coerce.number().int().min(1).max(6).optional(),groupSizeMm:z.coerce.number().finite().min(20).max(500).optional(),startId:z.coerce.number().int().min(0).max(586).default(0),
   rows:z.coerce.number().int().min(1).max(6).optional(),cols:z.coerce.number().int().min(1).max(6).optional(),
   widthMm:z.coerce.number().finite().min(20).max(500).optional(),heightMm:z.coerce.number().finite().min(20).max(500).optional()}).merge(boardCrosshairQuery).parse(req.query);
  const plan=boardPlan({...query,groupCount:1});return reply.type('image/svg+xml').send(boardSvg(plan.boards[0]!,query.centerCrosshair));
 });
 app.get<{Params:{id:string}}>('/api/boards/:id.svg',(req,reply)=>{const options=boardCrosshairQuery.parse(req.query),board=listBoards(store).find(item=>item.id===req.params.id);return board?reply.type('image/svg+xml').send(boardSvg(board,options.centerCrosshair)):reply.code(404).send({error:'定位板不存在'});});
 app.post('/api/boards/pdf',async(req,reply)=>{
  const request=boardPrintSchema.parse(req.body),plan=boardPlan(request);
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
 // ===== 二维码现场别名（按 map 作用域）=====
 // 铁律：别名只影响显示。真实 tag36h11 编号、坐标、朝向、地图摘要与版本都不动，
 // 也不写 versions 表——所以旧路线与旧任务的摘要校验永远不受影响。
 app.get<{Params:{id:string}}>('/api/maps/:id/tag-aliases',req=>{
  const item=store.get(req.params.id);if(!item)throw Object.assign(new Error('地图不存在'),{statusCode:404});
  return {mapId:item.map.id,mapVersion:item.version,aliases:store.listTagAliases(item.map.id),disclaimer:TAG_ALIAS_DISCLAIMER};
 });
 const tagAliasRequestSchema=z.object({
  baseVersion:z.number().int().nonnegative().optional(),
  aliases:z.array(z.object({tagId:z.number().int().min(0).max(586),name:z.string()})).max(587),
 }).strict();
 app.post<{Params:{id:string}}>('/api/maps/:id/tag-aliases',req=>{
  const body=tagAliasRequestSchema.parse(req.body);
  return store.db.transaction(()=>{
   const item=store.get(req.params.id);if(!item)throw Object.assign(new Error('地图不存在'),{statusCode:404});
   const known=new Set(item.map.tags.map(tag=>tag.id));
   const problems:string[]=[];
   const byName=new Map<string,number>();
   const next:{tagId:number;name:string;updated:string}[]=[];
   const now=new Date().toISOString();
   for(const alias of body.aliases){
    if(!known.has(alias.tagId)){problems.push('Q'+String(alias.tagId).padStart(3,'0')+' 不在这张地图中');continue;}
    const check=checkTagAliasName(alias.name);
    if(!check.ok){problems.push('Q'+String(alias.tagId).padStart(3,'0')+'：'+check.message);continue;}
    const key=tagAliasNameKey(check.name);
    const clash=byName.get(key);
    if(clash!==undefined){problems.push('名称「'+check.name+'」被 Q'+String(clash).padStart(3,'0')+' 与 Q'+String(alias.tagId).padStart(3,'0')+' 重复使用');continue;}
    byName.set(key,alias.tagId);
    next.push({tagId:alias.tagId,name:check.name,updated:now});
   }
   if(problems.length)throw Object.assign(new Error(problems.join('；')),{statusCode:400});
   const before=store.listTagAliases(item.map.id);
   const saved=store.saveTagAliases(item.map.id,next);
   const changed=saved.aliases.filter(alias=>{const old=before.find(entry=>entry.tagId===alias.tagId);return !old||old.name!==alias.name;}).length;
   const removed=before.filter(entry=>!saved.aliases.some(alias=>alias.tagId===entry.tagId)).length;
   log('保存地图二维码别名 '+item.map.id+' · '+saved.aliases.length+' 个 · 改 '+changed+' · 删 '+removed);
   return {mapId:item.map.id,mapVersion:item.version,aliases:saved.aliases,changed,removed,disclaimer:TAG_ALIAS_DISCLAIMER};
  })();
 });
 app.delete<{Params:{id:string}}>('/api/maps/:id/tag-aliases',req=>{
  return store.db.transaction(()=>{
   const item=store.get(req.params.id);if(!item)throw Object.assign(new Error('地图不存在'),{statusCode:404});
   const removed=store.deleteTagAliases(item.map.id);
   log('清空地图二维码别名 '+item.map.id+' · '+removed+' 个');
   return {mapId:item.map.id,removed,aliases:[]};
  })();
 });
 // 通用整图保存。默认语义是"就在当前版本上改"（saveMapCurrent → 原地覆盖），
// 因为画布拖入/批量移动/改参/正交校正都属于同一张图的连续编辑，每改一次就多
// 一个 vN 既不符合现场直觉，也会让路径/任务绑定不断失效。
// 想在 vN 之上留一份可回滚历史时才显式传 newVersion:true。
// 冲突门（baseVersion 过期 → 409）、mapSchema、validate()、运行中禁止写入一律照旧。
app.post('/api/maps',req=>{
 const body=z.object({map:mapSchema,baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false)}).parse(req.body);
 return saveMapCurrent(body.map,body.baseVersion,body.newVersion);
});
 // 新建空白地图（手动铺码的起点）。与 POST /api/maps 刻意分成两条路径：那条要求
 // 调用方自带完整 map + baseVersion，语义是"在某个已有版本之上保存改动"；这里
 // 服务端才是唯一决定 id / zone / vehicle 的地方，一张新图的 baseVersion 恒为 0，
 // 绝不与"原地覆盖当前版本"或"在 vN 之上新建 vN+1"的语义混用。
 // 地图合法性与导航可用性都走同一套 mapSchema.parse + validate()（在 createBlankMap 内）；
 // 空点位只是 warning，因此空图可以保存，但 /api/navigation/start 会以 423 拒绝 map-only。
 app.post('/api/maps/new',req=>{
  const body=blankMapRequestSchema.parse(req.body);
  return store.db.transaction(()=>{
   const design=createBlankMap({...(body.id===undefined?{}:{id:body.id}),name:body.name,...(body.zone===undefined?{}:{zone:body.zone}),...(body.vehicle===undefined?{}:{vehicle:body.vehicle}),...(body.tagSizeMm===undefined?{}:{tagSizeMm:body.tagSizeMm}),...(body.notes===undefined?{}:{notes:body.notes})});
   if(!design.ready||!design.map)throw Object.assign(new Error('新建空白地图无效：'+(design.reasons.map(reason=>reason.message).join('；')||'未知原因')),{statusCode:400});
   // 同编号已存在时绝不覆盖：新建空白图必须每次都得到一张新图，否则会静默改动别的地图。
   const existing=store.get(design.map.id);
   if(existing)throw Object.assign(new Error('地图编号 '+design.map.id+' 已存在（当前 v'+existing.version+'），新建空白地图不能覆盖已有地图'),{statusCode:409});
   const saved=store.save(design.map,0);
   log('新建空白地图 '+saved.map.id+' v'+saved.version+' · 范围 '+saved.map.zone.map(point=>'('+point.x+', '+point.y+')').join(' ')+' · 铺码边长 '+design.tagSizeMm+' mm');
   return {map:saved.map,version:saved.version,validation:saved.validation,created:true,id:saved.map.id,tagSizeMm:design.tagSizeMm,reasons:design.reasons,notes:design.notes,disclaimer:BLANK_MAP_DISCLAIMER};
  })();
 });
 // Map QR position adjustment is its own stage, separate from route editing.
 // The request only carries absolute centres/headings for existing points; the
 // server rebuilds the candidate, reapplies mapSchema+validate and saves a new
 // version. Routes, tasks and historical map versions are deliberately untouched.
 app.post<{Params:{id:string}}>('/api/maps/:id/tag-positions',req=>{
  const body=tagPositionRequestSchema.parse(req.body);
  return store.db.transaction(()=>{
   const item=store.get(req.params.id);if(!item)throw Object.assign(new Error('地图不存在'),{statusCode:404});
   if(item.version!==body.baseVersion)throw Object.assign(new Error('地图已有新版本，请重新加载后再调整二维码位置'),{statusCode:409});
   if(item.map.routeMode!=='map-only')throw Object.assign(new Error('二维码位置调整仅适用于尚未创建路径的定位码地图；已包含路径的地图请保留旧版本并新建扫描'),{statusCode:409});
   const preview=previewTagPositions(item.map,body.tags);
   if(!preview.ready||!preview.map)throw Object.assign(new Error('二维码位置无效：'+preview.reasons.map(reason=>reason.message).join('；')),{statusCode:400});
   const saved=body.newVersion?saveMap(preview.map,body.baseVersion):store.saveInPlace(preview.map,body.baseVersion);
   log('调整地图二维码位置 '+item.map.id+' v'+saved.version+' · '+preview.changedIds.length+' 个定位组 · 最大位移 '+(preview.maxDisplacementM*100).toFixed(1)+' cm');
   return {...saved,previousVersion:item.version,changedTags:preview.points.map(({id,before,after,displacementM,rigidMemberCount})=>({id,before,after,displacementM,rigidMemberCount})),maxDisplacementM:preview.maxDisplacementM,maxAngleChangeDeg:preview.maxAngleChangeDeg,disclaimer:TAG_POSITION_DISCLAIMER};
  })();
 });
 // Spacing is its own stage too: the request carries a distance, not coordinates,
 // so the server is the only place that decides where the point lands. Same gates
 // as the position editor: latest version, map-only map, mapSchema+validate, new
 // version. Routes, tasks and every older map version stay untouched.
 const spacingGuard=(id:string,baseVersion:number)=>{
  const item=store.get(id);if(!item)throw Object.assign(new Error('地图不存在'),{statusCode:404});
  if(item.version!==baseVersion)throw Object.assign(new Error('地图已有新版本，请重新加载后再调整二维码间距'),{statusCode:409});
  if(item.map.routeMode!=='map-only')throw Object.assign(new Error('二维码间距调整仅适用于尚未创建路径的定位码地图；已包含路径的地图请保留旧版本并新建扫描'),{statusCode:409});
  return item;
 };
 app.post<{Params:{id:string}}>('/api/maps/:id/tag-distance',req=>{
  const body=tagDistanceRequestSchema.parse(req.body);
  return store.db.transaction(()=>{
   const item=spacingGuard(req.params.id,body.baseVersion);
   const preview=previewTagDistance(item.map,{fromId:body.fromId,toId:body.toId,targetM:body.targetM});
   if(!preview.ready||!preview.map)throw Object.assign(new Error('二维码间距无效：'+preview.reasons.map(reason=>reason.message).join('；')),{statusCode:400});
   const saved=body.newVersion?saveMap(preview.map,body.baseVersion):store.saveInPlace(preview.map,body.baseVersion);
   log('调整地图二维码间距 '+item.map.id+' v'+saved.version+' · '+preview.points.map(point=>point.label+' '+(point.offsetBeforeM*100).toFixed(1)+'→'+(point.offsetAfterM*100).toFixed(1)+' cm').join('、')+' · 最大位移 '+(preview.maxDisplacementM*100).toFixed(1)+' cm');
   return {...saved,previousVersion:item.version,
    changedTags:preview.points.map(({id,label,before,after,displacementM,rigidMemberCount})=>({id,label,before,after,displacementM,rigidMemberCount})),
    neighbors:preview.line?preview.line.memberIds:[],
    axis:preview.axis,
    beforeM:preview.beforeM,afterM:preview.afterM,
    beforeDistance:preview.before,afterDistance:preview.after,
    targetM:preview.targetM,deltaM:preview.deltaM,
    maxDisplacementM:preview.maxDisplacementM,
    notes:preview.notes,
    disclaimer:TAG_DISTANCE_DISCLAIMER};
  })();
 });
 app.post<{Params:{id:string}}>('/api/maps/:id/tag-equal-spacing',req=>{
  const body=tagEqualSpacingRequestSchema.parse(req.body);
  return store.db.transaction(()=>{
   const item=spacingGuard(req.params.id,body.baseVersion);
   const preview=previewEqualSpacing(item.map,{ids:body.ids,targetM:body.targetM});
   if(!preview.ready||!preview.map)throw Object.assign(new Error('二维码等间距无效：'+preview.reasons.map(reason=>reason.message).join('；')),{statusCode:400});
   const saved=body.newVersion?saveMap(preview.map,body.baseVersion):store.saveInPlace(preview.map,body.baseVersion);
   log('批量重排地图二维码间距 '+item.map.id+' v'+saved.version+' · '+preview.changedIds.length+' 个点位等距 '+(body.targetM*100).toFixed(1)+' cm · 最大位移 '+(preview.maxDisplacementM*100).toFixed(1)+' cm');
   return {...saved,previousVersion:item.version,
    changedTags:preview.points.map(({id,label,before,after,displacementM,beforeGapM,afterGapM,rigidMemberCount})=>({id,label,before,after,displacementM,beforeGapM,afterGapM,rigidMemberCount})),
    order:preview.ids,
    axis:preview.axis,
    targetM:preview.targetM,
    count:preview.count,
    spanBeforeM:preview.spanBeforeM,spanAfterM:preview.spanAfterM,
    maxDisplacementM:preview.maxDisplacementM,
    maxLateralM:preview.maxLateralM,
    notes:preview.notes,
    disclaimer:TAG_DISTANCE_DISCLAIMER};
  })();
 });
// 建图阶段直接新建二维码：单点 / 矩形阵列 / 直线铺码 / 删除 / 对齐。
// 与位置、间距两个阶段同一套门限：必须是最新版本、必须是定位码地图、
// 候选地图重新过 mapSchema+validate（纯函数引擎里做），ready 为 false 一律 400。
// 默认原地覆盖当前版本（现场铺码会连续加很多点，不必每次都多一个版本）；
// newVersion:true 时才升号，历史版本、路线与任务绑定保持不变。
const tagCreateRequestSchema=z.object({baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false),x:z.number().finite().min(-10000).max(10000),y:z.number().finite().min(-10000).max(10000),sizeM:z.number().finite().min(MIN_TAG_SIZE_M).max(MAX_TAG_SIZE_M).optional(),angleDeg:z.number().finite().min(-3600).max(3600).optional(),groupId:z.string().regex(/^B\d{3}$/).optional()}).strict();
const tagGridRequestSchema=z.object({baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false),originX:z.number().finite().min(-10000).max(10000),originY:z.number().finite().min(-10000).max(10000),columns:z.number().int().min(1).max(MAX_GRID_POINTS),rows:z.number().int().min(1).max(MAX_GRID_POINTS),spacingXM:z.number().finite().min(MIN_CREATION_DISTANCE_M).max(100),spacingYM:z.number().finite().min(MIN_CREATION_DISTANCE_M).max(100),angleDeg:z.number().finite().min(-3600).max(3600).optional(),sizeM:z.number().finite().min(MIN_TAG_SIZE_M).max(MAX_TAG_SIZE_M).optional(),onConflict:z.enum(['reject','skip']).default('reject')}).strict().superRefine((value,ctx)=>{
 if(value.columns*value.rows>MAX_GRID_POINTS)ctx.addIssue({code:z.ZodIssueCode.custom,message:`阵列最多 ${MAX_GRID_POINTS} 个点位`,path:['columns']});
});
const tagLineRequestSchema=z.object({baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false),fromTagId:z.number().int().min(0).max(MAX_TAG_ID).optional(),startX:z.number().finite().min(-10000).max(10000).optional(),startY:z.number().finite().min(-10000).max(10000).optional(),count:z.number().int().min(1).max(MAX_TAG_COUNT),spacingM:z.number().finite().min(MIN_CREATION_DISTANCE_M).max(100),axis:z.enum(['horizontal','vertical']),direction:z.union([z.literal(1),z.literal(-1)]).default(1),angleDeg:z.number().finite().min(-3600).max(3600).optional(),sizeM:z.number().finite().min(MIN_TAG_SIZE_M).max(MAX_TAG_SIZE_M).optional()}).strict().superRefine((value,ctx)=>{
 if(value.fromTagId===undefined&&(value.startX===undefined||value.startY===undefined))ctx.addIssue({code:z.ZodIssueCode.custom,message:'铺码必须提供 fromTagId 或 startX/startY',path:['fromTagId']});
});
const tagDeleteRequestSchema=z.object({baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false),ids:z.array(z.number().int().min(0).max(MAX_TAG_ID)).max(MAX_TAG_COUNT),orphanGroups:z.enum(['reject','prune']).default('reject')}).strict();
const tagAlignRequestSchema=z.object({baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false),ids:z.array(z.number().int().min(0).max(MAX_TAG_ID)).min(2).max(MAX_TAG_COUNT),mode:z.enum(TAG_ALIGN_MODES)}).strict().superRefine((value,ctx)=>{
 const ids=new Set<number>();
 for(const id of value.ids){if(ids.has(id))ctx.addIssue({code:z.ZodIssueCode.custom,message:`Q${id} 被重复提交`});ids.add(id);}
});
const creationGuard=(id:string,baseVersion:number)=>{
 const mapItem=store.get(id);if(!mapItem)throw Object.assign(new Error('地图不存在'),{statusCode:404});
 if(mapItem.version!==baseVersion)throw Object.assign(new Error('地图已有新版本，请重新加载后再新建二维码'),{statusCode:409});
 if(mapItem.map.routeMode!=='map-only')throw Object.assign(new Error('二维码新建仅适用于尚未创建路径的定位码地图；已包含路径的地图请保留旧版本并新建扫描'),{statusCode:409});
 return mapItem;
};
const creationSaved=(candidate:z.infer<typeof mapSchema>,baseVersion:number,newVersion:boolean)=>newVersion?saveMap(candidate,baseVersion):store.saveInPlace(candidate,baseVersion);
// POST /api/maps/:id/tags/create — 单点新建
app.post<{Params:{id:string}}>('/api/maps/:id/tags/create',req=>{
 const body=tagCreateRequestSchema.parse(req.body);
 return store.db.transaction(()=>{
  const item=creationGuard(req.params.id,body.baseVersion);
  const preview=createTag(item.map,{x:body.x,y:body.y,...(body.sizeM===undefined?{}:{sizeM:body.sizeM}),...(body.angleDeg===undefined?{}:{angleDeg:body.angleDeg}),...(body.groupId===undefined?{}:{groupId:body.groupId})});
  if(!preview.ready||!preview.map)throw Object.assign(new Error('新建二维码无效：'+preview.reasons.map(reason=>reason.message).join('；')),{statusCode:400});
  const saved=creationSaved(preview.map,body.baseVersion,body.newVersion);
  log('新建地图二维码 '+item.map.id+' v'+saved.version+' · '+preview.tag!.id+' @('+preview.tag!.x+', '+preview.tag!.y+')');
  return {...saved,previousVersion:item.version,created:1,deleted:0,changed:1,tags:[preview.tag],reasons:preview.reasons,notes:preview.notes,disclaimer:TAG_CREATION_DISCLAIMER};
 })();
});
// POST /api/maps/:id/tags/grid — 矩形阵列
app.post<{Params:{id:string}}>('/api/maps/:id/tags/grid',req=>{
 const body=tagGridRequestSchema.parse(req.body);
 return store.db.transaction(()=>{
  const item=creationGuard(req.params.id,body.baseVersion);
  const preview=createTagGrid(item.map,{originX:body.originX,originY:body.originY,columns:body.columns,rows:body.rows,spacingXM:body.spacingXM,spacingYM:body.spacingYM,onConflict:body.onConflict,...(body.angleDeg===undefined?{}:{angleDeg:body.angleDeg}),...(body.sizeM===undefined?{}:{sizeM:body.sizeM})});
  if(!preview.ready||!preview.map)throw Object.assign(new Error('新建二维码阵列无效：'+preview.reasons.map(reason=>reason.message).join('；')),{statusCode:400});
  const saved=creationSaved(preview.map,body.baseVersion,body.newVersion);
  log('新建地图二维码阵列 '+item.map.id+' v'+saved.version+' · '+body.columns+'×'+body.rows+' 生成 '+preview.created+' 个');
  return {...saved,previousVersion:item.version,created:preview.created,deleted:0,changed:preview.created,tags:preview.tags,spanXM:preview.spanXM,spanYM:preview.spanYM,skipped:preview.skipped,reasons:preview.reasons,notes:preview.notes,disclaimer:TAG_CREATION_DISCLAIMER};
 })();
});
// POST /api/maps/:id/tags/line — 直线铺码
app.post<{Params:{id:string}}>('/api/maps/:id/tags/line',req=>{
 const body=tagLineRequestSchema.parse(req.body);
 return store.db.transaction(()=>{
  const item=creationGuard(req.params.id,body.baseVersion);
  const preview=createTagLine(item.map,{...(body.fromTagId===undefined?{}:{fromTagId:body.fromTagId}),...(body.startX===undefined?{}:{startX:body.startX}),...(body.startY===undefined?{}:{startY:body.startY}),count:body.count,spacingM:body.spacingM,axis:body.axis,direction:body.direction,...(body.angleDeg===undefined?{}:{angleDeg:body.angleDeg}),...(body.sizeM===undefined?{}:{sizeM:body.sizeM})});
  if(!preview.ready||!preview.map)throw Object.assign(new Error('直线铺码无效：'+preview.reasons.map(reason=>reason.message).join('；')),{statusCode:400});
  const saved=creationSaved(preview.map,body.baseVersion,body.newVersion);
  log('直线铺码 '+item.map.id+' v'+saved.version+' · '+body.axis+' 间距 '+(body.spacingM*100).toFixed(1)+' cm 新建 '+preview.created+' 个');
  return {...saved,previousVersion:item.version,created:preview.created,deleted:0,changed:preview.created,tags:preview.tags,axis:preview.axis,direction:preview.direction,spacingM:preview.spacingM,spanM:preview.spanM,points:preview.points,reasons:preview.reasons,notes:preview.notes,disclaimer:TAG_CREATION_DISCLAIMER};
 })();
});
// DELETE /api/maps/:id/tags — 画错回退
app.delete<{Params:{id:string}}>('/api/maps/:id/tags',req=>{
 const body=tagDeleteRequestSchema.parse(req.body);
 return store.db.transaction(()=>{
  const item=creationGuard(req.params.id,body.baseVersion);
  const preview=removeTags(item.map,body.ids,{orphanGroups:body.orphanGroups});
  if(!preview.ready||!preview.map)throw Object.assign(new Error('删除二维码无效：'+preview.reasons.map(reason=>reason.message).join('；')),{statusCode:400});
  const saved=creationSaved(preview.map,body.baseVersion,body.newVersion);
  log('删除地图二维码 '+item.map.id+' v'+saved.version+' · '+preview.removed+' 个'+(preview.prunedGroups.length?' · 移除定位组 '+preview.prunedGroups.join('、'):''));
  return {...saved,previousVersion:item.version,created:0,deleted:preview.removed,changed:preview.removed,ids:preview.ids,tags:preview.tags,prunedGroups:preview.prunedGroups,reasons:preview.reasons,notes:preview.notes,disclaimer:TAG_CREATION_DISCLAIMER};
 })();
});
// POST /api/maps/:id/groups/:groupId/spec — 改组规格（行×列 / 整组宽高 / 起始编号）
// 用与 generateBoards 相同的几何重建 members，并同步组中心点的 size，
// 再走 mapSchema + validate + 保存；版本冲突与运行中禁止写入照旧。
// 默认原地覆盖当前版本（改规格是同一张图的连续编辑，不该每次多一个 vN）；
// 只有显式传 newVersion:true 时才在 vN 之上新建 vN+1。
// 新形状 {rows,cols,widthMm,heightMm} 与旧形状 {gridSize,sizeMm} 都接受，
// 两者同时出现时以新字段为准；旧形状等价于 rows=cols=gridSize、width=height=sizeMm。
const groupSpecSchema=z.object({
 baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false),
 gridSize:z.number().int().min(1).max(6).optional(),sizeMm:z.number().finite().min(20).max(500).optional(),
 rows:z.number().int().min(1).max(6).optional(),cols:z.number().int().min(1).max(6).optional(),
 widthMm:z.number().finite().min(20).max(500).optional(),heightMm:z.number().finite().min(20).max(500).optional(),
 startId:z.number().int().min(0).max(586).optional(),
}).strict().superRefine((value,ctx)=>{
 if((value.rows??value.gridSize)===undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'缺少行数（rows 或旧字段 gridSize）',path:['rows']});
 if((value.cols??value.gridSize)===undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'缺少列数（cols 或旧字段 gridSize）',path:['cols']});
 if((value.widthMm??value.sizeMm)===undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'缺少整组宽（widthMm 或旧字段 sizeMm）',path:['widthMm']});
 if((value.heightMm??value.sizeMm)===undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'缺少整组高（heightMm 或旧字段 sizeMm）',path:['heightMm']});
});
app.post<{Params:{id:string;groupId:string}}>('/api/maps/:id/groups/:groupId/spec',req=>{
 const body=groupSpecSchema.parse(req.body);
 return store.db.transaction(()=>{
  const item=creationGuard(req.params.id,body.baseVersion);
  if(robot.status().running)throw Object.assign(new Error('车辆正在执行导航任务，请先停止导航再改组规格'),{statusCode:409});
  const groups=item.map.groups??[];
  const group=groups.find(g=>g.id===req.params.groupId);
  if(!group)throw Object.assign(new Error(`地图 ${item.map.id} 里没有定位组 ${req.params.groupId}`),{statusCode:404});
  const rows=(body.rows??body.gridSize)!,cols=(body.cols??body.gridSize)!;
  const widthMm=(body.widthMm??body.sizeMm)!,heightMm=(body.heightMm??body.sizeMm)!;
  const tileW=(widthMm-(cols-1)*2)/cols,tileH=(heightMm-(rows-1)*2)/rows;
  const referenceId=body.startId??group.referenceId;
  const members=Array.from({length:rows*cols},(_,index)=>{const column=index%cols,row=Math.floor(index/cols);return {id:referenceId+index,
   x:(-widthMm/2+tileW/2+column*(tileW+2))/1000,
   y:(heightMm/2-tileH/2-row*(tileH+2))/1000,
   angle:0,size:Math.min(tileW,tileH)/1.25/1000};});
  const gridSize=Math.max(rows,cols),groupSizeMm=Math.max(widthMm,heightMm);
  const nextGroup={...group,id:boardLabel(referenceId),referenceId,gridSize,sizeMm:groupSizeMm,gapMm:2 as const,rows,cols,widthMm,heightMm,members};
  const nextGroups=groups.map(g=>g.id===group.id?nextGroup:g);
  const centerId=group.referenceId;
  const nextTags=item.map.tags.map(t=>t.id===centerId?{...t,groupId:nextGroup.id,size:groupSizeMm/1000}:t);
  const candidate={...item.map,groups:nextGroups,tags:nextTags};
  const parsed=mapSchema.safeParse(candidate);
  if(!parsed.success)throw Object.assign(new Error('改组规格无效：'+parsed.error.issues.map(i=>`${i.path.join('.')}：${i.message}`).join('；')),{statusCode:400});
  const check=validate(parsed.data);
  if(check.errors.length)throw Object.assign(new Error('改组规格未通过校验：'+check.errors.join('；')),{statusCode:400});
  const saved=body.newVersion?saveMap(parsed.data,body.baseVersion):store.saveInPlace(parsed.data,body.baseVersion);
  log('改组规格 '+item.map.id+' '+nextGroup.id+' · '+rows+'×'+cols+' · '+widthMm+'×'+heightMm+'mm · v'+saved.version);
  return {...saved,previousVersion:item.version,group:nextGroup,centerId};
 })();
});
// POST /api/maps/:id/groups/spec-batch — 批量改组规格
// 现场最常见的诉求：现在全是 2×2 的定位组，要一次改成 3×3 / 4×4。
// groupIds 缺省时作用于这张图的全部定位组；几何与单组改组规格完全一致
// （members 按 referenceId 连续重建、组中心 size 同步），整批只保存一次。
const groupSpecBatchSchema=z.object({
 baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false),
 groupIds:z.array(z.string().min(1).max(16)).max(100).optional(),
 rows:z.number().int().min(1).max(6),cols:z.number().int().min(1).max(6),
 widthMm:z.number().finite().min(20).max(500).optional(),
 heightMm:z.number().finite().min(20).max(500).optional(),
}).strict();
app.post<{Params:{id:string}}>('/api/maps/:id/groups/spec-batch',req=>{
 const body=groupSpecBatchSchema.parse(req.body);
 return store.db.transaction(()=>{
  const item=creationGuard(req.params.id,body.baseVersion);
  if(robot.status().running)throw Object.assign(new Error('车辆正在执行导航任务，请先停止导航再改组规格'),{statusCode:409});
  const groups=item.map.groups??[];
  if(!groups.length)throw Object.assign(new Error('这张地图没有定位组：先铺码/串码生成定位组后再批量改组规格'),{statusCode:400});
  const wanted=body.groupIds?.length?new Set(body.groupIds):null;
  const targets=wanted?groups.filter(g=>wanted.has(g.id)):groups;
  if(!targets.length)throw Object.assign(new Error('没有找到要改的定位组'),{statusCode:404});
  const rows=body.rows,cols=body.cols;
  const rebuilt=new Map<string,any>();
  for(const group of targets){
   const widthMm=body.widthMm??group.widthMm??group.sizeMm;
   const heightMm=body.heightMm??group.heightMm??group.sizeMm;
   const tileW=(widthMm-(cols-1)*2)/cols,tileH=(heightMm-(rows-1)*2)/rows;
   const referenceId=group.referenceId;
   const members=Array.from({length:rows*cols},(_,index)=>{const column=index%cols,row=Math.floor(index/cols);return {id:referenceId+index,
    x:(-widthMm/2+tileW/2+column*(tileW+2))/1000,
    y:(heightMm/2-tileH/2-row*(tileH+2))/1000,
    angle:0,size:Math.min(tileW,tileH)/1.25/1000};});
   const gridSize=Math.max(rows,cols),groupSizeMm=Math.max(widthMm,heightMm);
   rebuilt.set(group.id,{...group,gridSize,sizeMm:groupSizeMm,gapMm:2 as const,rows,cols,widthMm,heightMm,members});
  }
  const nextGroups=groups.map(g=>rebuilt.get(g.id)??g);
  const nextTags=item.map.tags.map(t=>{
   const next=t.groupId?rebuilt.get(t.groupId):undefined;
   return next?{...t,size:next.sizeMm/1000}:t;
  });
  const candidate={...item.map,groups:nextGroups,tags:nextTags};
  const parsed=mapSchema.safeParse(candidate);
  if(!parsed.success)throw Object.assign(new Error('批量改组规格无效：'+parsed.error.issues.map(i=>`${i.path.join('.')}：${i.message}`).join('；')),{statusCode:400});
  const check=validate(parsed.data);
  if(check.errors.length)throw Object.assign(new Error('批量改组规格未通过校验：'+check.errors.join('；')),{statusCode:400});
  const saved=body.newVersion?saveMap(parsed.data,body.baseVersion):store.saveInPlace(parsed.data,body.baseVersion);
  log('批量改组规格 '+item.map.id+' · '+targets.length+' 组 · '+rows+'×'+cols+' · v'+saved.version);
  return {...saved,previousVersion:item.version,changed:targets.length,
   groups:targets.map(g=>rebuilt.get(g.id))};
 })();
});
// POST /api/maps/:id/tags/update — 统一改编号/坐标/朝向/尺寸
const tagUpdateEditSchema=z.object({id:z.number().int().min(0).max(586),nextId:z.number().int().min(0).max(586).optional(),x:z.number().finite().min(-10000).max(10000).optional(),y:z.number().finite().min(-10000).max(10000).optional(),angle:z.number().finite().min(-3600).max(3600).optional(),size:z.number().finite().min(0.02).max(0.18).optional()}).strict();
const tagUpdateRequestSchema=z.object({baseVersion:z.number().int().nonnegative(),newVersion:z.boolean().default(false),edits:z.array(tagUpdateEditSchema).min(1).max(587)}).strict().superRefine((value,ctx)=>{
 const ids=new Set<number>();
 for(const edit of value.edits){if(ids.has(edit.id))ctx.addIssue({code:z.ZodIssueCode.custom,message:`Q${edit.id} 被重复提交`});ids.add(edit.id);}
});
app.post<{Params:{id:string}}>('/api/maps/:id/tags/update',req=>{
 const body=tagUpdateRequestSchema.parse(req.body);
 return store.db.transaction(()=>{
  const item=creationGuard(req.params.id,body.baseVersion);
  const preview=previewTagUpdates(item.map,body.edits as TagUpdateEdit[]);
  if(!preview.ready||!preview.map)throw Object.assign(new Error('点位修改无效：'+preview.reasons.map(reason=>reason.message).join('；')),{statusCode:400});
  const saved=body.newVersion?saveMap(preview.map,body.baseVersion):store.saveInPlace(preview.map,body.baseVersion);
  log('修改地图二维码点位 '+item.map.id+' v'+saved.version+' · '+preview.changedIds.length+' 点 · 改号 '+preview.renumbered.length+' 个');
  return {...saved,previousVersion:item.version,points:preview.points,changedIds:preview.changedIds,renumbered:preview.renumbered,maxDisplacementM:preview.maxDisplacementM,maxAngleChangeDeg:preview.maxAngleChangeDeg,notes:preview.notes,disclaimer:TAG_UPDATE_DISCLAIMER};
 })();
});
// POST /api/maps/:id/tags/align — 对齐 / 等间距
app.post<{Params:{id:string}}>('/api/maps/:id/tags/align',req=>{
 const body=tagAlignRequestSchema.parse(req.body);
 return store.db.transaction(()=>{
  const item=creationGuard(req.params.id,body.baseVersion);
  const preview=alignTags(item.map,body.ids,body.mode);
  if(!preview.ready||!preview.map)throw Object.assign(new Error('二维码对齐无效：'+preview.reasons.map(reason=>reason.message).join('；')),{statusCode:400});
  const saved=creationSaved(preview.map,body.baseVersion,body.newVersion);
  log('对齐地图二维码 '+item.map.id+' v'+saved.version+' · '+body.mode+' · '+preview.changedIds.length+' 个点位 · 最大位移 '+(preview.maxDisplacementM*100).toFixed(1)+' cm');
  return {...saved,previousVersion:item.version,created:0,deleted:0,changed:preview.changedIds.length,order:preview.order,changedIds:preview.changedIds,changedTags:preview.points.map(({id,label,before,after,displacementM})=>({id,label,before,after,displacementM})),mode:preview.mode,axis:preview.axis,fixedIds:preview.fixedIds,maxDisplacementM:preview.maxDisplacementM,tags:preview.points.map(point=>({id:point.id,x:point.after.x,y:point.after.y})),reasons:preview.reasons,notes:preview.notes,disclaimer:TAG_CREATION_DISCLAIMER};
 })();
});
 // Read-only cascade preview for the delete dialog: what else disappears with this map.
 app.get<{Params:{id:string}}>('/api/maps/:id/deletion',(req,reply)=>{
  const info=store.mapDeletionInfo(req.params.id);if(!info)return reply.code(404).send({error:'地图不存在'});
  const running=robot.status().running;
  return {...info,blocked:running,blockedReason:running?'车辆正在执行导航任务，请先停止导航再删除地图':null};
 });
 app.delete<{Params:{id:string}}>('/api/maps/:id',req=>{
  if(robot.status().running)throw Object.assign(new Error('车辆正在执行导航任务，请先停止导航再删除地图'),{statusCode:409});
  if(robot.poll().some(command=>command.type==='start'))throw Object.assign(new Error('导航启动指令正在处理，请稍后再删除地图'),{statusCode:409});
  const result=store.deleteMap(req.params.id);
  deleteRouteTopologiesForMap(store.db,req.params.id);
  log(`删除地图 ${result.name} ${result.mapId} · 版本${result.deletedVersions} · 路径${result.deletedRoutes} · 任务${result.deletedTasks}`);
  return result;
 });
 app.get('/api/routes',(req)=>{const query=req.query as {mapId?:string};return store.listRoutes(query.mapId);});
 app.get<{Params:{id:string}}>('/api/routes/:id',(req,reply)=>{const route=store.getRoute(req.params.id);if(!route)return reply.code(404).send({error:'路径不存在'});const item=store.get(route.mapId,route.mapVersion);if(!item||route.mapDigest!==store.digest(item.map))return reply.code(409).send({error:'路径引用的地图版本或摘要已变化，请重新选择路径'});return {...route,route,map:routeMapSnapshot(item.map,route),version:item.version,acceptance:mapApproval(item)};});
 app.get<{Params:{id:string}}>('/api/routes/:id/usage',req=>store.routeUsage(req.params.id));
 app.delete<{Params:{id:string},Querystring:{detachTasks?:string}}>('/api/routes/:id',req=>{
  if(robot.status().running)throw Object.assign(new Error('车辆正在执行导航任务，请先停止导航再删除路径'),{statusCode:409});
  const result=store.deleteRoute(req.params.id,req.query.detachTasks==='1');
  log(`删除路径 ${result.name} ${result.routeId}`+(result.deletedTasks?` · 同时移除 ${result.deletedTasks} 个任务绑定`:''));
  return result;
 });
 // ===== 稳定 tagId 的有向路线拓扑 =====
 // 顶点是真实 tagId，边是「第几次经过」；几何只是渲染结果。
 // savePoints 时折线交给现有 compileDesignedRoute，安全门完全复用。
 const topologyGuard=(id:string,baseVersion?:number)=>{
  const route=store.getRoute(id);if(!route)throw Object.assign(new Error('路径不存在'),{statusCode:404});
  const item=store.get(route.mapId,route.mapVersion);if(!item)throw Object.assign(new Error('路径引用的地图版本不存在'),{statusCode:409});
  if(baseVersion!==undefined&&route.mapVersion!==baseVersion)throw Object.assign(new Error('路径引用的地图版本已变化（当前 v'+route.mapVersion+'），请重新加载后再改拓扑'),{statusCode:409});
  return {route,item};
 };
 const topologyTagCenters=(map:z.infer<typeof mapSchema>)=>map.tags.map(tag=>({id:tag.id,x:tag.x,y:tag.y}));
 app.get<{Params:{id:string}}>('/api/routes/:id/topology',req=>{
  const {route,item}=topologyGuard(req.params.id);
  const stored=listRouteTopology(store.db,route.routeId);
  const centers=topologyTagCenters(item.map);
  // 没有存过拓扑时从 motionSegments 还原，而不是 404：旧路径也有拓扑。
  const restored=stored?null:topologyFromSegments(route.motionSegments);
  const parsedStored=stored?routeTopologySchema.safeParse(stored.topology):null;
  const topology=parsedStored?.success?parsedStored.data:restored!.topology;
  const report=validateTopology(topology,centers);
  return {routeId:route.routeId,mapId:route.mapId,mapVersion:route.mapVersion,
   stored:!!stored,topology,summary:topologySummary(topology,centers),
   issues:[...(restored?restored.issues:[]),...report.errors,...report.warnings],
   strategyChoices:topologyStrategyChoices(topology),
   disclaimer:TOPOLOGY_DISCLAIMER};
 });
 app.put<{Params:{id:string}}>('/api/routes/:id/topology',req=>{
  const body=z.object({baseVersion:z.number().int().nonnegative(),topology:routeTopologySchema,savePoints:z.boolean().default(false)}).strict().parse(req.body);
  return store.db.transaction(()=>{
   const {route,item}=topologyGuard(req.params.id,body.baseVersion);
   const centers=topologyTagCenters(item.map);
   const report=validateTopology(body.topology,centers);
   if(report.errors.length)throw Object.assign(new Error('路线拓扑无效：'+report.errors.map(issue=>issue.message).join('；')),{statusCode:400});
   const now=new Date().toISOString();
   const saved=saveRouteTopology(store.db,{routeId:route.routeId,mapId:route.mapId,mapVersion:route.mapVersion,topology:body.topology,updated:now});
   let writtenRoute=route;
   if(body.savePoints){
    // 复用现有编译安全门：正交/最短段/最长段/点数/区间数/端点捕获全在这里。
    const flat=topologyToPoints(body.topology,centers);
    if(flat.issues.length)throw Object.assign(new Error('拓扑无法展平：'+flat.issues.map(issue=>issue.message).join('；')),{statusCode:400});
    const choices=topologyStrategyChoices(body.topology);
    const compiled=compileDesignedRoute(item.map,flat.points,route.bodyYawDeg,choices.choices,route.spacingOverrides);
    writtenRoute=store.saveRoute({...route,points:flat.points,motionSegments:compiled.map.motionSegments!,mapVersion:route.mapVersion,mapDigest:route.mapDigest,created:route.created,updated:now},route.updated);
   }
   log('保存路线拓扑 '+route.routeId+' · '+body.topology.edges.length+' 段'+(body.savePoints?' · 已重写折线':''));
   return {routeId:route.routeId,mapId:route.mapId,mapVersion:route.mapVersion,stored:true,topology:saved.topology,
    summary:topologySummary(body.topology,centers),issues:[...report.errors,...report.warnings],
    strategyChoices:topologyStrategyChoices(body.topology),
    route:writtenRoute,points:writtenRoute.points,segments:writtenRoute.motionSegments,
    disclaimer:TOPOLOGY_DISCLAIMER};
  })();
 });
 app.delete<{Params:{id:string}}>('/api/routes/:id/topology',req=>{
  const route=store.getRoute(req.params.id);if(!route)throw Object.assign(new Error('路径不存在'),{statusCode:404});
  const removed=deleteRouteTopology(store.db,route.routeId);
  log('删除路线拓扑 '+route.routeId+' · '+removed+' 条');
  return {routeId:route.routeId,removed};
 });
 app.post('/api/route/design',req=>{
  const parsed=routeDesignSchema.safeParse(req.body);if(!parsed.success)throw new Error('路径参数无效：mapId、正整数 baseVersion、2–501 个有限坐标 points、-180 到 180 度 bodyYawDeg 必须完整填写');
  const body=parsed.data,status=robot.status();if(status.running||robot.poll().some(c=>c.type==='start'))throw new Error('请先停止导航并等待启动指令处理完成，再编辑路径');
  return store.db.transaction(()=>{
   const latest=store.get(body.mapId),item=store.get(body.mapId,body.baseVersion);if(!latest)throw Object.assign(new Error('地图不存在'),{statusCode:404});if(!item)throw Object.assign(new Error('地图版本不存在或已被其他页面保存，请重新加载最新版本后再修改'),{statusCode:409});if(latest.version!==body.baseVersion)throw Object.assign(new Error('地图已有新版本，请重新加载后再编辑路径'),{statusCode:409});
   const compiled=compileDesignedRoute(item.map,body.points,body.bodyYawDeg,body.segmentModes,body.spacingOverrides);
   if(body.routeId||body.routeName||body.saveAs||item.map.routeMode==='map-only'){
    const routeId=body.saveAs||!body.routeId?'route-'+randomBytes(12).toString('hex'):body.routeId;const now=new Date().toISOString();
    const route=store.saveRoute({routeId,mapId:body.mapId,name:body.routeName??item.map.name+'路线',mapVersion:body.baseVersion,mapDigest:store.digest(item.map),points:body.points,motionSegments:compiled.map.motionSegments!,bodyYawDeg:body.bodyYawDeg,initialHeadingRad:body.initialHeadingRad??null,distanceModel:body.distanceModel??'center-euclidean',spacingOverrides:body.spacingOverrides??[],created:now,updated:now},body.routeUpdated);
    const snapshot=routeMapSnapshot(item.map,route);const tasks=(store.db.prepare('SELECT body FROM tasks ORDER BY updated DESC').all() as {body:string}[]).map(row=>taskSchema.parse(JSON.parse(row.body)));const matching=tasks.find(task=>task.routeId===route.routeId);
    const task=taskSchema.parse({...matching,id:matching?.id??'task-route-'+randomBytes(12).toString('hex'),name:route.name.slice(0,98)+'任务',mapId:route.mapId,mapVersion:route.mapVersion,routeId:route.routeId,routeSnapshot:route,rowOrder:snapshot.order,forwardSpeed:matching?.forwardSpeed??.08,reverseSpeed:matching?.reverseSpeed??.06,lateralSpeed:matching?.lateralSpeed??.05,endWaitSeconds:matching?.endWaitSeconds??2,returnToStart:matching?.returnToStart??false,enabled:matching?.enabled??true});
    store.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated=excluded.updated').run(task.id,JSON.stringify(task),route.updated);return {...route,route,map:snapshot,version:item.version,task,updatedTasks:[task],trimmed:compiled.trimmed,lengthM:compiled.lengthM,routeGroups:compiled.routeGroups,acceptance:mapApproval(item)};
   }
   const saved=saveMap(compiled.map,body.baseVersion);const existing=(store.db.prepare('SELECT body FROM tasks ORDER BY updated DESC').all() as {body:string}[]).map(row=>taskSchema.parse(JSON.parse(row.body))).filter(task=>task.mapId===item.map.id&&task.routeId===undefined);const updatedTasks=(existing.length?existing:[taskSchema.parse({id:'task-scan-design-'+randomBytes(12).toString('hex'),name:item.map.name.slice(0,95)+'任务',mapId:item.map.id,mapVersion:saved.version,rowOrder:saved.map.order,forwardSpeed:.08,reverseSpeed:.06,lateralSpeed:.05,endWaitSeconds:2})]).map(task=>taskSchema.parse({...task,mapVersion:saved.version,rowOrder:saved.map.order}));for(const task of updatedTasks)store.db.prepare('INSERT INTO tasks VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body,updated=excluded.updated').run(task.id,JSON.stringify(task),new Date().toISOString());const legacyId=legacyRouteId(saved.map.id),existingRoute=store.getRoute(legacyId),now=new Date().toISOString();const legacyRoute=store.saveRoute({routeId:legacyId,mapId:saved.map.id,name:saved.map.rows[0]?.name??saved.map.name+'路线',mapVersion:saved.version,mapDigest:store.digest(saved.map),points:body.points,motionSegments:saved.map.motionSegments!,bodyYawDeg:body.bodyYawDeg,initialHeadingRad:body.initialHeadingRad??null,distanceModel:body.distanceModel??'center-euclidean',spacingOverrides:body.spacingOverrides??[],created:now,updated:now},existingRoute?.updated);log('保存自定义正交路径 '+saved.map.id+' v'+saved.version);return {...saved,route:legacyRoute,task:updatedTasks[0],updatedTasks,trimmed:compiled.trimmed,lengthM:compiled.lengthM,routeGroups:compiled.routeGroups};
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
   const digest=store.digest(saved.map),updatedTasks=[],updatedRoutes=[];
   if(body.updateTasks){
    // 确认坐标必然生成新版本。同一场地的路径与任务原本绑定在旧版本上，
    // 若不一起前移，用户确认完反而会因“路径摘要失配”被迫重画路径才能启动导航。
    for(const route of store.listRoutes(map.id)){
     if(route.mapVersion!==item.version)continue;
     store.db.prepare('UPDATE routes SET map_version=?,map_digest=?,updated=? WHERE route_id=?').run(saved.version,digest,evidence.created,route.routeId);updatedRoutes.push(route.routeId);
    }
    for(const row of store.db.prepare('SELECT body FROM tasks').all() as {body:string}[]){
     const task=taskSchema.parse(JSON.parse(row.body));if(task.mapId!==map.id||task.mapVersion!==item.version)continue;
     const snapshot=task.routeId?store.getRoute(task.routeId):null;
     const updated={...task,mapVersion:saved.version,...(snapshot?{routeSnapshot:snapshot}:{})};store.db.prepare('UPDATE tasks SET body=?,updated=? WHERE id=?').run(JSON.stringify(updated),evidence.created,task.id);updatedTasks.push(updated);
    }
   }
   log('用户确认接纳地图 '+map.id+' v'+saved.version+'，确认人 '+body.operator+(updatedRoutes.length?`，路径前移 ${updatedRoutes.length} 条`:''));
   return {...saved,evidence,acceptance:mapApproval(saved),previousVersion:item.version,updatedTasks,updatedRoutes};
  })();
 });
 app.post('/api/maps/unify-angles',req=>{
  const body=mapUnifyAnglesSchema.parse(req.body);
  return store.db.transaction(()=>{
   const item=store.get(body.mapId);if(!item)throw Object.assign(new Error('地图不存在'),{statusCode:404});
   if(item.version!==body.version)throw Object.assign(new Error('请使用最新地图版本进行朝向统一'),{statusCode:409});
   const map=structuredClone(item.map),check=validate(map);if(check.errors.length)throw new Error(check.errors.join('；'));
   if(map.tags.length<2)throw new Error('地图至少需要两个定位码才能统一朝向');
   // 现场所有板子同方向铺设：扫描估计出的逐码朝向角只允许几度噪声，取中位数为统一目标。
   const sorted=map.tags.map(t=>t.angle).sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);
   const unified=sorted.length%2?sorted[middle]!:(sorted[middle-1]!+sorted[middle]!)/2;
   const before=map.tags.map(t=>({id:t.id,angleDeg:t.angle}));
   for(const tag of map.tags)tag.angle=unified;
   const saved=store.save(map,item.version);
   const evidence=mapConfirmationEvidenceSchema.parse({...body,kind:'user_confirmation',acceptedVersion:saved.version,created:new Date().toISOString()});
   store.db.prepare('INSERT INTO acceptances VALUES(?,?,?,?)').run(map.id,saved.version,store.digest(saved.map),JSON.stringify(evidence));
   const digest=store.digest(saved.map),updatedTasks=[],updatedRoutes=[];
   if(body.updateTasks){
    // 朝向统一必然生成新版本；绑定旧版本的路径与任务一起前移，避免摘要失配被迫重画。
    for(const route of store.listRoutes(map.id)){
     if(route.mapVersion!==item.version)continue;
     store.db.prepare('UPDATE routes SET map_version=?,map_digest=?,updated=? WHERE route_id=?').run(saved.version,digest,evidence.created,route.routeId);updatedRoutes.push(route.routeId);
    }
    for(const row of store.db.prepare('SELECT body FROM tasks').all() as {body:string}[]){
     const task=taskSchema.parse(JSON.parse(row.body));if(task.mapId!==map.id||task.mapVersion!==item.version)continue;
     const snapshot=task.routeId?store.getRoute(task.routeId):null;
     const updated={...task,mapVersion:saved.version,...(snapshot?{routeSnapshot:snapshot}:{})};store.db.prepare('UPDATE tasks SET body=?,updated=? WHERE id=?').run(JSON.stringify(updated),evidence.created,task.id);updatedTasks.push(updated);
    }
   }
   log('统一定位码朝向 '+map.id+' v'+saved.version+' → '+unified.toFixed(2)+'°（原散布 '+(sorted[sorted.length-1]!-sorted[0]!).toFixed(2)+'°），确认人 '+body.operator+(updatedRoutes.length?`，路径前移 ${updatedRoutes.length} 条`:''));
   return {...saved,evidence,acceptance:mapApproval(saved),previousVersion:item.version,unifiedAngleDeg:unified,before,updatedTasks,updatedRoutes};
  })();
 });
 app.post('/api/localization/map',req=>{
  const body=z.object({mapId:z.string(),version:z.number().int().positive()}).strict().parse(req.body),item=store.get(body.mapId);
  if(!item||item.version!==body.version)throw new Error('请使用最新的导航地图版本');
  // 同一场地会被重复扫描成多张测试地图，它们共用同一批物理二维码板。
  // 定位作用域必须跟随"当前选中的地图"：否则切换地图后定位仍锚在旧图上，界面只能显示
  // "当前定位属于其他地图"并永久卡住。这里只负责让定位跟随选择并清旧原点；
  // 能否开始导航由 /api/navigation/start 的"坐标已启用+验收+作用域匹配"共同把关，不在此放宽。
  const status=robot.status();if(!status.connected||status.running||Math.abs(status.speed)>.001||!status.chassis.connected||typeof status.chassis.feedback?.vx!=='number'||Math.abs(status.chassis.feedback.vx)>.001||robot.poll().some(c=>c.type==='start'))throw new Error('请在小车停止且底盘反馈在线时切换定位地图');
  const visible=new Set<string>((status.detector?.groups??[]).map((group:{id:string})=>String(group.id))),known=new Set<string>((item.map.groups??[]).map(group=>String(group.id)));
  // 板组不一致只是提示，不拦截：融合节点在没有匹配板组时本来就不会锚定。
  if(visible.size&&!Array.from(visible).some(id=>known.has(id)))log('定位地图切换提示：当前可见板组 '+Array.from(visible).join(',')+' 不在 '+item.map.id+' 内，等待该地图板组');
  const path=resolve(root,'maps/office-confirmed.json'),content=JSON.stringify({map:item.map,version:item.version});
  const previous=existsSync(path)?readFileSync(path,'utf8'):'';
  const switched=previous!==content;
  if(switched){writeFileSync(path+'.tmp',content);renameSync(path+'.tmp',path);}
  const reviewed=item.map.coordinateStatus==='reviewed';
  log((switched?'切换定位地图 ':'定位地图未变化 ')+item.map.id+' v'+item.version+(reviewed?'':'（坐标来自扫描：未做人工验收）'));
  return {mapId:item.map.id,version:item.version,coordinateStatus:item.map.coordinateStatus??'draft',reviewed,switched,
          localization:{mapId:status.localization?.mapId??'',mapVersion:status.localization?.mapVersion??null}};
 });
 app.get('/api/localization/scope',req=>{
  const q=z.object({mapId:z.string().min(1),version:z.coerce.number().int().positive()}).parse(req.query??{});
  const item=store.get(q.mapId),loc=robot.status().localization??null;
  const sameMap=!!loc&&loc.mapId===q.mapId,sameVersion=!!loc&&loc.mapVersion===q.version;
  const phase=localizationScopePhase(!!item,q.mapId,q.version,loc);
  return {target:{mapId:q.mapId,version:q.version,name:item?.map.name??'',coordinateStatus:item?.map.coordinateStatus??null,
                  accepted:item?mapApproval(item).accepted:false,isLatest:item?.version===q.version},
          localization:loc?{mapId:loc.mapId??'',mapVersion:loc.mapVersion??null,state:loc.state,poseAvailable:loc.poseAvailable===true,
                            navigationReady:loc.navigationReady===true,localEpoch:loc.localEpoch??'',reason:loc.reason??''}:null,
          matched:sameMap&&sameVersion,phase};
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
  const {taskId}=z.object({taskId:z.string()}).parse(req.body);const row=store.db.prepare('SELECT body FROM tasks WHERE id=?').get(taskId) as {body:string}|undefined;if(!row)throw new Error('请先保存导航任务');const task=taskSchema.parse(JSON.parse(row.body));const latest=store.get(task.mapId),base=store.get(task.mapId,task.mapVersion),route=task.routeId?store.getRoute(task.routeId):null;if(!latest||!base||latest.version!==task.mapVersion||task.routeId&&(!route||route.mapId!==task.mapId||route.mapVersion!==task.mapVersion||route.mapDigest!==store.digest(base.map)))throw new Error('地图已有修改或执行路径绑定版本不一致，请重新验收并更新任务绑定版本');const item=route?{...base,map:routeMapSnapshot(base.map,route)}:base;
  if(task.routeSnapshot){const snapshot=task.routeSnapshot;if(!route||snapshot.routeId!==task.routeId||snapshot.mapId!==task.mapId||snapshot.mapVersion!==task.mapVersion||snapshot.mapDigest!==store.digest(base.map))throw new Error('任务路径快照与当前地图摘要或版本不一致');item.map=routeMapSnapshot(base.map,snapshot);}
  if(item.map.routeMode==='map-only')throw Object.assign(new Error('请先手动编辑并保存导航路径'),{statusCode:423});
  const strategyBlockers=segmentExecutionBlockers(item.map.motionSegments,{turnInPlace:robot.status().capabilities?.turnInPlace===true});if(strategyBlockers.length)throw Object.assign(new Error('路径策略尚不可执行：'+strategyBlockers.join('；')),{statusCode:423});
  if(item.map.motionSegments?.some(segment=>segment.strategy==='left'||segment.strategy==='right')&&robot.status().mapping?.lateralSupported!==true)throw Object.assign(new Error('横移能力未由当前导航节点确认，禁止执行显式左/右平移策略'),{statusCode:423});
  // 自用版：坐标直接读取扫描结果，切换地图即视为当前导航地图，不再要求人工"启用/确认坐标"。
  // 真实安全门逐项保留：位姿/相机/IMU/底盘条件、路径策略、地图与路径版本一致性、定位作用域。
  if(item.map.captureQuality==='draft')throw Object.assign(new Error('此地图来自草稿采集，请完成正式扫描后再导航'),{statusCode:423});
  const reasons=robot.status().conditions.filter(c=>!c.ready).map(c=>c.label);
  if(!task.enabled)reasons.push('任务启用');if(!robot.status().connected)reasons.push('ROS2节点连接');if(reasons.length)throw Object.assign(new Error('尚未满足：'+[...new Set(reasons)].join('、')),{statusCode:423});
  // 生产实例(database 为空)必须让定位作用域与任务地图严格一致：同一批二维码被多张地图共用时，
  // 只比较路线/版本会把"定位仍锚在别的图"当成可执行。单元测试不注入实时定位，故仅生产校验。
  if(!database){const scopeBlock=localizationScopeBlock(item.map.id,item.version,robot.status().localization);if(scopeBlock)throw Object.assign(new Error(scopeBlock),{statusCode:423});}const check=validate({...item.map,order:task.rowOrder});if(check.errors.length)throw new Error(check.errors.join('；'));log('请求启动任务 '+taskId);return robot.enqueue('start',{map:item.map,task});
 });
 for(const command of ['pause','resume','stop'])app.post('/api/navigation/'+command,()=>{log('请求'+command);return robot.enqueue(command);});
 app.get('/api/logs',()=>store.db.prepare('SELECT stamp,event FROM runtime_log ORDER BY rowid DESC LIMIT 200').all());
 app.post('/api/survey/resume',req=>{const {sessionId}=z.object({sessionId:z.string()}).parse(req.body);if(surveyId&&surveyId!==sessionId)throw new Error('先停止当前采集记录');const existing=getSurvey(store,sessionId);if(existing.samples[0]?.localEpoch&&existing.samples[0].localEpoch!==robot.status().mapping?.localEpoch)throw new Error('局部定位原点已变化，请新建扫描');store.db.prepare('UPDATE survey_sessions SET state=? WHERE id=?').run('collecting',sessionId);surveyId=sessionId;return getSurvey(store,sessionId);});
 app.get('/api/surveys',()=>listSurveys(store));
 app.delete<{Params:{id:string}}>('/api/surveys/:id',req=>{const result=deleteSurvey(store,req.params.id);log('删除扫描记录 '+result.name+' '+result.id);return result;});
 app.post('/api/survey/start',req=>{const {name}=z.object({name:z.string().min(1).max(100)}).parse(req.body);if(surveyId)throw new Error('已有采集任务，请先停止');const session=createSurvey(store,name,listBoards(store));surveyId=session.id;return session;});
 // 界面详情：summary 模式（有界记录 + 明确标注不完整 + 校验结论标 complete:false）。
 app.get<{Params:{id:string}}>('/api/surveys/:id',req=>getSurvey(store,req.params.id,'summary'));
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
  authorized(req);
  const body=z.object({records:z.array(z.unknown()).max(200)}).parse(req.body);
  if(surveyId)return appendMotionRecords(store,surveyId,body.records);
  // 融合标定：复用同一被动反馈通道；只有存在录制中试验时才入库。
  const activeCalibration=calibrationStore.activeTrial();
  if(activeCalibration){
   const samples=body.records.map(record=>{
    const fields=record as Record<string,unknown>;
    return {kind:'feedback',...fields,stamp:Number(fields.stamp)};
   }).filter(sample=>Number.isFinite(sample.stamp));
   return calibrationStore.addSamples(activeCalibration.sessionId,activeCalibration.trialId,samples);
  }
  return {stored:0};
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
 app.post('/api/survey/map',async req=>{
  const body=mapOnlyRequestSchema.parse(req.body),session=getSurvey(store,body.sessionId,'full');
  if(session.state!=="stopped")throw new Error("请先停止扫描，再保存定位码地图");
  const id="scan-"+session.id.replaceAll("-",""),existing=store.get(id);
  if(existing&&existing.map.routeMode!=="map-only")throw Object.assign(new Error("此记录已有旧导航地图，请保留原地图并另建扫描"),{statusCode:409});
  if((existing?.version??0)!==body.baseVersion)throw Object.assign(new Error("地图已被其他页面保存，请重新加载最新版本后再修改"),{statusCode:409});
  if(existing&&!body.rebuild)throw Object.assign(new Error("此扫描已保存地图，请点击从原始扫描重建新版本；旧版本将保留"),{statusCode:409});
  const evidence=JSON.stringify([session.name,session.samples,session.boards,session.anchors]);
  const map=await createSurveyPointMap(root,session,body);
  return store.db.transaction(()=>{
   const latest=getSurvey(store,body.sessionId);
   if(latest.state!=="stopped"||JSON.stringify([latest.name,latest.samples,latest.boards,latest.anchors])!==evidence)throw Object.assign(new Error("整理期间扫描记录发生变化，请重新停止并保存"),{statusCode:409});
   const saved=saveMap(map,body.baseVersion);
   log((existing?"从原始扫描重建定位码地图新版本 ":"保存整理后的定位码地图 ")+session.id+" v"+saved.version);
   return {...saved,mapOnly:true,route:null,task:null};
  })();
 });
 app.post('/api/survey/draft',req=>{
  const body=z.object({sessionId:z.string(),tagSizeMm:z.number().min(20).max(180).default(80)}).parse(req.body),session=getSurvey(store,body.sessionId,'full');
  if(session.state!=='stopped')throw new Error('请先停止扫描，再保存地图草稿');
  const map=pointDraftMap(session,body.tagSizeMm),existing=store.get(map.id);
  const saved=saveMap(map,existing?.version??0);log('保存扫描点位草稿 '+session.id);return saved;
 });
 app.post('/api/survey/optimize',async req=>{const body=z.object({sessionId:z.string(),anchors:z.array(anchorSchema).max(587)}).parse(req.body);const session=getSurvey(store,body.sessionId);if(session.state==='collecting')throw new Error('请先停止扫描再整理记录');const samples=optimizationSamples(session.samples);const result=await optimizeSurvey(root,{samples,anchors:body.anchors});const latest=getSurvey(store,body.sessionId);if(latest.state!=='stopped'||latest.samples.length!==session.samples.length||latest.samples.at(-1)?.stamp!==session.samples.at(-1)?.stamp)throw new Error('整理期间扫描记录发生变化，请重新停止并整理');store.db.prepare('UPDATE survey_sessions SET anchors=?,result=? WHERE id=?').run(JSON.stringify(body.anchors),JSON.stringify(result),body.sessionId);return getSurvey(store,body.sessionId);});
 app.post('/api/workflow/finalize',req=>{
  const body=scanSettings.parse(req.body);
  // 建图是**安全校验 + 编译**，必须基于**全量**运动记录：
  // validateMotionSegments 靠完整时间序列找换挡点，只校验尾部会把早期异常放行成「通过」。
  // 所以这里显式用 full 模式，而不是界面用的 summary 摘要。
  const session=getSurvey(store,body.sessionId,'full');
  if(session.state!=='stopped')throw new Error('请先停止扫描，再生成地图');
  if(!session.result)throw new Error('没有已整理的扫描记录');
  if(session.motionTruncated)throw new Error('运动记录未能完整读取，禁止据此处生成地图（会漏检早期异常），请重试或缩小记录规模');
  if(!session.motionValidation.ready)throw new Error('区间模式校验未通过，请重新录制：'+[...session.motionValidation.reasons,...session.motionValidation.segments.flatMap((s:any)=>s.reasons)].filter((v:string,i:number,a:string[])=>a.indexOf(v)===i).join('；'));

  const compiled=compileScan(session.result,body,session.boards,session.samples.flatMap(sample=>sample.tags.map((tag:{id:number})=>tag.id)),session.motionRecords.length?{samples:session.samples,optimizedSamples:optimizationSamples(session.samples),records:session.motionRecords}:undefined);compiled.map.captureQuality=session.captureQuality as 'draft'|'verified';const existing=store.get(compiled.map.id);
  if(existing)throw Object.assign(new Error('此扫描已生成地图，请加载原地图进行确认'),{statusCode:409});
  return store.db.transaction(()=>{
   const saved=saveMap(compiled.map,0),row=saved.map.rows[0]!,routeId=legacyRouteId(saved.map.id),now=new Date().toISOString();
   const route=store.saveRoute({routeId,mapId:saved.map.id,name:row.name,mapVersion:saved.version,mapDigest:store.digest(saved.map),points:[...(row.start?[row.start]:[]),...row.points],motionSegments:saved.map.motionSegments!,bodyYawDeg:(saved.map.motionSegments?.[0]?.bodyYaw??0)*180/Math.PI,created:now,updated:now});
   const task={...compiled.task,mapVersion:saved.version,routeId:route.routeId,routeSnapshot:route};
   store.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.id,JSON.stringify(task),now);
   log('扫描生成地图草稿 '+saved.map.id);return {...saved,route,task};
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
