import {z} from 'zod';
export const taskSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),name:z.string().min(1).max(100),mapId:z.string().min(1),mapVersion:z.number().int().positive(),rowOrder:z.array(z.string()).min(1).max(100),forwardSpeed:z.number().min(0.02).max(0.2),reverseSpeed:z.number().min(0.02).max(0.15),lateralSpeed:z.number().min(0.02).max(0.1),endWaitSeconds:z.number().min(0).max(600),returnToStart:z.boolean().default(false),enabled:z.boolean().default(true)});
export type Task=z.infer<typeof taskSchema>;
