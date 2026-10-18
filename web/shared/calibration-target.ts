import {z} from 'zod';

export const tagFamilies=['auto','tag36h11','tag36h10','tag25h9','tag16h5'] as const;
const familyCapacity={tag36h11:587,tag36h10:2320,tag25h9:35,tag16h5:30};
const aprilGrid=z.object({
 type:z.literal('aprilgrid'),family:z.enum(tagFamilies),
 rows:z.number().int().min(2).max(12),columns:z.number().int().min(2).max(12),
 tagSizeMm:z.number().finite().min(3).max(200),gapMm:z.number().finite().min(.1).max(200),
 layoutMode:z.enum(['auto','manual']).default('manual'),
 firstId:z.number().int().min(0).max(2319).default(0),
 idOrder:z.enum(['row-major','column-major']).default('row-major')
});
const checkerboard=z.object({
 type:z.literal('checkerboard'),columns:z.number().int().min(3).max(20),rows:z.number().int().min(3).max(20),
 squareSizeMm:z.number().finite().min(1).max(200)
});
export const calibrationTargetSchema=z.discriminatedUnion('type',[
 z.object({type:z.literal('registered'),boardId:z.string()}),aprilGrid,checkerboard
]).superRefine((t,ctx)=>{
 if(t.type==='aprilgrid'&&(t.layoutMode==='manual'?t.firstId:0)+t.rows*t.columns>(t.family==='auto'?2320:familyCapacity[t.family]))
  ctx.addIssue({code:z.ZodIssueCode.custom,message:'此码族的编号数量不足，请核对码族、起始ID和板规格'});
});
export type CalibrationTarget=z.infer<typeof calibrationTargetSchema>;
