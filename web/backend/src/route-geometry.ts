import {z} from 'zod';
import type {FastifyInstance} from 'fastify';
import {randomBytes} from 'node:crypto';
import {pointSchema,type Point} from '../../shared/model';
import {segmentChoiceSchema} from '../../shared/segment-strategy';
import {ROUTE_GROUP_CAPTURE} from '../../shared/route-design';
import {
 diagnoseRouteBindings,equalizeLegs,insertAnchorAt,mirrorRoute,moveAnchorKeepingOrthogonal,
 removeAnchor,rotateRoute,translateRoute,validateRouteGeometry,
} from '../../shared/route-geometry';
import {compileDesignedRoute} from './route-design';
import type {Store} from './store';
import type {RobotLink} from './robot';
import {routeTaskSchema as taskSchema} from '../../shared/task';

/**
 * Route geometry editing API.
 *
 * A thin, strict shell around the pure functions in `web/shared/route-geometry.ts`:
 *
 *   1. the pure function computes a candidate point list and refuses an illegal
 *      edit with an explanation (bad index, diagonal leg, corner inside an
 *      equal-spacing run, non-90° rotation, …);
 *   2. the candidate goes through the *existing* `compileDesignedRoute`, so
 *      orthogonality, the 8 cm minimum leg, the 50 m total, the 501 point and
 *      the 100 interval limits are exactly the ones the executor already
 *      enforces. Nothing here relaxes them;
 *   3. the compiled route is written with the same `routeUpdated` / `baseVersion`
 *      conflict guards the named-route editor uses. A default save overwrites
 *      the route in place (same routeId, no new map version); only
 *      `newVersion:true` mints a new routeId.
 */

const deltaSchema = z.object({x:z.number().finite().min(-10000).max(10000),y:z.number().finite().min(-10000).max(10000)}).strict();

export const routeGeometryParamsSchema = z.object({
 index:z.number().int().min(0).max(501).optional(),
 fromIndex:z.number().int().min(0).max(501).optional(),
 toIndex:z.number().int().min(0).max(501).optional(),
 point:pointSchema.optional(),
 delta:deltaSchema.optional(),
 dx:z.number().finite().min(-10000).max(10000).optional(),
 dy:z.number().finite().min(-10000).max(10000).optional(),
 pivot:pointSchema.optional(),
 degrees:z.number().finite().min(-1440).max(1440).optional(),
 axis:z.enum(['horizontal','vertical']).optional(),
 at:z.number().finite().min(-10000).max(10000).optional(),
 targetM:z.number().finite().min(0.08).max(50).optional(),
 grid:z.number().finite().min(0.001).max(1).optional(),
}).strict();

export const ROUTE_GEOMETRY_OPERATIONS = ['insert','remove','move','equalize','translate','rotate','mirror'] as const;
export type RouteGeometryOperation = typeof ROUTE_GEOMETRY_OPERATIONS[number];

export const routeGeometrySchema = z.object({
 mapId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
 baseVersion:z.number().int().positive(),
 routeUpdated:z.string().datetime().optional(),
 points:z.array(pointSchema).min(2).max(501),
 operation:z.enum(ROUTE_GEOMETRY_OPERATIONS),
 params:routeGeometryParamsSchema.default({}),
 /** Default is an in-place edit of this route: same routeId, no new map version. */
 newVersion:z.boolean().default(false),
 routeName:z.string().trim().min(1).max(100).optional(),
 bodyYawDeg:z.number().finite().min(-180).max(180).optional(),
 initialHeadingRad:z.number().finite().min(-Math.PI).max(Math.PI).nullable().optional(),
 segmentModes:z.array(segmentChoiceSchema).max(100).optional(),
 spacingOverrides:z.array(z.object({fromId:z.number().int().min(0).max(586),toId:z.number().int().min(0).max(586),occurrence:z.number().int().positive().default(1),targetM:z.number().finite().min(.08).max(50)})).max(100).optional(),
}).strict();

export type RouteGeometryRequest = z.infer<typeof routeGeometrySchema>;
export type RouteGeometryParams = z.infer<typeof routeGeometryParamsSchema>;

export interface AppliedGeometry {
 points:Point[];
 operation:RouteGeometryOperation;
 notes:string[];
 /** Operation-specific readout for the UI toast. */
 detail:Record<string,number|string|boolean|null>;
 /** Positions touched by this edit, in the *new* point list. */
 affectedIndexes:number[];
}

/** A user-facing, repairable edit error: the server maps it to HTTP 400. */
class RouteEditError extends Error{}

function reject(message:string):never{throw new RouteEditError(message);}

function required<K extends keyof RouteGeometryParams>(params:RouteGeometryParams,key:K,label:string):NonNullable<RouteGeometryParams[K]>{
 const value=params[key];
 if(value===undefined)reject(`「${label}」操作缺少参数 ${String(key)}`);
 return value as NonNullable<RouteGeometryParams[K]>;
}

