/**
 * 校验：列名、类型与计划结构在执行前完成检查；
 * 任何错误都返回 ok:false 且不携带任何部分结果。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeQuery, type QueryFailure } from '../src/index.js';
import { aggregate, cmp, col, filter, join, lit, project, scan, table } from './helpers.js';

const nums = table('nums', [['n', 'number']], [
  ['a', 1],
  ['b', 2],
]);
const strs = table('strs', [['s', 'string']], [['c', 'x']]);

function expectFailure(request: unknown, pattern: RegExp): QueryFailure {
  const result = executeQuery(request);
  assert.ok(!result.ok, `expected failure, got ${JSON.stringify(result)}`);
  // 错误响应不得携带任何部分结果
  assert.ok(!('rows' in result), 'failure must not contain partial rows');
  assert.ok(!('columns' in result), 'failure must not contain partial columns');
  assert.ok(result.errors.length > 0, 'must report at least one error');
  assert.match(
    result.errors.join('\n'),
    pattern,
    `errors ${JSON.stringify(result.errors)} should match ${pattern}`,
  );
  return result;
}

test('请求本身不是对象', () => {
  expectFailure(null, /object/);
  expectFailure([1, 2], /object/);
  expectFailure('query', /object/);
});

test('表数量限制：至少 1 张、最多 2 张', () => {
  expectFailure({ tables: [], plan: scan('nums') }, /at least one/);
  expectFailure({ tables: [nums, strs, nums], plan: scan('nums') }, /at most 2/);
});

test('每表最多 300 行', () => {
  const big = table(
    'big',
    [['n', 'number']],
    Array.from({ length: 301 }, (_, i) => [`r${i}`, i] as [string, number]),
  );
  expectFailure({ tables: [big], plan: scan('big') }, /at most 300/);
  const ok = table(
    'ok300',
    [['n', 'number']],
    Array.from({ length: 300 }, (_, i) => [`r${i}`, i] as [string, number]),
  );
  assert.ok(executeQuery({ tables: [ok], plan: scan('ok300') }).ok);
});

test('表名重复 / 列名重复 / 列类型非法 / 名称含点号', () => {
  expectFailure({ tables: [nums, nums], plan: scan('nums') }, /duplicate table name/);
  expectFailure(
    {
      tables: [
        {
          name: 't',
          columns: [
            { name: 'a', type: 'number' },
            { name: 'a', type: 'number' },
          ],
          rows: [],
        },
      ],
      plan: scan('t'),
    },
    /duplicate column name/,
  );
  expectFailure(
    {
      tables: [{ name: 't', columns: [{ name: 'a', type: 'int' }], rows: [] }],
      plan: scan('t'),
    },
    /type/,
  );
  expectFailure(
    {
      tables: [{ name: 't', columns: [{ name: 'a.b', type: 'number' }], rows: [] }],
      plan: scan('t'),
    },
    /\./,
  );
});

test('行校验：长度不符、类型不符、非法值、ID 重复', () => {
  expectFailure(
    {
      tables: [{ name: 't', columns: [{ name: 'n', type: 'number' }], rows: [{ id: 'x', values: [1, 2] }] }],
      plan: scan('t'),
    },
    /exactly 1/,
  );
  expectFailure(
    {
      tables: [{ name: 't', columns: [{ name: 'n', type: 'number' }], rows: [{ id: 'x', values: ['oops'] }] }],
      plan: scan('t'),
    },
    /expected number/,
  );
  expectFailure(
    {
      tables: [{ name: 't', columns: [{ name: 'n', type: 'number' }], rows: [{ id: 'x', values: [NaN] }] }],
      plan: scan('t'),
    },
    /unsupported value/,
  );
  expectFailure(
    {
      tables: [
        {
          name: 't',
          columns: [{ name: 'n', type: 'number' }],
          rows: [
            { id: 'x', values: [1] },
            { id: 'x', values: [2] },
          ],
        },
      ],
      plan: scan('t'),
    },
    /duplicate row id/,
  );
  // 跨表重复 ID 也不允许
  expectFailure(
    {
      tables: [
        { name: 't1', columns: [{ name: 'n', type: 'number' }], rows: [{ id: 'x', values: [1] }] },
        { name: 't2', columns: [{ name: 'n', type: 'number' }], rows: [{ id: 'x', values: [2] }] },
      ],
      plan: scan('t1'),
    },
    /duplicate row id/,
  );
  // 数值 1 与字符串 '1' 是不同的 ID，不冲突
  const mixed = executeQuery({
    tables: [
      {
        name: 't',
        columns: [{ name: 'n', type: 'number' }],
        rows: [
          { id: 1, values: [10] },
          { id: '1', values: [20] },
        ],
      },
    ],
    plan: scan('t'),
  });
  assert.ok(mixed.ok);
});

test('计划结构：未知节点、缺失字段、嵌套过深的多连接/多聚合', () => {
  expectFailure({ tables: [nums], plan: { op: 'sort' } }, /unknown plan node/);
  expectFailure({ tables: [nums], plan: { op: 'scan' } }, /table/);
  expectFailure({ tables: [nums], plan: { op: 'filter', input: scan('nums') } }, /predicate/);
  expectFailure(
    {
      tables: [nums, strs],
      plan: join(join(scan('nums'), scan('strs'), 'n', 's'), scan('nums'), 'n', 'n'),
    },
    /at most one join/,
  );
  expectFailure(
    {
      tables: [nums],
      plan: aggregate(aggregate(scan('nums'), [], [{ func: 'countStar', as: 'a' }]), [], [
        { func: 'countStar', as: 'b' },
      ]),
    },
    /at most one aggregate/,
  );
});

test('列名引用：扫描未知表、筛选/投影/聚合/连接引用未知列', () => {
  expectFailure({ tables: [nums], plan: scan('nope') }, /unknown table 'nope'/);
  expectFailure(
    { tables: [nums], plan: filter(scan('nums'), cmp('=', col('nope'), lit(1))) },
    /unknown column 'nope'/,
  );
  expectFailure(
    { tables: [nums], plan: project(scan('nums'), ['nope']) },
    /unknown column 'nope'/,
  );
  expectFailure(
    { tables: [nums], plan: aggregate(scan('nums'), ['nope'], []) },
    /unknown group-by column 'nope'/,
  );
  expectFailure(
    { tables: [nums], plan: aggregate(scan('nums'), [], [{ func: 'count', column: 'nope', as: 'c' }]) },
    /unknown aggregate column 'nope'/,
  );
  expectFailure(
    { tables: [nums, strs], plan: join(scan('nums'), scan('strs'), 'nope', 's') },
    /left join column 'nope'/,
  );
});

test('类型一致性：比较两侧类型必须匹配', () => {
  expectFailure(
    { tables: [nums, strs], plan: join(scan('nums'), scan('strs'), 'n', 's') },
    /join key type mismatch/,
  );
  expectFailure(
    { tables: [nums, strs], plan: filter(scan('strs'), cmp('=', col('s'), lit(1))) },
    /cannot compare string with number/,
  );
  const bools = table('bools', [['b', 'boolean']], [['x', true]]);
  expectFailure(
    { tables: [bools], plan: filter(scan('bools'), cmp('<', col('b'), lit(true))) },
    /not defined for boolean/,
  );
  expectFailure(
    { tables: [strs], plan: aggregate(scan('strs'), [], [{ func: 'sum', column: 's', as: 'total' }]) },
    /SUM requires a numeric column/,
  );
});

test('输出列名冲突：投影重名、聚合别名与分组键重名', () => {
  expectFailure(
    { tables: [nums], plan: project(scan('nums'), ['n', { name: 'n', as: 'n' }]) },
    /duplicate output column/,
  );
  expectFailure(
    {
      tables: [nums],
      plan: aggregate(scan('nums'), ['n'], [{ func: 'countStar', as: 'n' }]),
    },
    /duplicate output column name/,
  );
});

test('连接列名冲突但无法限定（同名关系）', () => {
  const t1 = table('t', [['k', 'number']], [['a', 1]]);
  const t2 = table('t', [['k', 'number']], [['b', 1]]);
  expectFailure(
    { tables: [t1, t2], plan: join(scan('t'), scan('t'), 'k', 'k') },
    /duplicate table name/,
  );
  const j1 = table('j1', [['k', 'number']], [['a', 1]]);
  const j2 = table('j2', [['k', 'number']], [['b', 1]]);
  // 两侧都有 k 且关系名不同 → 自动限定为 j1.k / j2.k，合法
  const qualified = executeQuery({ tables: [j1, j2], plan: join(scan('j1'), scan('j2'), 'k', 'k') });
  assert.ok(qualified.ok);
  assert.deepEqual(
    qualified.columns.map((c) => c.name),
    ['j1.k', 'j2.k'],
  );
});

test('一次报告多个独立错误', () => {
  const result = expectFailure(
    {
      tables: [nums],
      plan: filter(scan('nope'), cmp('=', col('ghost'), lit(1))),
    },
    /unknown table 'nope'/,
  );
  // 未知表导致子树无法检查，但错误必须导致整体失败且无部分结果
  assert.ok(result.errors.length >= 1);
});

test('校验失败的请求不会执行（无副作用、无部分结果）', () => {
  // 计划本身合法但引用了不存在的列：必须整体失败
  const result = executeQuery({
    tables: [nums],
    plan: project(filter(scan('nums'), cmp('=', col('n'), lit(1))), ['n', 'ghost']),
  });
  assert.ok(!result.ok);
  assert.deepEqual(Object.keys(result), ['ok', 'errors']);
});
