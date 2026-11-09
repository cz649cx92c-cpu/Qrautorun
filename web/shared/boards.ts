import {z} from 'zod';

export const boardMemberSchema=z.object({
 id:z.number().int().min(0).max(586),x:z.number().finite(),y:z.number().finite(),
 angle:z.number().finite().default(0),size:z.number().finite().min(.01).max(.15)
});
const axis=z.number().int().min(1).max(6);
const sizeMm=z.number().finite().min(20).max(500);
/** 旧行只有 gridSize/sizeMm；换算后的实际值全部走这四个 helper，绝不改写库里的旧 JSON。 */
export const boardSchema=z.object({
 id:z.string().regex(/^B\d{3}$/),referenceId:z.number().int().min(0).max(586),
 gridSize:axis,sizeMm:sizeMm,gapMm:z.literal(2),
 members:z.array(boardMemberSchema).min(1).max(36),
 rows:axis.optional(),cols:axis.optional(),widthMm:sizeMm.optional(),heightMm:sizeMm.optional()
}).superRefine((board,ctx)=>{
 const rows=boardRows(board),cols=boardCols(board),widthMm=boardWidthMm(board),heightMm=boardHeightMm(board);
 if(rows*cols>36)ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板行列数乘积不能超过36'});
 if(board.gridSize!==Math.max(rows,cols))ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板 gridSize 必须等于行列数的较大值'});
 if(Math.abs(board.sizeMm-Math.max(widthMm,heightMm))>1e-9)ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板 sizeMm 必须等于整组宽高的较大值'});
 if(board.members.length!==rows*cols)ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板成员数量与规格不符'});
 const tileW=(widthMm-(cols-1)*board.gapMm)/cols;
 const tileH=(heightMm-(rows-1)*board.gapMm)/rows;
 if(!(tileW>0)||!(tileH>0)){ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板整组尺寸不足以容纳子码与白缝'});return;}
 const first=board.members[0];if(!first||first.id!==board.referenceId||board.id!==boardLabel(board.referenceId))ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板编号与首个成员不符'});
 board.members.forEach((member,index)=>{
  const column=index%cols,row=Math.floor(index/cols);
  const x=(-widthMm/2+tileW/2+column*(tileW+board.gapMm))/1000;
  const y=(heightMm/2-tileH/2-row*(tileH+board.gapMm))/1000;
  const size=Math.min(tileW,tileH)/1.25/1000;
  if(member.id!==board.referenceId+index||Math.abs(member.x-x)>1e-9||Math.abs(member.y-y)>1e-9||Math.abs(member.angle)>1e-9||Math.abs(member.size-size)>1e-9)ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板成员几何或编号不匹配',path:['members',index]});
 });
});
export type Board=z.infer<typeof boardSchema>;
export function boardLabel(referenceId:number){return `B${String(referenceId).padStart(3,'0')}`;}
/** 旧 JSON 没有 rows/cols/widthMm/heightMm：一律回落到旧的方形字段。 */
export function boardRows(board:{gridSize:number;rows?:number}){return board.rows??board.gridSize;}
export function boardCols(board:{gridSize:number;cols?:number}){return board.cols??board.gridSize;}
export function boardWidthMm(board:{sizeMm:number;widthMm?:number}){return board.widthMm??board.sizeMm;}
export function boardHeightMm(board:{sizeMm:number;heightMm?:number}){return board.heightMm??board.sizeMm;}
/** 子码黑边 10 mm 对应含静区 12.5 mm；白缝固定 2 mm。 */
export function boardMinWidthMm(cols:number){
 if(!Number.isInteger(cols)||cols<1||cols>6)throw new Error('定位板列数必须为1至6');
 return Math.max(20,Math.ceil(cols*1.25*10+(cols-1)*2));
}
export function boardMinHeightMm(rows:number){
 if(!Number.isInteger(rows)||rows<1||rows>6)throw new Error('定位板行数必须为1至6');
 return Math.max(20,Math.ceil(rows*1.25*10+(rows-1)*2));
}
export function boardGridOptions(gridSize:number){
 if(!Number.isInteger(gridSize)||gridSize<1||gridSize>6)throw new Error('定位板规格必须为1×1至6×6');
 const minGroupSizeMm=Math.max(20,Math.ceil(gridSize*1.25*10+(gridSize-1)*2));
 return {gridSize,minGroupSizeMm,maxGroupSizeMm:180,minChildSizeMm:10,
  minWidthMm:boardMinWidthMm(gridSize),minHeightMm:boardMinHeightMm(gridSize)};
}
/** 打印请求：旧字段 gridSize/groupSizeMm 仍可单独使用；新字段存在时按新字段取值。 */
export const boardPrintSchema=z.object({
 gridSize:axis.optional(),groupSizeMm:sizeMm.optional(),
 groupCount:z.number().int().min(1).max(587),startId:z.number().int().min(0).max(586),
 centerCrosshair:z.boolean().default(true),
 rows:axis.optional(),cols:axis.optional(),widthMm:sizeMm.optional(),heightMm:sizeMm.optional()
}).superRefine((value,ctx)=>{
 const rows=value.rows??value.gridSize,cols=value.cols??value.gridSize;
 const widthMm=value.widthMm??value.groupSizeMm,heightMm=value.heightMm??value.groupSizeMm;
 if(rows===undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'缺少行数（rows 或旧字段 gridSize）',path:['rows']});
 if(cols===undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'缺少列数（cols 或旧字段 gridSize）',path:['cols']});
 if(widthMm===undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'缺少整组宽（widthMm 或旧字段 groupSizeMm）',path:['widthMm']});
 if(heightMm===undefined)ctx.addIssue({code:z.ZodIssueCode.custom,message:'缺少整组高（heightMm 或旧字段 groupSizeMm）',path:['heightMm']});
 if(rows===undefined||cols===undefined||widthMm===undefined||heightMm===undefined)return;
 if(rows*cols>36)ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板行列数乘积不能超过36'});
 const minWidth=boardMinWidthMm(cols),minHeight=boardMinHeightMm(rows);
 if(widthMm<minWidth)ctx.addIssue({code:z.ZodIssueCode.custom,message:`${rows}×${cols}整组宽至少为${minWidth}mm`,path:['widthMm']});
 if(heightMm<minHeight)ctx.addIssue({code:z.ZodIssueCode.custom,message:`${rows}×${cols}整组高至少为${minHeight}mm`,path:['heightMm']});
 const tileW=(widthMm-(cols-1)*2)/cols,tileH=(heightMm-(rows-1)*2)/rows;
 if(tileW>0&&tileH>0&&Math.min(tileW,tileH)/1.25>150.0000001)ctx.addIssue({code:z.ZodIssueCode.custom,message:'子码黑边尺寸超过150mm，请减小整组尺寸或增加行列数',path:['widthMm']});
 if(value.startId+value.groupCount*rows*cols>587)ctx.addIssue({code:z.ZodIssueCode.custom,message:'定位板成员总数超出剩余AprilTag编号（0–586）',path:['groupCount']});
});
export function generateBoards(raw:unknown):Board[]{
 const request=boardPrintSchema.parse(raw);
 const rows=(request.rows??request.gridSize)!,cols=(request.cols??request.gridSize)!;
 const widthMm=(request.widthMm??request.groupSizeMm)!,heightMm=(request.heightMm??request.groupSizeMm)!;
 const tileW=(widthMm-(cols-1)*2)/cols,tileH=(heightMm-(rows-1)*2)/rows,count=rows*cols;
 const gridSize=Math.max(rows,cols),groupSizeMm=Math.max(widthMm,heightMm);
 return Array.from({length:request.groupCount},(_,group)=>{
  const referenceId=request.startId+group*count;
  return boardSchema.parse({id:boardLabel(referenceId),referenceId,gridSize,sizeMm:groupSizeMm,gapMm:2,rows,cols,widthMm,heightMm,
   members:Array.from({length:count},(_,index)=>{const column=index%cols,row=Math.floor(index/cols);return {id:referenceId+index,
    x:(-widthMm/2+tileW/2+column*(tileW+2))/1000,
    y:(heightMm/2-tileH/2-row*(tileH+2))/1000,
    angle:0,size:Math.min(tileW,tileH)/1.25/1000};})});
 });
}
/** 单个成员可恢复板中心；输入姿态必须已统一到相同坐标系。 */
export function boardPoseFromMember(board:Board,memberId:number,pose:{x:number,y:number,yaw:number}){
 const member=board.members.find(item=>item.id===memberId);if(!member)throw new Error('标记不属于此定位板');
 const yaw=pose.yaw-member.angle,c=Math.cos(yaw),s=Math.sin(yaw);
 return {x:pose.x-c*member.x+s*member.y,y:pose.y-s*member.x-c*member.y,yaw:Math.atan2(Math.sin(yaw),Math.cos(yaw))};
}
