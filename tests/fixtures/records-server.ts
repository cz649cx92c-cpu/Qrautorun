// 浏览器检查专用服务：内存数据库，不连接用户数据或 ROS2。
import {createApp} from '../../web/backend/src/server';
import {defaults} from '../../web/shared/model';
const app=await createApp(':memory:');
async function stopped(name:string){const session=(await app.inject({method:'POST',url:'/api/survey/start',payload:{name}})).json();await app.inject({method:'POST',url:'/api/survey/stop',payload:{}});return session;}
const first=await stopped('温室地面标记采集'),second=await stopped('温室地面标记采集'),linked=await stopped('已建图扫描');
const {map}=(await app.inject({method:'POST',url:'/api/maps/generate',payload:defaults})).json();map.id='scan-'+linked.id.replaceAll('-','');
await app.inject({method:'POST',url:'/api/maps',payload:{map,baseVersion:0}});
const address=await app.listen({host:'127.0.0.1',port:0});
console.log(JSON.stringify({address,first,second,linked}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
