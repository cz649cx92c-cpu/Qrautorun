import {z} from 'zod';
import {motionSegmentSchema,pointSchema} from './model';

export const routeSchema=z.object({
 routeId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
 mapId:z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
 name:z.string().trim().min(1).max(100),
 mapVersion:z.number().int().positive(),
 mapDigest:z.string().regex(/^[a-f0-9]{64}$/),
 points:z.array(pointSchema).min(2).max(501),
 motionSegments:z.array(motionSegmentSchema).min(1).max(100),
 bodyYawDeg:z.number().finite().min(-180).max(180),
 // Explicitly chosen starting body heading. null/absent means "not set by the
 // user": the editor then defaults to the first leg's travel direction.
 initialHeadingRad:z.number().finite().nullable().optional(),
 distanceModel:z.literal('center-euclidean').default('center-euclidean'),
 spacingOverrides:z.array(z.object({fromId:z.number().int().min(0).max(586),toId:z.number().int().min(0).max(586),occurrence:z.number().int().positive().default(1),targetM:z.number().finite().min(0.08).max(50)})).max(100).default([]),
 created:z.string().datetime(),
 updated:z.string().datetime()
});
export type Route=z.infer<typeof routeSchema>;

// Display identity for stored route segments: order by the stable fromId->toId chain,
// not by the persisted array index. A valid chain round-trips unchanged; a broken or
// cyclic chain keeps every segment (best effort) so nothing silently disappears.
export function orderMotionSegmentsByChain<T extends {fromId:number;toId:number}>(segments:T[]):T[]{
 if(segments.length<2)return segments.slice();
 const tos=new Set(segments.map(s=>s.toId));
 const remaining=[...segments];
 let start=remaining.findIndex(s=>!tos.has(s.fromId));
 if(start<0)start=0;
 const ordered:T[]=[remaining.splice(start,1)[0]!];
 while(remaining.length){
  const next=remaining.findIndex(s=>s.fromId===ordered[ordered.length-1]!.toId);
  if(next<0)break;
  ordered.push(remaining.splice(next,1)[0]!);
 }
 return [...ordered,...remaining];
}