const count=(value:number|undefined,fallback:number)=>value===undefined?fallback:value;

/**
 * Run one geometry operation on a point list and return the candidate points.
 * Anything the operation itself cannot repair is thrown as a Chinese message,
 * which the server error handler turns into HTTP 400.
 */
export function applyRouteGeometry(points:Point[],operation:RouteGeometryOperation,params:RouteGeometryParams={}):AppliedGeometry{
 const all=(list:Point[],offset=0)=>list.map((_,index)=>index+offset);
 switch(operation){
  case 'insert':{
   const index=required(params,'index','插入'),point=required(params,'point','插入');
   const result=insertAnchorAt(points,index,point);
   if(!result.ready)reject(result.issues.map(issue=>issue.message).join('；'));
   return {points:result.points,operation,notes:result.notes,
    affectedIndexes:[result.insertedIndex,...result.cornerIndexes].filter(value=>value>=0),
    detail:{index,insertedIndex:result.insertedIndex,cornerCount:result.cornerIndexes.length}};
  }
  case 'remove':{
   const index=required(params,'index','删除');
   const result=removeAnchor(points,index);
   if(!result.ready)reject(result.issues.map(issue=>issue.message).join('；'));
   return {points:result.points,operation,notes:result.notes,
    affectedIndexes:all(result.points),
    detail:{index,removedX:result.removed?.x??null,removedY:result.removed?.y??null}};
  }
  case 'move':{
   const index=required(params,'index','移动'),shift=required(params,'delta','移动');
   const result=moveAnchorKeepingOrthogonal(points,index,shift);
   if(!result.ready)reject(result.issues.map(issue=>issue.message).join('；'));
   return {points:result.points,operation,notes:result.notes,
    affectedIndexes:[result.movedIndex,...result.cornerIndexes].filter(value=>value>=0),
    detail:{index,deltaX:shift.x,deltaY:shift.y,movedIndex:result.movedIndex,cornerCount:result.cornerIndexes.length}};
  }
  case 'equalize':{
   const fromIndex=required(params,'fromIndex','等间距'),toIndex=required(params,'toIndex','等间距'),targetM=required(params,'targetM','等间距');
   const result=equalizeLegs(points,fromIndex,toIndex,targetM);
   if(!result.ready)reject(result.issues.map(issue=>issue.message).join('；'));
   return {points:result.points,operation,notes:result.notes,affectedIndexes:result.movedIndexes,
    detail:{fromIndex,toIndex,targetM,legs:toIndex-fromIndex,axis:result.axis,direction:result.direction,tailDeltaM:result.tailDeltaM,spanBeforeM:result.spanBeforeM,spanAfterM:result.spanAfterM}};
  }
  case 'translate':{
   const dx=count(params.dx,0),dy=count(params.dy,0);
   const result=translateRoute(points,dx,dy);
   if(!result.ready)reject(result.issues.map(issue=>issue.message).join('；'));
   return {points:result.points,operation,notes:result.notes,affectedIndexes:all(result.points),detail:{dx,dy}};
  }
  case 'rotate':{
   const pivot=required(params,'pivot','旋转'),degrees=required(params,'degrees','旋转');
   const result=rotateRoute(points,pivot,degrees);
   if(!result.ready)reject(result.issues.map(issue=>issue.message).join('；'));
   return {points:result.points,operation,notes:result.notes,affectedIndexes:all(result.points),
    detail:{degrees,pivotX:pivot.x,pivotY:pivot.y,turns:((Math.round(degrees/90)%4)+4)%4}};
  }
  case 'mirror':{
   const axis=required(params,'axis','镜像'),at=count(params.at,0);
   const result=mirrorRoute(points,axis,at);
   if(!result.ready)reject(result.issues.map(issue=>issue.message).join('；'));
   return {points:result.points,operation,notes:result.notes,affectedIndexes:all(result.points),detail:{axis,at}};
  }
 }
 return reject('不支持的路径几何操作');
}

export interface RouteGeometryDeps {
 store:Store;
 robot:Pick<RobotLink,'status'|'poll'>;
 log(event:string):void;
}

const conflict=(message:string)=>Object.assign(new Error(message),{statusCode:409});
const missing=(message:string)=>Object.assign(new Error(message),{statusCode:404});

/** Compare a client preview with the stored geometry at micron resolution. */
const samePoints=(a:Point[],b:Point[])=>
 a.length===b.length&&a.every((point,index)=>Math.abs(point.x-b[index]!.x)<=1e-6&&Math.abs(point.y-b[index]!.y)<=1e-6);

