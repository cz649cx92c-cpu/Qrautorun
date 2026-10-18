import {test} from 'node:test';
import assert from 'node:assert/strict';
import {RobotLink} from '../web/backend/src/robot';

test('底盘IMU支持横移时网页仍接收草稿状态，不提升相机采集质量或执行许可',()=>{
 const robot=new RobotLink();
 const status={bootId:'offline-chassis-test',seq:1,state:'IDLE',running:false,paused:false,rowId:'',pose:null,speed:0,wheelAngle:null,tagId:null,chassis:{connected:true,feedback:null},sensors:{camera:'等待同步',odom:'底盘反馈 + IMU 已融合',imu:'在线',localization:'等待二维码'},conditions:[{id:'execution',label:'实体执行许可',ready:false}],events:[],cycleMs:1,mapping:{ready:true,quality:'draft',reason:'',localEpoch:'epoch-test',lateralSupported:true}};
 robot.update(status);
 const result=robot.status();assert.equal(result.connected,true);assert.equal(result.mapping?.lateralSupported,true);assert.equal(result.mapping?.quality,'draft');assert.equal(result.conditions[0]?.ready,false);assert.equal(result.pose,null);
 robot.update({...status,seq:2,mapping:{...status.mapping,quality:'verified'}});
 const formal=robot.status();assert.equal(formal.mapping?.quality,'verified');assert.equal(formal.conditions[0]?.ready,false);assert.equal(formal.pose,null);
 assert.throws(()=>robot.update({...status,seq:3,mapping:{...status.mapping,quality:'unknown'}}));
});
