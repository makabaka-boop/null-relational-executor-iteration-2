/**
 * 等值连接：NULL 键不能连接、袋语义保留重复、左行优先顺序、
 * 重名列限定、来源证据。用独立的哈希索引参考实现交叉核对。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeQuery, type QuerySuccess } from '../src/index.js';
import { join, refJoin, refScan, rng, scan, table } from './helpers.js';

const users = table(
  'users',
  [
    ['id', 'number'],
    ['name', 'string'],
    ['deptId', 'number'],
  ],
  [
    ['u1', 1, 'alice', 10],
    ['u2', 2, 'bob', 20],
    ['u3', 3, 'carol', 10],
    ['u4', 4, 'dave', null], // NULL 外键：不能连接
    ['u5', 5, 'erin', 99], // 无匹配部门
  ],
);

const departments = table(
  'departments',
  [
    ['id', 'number'],
    ['dname', 'string'],
  ],
  [
    ['d1', 10, 'eng'],
    ['d2', 20, 'sales'],
    ['d3', null, 'hr'], // NULL 主键：不能连接
  ],
);

function runJoin(): QuerySuccess {
  const result = executeQuery({
    tables: [users, departments],
    plan: join(scan('users'), scan('departments'), 'deptId', 'id'),
  });
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result;
}

test('等值连接：匹配行、左行优先顺序、NULL 键被排除', () => {
  const result = runJoin();
  assert.deepEqual(
    result.rows.map((r) => r.sourceIds),
    [
      ['u1', 'd1'],
      ['u2', 'd2'],
      ['u3', 'd1'],
    ],
  );
  // u4（deptId 为 NULL）、u5（无匹配）、d3（id 为 NULL）都不出现
});

test('连接列名冲突时两侧都限定为 表名.列名', () => {
  const result = runJoin();
  assert.deepEqual(
    result.columns.map((c) => c.name),
    ['users.id', 'name', 'deptId', 'departments.id', 'dname'],
  );
  assert.deepEqual(result.rows[0]!.values, [1, 'alice', 10, 10, 'eng']);
});

test('袋语义：重复键产生笛卡尔积式的重复行，顺序为左行优先', () => {
  const l = table('l', [['k', 'number']], [
    ['l1', 1],
    ['l2', 1],
    ['l3', 2],
  ]);
  const r = table('r', [['k', 'number']], [
    ['r1', 1],
    ['r2', 1],
    ['r3', 1],
    ['r4', 2],
  ]);
  const result = executeQuery({ tables: [l, r], plan: join(scan('l'), scan('r'), 'k', 'k') });
  assert.ok(result.ok);
  assert.deepEqual(
    result.rows.map((row) => row.sourceIds),
    [
      ['l1', 'r1'],
      ['l1', 'r2'],
      ['l1', 'r3'],
      ['l2', 'r1'],
      ['l2', 'r2'],
      ['l2', 'r3'],
      ['l3', 'r4'],
    ],
  );
});

test('NULL = NULL 不成立：两侧 NULL 键互不连接', () => {
  const l = table('l', [['k', 'number']], [['l1', null]]);
  const r = table('r', [['k', 'number']], [['r1', null]]);
  const result = executeQuery({ tables: [l, r], plan: join(scan('l'), scan('r'), 'k', 'k') });
  assert.ok(result.ok);
  assert.deepEqual(result.rows, []);
});

test('自连接需要别名区分两侧，输出列全部限定', () => {
  const employees = table(
    'employees',
    [
      ['id', 'number'],
      ['mgrId', 'number'],
    ],
    [
      ['e1', 1, null],
      ['e2', 2, 1],
      ['e3', 3, 1],
      ['e4', 4, 2],
    ],
  );
  const bad = executeQuery({
    tables: [employees],
    plan: join(scan('employees'), scan('employees'), 'mgrId', 'id'),
  });
  assert.ok(!bad.ok);
  assert.match(bad.errors.join('\n'), /alias/i);

  const good = executeQuery({
    tables: [employees],
    plan: join(scan('employees', 'e'), scan('employees', 'm'), 'mgrId', 'id'),
  });
  assert.ok(good.ok);
  assert.deepEqual(
    good.columns.map((c) => c.name),
    ['e.id', 'e.mgrId', 'm.id', 'm.mgrId'],
  );
  assert.deepEqual(
    good.rows.map((r) => r.sourceIds),
    [
      ['e2', 'e1'],
      ['e3', 'e1'],
      ['e4', 'e2'],
    ],
  );
});

test('随机交叉核对：引擎（嵌套循环）与参考实现（哈希索引）结果一致', () => {
  const rand = rng(20261001);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  for (let iter = 0; iter < 150; iter += 1) {
    // 小值域制造大量重复键；约 1/4 的键为 NULL
    const domain = [1, 2, 3, null, null] as const;
    const mkRows = (prefix: string, n: number): [string, number | null, number][] =>
      Array.from({ length: n }, (_, i) => [
        `${prefix}${i}`,
        pick(domain),
        Math.floor(rand() * 5),
      ] as [string, number | null, number]);
    const l = table(
      'tl',
      [
        ['k', 'number'],
        ['v', 'number'],
      ],
      mkRows('L', Math.floor(rand() * 25)),
    );
    const r = table(
      'tr',
      [
        ['k', 'number'],
        ['w', 'number'],
      ],
      mkRows('R', Math.floor(rand() * 25)),
    );
    const engine = executeQuery({ tables: [l, r], plan: join(scan('tl'), scan('tr'), 'k', 'k') });
    assert.ok(engine.ok, `iter ${iter}: ${JSON.stringify(engine)}`);
    const expected = refJoin(refScan(l), refScan(r), 'k', 'k');
    assert.deepEqual(
      engine.rows.map((row) => ({ values: row.values, sourceIds: row.sourceIds })),
      expected.rows.map((row) => ({ values: row.values, sourceIds: row.sourceIds })),
      `iter ${iter}`,
    );
  }
});
