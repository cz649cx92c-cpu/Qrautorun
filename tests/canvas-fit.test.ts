/**
 * 默认 fit（tags-and-route）必须让**每一个合法 tag** 都落在包围盒内。
 *
 * 存在的唯一目的：防止「离群剔除」把合法的远端码排除在包围盒外——那会让该码落到
 * 可视区之外，等同于把用户自己的码隐藏起来。同时确认 zone（人工图幅边界）不会
 * 把默认视图挤小；zone 只在 whole-map 模式纳入。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {computeFitBounds} from '../web/frontend/src/composables/useCanvasFit';

const contains = (b: {minX: number; minY: number; maxX: number; maxY: number}, p: {x: number; y: number}) =>
  p.x >= b.minX && p.x <= b.maxX && p.y >= b.minY && p.y <= b.maxY;

test('默认 fit：合法远端码仍在包围盒内（不做离群剔除）', () => {
  // 主群聚在 (0,0) 附近，另有一个合法的远端码在 (30,0)。
  // 旧实现会把 (30,0) 当离群点剔除，包围盒只覆盖主群。
  const tags = [
    {x: 0, y: 0}, {x: 1, y: 0}, {x: 0, y: 1}, {x: 1, y: 1},
    {x: 30, y: 0},
  ];
  const result = computeFitBounds({tags, mode: 'tags-and-route'});
  assert.ok(result, '有效点足够时必须返回包围盒');
  assert.equal(result!.excludedOutliers, 0, '默认 fit 不得剔除任何合法 tag');
  assert.equal(result!.usedPoints, tags.length, '全部 tag 都应参与包围盒');
  for (const tag of tags) {
    assert.ok(contains(result!.bounds, tag), `tag (${tag.x},${tag.y}) 必须落在包围盒内`);
  }
});

test('默认 fit：zone 不参与，不会把视图挤小', () => {
  // 真实码集中在小范围内；zone 是一个大得多的手绘图幅边界。
  const tags = [{x: 0, y: 0}, {x: 2, y: 0}, {x: 2, y: 2}, {x: 0, y: 2}];
  const zone = [{x: -50, y: -50}, {x: 60, y: -50}, {x: 60, y: 60}, {x: -50, y: 60}];

  const def = computeFitBounds({tags, zone, mode: 'tags-and-route'});
  const whole = computeFitBounds({tags, zone, mode: 'whole-map'});
  assert.ok(def && whole);

  // 默认视图必须比 whole-map 明显更紧（zone 没有把它撑大）
  const defW = def!.bounds.maxX - def!.bounds.minX;
  const wholeW = whole!.bounds.maxX - whole!.bounds.minX;
  assert.ok(defW < wholeW, `默认视图宽度 ${defW} 应小于 whole-map 宽度 ${wholeW}`);
  assert.ok(def!.bounds.minX > zone[0]!.x, '默认视图左边界不得扩到 zone 之外');

  // 但每一个真实 tag 仍然完整可见
  for (const tag of tags) {
    assert.ok(contains(def!.bounds, tag), `tag (${tag.x},${tag.y}) 必须在默认包围盒内`);
  }

  // whole-map 才纳入 zone
  assert.ok(whole!.bounds.minX <= zone[0]!.x, 'whole-map 必须覆盖 zone 左边界');
});
