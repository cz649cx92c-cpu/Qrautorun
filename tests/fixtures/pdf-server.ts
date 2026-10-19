import {createApp} from '../../web/backend/src/server';
const app=await createApp(':memory:');
await app.listen({host:'127.0.0.1',port:4183});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await app.close();process.exit(0);});
