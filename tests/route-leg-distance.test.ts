import test from 'node:test';
import assert from 'node:assert/strict';
import {previewLegDistance,MIN_LEG_DISTANCE_M} from '../web/shared/route-leg-distance';

const anchors=(...pairs:[number,number][]) => pairs.map(([x,y])=>({x,y}));

test('路段距离：只改路径锚点，末段只移动终点，等距关系正确',()=>{
 const a=anchors([0,0],[0.6,0],[1.2,0],[1.8,0]);
 const preview=previewLegDistance(a,2,0.9);
 assert.equal(preview.ready,true,JSON.stringify(preview.issues));
 assert.equal(preview.axis,'horizontal');
 assert.ok(Math.abs(preview.beforeM-0.6)<1e-9);
 assert.ok(Math.abs(preview.afterM-0.9)<1e-9);
 assert.equal(preview.mode,'move-endpoint','同向后续段只移终点');
 assert.equal(preview.anchors[1]!.x,0.6,'前一段不动');
 assert.ok(Math.abs(preview.anchors[2]!.x-1.5)<1e-9,'终点相对上一点移动到 0.6+0.9');
 assert.equal(preview.anchors[3]!.x,1.8,'后续点不动');
 assert.equal(preview.distance.cm,90);
 assert.equal(preview.distance.mm,900);
 assert.equal(a[2]!.x,1.2,'入参不能被修改');
});

test('路段距离：拐角处整体平移后续点，保持正交与后续段长',()=>{
 const a=anchors([0,0],[0.6,0],[0.6,0.6],[1.2,0.6]);
 const preview=previewLegDistance(a,1,0.4);
 assert.equal(preview.ready,true,JSON.stringify(preview.issues));
 assert.equal(preview.mode,'shift-tail');
 assert.ok(Math.abs(preview.anchors[1]!.x-0.4)<1e-9);
 assert.equal(preview.anchors[1]!.y,0);
 const shift=preview.anchors[2]!.x-0.6;
 assert.ok(Math.abs(preview.anchors[2]!.y-0.6)<1e-9,'纵向段长度不变');
 assert.ok(Math.abs(preview.anchors[3]!.x-(1.2+shift))<1e-9,'后续点整体平移');
 assert.ok(Math.abs(preview.anchors[3]!.y-0.6)<1e-9);
 assert.equal(preview.movedIndexes.length,3);
});

test('路段距离：竖直线按 y 方向调整，方向符号正确',()=>{
 const a=anchors([0,0],[0,0.5]);
 const shrink=previewLegDistance(a,1,0.2);
 assert.equal(shrink.ready,true);
 assert.ok(Math.abs(shrink.anchors[1]!.y-0.2)<1e-9,'缩短时向起点方向移动');
 const grow=previewLegDistance(a,1,1.5);
 assert.equal(grow.ready,true);
 assert.ok(Math.abs(grow.anchors[1]!.y-1.5)<1e-9,'加长时向远端移动');
});

test('路段距离：斜段/过小/过大/非法索引/首点一律拒绝且不改锚点',()=>{
 const diagonal=previewLegDistance(anchors([0,0],[1,1]),1,0.5);
 assert.equal(diagonal.ready,false);
 assert.equal(diagonal.issues[0]!.code,'not-orthogonal');
 const small=previewLegDistance(anchors([0,0],[0.6,0]),1,MIN_LEG_DISTANCE_M-0.001);
 assert.equal(small.issues[0]!.code,'too-small');
 const big=previewLegDistance(anchors([0,0],[0.6,0]),1,51);
 assert.equal(big.issues[0]!.code,'too-large');
 assert.equal(previewLegDistance(anchors([0,0],[0.6,0]),0,0.5).issues[0]!.code,'bad-index');
 assert.equal(previewLegDistance(anchors([0,0],[0.6,0]),2,0.5).issues[0]!.code,'bad-index');
 assert.equal(previewLegDistance(anchors([0,0],[0.6,0]),1,Number.NaN).issues[0]!.code,'bad-target');
 const source=anchors([0,0],[0.6,0]);
 previewLegDistance(source,1,0.001);
 assert.equal(source[1]!.x,0.6,'拒绝时不得改动锚点');
});

test('路段距离：微米取整，避免浮点噪声进入路径',()=>{
 const preview=previewLegDistance(anchors([0.1,0.2],[0.7000000001,0.2]),1,0.35);
 assert.equal(preview.ready,true);
 assert.equal(preview.anchors[1]!.x,0.45,'坐标按 1e-6 取整');
 assert.equal(preview.afterM,0.35);
});
