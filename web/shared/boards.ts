import {z} from 'zod';

export const boardMemberSchema=z.object({
 id:z.number().int().min(0).max(586),x:z.number().finite(),y:z.number().finite(),
 angle:z.number().finite().default(0),size:z.number().finite().min(.01).max(.15)
});
export const boardSchema=z.object({
 id:z.string().regex(/^B\d{3}$/),referenceId:z.number().int().min(0).max(586),
 gridSize:z.number().int().min(1).max(6),sizeMm:z.number().finite().min(20).max(180),gapMm:z.literal(2),
 members:z.array(boardMemberSchema).min(1).max(36)
}).superRefine((board,ctx)=>{
 if(board.members.length!==board.gridSize**2)ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板成员数量与规格不符'});
 const first=board.members[0];if(!first||first.id!==board.referenceId||board.id!==boardLabel(board.referenceId))ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板编号与首个成员不符'});
 const tile=(board.sizeMm-(board.gridSize-1)*board.gapMm)/board.gridSize;
 board.members.forEach((member,index)=>{
  const column=index%board.gridSize,row=Math.floor(index/board.gridSize);
  const x=(-board.sizeMm/2+tile/2+column*(tile+board.gapMm))/1000;
  const y=(board.sizeMm/2-tile/2-row*(tile+board.gapMm))/1000;
  if(member.id!==board.referenceId+index||Math.abs(member.x-x)>1e-9||Math.abs(member.y-y)>1e-9||Math.abs(member.angle)>1e-9||Math.abs(member.size-tile/1.25/1000)>1e-9)ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板成员几何或编号不匹配',path:['members',index]});
 });
});
export type Board=z.infer<typeof boardSchema>;
export function boardLabel(referenceId:number){return `B${String(referenceId).padStart(3,'0')}`;}
export function boardGridOptions(gridSize:number){
 if(!Number.isInteger(gridSize)||gridSize<1||gridSize>6)throw new Error('定位板规格必须为1×1至6×6');
 return {gridSize,minGroupSizeMm:Math.max(20,Math.ceil(gridSize*1.25*10+(gridSize-1)*2)),maxGroupSizeMm:180,minChildSizeMm:10};
}
export const boardPrintSchema=z.object({
 gridSize:z.number().int().min(1).max(6),groupSizeMm:z.number().finite().min(20).max(180),
 groupCount:z.number().int().min(1).max(587),startId:z.number().int().min(0).max(586),
 centerCrosshair:z.boolean().default(true)
}).superRefine((value,ctx)=>{
 const {minGroupSizeMm}=boardGridOptions(value.gridSize);
 if(value.groupSizeMm<minGroupSizeMm)ctx.addIssue({code:z.ZodIssueCode.custom,message:`${value.gridSize}×${value.gridSize}整组尺寸至少为${minGroupSizeMm}mm`,path:['groupSizeMm']});
 if(value.startId+value.groupCount*value.gridSize**2>587)ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板成员总数超出剩余AprilTag编号（0–586）',path:['groupCount']});
});
export function generateBoards(raw:unknown):Board[]{
 const request=boardPrintSchema.parse(raw),n=request.gridSize,tile=(request.groupSizeMm-(n-1)*2)/n;
 return Array.from({length:request.groupCount},(_,group)=>{
  const referenceId=request.startId+group*n*n;
  return boardSchema.parse({id:boardLabel(referenceId),referenceId,gridSize:n,sizeMm:request.groupSizeMm,gapMm:2,
   members:Array.from({length:n*n},(_,index)=>({id:referenceId+index,
    x:(-request.groupSizeMm/2+tile/2+(index%n)*(tile+2))/1000,
    y:(request.groupSizeMm/2-tile/2-Math.floor(index/n)*(tile+2))/1000,
    angle:0,size:tile/1.25/1000}))});
 });
}
/** 单个成员可恢复板中心；输入姿态必须已统一到相同坐标系。 */
export function boardPoseFromMember(board:Board,memberId:number,pose:{x:number,y:number,yaw:number}){
 const member=board.members.find(item=>item.id===memberId);if(!member)throw new Error('标记不属于此定位板');
 const yaw=pose.yaw-member.angle,c=Math.cos(yaw),s=Math.sin(yaw);
 return {x:pose.x-c*member.x+s*member.y,y:pose.y-s*member.x-c*member.y,yaw:Math.atan2(Math.sin(yaw),Math.cos(yaw))};
}
