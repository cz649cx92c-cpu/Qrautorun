import {motionRecordSchema,validateMotionSegments} from './survey-motion';
import {z} from 'zod';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import type {Store} from './store';
import {groupsSchema,mapSchema} from '../../shared/model';
import type {Board} from '../../shared/boards';
import type {SurveySummary} from '../../shared/survey';
const finite=z.number().finite().min(-10000).max(10000);
const observation=z.object({id:z.number().int().min(0).max(586),x:finite,y:finite,angle:finite.default(0),sigma:z.number().min(.005).max(.2).default(.02),groupId:z.string().optional(),memberIds:z.array(z.number().int().min(0).max(586)).max(16).optional(),visibleCount:z.number().int().min(1).max(16).optional(),detectedCount:z.number().int().min(1).max(16).optional(),angleSigma:z.number().finite().positive().optional(),size:z.number().finite().positive().optional()});
export const sampleSchema=z.object({stamp:z.number().finite().nonnegative(),pose:z.object({x:finite,y:finite,yaw:finite}),imuYaw:finite.optional(),representation:z.enum(['board-centers','single-tags']).optional(),groupLayouts:groupsSchema.optional(),tags:z.array(observation).max(30),calibrated:z.literal(true),synchronized:z.boolean(),quality:z.enum(['verified','draft']).default('verified'),localEpoch:z.string().min(1).max(80).optional(),timestampSource:z.enum(['capture','server_receive']).optional()}).superRefine((s,ctx)=>{
 if(s.quality==='verified'&&!s.synchronized)ctx.addIssue({code:z.ZodIssueCode.custom,message:'正式观测必须通过时间同步'});
 if(s.quality==='draft'&&(s.synchronized||!s.localEpoch||s.timestampSource!=='server_receive'))ctx.addIssue({code:z.ZodIssueCode.custom,message:'草稿必须保留局部原点和未验证接收时戳'});
});
export const anchorSchema=z.object({id:z.number().int().min(0).max(586),x:finite,y:finite});
export function surveyTables(store:Store){
 store.db.exec('CREATE TABLE IF NOT EXISTS survey_motion(session_id TEXT,stamp REAL,body TEXT,PRIMARY KEY(session_id,stamp));');
 store.db.exec('CREATE TABLE IF NOT EXISTS survey_sessions(id TEXT PRIMARY KEY,name TEXT,created TEXT,state TEXT,anchors TEXT,result TEXT); CREATE TABLE IF NOT EXISTS survey_samples(session_id TEXT,stamp REAL,body TEXT,PRIMARY KEY(session_id,stamp));');
 const columns=store.db.prepare('PRAGMA table_info(survey_sessions)').all() as {name:string}[];
 if(!columns.some(c=>c.name==='stop_reason'))store.db.exec("ALTER TABLE survey_sessions ADD COLUMN stop_reason TEXT");
 if(!columns.some(c=>c.name==='boards'))store.db.exec("ALTER TABLE survey_sessions ADD COLUMN boards TEXT NOT NULL DEFAULT '[]'");
}
export function createSurvey(store:Store,name:string,layouts:Board[]=[]){const boards=groupsSchema.parse(layouts),id=randomUUID();store.db.prepare('INSERT INTO survey_sessions(id,name,created,state,anchors,result,boards) VALUES(?,?,?,?,?,?,?)').run(id,name,new Date().toISOString(),'collecting','[]',null,JSON.stringify(boards));return getSurvey(store,id);}
// 与 compileScan 的地图 ID 一致，保护已经生成地图的原始观测。
function surveyMapId(id:string){return 'scan-'+id.replaceAll('-','');}
function linkedSurveyMap(store:Store,id:string){const mapId=surveyMapId(id),draftId='draft-'+mapId;const found=store.db.prepare('SELECT map_id FROM versions WHERE map_id IN (?,?) ORDER BY CASE WHEN map_id=? THEN 0 ELSE 1 END LIMIT 1').get(mapId,draftId,mapId) as {map_id:string}|undefined;return found?.map_id??(store.db.prepare("SELECT 1 FROM tasks WHERE json_extract(body,'$.mapId')=? LIMIT 1").get(mapId)?mapId:null);}
function removableDraft(store:Store,mapId:string|null){if(!mapId?.startsWith('draft-'))return false;const item=store.get(mapId);return !!item&&item.map.coordinateStatus==='draft'&&item.map.rows.length===0&&!store.db.prepare("SELECT 1 FROM tasks WHERE json_extract(body,'$.mapId')=? LIMIT 1").get(mapId);}
export function listSurveys(store:Store):SurveySummary[]{
 const rows=store.db.prepare(`SELECT s.id,s.name,s.created,s.state,
  (SELECT COUNT(*) FROM survey_samples p WHERE p.session_id=s.id) AS sampleCount,
  (SELECT COUNT(DISTINCT json_extract(t.value,'$.id')) FROM survey_samples p,json_each(p.body,'$.tags') t WHERE p.session_id=s.id) AS groupCount
  FROM survey_sessions s ORDER BY s.created DESC,s.id DESC`).all() as Omit<SurveySummary,'mapId'|'deletable'|'protectedReason'>[];
 return rows.map(row=>{const linked=linkedSurveyMap(store,row.id),protectedReason=row.state==='collecting'?'采集中':linked&&!removableDraft(store,linked)?'已生成导航地图':null;return {...row,mapId:linked,deletable:!protectedReason,protectedReason};});
}
export function deleteSurvey(store:Store,id:string){
 return store.db.transaction(()=>{
  const row=store.db.prepare('SELECT id,name,state FROM survey_sessions WHERE id=?').get(id) as {id:string,name:string,state:string}|undefined;
  if(!row)throw Object.assign(new Error('扫描记录不存在'),{statusCode:404});
  if(row.state==='collecting')throw Object.assign(new Error('正在采集的扫描记录不能删除'),{statusCode:409});
  const linked=linkedSurveyMap(store,id);if(linked&&!removableDraft(store,linked))throw Object.assign(new Error('此扫描已生成导航地图，原始记录不能删除'),{statusCode:409});
  if(linked)store.db.prepare('DELETE FROM versions WHERE map_id=?').run(linked);
  store.db.prepare('DELETE FROM survey_motion WHERE session_id=?').run(id);
  const samples=store.db.prepare('DELETE FROM survey_samples WHERE session_id=?').run(id).changes;
  store.db.prepare('DELETE FROM survey_sessions WHERE id=?').run(id);
  return {deleted:true,id:row.id,name:row.name,sampleCount:samples};
 })();
}
export function getSurvey(store:Store,id:string){
 const s=store.db.prepare('SELECT * FROM survey_sessions WHERE id=?').get(id) as {id:string,name:string,created:string,state:string,anchors:string,result:string,boards:string}|undefined;
 if(!s)throw Object.assign(new Error('扫描记录不存在'),{statusCode:404});
 const rows=store.db.prepare('SELECT body FROM survey_samples WHERE session_id=? ORDER BY stamp').all(id) as {body:string}[];
 const samples=rows.map(r=>JSON.parse(r.body)),counts:Record<string,number>={},visibility:Record<string,{visible:number,total:number,memberIds:number[]}>={};
 const boards=groupsSchema.parse(JSON.parse(s.boards));
 for(const sample of samples)for(const tag of sample.tags){counts[tag.id]=(counts[tag.id]??0)+1;const board=boards.find(b=>b.referenceId===tag.id);if(board)visibility[board.id]={visible:tag.visibleCount??0,total:board.members.length,memberIds:tag.memberIds??[]};}
 const motionRecords=(store.db.prepare('SELECT body FROM survey_motion WHERE session_id=? ORDER BY stamp').all(id) as {body:string}[]).map(r=>JSON.parse(r.body));
 const motionValidation=validateMotionSegments(samples,motionRecords);
 return {...s,motionRecords,motionValidation,boards,anchors:JSON.parse(s.anchors),result:s.result?JSON.parse(s.result):null,samples,counts,visibility,captureQuality:samples.some(p=>p.quality==='draft')?'draft':'verified'};
}
export function appendSamples(store:Store,id:string,raw:unknown){
 const samples=z.array(sampleSchema).min(1).max(500).parse(raw),session=getSurvey(store,id);
 if(session.state!=='collecting')throw new Error('采集任务已经停止');if(session.samples.length+samples.length>10000)throw new Error('采集达到10000组，请停止并整理本次记录');
 const baseline=session.samples[0]??samples[0];
 for(const sample of samples){
  if((baseline.quality??'verified')!==sample.quality||(baseline.localEpoch??null)!==(sample.localEpoch??null))throw new Error('局部定位原点或采集质量发生变化，请保存当前记录并新建扫描');
  if(session.boards.length){
   if(sample.representation!=='board-centers')throw new Error('多码组扫描必须保存整组中心');
   const layouts=sample.groupLayouts??[];
   for(const t of sample.tags){
    const board=session.boards.find(b=>b.referenceId===t.id),snapshot=layouts.find(b=>b.id===t.groupId);
    if(!board||t.groupId!==board.id||!snapshot||JSON.stringify(snapshot)!==JSON.stringify(board))throw new Error('观测定位组布局与扫描记录不一致');
    if(!t.memberIds?.length||new Set(t.memberIds).size!==t.memberIds.length||t.visibleCount!==t.memberIds.length||t.memberIds.some(mid=>!board.members.some(m=>m.id===mid)))throw new Error('观测子码与定位组成员不符');
    const penalty=Math.max(t.memberIds.length===1?1.5:1,Math.sqrt(board.members.length/t.memberIds.length));if(t.sigma+.0000001<.01*penalty)throw new Error('部分子码定位不确定性不足');if(t.size!==undefined&&Math.abs(t.size-board.sizeMm/1000)>1e-9)throw new Error('观测整组尺寸不一致');
   }
  }else if(sample.tags.some(t=>t.groupId))throw new Error('此旧扫描未绑定多码布局，请开始新扫描');
 }
 store.db.transaction(()=>{for(const sample of samples)store.db.prepare('INSERT OR IGNORE INTO survey_samples VALUES(?,?,?)').run(id,sample.stamp,JSON.stringify(sample));store.db.prepare('UPDATE survey_sessions SET result=NULL WHERE id=?').run(id);})();return getSurvey(store,id);
}
// A real origin reset stops this recording and retains selected data.
export function appendLiveSamples(store:Store,id:string,raw:unknown[],currentEpoch?:string){
 const parsed=z.array(sampleSchema).max(10).parse(raw);
 const samples=parsed.filter(s=>s.quality!=='draft'||!currentEpoch||s.localEpoch===currentEpoch);
 if(!samples.length)return {sessionId:id,stored:0};
 return store.db.transaction(()=>{
  let session=getSurvey(store,id),activeId=id,stored=0,continuedFrom:string|undefined;
  const baseline=session.samples[0]??samples[0]!;
  if(session.samples.length+samples.length<=10000&&samples.every(s=>(baseline.quality??'verified')===s.quality&&(baseline.localEpoch??null)===(s.localEpoch??null))){
   const updated=appendSamples(store,id,samples);
   return {sessionId:id,stored:updated.samples.length-session.samples.length};
  }
  for(const sample of samples){
   const baseline=session.samples[0];
   if(baseline&&(baseline.quality??'verified')!==sample.quality)throw new Error('采集质量发生变化，请保存当前记录并新建扫描');
   const changed=!!baseline&&sample.localEpoch!==baseline.localEpoch;
   if(changed&&(!currentEpoch||sample.localEpoch!==currentEpoch))continue;
   if(changed){
    const reason='定位原点发生变化，本次扫描已保留并停止；可保存地图草稿，请新建扫描继续录制';
    store.db.prepare('UPDATE survey_sessions SET state=?,stop_reason=? WHERE id=?').run('stopped',reason,activeId);
    return {sessionId:activeId,stored,stopped:true,reason,continuedFrom:undefined};
   }
   if(session.samples.length>=10000){
    if(session.state!=='collecting')throw new Error('采集任务已经停止');
    store.db.prepare('UPDATE survey_sessions SET state=? WHERE id=?').run('stopped',activeId);
    const next=createSurvey(store,session.name,session.boards);
    if(!continuedFrom)continuedFrom=activeId;
    activeId=next.id;session=next;
   }
   const before=session.samples.length;
   session=appendSamples(store,activeId,[sample]);stored+=session.samples.length-before;
  }
  return {sessionId:activeId,stored,...(continuedFrom?{continuedFrom}:{})};
 })();
}

