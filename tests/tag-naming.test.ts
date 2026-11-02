/**
 * 二维码别名（现场名称）的语义边界。
 *
 * 这些断言存在的唯一目的：证明「名称只是显示层」。任何一条失败都意味着真实
 * tag36h11 编号可能被别名污染，而编号是导航、打印、校验与地图摘要的共同基准。
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTagAliasName,
  checkTagAliasName,
  aliasMap,
  aliasNameFor,
  tagAliasNameKey,
  tagQrId,
  TAG_ALIAS_MAX_LENGTH,
  TAG_ALIAS_DISCLAIMER,
} from '../web/shared/tag-naming';

test('别名规范化：折叠空白、去首尾、全角转半角', () => {
  assert.equal(normalizeTagAliasName('  东头   桩  '), '东头 桩');
  assert.equal(normalizeTagAliasName('Ａ１'), 'A1');
  assert.equal(normalizeTagAliasName(''), '');
  assert.equal(normalizeTagAliasName(null), '');
  assert.equal(normalizeTagAliasName(undefined), '');
});

test('别名校验：拒绝空、拒绝冒充编号、拒绝超长', () => {
  assert.equal(checkTagAliasName('东头桩').ok, true);
  assert.equal(checkTagAliasName('  ').ok, false);
  // 冒充编号会让现场无法区分「名称」与「编号」，必须拒绝
  assert.equal(checkTagAliasName('Q012').ok, false);
  assert.equal(checkTagAliasName('q12').ok, false);
  assert.equal(checkTagAliasName('12').ok, false);
  assert.equal(checkTagAliasName('0').ok, false);
  const tooLong = 'A'.repeat(TAG_ALIAS_MAX_LENGTH + 1);
  assert.equal(checkTagAliasName(tooLong).ok, false);
  assert.equal(checkTagAliasName('A'.repeat(TAG_ALIAS_MAX_LENGTH)).ok, true);
});

test('别名查表：空值安全，且绝不把编号当名称返回', () => {
  assert.deepEqual([...aliasMap(null)], []);
  assert.deepEqual([...aliasMap(undefined)], []);
  assert.equal(aliasNameFor(12, null), null);
  assert.equal(aliasNameFor(12, [{tagId: 12, name: '东头桩', updated: ''}]), '东头桩');
  // 没有别名时返回 null，而不是编号字符串
  assert.equal(aliasNameFor(12, [{tagId: 7, name: 'x', updated: ''}]), null);
});

test('别名查表：支持对象数组与 [id,name] 元组两种形态', () => {
  const objects = aliasMap([{tagId: 3, name: '甲', updated: ''}, {tagId: 5, name: '乙', updated: ''}]);
  assert.equal(objects.get(3), '甲');
  assert.equal(objects.get(5), '乙');
  const tuples = aliasMap([[3, '甲'], [5, '乙']] as const);
  assert.equal(tuples.get(3), '甲');
  assert.equal(tuples.get(5), '乙');
  // 空名不进表
  const mixed = aliasMap([{tagId: 3, name: '   ', updated: ''}]);
  assert.equal(mixed.has(3), false);
});

test('别名去重键：大小写与空白不敏感', () => {
  assert.equal(tagAliasNameKey('  East  Post '), tagAliasNameKey('east post'));
  assert.notEqual(tagAliasNameKey('东头'), tagAliasNameKey('西头'));
});

test('编号格式固定为 Q + 三位，且不受别名影响', () => {
  assert.equal(tagQrId(0), 'Q000');
  assert.equal(tagQrId(12), 'Q012');
  assert.equal(tagQrId(586), 'Q586');
  // 编号永远是编号本身：别名只在标签串里追加
  assert.ok(TAG_ALIAS_DISCLAIMER.includes('名称只是现场别名'));
});
