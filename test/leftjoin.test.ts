/**
 * 左外连接：保留无匹配明细的主表行；严格区分“连接时（on）不满足条件”
 * 与“连接后被外层 filter 筛掉”。额外 on 谓词在连接内部、合并后的模式上
 * 按三值逻辑求值；FALSE/UNKNOWN 不产生匹配，左行改由右侧 NULL 扩展行保留。
 *
 * 覆盖：重复键袋语义、NULL 键、无匹配、on 与外层 filter 的阶段差异、
 * 补空行位置（左行优先）、右侧 NULL 下 COUNT(*)/COUNT(列)/SUM 的三值逻辑、
 * 聚合来源证据、限定名 on、校验整体拒绝与 HTTP 支持。
 *
 * 预言机与引擎完全独立：参考连接用哈希索引（引擎用嵌套循环）、
 * 谓词用真值表查表、分组用线性查找 + 逐键深比较。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { executeQuery, type PlanNode, type Predicate, type QuerySuccess } from '../src/index.js';
import { createServer } from '../src/server.js';
import {
  andP,
  cmp,
  col,
  constantP,
  filter,
  isNotNullP,
  isNullP,
  joinOn,
  leftJoin,
  lit,
  orP,
  project,
  aggregate,
  refAggregate,
  refFilter,
  refJoin,
  refScan,
  rng,
  scan,
  table,
  join,
  type RefRelation,
} from './helpers.js';

// ---------------------------------------------------------------------------
// 固定小表：刻意制造重复键、NULL 键与无匹配
// ---------------------------------------------------------------------------

// 主表（左）：lk 为连接键，v 为数值载荷，tag 为分组标签（可空）
const left = table(
  'orders',
  [
    ['lk', 'number'],
    ['v', 'number'],
    ['tag', 'string'],
  ],
  [
    ['l1', 1, 10, 'a'],
    ['l2', 1, 20, 'b'], // 与 l1 重复键
    ['l3', 2, 30, 'a'], // 有键匹配，但可被 on 拒绝
    ['l4', 3, 40, null], // 右侧无此键 → 必补空
    ['l5', null, 50, 'c'], // NULL 键：NULL=NULL 不成立 → 必补空
  ],
);

// 明细表（右）
const right = table(
  'lines',
  [
    ['rk', 'number'],
    ['w', 'number'],
  ],
  [
    ['r1', 1, 100],
    ['r2', 1, 200], // 与 r1 重复键
    ['r3', 2, 300],
    ['r4', null, 400], // NULL 键：永不参与连接
  ],
);

const ALL_LEFT = ['l1', 'l2', 'l3', 'l4', 'l5'];

function runOk(plan: PlanNode): QuerySuccess {
  const result = executeQuery({ tables: [left, right], plan });
  assert.ok(result.ok, `expected success, got ${JSON.stringify(result)}`);
  return result;
}

// 等价的参考流水线（独立实现）
function oracle(
  joinType: 'inner' | 'left',
  on: Predicate | undefined,
  outer: Predicate | undefined,
): RefRelation {
  let ref = refJoin(refScan(left), refScan(right), 'lk', 'rk', { joinType, on });
  if (outer !== undefined) ref = refFilter(ref, outer);
  return ref;
}

function assertMatchesOracle(
  plan: PlanNode,
  joinType: 'inner' | 'left',
  on: Predicate | undefined,
  outer: Predicate | undefined,
  label: string,
): void {
  const engine = runOk(plan);
  const expected = oracle(joinType, on, outer);
  assert.deepEqual(
    engine.columns.map((c) => c.name),
    expected.columns.map((c) => c.name),
    `${label}: column names`,
  );
  assert.deepEqual(
    engine.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
    expected.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
    label,
  );
}

// ---------------------------------------------------------------------------
// 手工断言：基本形状、补空行、顺序、来源证据
// ---------------------------------------------------------------------------

test('左外连接：匹配行按左行优先×右侧输入顺序，无匹配行恰好补一次 NULL', () => {
  const result = runOk(leftJoin(scan('orders'), scan('lines'), 'lk', 'rk'));
  assert.deepEqual(
    result.columns.map((c) => c.name),
    ['lk', 'v', 'tag', 'rk', 'w'],
  );
  assert.deepEqual(
    result.rows.map((r) => r.values),
    [
      [1, 10, 'a', 1, 100], // l1 × r1
      [1, 10, 'a', 1, 200], // l1 × r2
      [1, 20, 'b', 1, 100], // l2 × r1
      [1, 20, 'b', 1, 200], // l2 × r2
      [2, 30, 'a', 2, 300], // l3 × r3
      [3, 40, null, null, null], // l4：无键匹配 → 右侧 NULL 扩展
      [null, 50, 'c', null, null], // l5：NULL 键 → 右侧 NULL 扩展
    ],
  );
  assert.deepEqual(
    result.rows.map((r) => r.sourceIds),
    [
      ['l1', 'r1'],
      ['l1', 'r2'],
      ['l2', 'r1'],
      ['l2', 'r2'],
      ['l3', 'r3'],
      ['l4'], // 补空行来源证据只含左侧行 ID
      ['l5'],
    ],
  );
  // 每个左行都出现；r4（NULL 键）任何情况下都不出现
  const leftSeen = new Set(
    result.rows
      .flatMap((r) => r.sourceIds)
      .filter((id) => String(id).startsWith('l')),
  );
  assert.deepEqual([...leftSeen], ALL_LEFT);
  assert.ok(!result.rows.some((r) => r.sourceIds.includes('r4')));
});

test('袋语义：左右重复键产生笛卡尔式重复，补空行位置就在该左行处', () => {
  // 左表两行重复键 1，右表两行重复键 1 → 4 个匹配；其余左行各补一次
  const result = runOk(leftJoin(scan('orders'), scan('lines'), 'lk', 'rk'));
  assert.deepEqual(
    result.rows.map((r) => r.sourceIds[0]),
    ['l1', 'l1', 'l2', 'l2', 'l3', 'l4', 'l5'],
  );
  assert.equal(result.rows.length, 7);
});

test('等值键仍是必需条件：on 恒真也不能让 NULL 键或无匹配键连接', () => {
  const result = runOk(
    leftJoin(scan('orders'), scan('lines'), 'lk', 'rk', constantP(true)),
  );
  // l4（键 3 无匹配）、l5（NULL 键）依旧补空；r4（NULL 键）依旧不出现
  const tail = result.rows.slice(-2);
  assert.deepEqual(tail.map((r) => r.values), [
    [3, 40, null, null, null],
    [null, 50, 'c', null, null],
  ]);
  assert.deepEqual(tail.map((r) => r.sourceIds), [['l4'], ['l5']]);
});

// ---------------------------------------------------------------------------
// on 与外层 filter 必须分阶段（本任务最核心的区分）
// ---------------------------------------------------------------------------

test('on 拒绝候选（FALSE/UNKNOWN）→ 左行保留为补空行；外层 filter 拒绝 → 整行消失', () => {
  // on: w >= 150 —— r1(100) 被拒绝，但 r2(200)/r3(300) 匹配
  const onPred = cmp('>=', col('w'), lit(150));

  // 仅 on：l1/l2 仍有 r2 匹配；l3 有 r3；l4/l5 补空（共 5 行）
  const onlyOn = runOk(leftJoin(scan('orders'), scan('lines'), 'lk', 'rk', onPred));
  assert.deepEqual(
    onlyOn.rows.map((r) => r.values),
    [
      [1, 10, 'a', 1, 200],
      [1, 20, 'b', 1, 200],
      [2, 30, 'a', 2, 300],
      [3, 40, null, null, null],
      [null, 50, 'c', null, null],
    ],
  );

  // on 之后再加外层 filter（w >= 150）：补空行 w 为 NULL → UNKNOWN → 被筛掉，
  // 且不会因此重新补空。只剩 3 行真实匹配。
  const thenFilter = runOk(
    filter(leftJoin(scan('orders'), scan('lines'), 'lk', 'rk', onPred), onPred),
  );
  assert.deepEqual(
    thenFilter.rows.map((r) => r.values),
    [
      [1, 10, 'a', 1, 200],
      [1, 20, 'b', 1, 200],
      [2, 30, 'a', 2, 300],
    ],
  );

  // 外层 filter 用 IS NULL 可以显式“找回”在连接阶段被 on 拒绝的主表行
  const recovered = runOk(
    filter(leftJoin(scan('orders'), scan('lines'), 'lk', 'rk', onPred), isNullP(col('w'))),
  );
  assert.deepEqual(
    recovered.rows.map((r) => r.sourceIds),
    [['l4'], ['l5']],
  );
  // 这正是“连接时不满足”与“连接后被筛掉”的可观察区别
});

test('on 恒为 FALSE/UNKNOWN：左外连接每个左行补空；内连接则全空', () => {
  for (const onPred of [constantP(false), cmp('=', col('w'), lit(null))]) {
    const lj = runOk(leftJoin(scan('orders'), scan('lines'), 'lk', 'rk', onPred));
    assert.equal(lj.rows.length, 5, `left join on ${JSON.stringify(onPred)}`);
    assert.deepEqual(
      lj.rows.map((r) => r.values),
      [
        [1, 10, 'a', null, null],
        [1, 20, 'b', null, null],
        [2, 30, 'a', null, null],
        [3, 40, null, null, null],
        [null, 50, 'c', null, null],
      ],
    );
    assert.deepEqual(
      lj.rows.map((r) => r.sourceIds),
      ALL_LEFT.map((id) => [id]),
    );
    const ij = runOk(joinOn(scan('orders'), scan('lines'), 'lk', 'rk', onPred));
    assert.deepEqual(ij.rows, []);
  }
});

test('on 谓词不作用于补空行：IS NULL(右列) 写在 on 里不会让失配左行“匹配”', () => {
  // on: IS NULL(rk)。候选行 rk 恒非 NULL（NULL 键行 r4 根本不构成候选）→ 无匹配；
  // 补空行虽有 rk=NULL，也不会被 on 重新判定为匹配（恰好一次补空）。
  const result = runOk(
    leftJoin(scan('orders'), scan('lines'), 'lk', 'rk', isNullP(col('rk'))),
  );
  assert.equal(result.rows.length, 5);
  assert.ok(result.rows.every((r) => r.values[3] === null && r.values[4] === null));
});

// ---------------------------------------------------------------------------
// 聚合沿三值逻辑：COUNT(*) 计补空行；COUNT(右列)/SUM(右列) 忽略右侧 NULL
// ---------------------------------------------------------------------------

const aggSpecs = [
  { func: 'countStar', as: 'n' },
  { func: 'count', column: 'w', as: 'cw' },
  { func: 'sum', column: 'w', as: 'sw' },
  { func: 'count', column: 'v', as: 'cv' },
  { func: 'sum', column: 'v', as: 'sv' },
] as const;

test('左外连接 + 无分组聚合：COUNT(*) 含补空行，右列 COUNT/SUM 忽略 NULL 扩展', () => {
  const result = runOk(
    aggregate(leftJoin(scan('orders'), scan('lines'), 'lk', 'rk'), [], [...aggSpecs]),
  );
  // 7 行；w 非空 5 个（100,200,100,200,300）；v 全 7 行非空
  assert.deepEqual(result.rows.map((r) => r.values), [[7, 5, 900, 7, 180]]);
  assert.deepEqual(result.rows[0]!.sourceIds, ['l1', 'r1', 'r2', 'l2', 'l3', 'r3', 'l4', 'l5']);
});

test('左外连接 + 分组聚合：补空行参与其左行所在组；全无匹配的组 SUM 为 NULL', () => {
  const result = runOk(
    aggregate(leftJoin(scan('orders'), scan('lines'), 'lk', 'rk'), ['tag'], [...aggSpecs]),
  );
  assert.deepEqual(
    result.columns.map((c) => c.name),
    ['tag', 'n', 'cw', 'sw', 'cv', 'sv'],
  );
  assert.deepEqual(
    result.rows.map((r) => r.values),
    [
      ['a', 3, 3, 600, 3, 50], // l1×2 + l3×1：w=100+200+300，v=10+10+30
      ['b', 2, 2, 300, 2, 40], // l2×2：100+200
      [null, 1, 0, null, 1, 40], // l4 补空行：右列 NULL → COUNT 0、SUM NULL
      ['c', 1, 0, null, 1, 50], // l5 补空行
    ],
  );
  assert.deepEqual(
    result.rows.map((r) => r.sourceIds),
    [
      ['l1', 'r1', 'r2', 'l3', 'r3'],
      ['l2', 'r1', 'r2'],
      ['l4'],
      ['l5'],
    ],
  );
});

test('on 过滤后的聚合：被 on 拒绝的左行经补空行仍计入 COUNT(*) 与左列聚合', () => {
  const onPred = cmp('>=', col('w'), lit(150));
  const plan = aggregate(
    leftJoin(scan('orders'), scan('lines'), 'lk', 'rk', onPred),
    [],
    [...aggSpecs],
  );
  const result = runOk(plan);
  // 3 个匹配（200,200,300）+ 2 个补空行
  assert.deepEqual(result.rows.map((r) => r.values), [[5, 3, 700, 5, 150]]);
  assert.deepEqual(result.rows[0]!.sourceIds, ['l1', 'r2', 'l2', 'l3', 'r3', 'l4', 'l5']);
});

test('投影补空行：右列投影出 NULL，来源证据透传', () => {
  const result = runOk(
    project(leftJoin(scan('orders'), scan('lines'), 'lk', 'rk'), [
      'tag',
      'w',
      { name: 'v', as: 'amount' },
    ]),
  );
  assert.deepEqual(
    result.columns.map((c) => c.name),
    ['tag', 'w', 'amount'],
  );
  assert.deepEqual(
    result.rows.slice(-2).map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
    [
      { values: [null, null, 40], sourceIds: ['l4'] },
      { values: ['c', null, 50], sourceIds: ['l5'] },
    ],
  );
});

// ---------------------------------------------------------------------------
// 限定名 on（两侧同名列在连接模式中被限定）
// ---------------------------------------------------------------------------

test('on 谓词可引用连接后的限定名（表名.列名）', () => {
  const a = table(
    'a',
    [
      ['k', 'number'],
      ['v', 'number'],
      ['mark', 'number'],
    ],
    [
      ['a1', 1, 10, 5],
      ['a2', 2, 20, 5],
      ['a3', 9, 30, 5],
    ],
  );
  const b = table(
    'b',
    [
      ['k', 'number'],
      ['w', 'number'],
      ['mark', 'number'],
    ],
    [
      ['b1', 1, 100, 0],
      ['b2', 2, 200, 9],
    ],
  );
  // 等值键之外再要求 a.k IS NOT NULL（候选恒真）OR b.mark >= 7；
  // 因 a.k IS NOT NULL 在候选上恒真，所有键匹配都成立
  const onPred = orP(isNotNullP(col('a.k')), cmp('>=', col('b.mark'), lit(7)));
  const result = executeQuery({
    tables: [a, b],
    plan: leftJoin(scan('a'), scan('b'), 'k', 'k', onPred),
  });
  assert.ok(result.ok, JSON.stringify(result));
  assert.deepEqual(
    result.columns.map((c) => c.name),
    ['a.k', 'v', 'a.mark', 'b.k', 'w', 'b.mark'],
  );
  // 所有键匹配都成立；仅 a3（无匹配）补空
  assert.deepEqual(
    result.rows.map((r) => r.values),
    [
      [1, 10, 5, 1, 100, 0],
      [2, 20, 5, 2, 200, 9],
      [9, 30, 5, null, null, null],
    ],
  );

  // 换一个真正筛掉候选的 on（右列限定名）：b.mark >= 7 → b1 被拒，a1 补空
  const onPred2 = cmp('>=', col('b.mark'), lit(7));
  const result2 = executeQuery({
    tables: [a, b],
    plan: leftJoin(scan('a'), scan('b'), 'k', 'k', onPred2),
  });
  assert.ok(result2.ok, JSON.stringify(result2));
  assert.deepEqual(
    result2.rows.map((r) => r.values),
    [
      [1, 10, 5, null, null, null], // a1 的唯一候选 b1 被 on 拒绝 → 补空
      [2, 20, 5, 2, 200, 9],
      [9, 30, 5, null, null, null], // 无匹配 → 补空
    ],
  );
});

// ---------------------------------------------------------------------------
// 枚举预言机：joinType × on × 外层 filter 的小表全组合交叉核对
// ---------------------------------------------------------------------------

test('枚举预言机：joinType × on × 外层 filter，引擎与独立参考逐行一致', () => {
  const onPreds: (Predicate | undefined)[] = [
    undefined,
    constantP(true),
    constantP(false),
    cmp('>=', col('w'), lit(150)),
    cmp('=', col('v'), col('w')),
    isNullP(col('rk')),
    cmp('=', col('w'), lit(null)), // 恒 UNKNOWN
    orP(cmp('>=', col('w'), lit(150)), cmp('=', col('w'), lit(null))),
    andP(isNotNullP(col('w')), cmp('<', col('v'), lit(25))),
  ];
  const outerPreds: (Predicate | undefined)[] = [
    undefined,
    isNotNullP(col('w')), // 删光补空行
    cmp('>=', col('w'), lit(150)),
    isNullP(col('w')), // 只保留补空行
    orP(isNullP(col('w')), cmp('>=', col('w'), lit(150))), // 保留补空行 + 大 w
    cmp('=', col('lk'), col('rk')), // 补空行上为 UNKNOWN
  ];

  let cases = 0;
  for (const joinType of ['inner', 'left'] as const) {
    for (const on of onPreds) {
      for (const outer of outerPreds) {
        const joined =
          joinType === 'left'
            ? leftJoin(scan('orders'), scan('lines'), 'lk', 'rk', on)
            : on === undefined
              ? join(scan('orders'), scan('lines'), 'lk', 'rk')
              : joinOn(scan('orders'), scan('lines'), 'lk', 'rk', on);
        const plan = outer === undefined ? joined : filter(joined, outer);
        assertMatchesOracle(plan, joinType, on, outer, `case ${cases}`);
        cases += 1;
      }
    }
  }
  // 2 × 9 × 6 = 108 个枚举组合
  assert.equal(cases, 108);
});

test('枚举预言机：再接投影/聚合，值与来源证据与参考一致', () => {
  const onPreds: (Predicate | undefined)[] = [
    undefined,
    cmp('>=', col('w'), lit(150)),
    constantP(false),
    orP(isNullP(col('w')), cmp('<', col('v'), lit(99))),
  ];
  for (const joinType of ['inner', 'left'] as const) {
    for (const on of onPreds) {
      for (const outer of [undefined, isNotNullP(col('w'))] as const) {
        const joined =
          joinType === 'left'
            ? leftJoin(scan('orders'), scan('lines'), 'lk', 'rk', on)
            : on === undefined
              ? join(scan('orders'), scan('lines'), 'lk', 'rk')
              : joinOn(scan('orders'), scan('lines'), 'lk', 'rk', on);
        const filtered = outer === undefined ? joined : filter(joined, outer);
        const base = oracle(joinType, on, outer);

        // 聚合路径
        const plan = aggregate(filtered, ['tag'], [...aggSpecs]);
        const engine = runOk(plan);
        const aggRef = refAggregate(base, ['tag'], [...aggSpecs]);
        assert.deepEqual(
          engine.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
          aggRef.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
          `aggregate ${joinType} ${JSON.stringify(on)} ${JSON.stringify(outer)}`,
        );

        // 投影路径（含重命名 tag → label）
        const pPlan = project(filtered, ['lk', 'w', { name: 'tag', as: 'label' }]);
        const pEngine = runOk(pPlan);
        const idx = ['lk', 'w', 'tag'].map((n) => base.columns.findIndex((c) => c.name === n));
        const pRef: RefRelation = {
          columns: [
            base.columns[idx[0]!]!,
            base.columns[idx[1]!]!,
            { name: 'label', type: 'string' },
          ],
          rows: base.rows.map((row) => ({
            values: idx.map((i) => row.values[i]!),
            sourceIds: row.sourceIds,
          })),
        };
        assert.deepEqual(
          pEngine.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
          pRef.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
          `project ${joinType} ${JSON.stringify(on)} ${JSON.stringify(outer)}`,
        );
      }
    }
  }
});

// ---------------------------------------------------------------------------
// 随机小表枚举预言机：重复键、NULL 键、失配、3VL on/filter 全面交叉核对
// ---------------------------------------------------------------------------

test('随机预言机：随机小表 × joinType × on × 外层 filter × 投影/聚合', () => {
  const rand = rng(13131313);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
  for (let iter = 0; iter < 200; iter += 1) {
    const keyDomain = [1, 2, null] as const;
    const mkLeft = (): [string, number | null, number | null, string | null][] =>
      Array.from({ length: Math.floor(rand() * 8) }, (_, i) => [
        `L${i}`,
        pick(keyDomain),
        rand() < 0.25 ? null : Math.floor(rand() * 5),
        rand() < 0.4 ? null : pick(['p', 'q'] as const),
      ]);
    const mkRight = (): [string, number | null, number | null][] =>
      Array.from({ length: Math.floor(rand() * 8) }, (_, i) => [
        `R${i}`,
        pick(keyDomain),
        rand() < 0.25 ? null : Math.floor(rand() * 5),
      ]);
    const tl = table(
      'tl',
      [
        ['lk', 'number'],
        ['v', 'number'],
        ['tag', 'string'],
      ],
      mkLeft(),
    );
    const tr = table(
      'tr',
      [
        ['rk', 'number'],
        ['w', 'number'],
      ],
      mkRight(),
    );

    const onFamily: (Predicate | undefined)[] = [
      undefined,
      cmp('>=', col('w'), lit(2)),
      cmp('=', col('v'), col('w')),
      isNullP(col('w')),
      orP(cmp('>', col('v'), lit(1)), cmp('=', col('w'), lit(null))),
      constantP(rand() < 0.5),
    ];
    const outerFamily: (Predicate | undefined)[] = [
      undefined,
      isNotNullP(col('w')),
      isNullP(col('w')),
      cmp('>=', col('w'), lit(2)),
    ];
    const joinType = rand() < 0.5 ? 'left' : 'inner';
    const onPred = pick(onFamily);
    const outerPred = pick(outerFamily);

    let plan: PlanNode =
      joinType === 'left'
        ? leftJoin(scan('tl'), scan('tr'), 'lk', 'rk', onPred)
        : onPred === undefined
          ? join(scan('tl'), scan('tr'), 'lk', 'rk')
          : joinOn(scan('tl'), scan('tr'), 'lk', 'rk', onPred);
    let ref = refJoin(refScan(tl), refScan(tr), 'lk', 'rk', { joinType, on: onPred });
    if (outerPred !== undefined) {
      plan = filter(plan, outerPred);
      ref = refFilter(ref, outerPred);
    }

    if (rand() < 0.5) {
      const aggs = [
        { func: 'countStar', as: 'n' },
        { func: 'count', column: 'w', as: 'cw' },
        { func: 'sum', column: 'w', as: 'sw' },
        { func: 'count', column: 'v', as: 'cv' },
      ] as const;
      const groupBy = rand() < 0.6 ? ['tag'] : [];
      plan = aggregate(plan, groupBy, [...aggs]);
      ref = refAggregate(ref, groupBy, [...aggs]);
    } else {
      plan = project(plan, ['tag', 'w']);
      ref = {
        relation: ref.relation,
        columns: ['tag', 'w'].map((n) => ref.columns.find((c) => c.name === n)!),
        rows: ref.rows.map((r) => ({
          values: ['tag', 'w'].map(
            (n) => r.values[ref.columns.findIndex((c) => c.name === n)]!,
          ),
          sourceIds: r.sourceIds,
        })),
      };
    }

    const engine = executeQuery({ tables: [tl, tr], plan });
    assert.ok(engine.ok, `iter ${iter}: ${JSON.stringify(engine)}`);
    assert.deepEqual(
      engine.columns.map((c) => c.name),
      ref.columns.map((c) => c.name),
      `iter ${iter} columns`,
    );
    assert.deepEqual(
      engine.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
      ref.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
      `iter ${iter} rows`,
    );
  }
});

// ---------------------------------------------------------------------------
// 校验：非法 joinType / on 列引用 / on 谓词类型 → 整次拒绝，无部分结果
// ---------------------------------------------------------------------------

test('非法 joinType 枚举值被拒绝', () => {
  const result = executeQuery({
    tables: [left, right],
    plan: {
      op: 'join',
      joinType: 'outer',
      left: scan('orders'),
      right: scan('lines'),
      leftColumn: 'lk',
      rightColumn: 'rk',
    },
  });
  assert.ok(!result.ok);
  assert.match(result.errors.join('\n'), /joinType/);
  assert.deepEqual(Object.keys(result), ['ok', 'errors']);
});

test('on 谓词引用未知列：整次拒绝', () => {
  const result = executeQuery({
    tables: [left, right],
    plan: {
      op: 'join',
      joinType: 'left',
      left: scan('orders'),
      right: scan('lines'),
      leftColumn: 'lk',
      rightColumn: 'rk',
      on: { kind: 'comparison', op: '=', left: { kind: 'column', name: 'ghost' }, right: { kind: 'literal', value: 1 } },
    },
  });
  assert.ok(!result.ok);
  assert.match(result.errors.join('\n'), /plan\.on/);
  assert.match(result.errors.join('\n'), /unknown column 'ghost'/);
});

test('on 谓词类型不一致：整次拒绝', () => {
  const result = executeQuery({
    tables: [left, right],
    plan: leftJoin(scan('orders'), scan('lines'), 'lk', 'rk', cmp('=', col('tag'), col('w'))),
  });
  assert.ok(!result.ok);
  assert.match(result.errors.join('\n'), /plan\.on/);
  assert.match(result.errors.join('\n'), /cannot compare string with number/);
});

test('on 不是谓词对象 / joinType 类型错误：结构校验拒绝', () => {
  const base = {
    left: { op: 'scan', table: 'orders' },
    right: { op: 'scan', table: 'lines' },
    leftColumn: 'lk',
    rightColumn: 'rk',
  };
  const badOn = executeQuery({
    tables: [left, right],
    plan: { op: 'join', joinType: 'left', ...base, on: 5 },
  });
  assert.ok(!badOn.ok);
  assert.match(badOn.errors.join('\n'), /plan\.on/);

  const badType = executeQuery({
    tables: [left, right],
    plan: { op: 'join', joinType: 42, ...base },
  });
  assert.ok(!badType.ok);
  assert.match(badType.errors.join('\n'), /joinType/);
});

test('显式 inner + on 与无 joinType 字段的旧计划字节级一致', () => {
  const onPred = cmp('>=', col('w'), lit(150));
  const explicit = executeQuery({
    tables: [left, right],
    plan: joinOn(scan('orders'), scan('lines'), 'lk', 'rk', onPred),
  });
  const viaLeftFilter = executeQuery({
    tables: [left, right],
    plan: filter(
      join(scan('orders'), scan('lines'), 'lk', 'rk'),
      onPred,
    ),
  });
  // 内连接中 on 与先连接再外层 filter 等价（左外连接则不等价）
  assert.deepEqual(JSON.stringify(explicit), JSON.stringify(viaLeftFilter));
});

// ---------------------------------------------------------------------------
// HTTP：/execute 直接支持左外连接节点
// ---------------------------------------------------------------------------

test('HTTP /execute 支持左外连接（补空行与来源证据可见）', async () => {
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
            name: 'p',
            columns: [
              { name: 'k', type: 'number' },
              { name: 'name', type: 'string' },
            ],
            rows: [
              { id: 'p1', values: [1, 'a'] },
              { id: 'p2', values: [9, 'b'] },
            ],
          },
          {
            name: 'c',
            columns: [
              { name: 'k', type: 'number' },
              { name: 'detail', type: 'string' },
            ],
            rows: [{ id: 'c1', values: [1, 'x'] }],
          },
        ],
        plan: {
          op: 'join',
          joinType: 'left',
          left: { op: 'scan', table: 'p' },
          right: { op: 'scan', table: 'c' },
          leftColumn: 'k',
          rightColumn: 'k',
        },
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as QuerySuccess;
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
      [
        { values: [1, 'a', 1, 'x'], sourceIds: ['p1', 'c1'] },
        { values: [9, 'b', null, null], sourceIds: ['p2'] },
      ],
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