/**
 * POST /api/routes/:id/geometry
 *
 * Body: {mapId, baseVersion, routeUpdated?, points, operation, params,
 *        newVersion?, routeName?, bodyYawDeg?, initialHeadingRad?,
 *        segmentModes?, spacingOverrides?}
 *
 * Default: overwrite this route in place (same routeId, tasks bound to it get
 * their snapshot refreshed). `newVersion:true`: mint a new routeId so the old
 * path stays available.
 */
export function registerRouteGeometryRoutes(app:FastifyInstance,deps:RouteGeometryDeps){
 const {store,robot,log}=deps;
 app.post<{Params:{id:string}}>('/api/routes/:id/geometry',req=>{
  const body=routeGeometrySchema.parse(req.body);
  const status=robot.status();
  if(status.running||robot.poll().some(command=>command.type==='start'))reject('请先停止导航并等待启动指令处理完成，再编辑路径');
  return store.db.transaction(()=>{
   const route=store.getRoute(req.params.id);
   if(!route)throw missing('路径不存在');
   if(route.mapId!==body.mapId)throw conflict(`路径属于地图 ${route.mapId}，不能按 ${body.mapId} 修改几何`);
   const item=store.get(route.mapId,route.mapVersion);
   if(!item)throw conflict('路径引用的地图版本已不存在，请重新加载地图与路径');
   if(item.version!==body.baseVersion)throw conflict('地图已有新版本，请重新加载后再编辑路径');
   if(route.mapDigest!==store.digest(item.map))throw conflict('路径引用的地图摘要已变化，请重新选择路径');
   // The edit runs on the *stored* points. The client's `points` are the preview
   // it believes it is editing; when they no longer match the stored geometry,
   // another page (or a stale tab) already changed this route. Refusing here is
   // what stops a stale preview from silently overwriting newer work.
   if(!samePoints(route.points,body.points))throw conflict('路径几何已被其他页面修改，请重新加载后再编辑');
   const applied=applyRouteGeometry(route.points,body.operation,body.params);
   // The report is a diagnostic, not a gate: `compileDesignedRoute` below is the
   // authority, and it is deliberately not made stricter here. A stored route may
   // legitimately carry anchors closer than 8 cm as long as the compiled interval
   // endpoints honour the limit.
   const report=validateRouteGeometry(applied.points);
   const diagnostics=diagnoseRouteBindings(applied.points,item.map.tags.map(({id,x,y})=>({id,x,y})),{toleranceM:ROUTE_GROUP_CAPTURE});
   const yaw=body.bodyYawDeg??route.bodyYawDeg;
   const spacingOverrides=body.spacingOverrides??route.spacingOverrides;
   const compiled=compileDesignedRoute(item.map,applied.points,yaw,body.segmentModes,spacingOverrides);
   const now=new Date().toISOString();
   const createNew=body.newVersion===true;
   const routeId=createNew?'route-'+randomBytes(12).toString('hex'):route.routeId;
   const name=body.routeName??(createNew?`${route.name}（编辑 ${now.slice(11,19)}）`:route.name);
   const saved=store.saveRoute({
    routeId,mapId:route.mapId,name,mapVersion:item.version,mapDigest:store.digest(item.map),
    points:applied.points,motionSegments:compiled.map.motionSegments!,bodyYawDeg:yaw,
    initialHeadingRad:body.initialHeadingRad!==undefined?body.initialHeadingRad:route.initialHeadingRad??null,
    distanceModel:route.distanceModel,spacingOverrides,
    created:now,updated:now,
   },createNew?undefined:body.routeUpdated);
   const updatedTasks:string[]=[];
   if(!createNew){
    // A task stores a route snapshot for execution. An in-place edit must refresh
    // that snapshot, otherwise start would keep driving the old geometry.
    for(const row of store.db.prepare('SELECT body FROM tasks').all() as {body:string}[]){
     const task=taskSchema.parse(JSON.parse(row.body));
     if(task.routeId!==saved.routeId)continue;
     store.db.prepare('UPDATE tasks SET body=?,updated=? WHERE id=?').run(JSON.stringify({...task,routeSnapshot:saved}),now,task.id);
     updatedTasks.push(task.id);
    }
   }
   log(`编辑路径几何 ${saved.name} ${saved.routeId} · ${body.operation} · ${applied.points.length} 点 · ${report.lengthM.toFixed(2)} m · ${compiled.map.motionSegments!.length} 段`);
   return {
    route:saved,motionSegments:saved.motionSegments,mapId:saved.mapId,mapVersion:saved.mapVersion,mapDigest:saved.mapDigest,
    operation:body.operation,params:body.params,newRoute:createNew,
    points:saved.points,lengthM:compiled.lengthM,trimmed:compiled.trimmed,routeGroups:compiled.routeGroups,
    geometry:{lengthM:report.lengthM,shortestLegM:report.shortestLegM,corners:report.corners,warnings:report.warnings.map(issue=>issue.message)},
    diagnostics,notes:applied.notes,tasks:updatedTasks,
   };
  })();
 });
}