export function optimizationSamples(raw:unknown[]){
 const samples=z.array(sampleSchema).parse(raw);if(samples.length<=500)return samples;
 const indices=new Set<number>([0,samples.length-1]),first=new Set<number>(),last=new Map<number,number>();
 let motion='stopped';
 for(let i=0;i<samples.length;i++){
  for(const t of samples[i]!.tags){if(!first.has(t.id)){first.add(t.id);indices.add(i);}last.set(t.id,i);}
  if(i){const p=samples[i-1]!.pose,q=samples[i]!.pose,dx=q.x-p.x,dy=q.y-p.y;if(Math.hypot(dx,dy)>.01){const a=dx*Math.cos(p.yaw)+dy*Math.sin(p.yaw),b=-dx*Math.sin(p.yaw)+dy*Math.cos(p.yaw),mode=Math.abs(b)>Math.abs(a)?'lateral':a>0?'forward':'reverse';if(mode!==motion){indices.add(i-1);indices.add(i);motion=mode;}}}
 }for(const i of last.values())indices.add(i);
 if(indices.size>500)throw new Error('示教模式变化或标记过多，请分段扫描；原始观测仍已保存');
 for(let n=0;indices.size<500&&n<samples.length;n++)indices.add(Math.round(n*(samples.length-1)/499));
 return [...indices].sort((a,b)=>a-b).map(i=>samples[i]!);
}
export function optimizeSurvey(root:string,data:unknown):Promise<unknown>{return new Promise((resolve,reject)=>{const process=spawn('/usr/bin/python3',[root+'/scripts/survey_optimize.py'],{stdio:['pipe','pipe','pipe']});let output='',errors='';const timer=setTimeout(()=>{process.kill('SIGTERM');reject(new Error('优化超时，请拆分采集段'));},60000);process.stdout.on('data',c=>output+=c);process.stderr.on('data',c=>errors+=c);process.on('error',e=>{clearTimeout(timer);reject(e);});process.on('close',code=>{clearTimeout(timer);try{const result=JSON.parse(output);if(code||result.error)reject(new Error(result.error??errors));else resolve(result);}catch{reject(new Error(errors||'优化结果无效'));}});process.stdin.end(JSON.stringify(data));});}

