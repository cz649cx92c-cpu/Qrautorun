import {createApp} from '../../web/backend/src/server';
import {generateBoards} from '../../web/shared/boards';
import {generate,defaults} from '../../web/shared/model';
import {compileDesignedRoute} from '../../web/backend/src/route-design';
const app=await createApp(':memory:');
async function post(url:string,payload:unknown){const result:any=await app.inject({method:'POST',url,payload:payload as any});if(result.statusCode!==200)throw new Error(result.body);return result.headers['content-type']?.includes('application/pdf')?result.rawPayload:result.json();}
const boards=generateBoards({gridSize:2,groupSizeMm:100,groupCount:10,startId:0});
await post('/api/boards/pdf',{gridSize:2,groupSizeMm:100,groupCount:10,startId:0});
const cases:Record<string,string>={};
for(const count of [1,10]){
 const record=await post('/api/survey/start',{name:count===1?'单组位置记录':'十组往返记录'});cases[String(count)]=record.id;
 const samples=boards.slice(0,count).flatMap((board,i)=>[0,.2,0].map((offset,j)=>({stamp:1+i*3+j,pose:{x:i+offset,y:0,yaw:0},representation:'board-centers',groupLayouts:[board],calibrated:true,synchronized:true,quality:'verified',localEpoch:'fixture-epoch',tags:[{id:board.referenceId,groupId:board.id,x:-offset,y:0,angle:0,sigma:.02,memberIds:board.members.map(member=>member.id),visibleCount:4,size:.1}]})));
 await post('/api/survey/import',{sessionId:record.id,samples});await post('/api/survey/stop',{sessionId:record.id});
}
const old=generate({...defaults,count:1,length:2,tagSpacing:1,angle:0});old.id='old-route-map';old.name='原有路线地图';
const routeMap=compileDesignedRoute(old,[{x:0,y:0},{x:2,y:0}],0).map;
await post('/api/maps',{map:routeMap,baseVersion:0});
await post('/api/route/design',{mapId:old.id,baseVersion:1,routeId:'old-route',routeName:'原有路径',points:[{x:0,y:0},{x:2,y:0}],bodyYawDeg:0});
app.get('/__fixture',()=>({cases,boards}));
await app.listen({host:'127.0.0.1',port:4187});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
