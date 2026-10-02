/**
 * 筛选节点：WHERE 只保留 TRUE；UNKNOWN 与 FALSE 都丢弃。
 * 用独立的真值表参考求值器交叉核对。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeQuery, type Predicate, type QuerySuccess } from '../src/index.js';
import {
  andP,
  cmp,
  col,
  filter,
  isNotNullP,
  isNullP,
  lit,
  notP,
  orP,
  refFilter,
  refScan,
  scan,
  table,
} from './helpers.js';

// a、b 数值列（含 NULL），s 字符串列（含 NULL）
const t = table(
  't',
  [
    ['a', 'number'],
    ['b', 'number'],
    ['s', 'string'],
  ],
  [
    ['r1', 1, 1, 'x'],
    ['r2', 2, null, 'y'],
    ['r3', null, 3, null],
    ['r4', 2, 2, 'x'],
    ['r5', null, null, 'z'],
  ],
);

function runFilter(pred: Predicate): QuerySuccess {
  const result = executeQuery({ tables: [t], plan: filter(scan('t'), pred) });
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result;
}

function keptIds(pred: Predicate): unknown[] {
  return runFilter(pred).rows.map((r) => r.sourceIds[0]);
}

test('等值筛选只保留 TRUE 的行，保持输入顺序', () => {
  assert.deepEqual(keptIds(cmp('=', col('a'), lit(2))), ['r2', 'r4']);
});

test('!= 中 NULL 行为 UNKNOWN，被丢弃', () => {
  assert.deepEqual(keptIds(cmp('!=', col('a'), lit(2))), ['r1']);
});

test('列与列比较：任一侧为 NULL 即 UNKNOWN', () => {
  assert.deepEqual(keptIds(cmp('=', col('a'), col('b'))), ['r1', 'r4']);
});

test('IS NULL / IS NOT NULL', () => {
  assert.deepEqual(keptIds(isNullP(col('a'))), ['r3', 'r5']);
  assert.deepEqual(keptIds(isNotNullP(col('a'))), ['r1', 'r2', 'r4']);
});

test('AND：UNKNOWN 与 TRUE 得 UNKNOWN，被丢弃', () => {
  assert.deepEqual(keptIds(andP(cmp('=', col('a'), lit(2)), cmp('=', col('b'), lit(2)))), ['r4']);
});

test('OR：FALSE 或 UNKNOWN 得 UNKNOWN，被丢弃', () => {
  assert.deepEqual(keptIds(orP(cmp('=', col('a'), lit(1)), cmp('=', col('b'), lit(3)))), [
    'r1',
    'r3',
  ]);
});

test('NOT：NOT UNKNOWN 仍是 UNKNOWN，被丢弃', () => {
  assert.deepEqual(keptIds(notP(cmp('=', col('a'), lit(2)))), ['r1']);
});

test('OR 与 IS NULL 组合可以命中 NULL 行', () => {
  assert.deepEqual(keptIds(orP(cmp('=', col('a'), lit(2)), isNullP(col('a')))), [
    'r2',
    'r3',
    'r4',
    'r5',
  ]);
});

test('常量谓词', () => {
  assert.deepEqual(keptIds({ kind: 'constant', value: false }), []);
  assert.deepEqual(keptIds({ kind: 'constant', value: true }), ['r1', 'r2', 'r3', 'r4', 'r5']);
});

test('与 NULL 字面量比较恒为 UNKNOWN，一行不留', () => {
  assert.deepEqual(keptIds(cmp('=', col('a'), lit(null))), []);
  assert.deepEqual(keptIds(cmp('!=', col('a'), lit(null))), []);
});

test('来源证据：保留下来的行携带自己的源行 ID', () => {
  const result = runFilter(cmp('>=', col('a'), lit(1)));
  assert.deepEqual(
    result.rows.map((r) => r.sourceIds),
    [['r1'], ['r2'], ['r4']],
  );
});

test('批量交叉核对：引擎结果与真值表参考求值器一致', () => {
  // 构造一批谓词：列×字面量×运算符，再两两用 AND/OR/NOT 组合
  const literalValues = [1, 2, null, 'x', 'y'] as const;
  const base: Predicate[] = [];
  for (const column of ['a', 'b', 's']) {
    for (const v of literalValues) {
      // 只构造类型合法的比较（NULL 字面量与任何列都兼容）
      const litType = v === null ? 'any' : typeof v === 'number' ? 'number' : 'string';
      const colType = column === 's' ? 'string' : 'number';
      if (litType === 'any' || litType === colType) {
        for (const op of ['=', '!=', '<', '<=', '>', '>='] as const) {
          base.push(cmp(op, col(column), lit(v)));
        }
      }
    }
  }
  base.push(isNullP(col('a')), isNotNullP(col('b')));
  const predicates: Predicate[] = [...base];
  for (let i = 0; i < base.length; i += 1) {
    for (let j = 0; j < base.length; j += 7) {
      predicates.push(andP(base[i]!, base[j]!));
      predicates.push(orP(base[i]!, base[j]!));
      predicates.push(notP(orP(base[i]!, base[j]!)));
    }
  }
  const reference = refScan(t);
  for (const pred of predicates) {
    const engine = runFilter(pred);
    const expected = refFilter(reference, pred);
    assert.deepEqual(
      engine.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
      expected.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
      `predicate ${JSON.stringify(pred)}`,
    );
  }
});
