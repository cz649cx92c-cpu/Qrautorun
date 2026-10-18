export interface SurveySummary {
 id:string;
 name:string;
 created:string;
 state:'collecting'|'stopped';
 sampleCount:number;
 groupCount:number;
 mapId:string|null;
 deletable:boolean;
 protectedReason:string|null;
}
