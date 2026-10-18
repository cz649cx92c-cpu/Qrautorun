// 仅用于真实摄像头浏览器检查，扫描和定位组都保存在内存数据库。
import {createApp} from '../../web/backend/src/server';
const app=await createApp(':memory:');
const registration=await app.inject({method:'POST',url:'/api/boards/pdf',payload:{gridSize:2,groupSizeMm:140,groupCount:1,startId:500}});
if(registration.statusCode!==200)throw new Error(registration.body);
const address=await app.listen({host:'127.0.0.1',port:0});console.log(JSON.stringify({address}));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
