import {readFileSync} from 'node:fs';
import type {FastifyInstance} from 'fastify';
import {root} from '../web/backend/src/server';
export async function addStraightMotion(app:FastifyInstance){
 const config=JSON.parse(readFileSync(root+'/config/web.json','utf8')),key=readFileSync(root+'/'+config.bridgeKeyFile,'utf8').trim();
 const records=Array.from({length:121},(_,i)=>({stamp:1+i*.05,seq:i,receivedMonotonic:i*.05,localEpoch:'offline-fixture',bodyGear:6,steeringGear:5,vx:.5,vy:0,vyRaw:0,wz:0,feedbackAgeS:.01,feedbackSource:'chassis_info_fb_aggregate'}));
 const response=await app.inject({method:'POST',url:'/api/robot/motion-records',headers:{'x-bridge-key':key},payload:{records}});
 if(response.statusCode!==200)throw new Error(response.body);
}
