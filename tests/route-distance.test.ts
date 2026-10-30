import assert from 'node:assert/strict';
import {distance, type Point} from '../web/shared/model';
import {previewTarget,polylineDistance} from '../web/shared/route-distance';
const a={x:0,y:0},b={x:1,y:0};
assert.equal(distance(a,b),1); assert.equal(polylineDistance([a,{x:0,y:1},b],a,b),Math.SQRT2+1);
const p=previewTarget([a,b],a,b,1.5); assert.equal(p.points[1]!.x,1.5); assert.equal(p.targetM,1.5);
assert.throws(()=>previewTarget([a,b],a,b,.01));
const corner=previewTarget([a,{x:1,y:0},{x:1,y:1}],a,{x:1,y:0},.8); assert.equal(corner.affectedSegments.length,1);
console.log('route distance tests passed');

console.log('override validation covered by compile gate');