export function appendMotionRecords(store:Store,id:string,raw:unknown){
 const records=z.array(motionRecordSchema).max(200).parse(raw);
 const active=store.db.prepare('SELECT state FROM survey_sessions WHERE id=?').get(id) as {state:string}|undefined;
 if(active?.state!=='collecting')return {stored:0};
 let stored=0;
 store.db.transaction(()=>{for(const record of records)stored+=store.db.prepare('INSERT OR IGNORE INTO survey_motion VALUES(?,?,?)').run(id,record.stamp,JSON.stringify(record)).changes;})();
 return {stored};
}

export function pointDraftMap(session:ReturnType<typeof getSurvey>,tagSizeMm=80){
 if(!session.samples.length)throw new Error('尚无定位组观测，扫描原始记录已保留');
 const epochs=new Set(session.samples.map(s=>s.localEpoch??''));
 if(epochs.size>1)throw new Error('记录包含不同定位原点，不能直接拼接地图；原始记录已保留');
 const estimates=new Map<number,{x:number;y:number;angle:number;count:number}>();
 for(const sample of session.samples){
  const c=Math.cos(sample.pose.yaw),s=Math.sin(sample.pose.yaw);
  for(const t of sample.tags){
   const x=sample.pose.x+c*t.x-s*t.y,y=sample.pose.y+s*t.x+c*t.y;
   const prev=estimates.get(t.id);
   if(prev){prev.x+=x;prev.y+=y;prev.count++;}
   else estimates.set(t.id,{x,y,angle:(sample.pose.yaw+(t.angle??0))*180/Math.PI,count:1});
  }
 }
 if(!estimates.size)throw new Error('尚无定位组观测，扫描原始记录已保留');
 const tags=[...estimates].map(([id,p])=>{
  const board=session.boards.find(b=>b.referenceId===id);
  return {id,x:p.x/p.count,y:p.y/p.count,angle:p.angle,size:board?board.sizeMm/1000:tagSizeMm/1000,...(board?{groupId:board.id}:{}),rowId:'',kind:'waypoint',rules:[]};
 });
 return mapSchema.parse({schemaVersion:1,id:'draft-scan-'+session.id.replaceAll('-',''),name:(session.name+'点位草稿').slice(0,100),frame:'map',family:'tag36h11',source:'survey',coordinateStatus:'draft',captureQuality:session.captureQuality,rows:[],tags,groups:session.boards,order:[],zone:Array.from({length:4},()=>({x:0,y:0})),vehicle:{width:.4,length:.8,margin:.05},notes:'点位草稿已保存；自动路线与行驶模式尚需校验。'});
}
