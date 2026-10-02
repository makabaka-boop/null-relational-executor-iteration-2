/**
 * 分组聚合：NULL 归为一组、COUNT(*)/COUNT(列)/SUM(列) 语义、
 * 空聚合 SUM 为 NULL、分组按首次出现顺序、袋语义、来源证据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeQuery, type QuerySuccess } from '../src/index.js';
import {
  aggregate,
  cmp,
  col,
  filter,
  join,
  lit,
  project,
  refAggregate,
  refScan,
  rng,
  scan,
  table,
} from './helpers.js';

const sales = table(
  'sales',
  [
    ['region', 'string'],
    ['amount', 'number'],
    ['qty', 'number'],
  ],
  [
    ['s1', 'east', 100, 1],
    ['s2', 'west', 200, 2],
    ['s3', 'east', null, 3],
    ['s4', null, 50, null],
    ['s5', 'west', 300, 4],
    ['s6', null, null, null],
    ['s7', 'east', 150, 5],
  ],
);

function runAggregate(plan: Parameters<typeof executeQuery>[0]): QuerySuccess {
  const result = executeQuery(plan);
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result;
}

const groupAggs = [
  { func: 'countStar', as: 'n' },
  { func: 'count', column: 'amount', as: 'c' },
  { func: 'sum', column: 'amount', as: 'total' },
  { func: 'sum', column: 'qty', as: 'q' },
] as const;

test('分组聚合：NULL 键归为一组，分组按首次出现顺序', () => {
  const result = runAggregate({
    tables: [sales],
    plan: aggregate(scan('sales'), ['region'], [...groupAggs]),
  });
  assert.deepEqual(
    result.columns.map((c) => c.name),
    ['region', 'n', 'c', 'total', 'q'],
  );
  assert.deepEqual(
    result.rows.map((r) => r.values),
    [
      ['east', 3, 2, 250, 9], // s1, s3, s7；amount 忽略一个 NULL
      ['west', 2, 2, 500, 6], // s2, s5
      [null, 2, 1, 50, null], // s4, s6：qty 全为 NULL → SUM 为 NULL
    ],
  );
});

test('聚合组的来源证据：收集组内全部源行 ID，按首次出现顺序', () => {
  const result = runAggregate({
    tables: [sales],
    plan: aggregate(scan('sales'), ['region'], [{ func: 'countStar', as: 'n' }]),
  });
  assert.deepEqual(
    result.rows.map((r) => r.sourceIds),
    [
      ['s1', 's3', 's7'],
      ['s2', 's5'],
      ['s4', 's6'],
    ],
  );
});

test('无分组键：整个输入为单一组；COUNT(*) 计全部行，COUNT(列)/SUM(列) 忽略 NULL', () => {
  const result = runAggregate({
    tables: [sales],
    plan: aggregate(scan('sales'), [], [...groupAggs]),
  });
  assert.deepEqual(result.rows.map((r) => r.values), [[7, 5, 800, 15]]);
  assert.deepEqual(result.rows[0]!.sourceIds, ['s1', 's2', 's3', 's4', 's5', 's6', 's7']);
});

test('空输入 + 无分组键：仍产出一行，COUNT 为 0、SUM 为 NULL、无来源行', () => {
  const result = runAggregate({
    tables: [sales],
    plan: aggregate(
      filter(scan('sales'), cmp('=', col('region'), lit('nowhere'))),
      [],
      [
        { func: 'countStar', as: 'n' },
        { func: 'count', column: 'amount', as: 'c' },
        { func: 'sum', column: 'amount', as: 'total' },
      ],
    ),
  });
  assert.deepEqual(result.rows.map((r) => r.values), [[0, 0, null]]);
  assert.deepEqual(result.rows[0]!.sourceIds, []);
});

test('空输入 + 有分组键：没有任何分组，产出零行', () => {
  const result = runAggregate({
    tables: [sales],
    plan: aggregate(
      filter(scan('sales'), cmp('=', col('region'), lit('nowhere'))),
      ['region'],
      [{ func: 'countStar', as: 'n' }],
    ),
  });
  assert.deepEqual(result.rows, []);
});

test('多列分组键：NULL 与非 NULL 的各种组合都是不同的组', () => {
  const t = table(
    't',
    [
      ['a', 'string'],
      ['b', 'number'],
    ],
    [
      ['r1', 'x', null],
      ['r2', null, 1],
      ['r3', 'x', null],
      ['r4', null, null],
      ['r5', null, 1],
      ['r6', null, null],
    ],
  );
  const result = runAggregate({
    tables: [t],
    plan: aggregate(scan('t'), ['a', 'b'], [{ func: 'countStar', as: 'n' }]),
  });
  assert.deepEqual(
    result.rows.map((r) => r.values),
    [
      ['x', null, 2],
      [null, 1, 2],
      [null, null, 2],
    ],
  );
});

test('袋语义：完全重复的行被重复计数', () => {
  const t = table('t', [['v', 'number']], [
    ['r1', 5],
    ['r2', 5],
    ['r3', 5],
  ]);
  const result = runAggregate({
    tables: [t],
    plan: aggregate(scan('t'), ['v'], [
      { func: 'countStar', as: 'n' },
      { func: 'sum', column: 'v', as: 'total' },
    ]),
  });
  assert.deepEqual(result.rows.map((r) => r.values), [[5, 3, 15]]);
});

test('连接后聚合：来源证据跨表收集且去重', () => {
  const l = table('l', [['k', 'number']], [['l1', 1]]);
  const r = table('r', [['k', 'number']], [
    ['r1', 1],
    ['r2', 1],
  ]);
  const result = runAggregate({
    tables: [l, r],
    plan: aggregate(join(scan('l'), scan('r'), 'k', 'k'), [], [
      { func: 'countStar', as: 'n' },
    ]),
  });
  // 连接产出 [l1,r1] 与 [l1,r2] 两行；聚合后 l1 只出现一次
  assert.deepEqual(result.rows.map((row) => row.values), [[2]]);
  assert.deepEqual(result.rows[0]!.sourceIds, ['l1', 'r1', 'r2']);
});

test('聚合后投影：按输出名引用，来源证据透传', () => {
  const result = runAggregate({
    tables: [sales],
    plan: project(aggregate(scan('sales'), ['region'], [{ func: 'sum', column: 'amount', as: 'total' }]), [
      'total',
      { name: 'region', as: 'area' },
    ]),
  });
  assert.deepEqual(
    result.columns.map((c) => c.name),
    ['total', 'area'],
  );
  assert.deepEqual(
    result.rows.map((r) => r.values),
    [
      [250, 'east'],
      [500, 'west'],
      [50, null],
    ],
  );
  assert.deepEqual(result.rows[0]!.sourceIds, ['s1', 's3', 's7']);
});

test('随机交叉核对：引擎聚合与线性查找分组的参考实现一致', () => {
  const rand = rng(777);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  for (let iter = 0; iter < 150; iter += 1) {
    const regions = ['east', 'west', 'north', null, null];
    const rows = Array.from({ length: Math.floor(rand() * 30) }, (_, i) => [
      `r${i}`,
      pick(regions),
      rand() < 0.3 ? null : Math.floor(rand() * 100),
      rand() < 0.3 ? null : Math.floor(rand() * 10),
    ]) as [string, string | null, number | null, number | null][];
    const t = table(
      't',
      [
        ['region', 'string'],
        ['amount', 'number'],
        ['qty', 'number'],
      ],
      rows,
    );
    const aggs = [
      { func: 'countStar', as: 'n' },
      { func: 'count', column: 'amount', as: 'c' },
      { func: 'sum', column: 'amount', as: 'total' },
      { func: 'sum', column: 'qty', as: 'q' },
    ] as const;
    const groupBy = rand() < 0.5 ? ['region'] : [];
    const engine = executeQuery({
      tables: [t],
      plan: aggregate(scan('t'), groupBy, [...aggs]),
    });
    assert.ok(engine.ok, `iter ${iter}: ${JSON.stringify(engine)}`);
    const expected = refAggregate(refScan(t), groupBy, [...aggs]);
    assert.deepEqual(
      engine.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
      expected.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
      `iter ${iter}`,
    );
  }
});
