import {createApp} from '../../web/backend/src/server';
import {generateBoards} from '../../web/shared/boards';
import {defaults,generate} from '../../web/shared/model';
import {compileDesignedRoute} from '../../web/backend/src/route-design';
const app=await createApp(':memory:');
const points=[{x:0,y:0},{x:1,y:0},{x:1,y:1},{x:0,y:1}];
for(const grouped of [true,false]){
 const map=generate({...defaults,count:1,angle:0}),start=grouped?100:200;map.id=grouped?'v4-browser-map':'v4-single-map';map.name=grouped?'真实2×2定位板':'真实独立单码';
 const boards=grouped?generateBoards({gridSize:2,groupSizeMm:100,groupCount:4,startId:start}):[];map.groups=boards;
 map.tags=points.map((p,i)=>({id:grouped?boards[i]!.referenceId:start+i,...p,rowId:map.rows[0]!.id,angle:0,size:grouped?.1:.08,kind:'waypoint',rules:[],...(grouped?{groupId:boards[i]!.id}:{})}));
 const base=compileDesignedRoute(map,points,0).map;
 const saved=await app.inject({method:'POST',url:'/api/maps',payload:{map:base,baseVersion:0}});if(saved.statusCode!==200)throw new Error(saved.body);
 const route=await app.inject({method:'POST',url:'/api/route/design',payload:{mapId:map.id,baseVersion:1,routeId:grouped?'v4-board-route':'v4-single-route',routeName:map.name,bodyYawDeg:0,points}});if(route.statusCode!==200)throw new Error(route.body);
 if(grouped){const registered=await app.inject({method:'POST',url:'/api/boards/pdf',payload:{gridSize:2,groupSizeMm:100,groupCount:4,startId:start}});if(registered.statusCode!==200)throw new Error(registered.body);}
}
await app.listen({host:'127.0.0.1',port:4184});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
