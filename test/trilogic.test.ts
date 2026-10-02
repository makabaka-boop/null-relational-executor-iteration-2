/**
 * 三值逻辑：用完整真值表核对 AND / OR / NOT 与比较运算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareValues, triAnd, triNot, triOr } from '../src/index.js';
import { AND_TABLE, NOT_TABLE, OR_TABLE, TRIS } from './helpers.js';

test('AND 真值表（全部 9 种组合）', () => {
  for (const a of TRIS) {
    for (const b of TRIS) {
      assert.equal(triAnd(a, b), AND_TABLE[a][b], `${a} AND ${b}`);
    }
  }
});

test('OR 真值表（全部 9 种组合）', () => {
  for (const a of TRIS) {
    for (const b of TRIS) {
      assert.equal(triOr(a, b), OR_TABLE[a][b], `${a} OR ${b}`);
    }
  }
});

test('NOT 真值表', () => {
  for (const a of TRIS) {
    assert.equal(triNot(a), NOT_TABLE[a], `NOT ${a}`);
  }
});

test('NULL 与任何值（包括 NULL）的比较都是 UNKNOWN', () => {
  const ops = ['=', '!=', '<', '<=', '>', '>='] as const;
  const values = [null, 0, 1, -2.5, '', 'abc', true, false];
  for (const op of ops) {
    for (const v of values) {
      assert.equal(compareValues(op, null, v), 'U', `NULL ${op} ${String(v)}`);
      assert.equal(compareValues(op, v, null), 'U', `${String(v)} ${op} NULL`);
    }
    assert.equal(compareValues(op, null, null), 'U', `NULL ${op} NULL`);
  }
});

test('数值比较', () => {
  assert.equal(compareValues('=', 1, 1), 'T');
  assert.equal(compareValues('=', 1, 2), 'F');
  assert.equal(compareValues('!=', 1, 2), 'T');
  assert.equal(compareValues('<', 1, 2), 'T');
  assert.equal(compareValues('<=', 2, 2), 'T');
  assert.equal(compareValues('>', 1, 2), 'F');
  assert.equal(compareValues('>=', 2, 2), 'T');
});

test('字符串比较（按码元字典序）', () => {
  assert.equal(compareValues('=', 'a', 'a'), 'T');
  assert.equal(compareValues('<', 'abc', 'abd'), 'T');
  assert.equal(compareValues('>', 'b', 'a'), 'T');
  assert.equal(compareValues('!=', 'a', 'b'), 'T');
});

test('布尔等值比较', () => {
  assert.equal(compareValues('=', true, true), 'T');
  assert.equal(compareValues('=', true, false), 'F');
  assert.equal(compareValues('!=', true, false), 'T');
});
