/**
 * 左外连接（joinType: 'leftOuter'）与可选额外 on 谓词。
 *
 * 关键语义：
 * - 等值键仍是必需条件，NULL 键不连接；
 * - on 在连接后的候选行上按三值逻辑求值，只有 TRUE 才算真实匹配；
 * - 右表无匹配，或所有候选 on 为 FALSE/UNKNOWN 时，左行恰好输出一次
 *   右侧 NULL 扩展行，来源证据只含左侧行 ID；
 * - 有真实匹配时保持袋语义与左行优先顺序；
 * - on 与连接外层 filter 分阶段执行：外层 filter 不能下推，否则补空行会被错误吞掉；
 * - 后续 project / COUNT(*) / COUNT(右列) / SUM 沿三值逻辑得到正确结果。
 *
 * 参考实现（哈希索引）与引擎（嵌套循环）相互独立；枚举预言机用独立小表穷举
 * 重复键、NULL 键、无匹配、on 与 filter 差异及聚合来源证据。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { executeQuery, type PlanNode, type Predicate, type QuerySuccess } from '../src/index.js';
import { createServer } from '../src/server.js';
import {
  aggregate,
  andP,
  cmp,
  col,
  filter,
  isNotNullP,
  isNullP,
  join,
  lit,
  orP,
  project,
  refAggregate,
  refFilter,
  refJoin,
  refLeftJoin,
  refProject,
  refScan,
  rng,
  scan,
  table,
  type RefRelation,
} from './helpers.js';

function run(request: Parameters<typeof executeQuery>[0]): QuerySuccess {
  const result = executeQuery(request);
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result;
}

// ---------------------------------------------------------------------------
// 固定小表：主表 + 明细表
// ---------------------------------------------------------------------------

const master = table(
  'master',
  [
    ['id', 'number'],
    ['mname', 'string'],
  ],
  [
    ['m1', 1, 'a'],
    ['m2', 2, 'b'], // 有匹配
    ['m3', 3, 'c'], // 无匹配（detail 无键 3）
    ['m4', null, 'd'], // NULL 键：不能连接，必须补空行
  ],
);

const detail = table(
  'detail',
  [
    ['id', 'number'],
    ['amt', 'number'],
    ['flag', 'boolean'],
  ],
  [
    ['d1', 1, 10, true],
    ['d2', 1, 20, false], // 键 1 重复：袋语义
    ['d3', 2, 30, true],
    ['d4', null, 40, true], // NULL 键：永不匹配任何主行
  ],
);

test('左外连接：无匹配与 NULL 键补一次右侧 NULL 扩展行，证据只含左侧 ID', () => {
  const result = run({
    tables: [master, detail],
    plan: join(scan('master'), scan('detail'), 'id', 'id', { joinType: 'leftOuter' }),
  });
  assert.deepEqual(result.columns.map((c) => c.name), [
    'master.id',
    'mname',
    'detail.id',
    'amt',
    'flag',
  ]);
  assert.deepEqual(
    result.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
    [
      { values: [1, 'a', 1, 10, true], sourceIds: ['m1', 'd1'] },
      { values: [1, 'a', 1, 20, false], sourceIds: ['m1', 'd2'] },
      { values: [2, 'b', 2, 30, true], sourceIds: ['m2', 'd3'] },
      // 无匹配：右侧整体 NULL，左侧原样保留
      { values: [3, 'c', null, null, null], sourceIds: ['m3'] },
      // NULL 键同样不连接：补空行，且证据不含 d4
      { values: [null, 'd', null, null, null], sourceIds: ['m4'] },
    ],
  );
});

test('左外连接：有真实匹配时与内连接同序同袋；重复键笛卡尔展开', () => {
  const l = table('l', [['k', 'number']], [
    ['l1', 1],
    ['l2', 1],
    ['l3', 2],
    ['l4', 4], // 无匹配
  ]);
  const r = table('r', [['k', 'number']], [
    ['r1', 1],
    ['r2', 1],
    ['r3', 1],
    ['r4', 2],
  ]);
  const result = run({
    tables: [l, r],
    plan: join(scan('l'), scan('r'), 'k', 'k', { joinType: 'leftOuter' }),
  });
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
      ['l4'], // 恰好一次补空行
    ],
  );
  assert.deepEqual(result.rows[7]!.values, [4, null]);
});

test('额外 on：FALSE 拒绝候选并补空行；UNKNOWN（NULL 比较）同样补空行', () => {
  // on: detail.amt > 15 —— d1(10) 为 FALSE；键为 NULL 的 m4 无候选；
  // m1 还有 d2(20)=TRUE，故 m1 不补空行；m2 的 d3(30) 通过；m3 无候选补空行。
  const on = cmp('>', col('amt'), lit(15));
  const result = run({
    tables: [master, detail],
    plan: join(scan('master'), scan('detail'), 'id', 'id', {
      joinType: 'leftOuter',
      on,
    }),
  });
  assert.deepEqual(
    result.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
    [
      { values: [1, 'a', 1, 20, false], sourceIds: ['m1', 'd2'] }, // d1 被 on 拒绝
      { values: [2, 'b', 2, 30, true], sourceIds: ['m2', 'd3'] },
      { values: [3, 'c', null, null, null], sourceIds: ['m3'] },
      { values: [null, 'd', null, null, null], sourceIds: ['m4'] },
    ],
  );

  // on 恒为 UNKNOWN（与 NULL 字面量比较）：所有候选都被拒绝，每个左行恰好补一次
  const allUnknown = run({
    tables: [master, detail],
    plan: join(scan('master'), scan('detail'), 'id', 'id', {
      joinType: 'leftOuter',
      on: cmp('=', col('amt'), lit(null)),
    }),
  });
  assert.equal(allUnknown.rows.length, master.rows.length);
  assert.deepEqual(
    allUnknown.rows.map((r) => r.sourceIds),
    [['m1'], ['m2'], ['m3'], ['m4']],
  );
  assert.deepEqual(
    allUnknown.rows.map((r) => r.values.slice(2)),
    Array.from({ length: 4 }, () => [null, null, null]),
  );
});

test('on 与连接外层 filter 必须分阶段：filter 会丢掉补空行，on 不会', () => {
  // 计划 A：左外连接 + on(amt > 15) —— m3/m4 作为补空行保留（右列为 NULL）
  const withOn = run({
    tables: [master, detail],
    plan: join(scan('master'), scan('detail'), 'id', 'id', {
      joinType: 'leftOuter',
      on: cmp('>', col('amt'), lit(15)),
    }),
  });
  assert.deepEqual(
    withOn.rows.map((r) => r.sourceIds),
    [['m1', 'd2'], ['m2', 'd3'], ['m3'], ['m4']],
  );

  // 计划 B：先左外连接（无 on），外层再 filter(amt > 15) —— 补空行上 amt IS NULL，
  // 谓词为 UNKNOWN，filter 只留 TRUE，故 m3/m4 被筛掉；m1/d1(10) 也被筛掉。
  // 若错误地把 filter 下推进连接的 on，m1 会再次补空行 —— 这正是要防止的错误。
  const withOuterFilter = run({
    tables: [master, detail],
    plan: filter(
      join(scan('master'), scan('detail'), 'id', 'id', { joinType: 'leftOuter' }),
      cmp('>', col('amt'), lit(15)),
    ),
  });
  assert.deepEqual(
    withOuterFilter.rows.map((r) => r.sourceIds),
    [
      ['m1', 'd2'],
      ['m2', 'd3'],
    ],
  );
});

test('内连接 + on：额外谓词只是连接阶段的合取条件，不补空行', () => {
  const result = run({
    tables: [master, detail],
    plan: join(scan('master'), scan('detail'), 'id', 'id', {
      on: cmp('>=', col('amt'), lit(30)),
    }),
  });
  assert.deepEqual(
    result.rows.map((r) => r.sourceIds),
    [['m2', 'd3']],
  );
});

test('on 谓词可引用左列、右列、组合谓词与 IS NULL', () => {
  // (amt >= 20) AND (mname IS NOT NULL) OR detail.flag IS NULL
  // flag 非 NULL，OR 的右支恒 FALSE；m1-d2(20)、m2-d3(30) 通过；
  // m1-d1(10) 为 FALSE → 但 m1 仍有 d2 匹配，不补空行；m3 无候选补空行。
  const on: Predicate = orP(
    andP(cmp('>=', col('amt'), lit(20)), isNotNullP(col('mname'))),
    isNullP(col('flag')),
  );
  const result = run({
    tables: [master, detail],
    plan: join(scan('master'), scan('detail'), 'id', 'id', {
      joinType: 'leftOuter',
      on,
    }),
  });
  assert.deepEqual(
    result.rows.map((r) => r.sourceIds),
    [['m1', 'd2'], ['m2', 'd3'], ['m3'], ['m4']],
  );
});

test('补空行后投影：右列投影为 NULL，左列保留，证据透传', () => {
  const result = run({
    tables: [master, detail],
    plan: project(
      join(scan('master'), scan('detail'), 'id', 'id', { joinType: 'leftOuter' }),
      ['mname', 'amt'],
    ),
  });
  assert.deepEqual(
    result.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
    [
      { values: ['a', 10], sourceIds: ['m1', 'd1'] },
      { values: ['a', 20], sourceIds: ['m1', 'd2'] },
      { values: ['b', 30], sourceIds: ['m2', 'd3'] },
      { values: ['c', null], sourceIds: ['m3'] },
      { values: ['d', null], sourceIds: ['m4'] },
    ],
  );
});

test('聚合沿三值逻辑：COUNT(*) 数补空行；COUNT(右列)/SUM(右列) 忽略 NULL', () => {
  const result = run({
    tables: [master, detail],
    plan: aggregate(
      join(scan('master'), scan('detail'), 'id', 'id', { joinType: 'leftOuter' }),
      [],
      [
        { func: 'countStar', as: 'n' },
        { func: 'count', column: 'amt', as: 'c_amt' },
        { func: 'sum', column: 'amt', as: 's_amt' },
      ],
    ),
  });
  // 左外连接共 5 行（3 个真实匹配行 + 2 个补空行）；
  // amt 非 NULL 仅 3 个：10+20+30=60
  assert.deepEqual(result.rows.map((r) => r.values), [[5, 3, 60]]);
  // 来源证据跨真实匹配与补空行收集，按首次出现顺序去重
  assert.deepEqual(result.rows[0]!.sourceIds, ['m1', 'd1', 'd2', 'm2', 'd3', 'm3', 'm4']);
});

test('分组聚合：补空行归到右侧 NULL 组，COUNT(右列) 不计该行', () => {
  const result = run({
    tables: [master, detail],
    plan: aggregate(
      join(scan('master'), scan('detail'), 'id', 'id', { joinType: 'leftOuter' }),
      ['detail.id'],
      [
        { func: 'countStar', as: 'n' },
        { func: 'count', column: 'amt', as: 'c' },
        { func: 'sum', column: 'amt', as: 's' },
      ],
    ),
  });
  assert.deepEqual(
    result.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
    [
      { values: [1, 2, 2, 30], sourceIds: ['m1', 'd1', 'd2'] },
      { values: [2, 1, 1, 30], sourceIds: ['m2', 'd3'] },
      // 补空行组：COUNT(*)=2（m3、m4），COUNT(amt)=0，SUM 全 NULL → NULL
      { values: [null, 2, 0, null], sourceIds: ['m3', 'm4'] },
    ],
  );
});

test('内连接缺省 joinType 时字节级可观察行为与旧计划一致', () => {
  // 旧计划 JSON 不含 joinType/on 字段：解析后执行结果与以前完全相同
  const legacyPlan = {
    op: 'join',
    left: { op: 'scan', table: 'master' },
    right: { op: 'scan', table: 'detail' },
    leftColumn: 'id',
    rightColumn: 'id',
  };
  const result = executeQuery({ tables: [master, detail], plan: legacyPlan });
  assert.ok(result.ok);
  assert.deepEqual(
    (result as QuerySuccess).rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
    [
      { values: [1, 'a', 1, 10, true], sourceIds: ['m1', 'd1'] },
      { values: [1, 'a', 1, 20, false], sourceIds: ['m1', 'd2'] },
      { values: [2, 'b', 2, 30, true], sourceIds: ['m2', 'd3'] },
    ],
  );

  // 显式 joinType: 'inner' 与缺省完全等价；非法请求错误路径同样不变
  const explicit = executeQuery({
    tables: [master, detail],
    plan: { ...legacyPlan, joinType: 'inner' },
  });
  assert.deepEqual(explicit, result);
});

// ---------------------------------------------------------------------------
// 枚举预言机：独立小表穷举 × 独立哈希参考实现
// ---------------------------------------------------------------------------

test('枚举预言机：左外/内连接 × on 形态 × 重复键/NULL 键/无匹配', () => {
  // 键域覆盖重复、NULL；载荷域覆盖 NULL（制造 UNKNOWN）
  const keyDomain = [1, 1, 2, 3, null] as const;
  const valDomain = [10, 20, null] as const;

  const allRowsFor = (prefix: string, vals: readonly (number | null)[]) =>
    vals.map(
      (v, i) => [`${prefix}${i}`, keyDomain[i]!, v] as [string, number | null, number | null],
    );

  // 固定的小表组合（枚举所有长度 0..4 的左表前缀 × 0..4 的右表前缀）
  const lVals = [10, null, 20, 10] as const;
  const rVals = [20, 10, null, 30] as const;

  const onForms: (undefined | Predicate)[] = [
    undefined,
    cmp('>', col('v'), lit(15)), // 右载荷
    cmp('>=', col('u'), lit(10)), // 左载荷：10/null/20/10
    cmp('=', col('v'), col('u')), // 列与列：NULL 参与时 UNKNOWN
    isNotNullP(col('v')), // 补空行上 v 为 NULL
    orP(cmp('=', col('v'), lit(20)), isNullP(col('v'))), // TRUE 恰在 v=20 或补空行形态
  ];

  let cases = 0;
  for (let ln = 0; ln <= 4; ln += 1) {
    for (let rn = 0; rn <= 4; rn += 1) {
      const l = table(
        'tl',
        [
          ['k', 'number'],
          ['u', 'number'],
        ],
        allRowsFor('L', lVals).slice(0, ln),
      );
      const r = table(
        'tr',
        [
          ['k', 'number'],
          ['v', 'number'],
        ],
        allRowsFor('R', rVals).slice(0, rn),
      );
      for (const on of onForms) {
        for (const joinType of ['inner', 'leftOuter'] as const) {
          cases += 1;
          const engine = executeQuery({
            tables: [l, r],
            plan: join(scan('tl'), scan('tr'), 'k', 'k', {
              joinType,
              ...(on !== undefined ? { on } : {}),
            }),
          });
          assert.ok(engine.ok, `case ${cases}: ${JSON.stringify(engine)}`);
          const expected =
            joinType === 'inner'
              ? refJoin(refScan(l, 'tl'), refScan(r, 'tr'), 'k', 'k', on)
              : refLeftJoin(refScan(l, 'tl'), refScan(r, 'tr'), 'k', 'k', on);
          assert.deepEqual(engine.columns.map((c) => c.name), expected.columns.map((c) => c.name));
          assert.deepEqual(
            engine.rows.map((row) => ({ values: row.values, sourceIds: row.sourceIds })),
            expected.rows.map((row) => ({ values: row.values, sourceIds: row.sourceIds })),
            `ln=${ln} rn=${rn} joinType=${joinType} on=${JSON.stringify(on)}`,
          );
        }
      }
    }
  }
  assert.ok(cases > 100, `expected exhaustive coverage, got ${cases}`);
});

test('枚举预言机：连接外层 filter 与 on 的差异（含补空行被筛掉）', () => {
  const l = table(
    'tl',
    [
      ['k', 'number'],
      ['u', 'number'],
    ],
    [
      ['L0', 1, 10],
      ['L1', 1, null],
      ['L2', 2, 20],
      ['L3', null, 5],
      ['L4', 4, 9],
    ],
  );
  const r = table(
    'tr',
    [
      ['k', 'number'],
      ['v', 'number'],
    ],
    [
      ['R0', 1, 10],
      ['R1', 1, 20],
      ['R2', 2, null],
      ['R3', null, 7],
    ],
  );

  const outerPreds: Predicate[] = [
    cmp('>=', col('v'), lit(15)),
    isNotNullP(col('v')),
    orP(cmp('=', col('v'), lit(10)), isNullP(col('v'))),
  ];
  const onPreds: (undefined | Predicate)[] = [undefined, ...outerPreds];

  for (const on of onPreds) {
    for (const outer of outerPreds) {
      // on 版本：左外连接内部用 on
      const planOn: PlanNode = join(scan('tl'), scan('tr'), 'k', 'k', {
        joinType: 'leftOuter',
        ...(on !== undefined ? { on } : {}),
      });
      // filter 版本：on 在连接外分阶段执行
      const planFilter: PlanNode = filter(
        join(scan('tl'), scan('tr'), 'k', 'k', { joinType: 'leftOuter' }),
        on ?? { kind: 'constant', value: true },
      );

      const refOn = (() => {
        const joined = refLeftJoin(refScan(l, 'tl'), refScan(r, 'tr'), 'k', 'k', on);
        return refFilter(joined, outer);
      })();
      const refFiltered = (() => {
        const joined = refLeftJoin(refScan(l, 'tl'), refScan(r, 'tr'), 'k', 'k');
        return refFilter(joined, on ?? { kind: 'constant', value: true });
      })();

      // 注意：这里对比的是“同一谓词在 on 内 vs filter 外”的两种不同语义，
      // 参考实现各自独立推导，两者一般不相等 —— 关键是引擎必须与各自参考一致。
      const engineOn = executeQuery({ tables: [l, r], plan: filter(planOn, outer) });
      const engineFiltered = executeQuery({ tables: [l, r], plan: planFilter });
      assert.ok(engineOn.ok, JSON.stringify(engineOn));
      assert.ok(engineFiltered.ok, JSON.stringify(engineFiltered));
      assert.deepEqual(
        engineOn.rows.map((x) => ({ values: x.values, sourceIds: x.sourceIds })),
        refOn.rows.map((x) => ({ values: x.values, sourceIds: x.sourceIds })),
        `on-staged on=${JSON.stringify(on)} outer=${JSON.stringify(outer)}`,
      );
      assert.deepEqual(
        engineFiltered.rows.map((x) => ({ values: x.values, sourceIds: x.sourceIds })),
        refFiltered.rows.map((x) => ({ values: x.values, sourceIds: x.sourceIds })),
        `filter-staged on=${JSON.stringify(on)}`,
      );
    }
  }

  // 显式断言：某些情形下两种语义确实不同（补空行的存在）
  const diverging = executeQuery({
    tables: [l, r],
    plan: join(scan('tl'), scan('tr'), 'k', 'k', {
      joinType: 'leftOuter',
      on: cmp('>=', col('v'), lit(15)),
    }),
  });
  const filtered = executeQuery({
    tables: [l, r],
    plan: filter(
      join(scan('tl'), scan('tr'), 'k', 'k', { joinType: 'leftOuter' }),
      cmp('>=', col('v'), lit(15)),
    ),
  });
  assert.ok(diverging.ok && filtered.ok);
  assert.ok((diverging as QuerySuccess).rows.length > (filtered as QuerySuccess).rows.length);
});

test('枚举预言机：左外连接 → 投影/聚合 的值、顺序与来源证据', () => {
  const l = table(
    'tl',
    [
      ['k', 'number'],
      ['u', 'number'],
    ],
    [
      ['L0', 1, 10],
      ['L1', 1, 20],
      ['L2', 2, null],
      ['L3', 3, 30],
    ],
  );
  const r = table(
    'tr',
    [
      ['k', 'number'],
      ['v', 'number'],
    ],
    [
      ['R0', 1, 5],
      ['R1', 1, 5],
      ['R2', 2, null],
      ['R4', null, 9],
    ],
  );

  const ons: (undefined | Predicate)[] = [
    undefined,
    cmp('=', col('v'), lit(5)),
    isNotNullP(col('v')),
  ];

  for (const on of ons) {
    // 投影
    {
      const plan = project(
        join(scan('tl'), scan('tr'), 'k', 'k', {
          joinType: 'leftOuter',
          ...(on !== undefined ? { on } : {}),
        }),
        ['u', 'v'],
      );
      const engine = executeQuery({ tables: [l, r], plan });
      assert.ok(engine.ok, JSON.stringify(engine));
      let ref = refLeftJoin(refScan(l, 'tl'), refScan(r, 'tr'), 'k', 'k', on);
      ref = refProject(ref, ['u', 'v']);
      assert.deepEqual(
        (engine as QuerySuccess).rows.map((x) => x.values),
        ref.rows.map((x) => x.values),
        `project on=${JSON.stringify(on)}`,
      );
    }

    // 全局聚合
    {
      const aggs = [
        { func: 'countStar', as: 'n' },
        { func: 'count', column: 'v', as: 'cv' },
        { func: 'sum', column: 'u', as: 'su' },
        { func: 'sum', column: 'v', as: 'sv' },
      ] as const;
      const plan = aggregate(
        join(scan('tl'), scan('tr'), 'k', 'k', {
          joinType: 'leftOuter',
          ...(on !== undefined ? { on } : {}),
        }),
        [],
        [...aggs],
      );
      const engine = executeQuery({ tables: [l, r], plan });
      assert.ok(engine.ok, JSON.stringify(engine));
      const ref = refAggregate(
        refLeftJoin(refScan(l, 'tl'), refScan(r, 'tr'), 'k', 'k', on),
        [],
        [...aggs],
      );
      assert.deepEqual(
        (engine as QuerySuccess).rows.map((x) => ({ values: x.values, sourceIds: x.sourceIds })),
        ref.rows.map((x) => ({ values: x.values, sourceIds: x.sourceIds })),
        `global agg on=${JSON.stringify(on)}`,
      );
    }

    // 按右列分组：补空行进 NULL 组
    {
      const plan = aggregate(
        join(scan('tl'), scan('tr'), 'k', 'k', {
          joinType: 'leftOuter',
          ...(on !== undefined ? { on } : {}),
        }),
        ['v'],
        [
          { func: 'countStar', as: 'n' },
          { func: 'sum', column: 'u', as: 'su' },
        ],
      );
      const engine = executeQuery({ tables: [l, r], plan });
      assert.ok(engine.ok, JSON.stringify(engine));
      const ref = refAggregate(
        refLeftJoin(refScan(l, 'tl'), refScan(r, 'tr'), 'k', 'k', on),
        ['v'],
        [
          { func: 'countStar', as: 'n' },
          { func: 'sum', column: 'u', as: 'su' },
        ],
      );
      assert.deepEqual(
        (engine as QuerySuccess).rows.map((x) => ({ values: x.values, sourceIds: x.sourceIds })),
        ref.rows.map((x) => ({ values: x.values, sourceIds: x.sourceIds })),
        `grouped agg on=${JSON.stringify(on)}`,
      );
    }
  }
});

test('随机交叉核对：左外连接（带随机 on）经筛选/投影/聚合与参考流水线一致', () => {
  const rand = rng(20261002);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  for (let iter = 0; iter < 200; iter += 1) {
    const keyDomain = [1, 2, 3, null, null] as const;
    const mk = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => [
        `${prefix}${i}`,
        pick(keyDomain),
        rand() < 0.3 ? null : Math.floor(rand() * 4),
      ]) as [string, number | null, number | null][];
    const l = table(
      'tl',
      [
        ['k', 'number'],
        ['u', 'number'],
      ],
      mk('L', Math.floor(rand() * 12)),
    );
    const r = table(
      'tr',
      [
        ['k', 'number'],
        ['v', 'number'],
      ],
      mk('R', Math.floor(rand() * 12)),
    );

    let refL: RefRelation = refScan(l, 'tl');
    let refR: RefRelation = refScan(r, 'tr');
    let leftPlan: PlanNode = scan('tl');
    let rightPlan: PlanNode = scan('tr');
    if (rand() < 0.4) {
      const p = cmp('=', col('u'), lit(1));
      leftPlan = filter(leftPlan, p);
      refL = refFilter(refL, p);
    }
    if (rand() < 0.4) {
      const p = isNotNullP(col('v'));
      rightPlan = filter(rightPlan, p);
      refR = refFilter(refR, p);
    }

    const on: Predicate | undefined =
      rand() < 0.5
        ? pick([
            cmp('=', col('v'), col('u')),
            cmp('>', col('v'), lit(1)),
            orP(cmp('=', col('u'), lit(2)), isNullP(col('v'))),
          ])
        : undefined;

    let plan: PlanNode = join(leftPlan, rightPlan, 'k', 'k', {
      joinType: 'leftOuter',
      ...(on !== undefined ? { on } : {}),
    });
    let ref = refLeftJoin(refL, refR, 'k', 'k', on);

    if (rand() < 0.5) {
      const p = pick<Predicate>([
        cmp('>', col('u'), lit(0)),
        isNotNullP(col('v')),
      ]);
      plan = filter(plan, p);
      ref = refFilter(ref, p);
    }

    if (rand() < 0.5) {
      plan = project(plan, ['u', 'v']);
      ref = refProject(ref, ['u', 'v']);
    } else {
      const aggs = [
        { func: 'countStar', as: 'n' },
        { func: 'count', column: 'v', as: 'cv' },
        { func: 'sum', column: 'u', as: 'su' },
        { func: 'sum', column: 'v', as: 'sv' },
      ] as const;
      const groupBy = rand() < 0.5 ? ['u'] : [];
      plan = aggregate(plan, groupBy, [...aggs]);
      ref = refAggregate(ref, groupBy, [...aggs]);
    }

    const engine = executeQuery({ tables: [l, r], plan });
    assert.ok(engine.ok, `iter ${iter}: ${JSON.stringify(engine)}`);
    assert.deepEqual(
      engine.columns.map((c) => c.name),
      ref.columns.map((c) => c.name),
      `iter ${iter} columns`,
    );
    assert.deepEqual(
      engine.rows.map((x) => ({ values: x.values, sourceIds: x.sourceIds })),
      ref.rows.map((x) => ({ values: x.values, sourceIds: x.sourceIds })),
      `iter ${iter} rows`,
    );
  }
});

// ---------------------------------------------------------------------------
// 校验：非法 joinType / on 列引用 / on 类型错误 / on 结构非法 → 整次拒绝
// ---------------------------------------------------------------------------

test('非法 joinType 枚举整体拒绝', () => {
  const result = executeQuery({
    tables: [master, detail],
    plan: {
      op: 'join',
      left: scan('master'),
      right: scan('detail'),
      leftColumn: 'id',
      rightColumn: 'id',
      joinType: 'rightOuter',
    },
  });
  assert.ok(!result.ok);
  assert.match(result.errors.join('\n'), /joinType/);
  assert.ok(!('rows' in result));
});

test('on 引用不存在的列：整次拒绝，无部分结果', () => {
  const result = executeQuery({
    tables: [master, detail],
    plan: join(scan('master'), scan('detail'), 'id', 'id', {
      joinType: 'leftOuter',
      on: cmp('=', col('ghost'), lit(1)),
    }),
  });
  assert.ok(!result.ok);
  assert.match(result.errors.join('\n'), /plan\.on/);
  assert.match(result.errors.join('\n'), /unknown column 'ghost'/);
});

test('on 谓词类型不一致：整次拒绝', () => {
  const result = executeQuery({
    tables: [master, detail],
    plan: join(scan('master'), scan('detail'), 'id', 'id', {
      on: cmp('=', col('mname'), lit(3)),
    }),
  });
  assert.ok(!result.ok);
  assert.match(result.errors.join('\n'), /cannot compare string with number/);
});

test('on 结构非法（非谓词对象）：整次拒绝', () => {
  const result = executeQuery({
    tables: [master, detail],
    plan: {
      op: 'join',
      left: scan('master'),
      right: scan('detail'),
      leftColumn: 'id',
      rightColumn: 'id',
      joinType: 'leftOuter',
      on: { kind: 'comparison' },
    },
  });
  assert.ok(!result.ok);
  assert.ok(!('rows' in result));
});

test('on 中布尔列使用 < 也被拒绝', () => {
  const result = executeQuery({
    tables: [master, detail],
    plan: join(scan('master'), scan('detail'), 'id', 'id', {
      joinType: 'leftOuter',
      on: cmp('<', col('flag'), lit(true)),
    }),
  });
  assert.ok(!result.ok);
  assert.match(result.errors.join('\n'), /not defined for boolean/);
});

// ---------------------------------------------------------------------------
// HTTP：左外连接节点经 /execute 端到端可用
// ---------------------------------------------------------------------------

test('HTTP /execute 支持左外连接（含补空行与 NULL 右列）', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tables: [
          {
            name: 'm',
            columns: [
              { name: 'k', type: 'number' },
              { name: 'label', type: 'string' },
            ],
            rows: [
              { id: 'a', values: [1, 'x'] },
              { id: 'b', values: [2, 'y'] },
            ],
          },
          {
            name: 'd',
            columns: [
              { name: 'k', type: 'number' },
              { name: 'v', type: 'number' },
            ],
            rows: [{ id: 'c', values: [1, 7] }],
          },
        ],
        plan: {
          op: 'join',
          joinType: 'leftOuter',
          left: { op: 'scan', table: 'm' },
          right: { op: 'scan', table: 'd' },
          leftColumn: 'k',
          rightColumn: 'k',
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as QuerySuccess;
    assert.deepEqual(body.rows, [
      { values: [1, 'x', 1, 7], sourceIds: ['a', 'c'] },
      { values: [2, 'y', null, null], sourceIds: ['b'] },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
