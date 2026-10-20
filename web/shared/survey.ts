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
 // Cascade counts shown before a delete is confirmed: the map produced by this
 // recording, its routes and the navigation tasks bound to that map.
 mapVersions:number;
 routeCount:number;
 taskCount:number;
}
