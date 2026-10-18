import {distance,type Point} from './model';

export const ROUTE_GRID=.05;
export const GROUP_SNAP=.04;
// Prefer a measured group center to the regular drawing grid.
export function snapRoutePoint(point:Point,centers:Point[],grid=ROUTE_GRID):Point {
 const nearest=centers.reduce<Point|undefined>((best,p)=>distance(point,p)<=GROUP_SNAP+1e-9&&(!best||distance(point,p)<distance(point,best))?p:best,undefined);
 return nearest?{x:nearest.x,y:nearest.y}:{x:Math.round(point.x/grid)*grid,y:Math.round(point.y/grid)*grid};
}
export function orthogonalRoute(anchors:Point[]):Point[] {
 const points:Point[]=[];
 const append=(p:Point)=>{if(!points.length||distance(points.at(-1)!,p)>1e-8)points.push({...p});};
 for(const p of anchors){const previous=points.at(-1);if(previous&&Math.abs(p.x-previous.x)>1e-8&&Math.abs(p.y-previous.y)>1e-8){
  append(Math.abs(p.x-previous.x)>=Math.abs(p.y-previous.y)?{x:p.x,y:previous.y}:{x:previous.x,y:p.y});
 }append(p);}
 return points;
}
// Promote visible automatic corners to editable waypoints when loading a route.
export function routeCorners(points:Point[]):Point[] {
 const result:Point[]=[];
 for(const p of points){if(result.length&&distance(result.at(-1)!,p)<1e-8)continue;
  while(result.length>=2){const a=result.at(-2)!,b=result.at(-1)!;
   if(Math.abs((b.x-a.x)*(p.y-b.y)-(b.y-a.y)*(p.x-b.x))>1e-8||(b.x-a.x)*(p.x-b.x)+(b.y-a.y)*(p.y-b.y)<=0)break;
   result.pop();
  }result.push({...p});
 }return result;
}
