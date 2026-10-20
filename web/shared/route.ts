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
 created:z.string().datetime(),
 updated:z.string().datetime()
});
export type Route=z.infer<typeof routeSchema>;
