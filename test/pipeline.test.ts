/**
 * 端到端：随机计划的完整流水线交叉核对（扫描→筛选→连接→筛选→投影/聚合），
 * 以及 HTTP 服务的行为测试。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { executeQuery, type PlanNode, type Predicate } from '../src/index.js';
import { createServer } from '../src/server.js';
import {
  aggregate,
  andP,
  cmp,
  col,
  filter,
  isNotNullP,
  join,
  lit,
  notP,
  orP,
  project,
  refAggregate,
  refFilter,
  refJoin,
  refProject,
  refScan,
  rng,
  scan,
  table,
  type RefRelation,
} from './helpers.js';

test('随机流水线：引擎结果与独立参考流水线一致（值、顺序、来源证据）', () => {
  const rand = rng(424242);
  const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;

  for (let iter = 0; iter < 200; iter += 1) {
    // 两张表：数值键列（小值域 + NULL，制造重复键与失配）+ 数值载荷 + 字符串标签
    const keyDomain = [1, 2, 3, 4, null] as const;
    const leftRows = Array.from({ length: Math.floor(rand() * 20) }, (_, i) => [
      `L${i}`,
      pick(keyDomain),
      rand() < 0.25 ? null : Math.floor(rand() * 50),
      rand() < 0.5 ? pick(['p', 'q', null] as const) : pick(['p', 'q'] as const),
    ] as [string, number | null, number | null, string | null]);
    const rightRows = Array.from({ length: Math.floor(rand() * 20) }, (_, i) => [
      `R${i}`,
      pick(keyDomain),
      rand() < 0.25 ? null : Math.floor(rand() * 50),
    ] as [string, number | null, number | null]);
    const left = table(
      'tl',
      [
        ['lk', 'number'],
        ['v', 'number'],
        ['tag', 'string'],
      ],
      leftRows,
    );
    const right = table(
      'tr',
      [
        ['rk', 'number'],
        ['w', 'number'],
      ],
      rightRows,
    );

    // 随机筛选谓词（均为类型合法的组合）
    const randPred = (keyCol: string, valCol: string): Predicate => {
      const p0 = cmp(pick(['=', '!=', '<', '>='] as const), col(keyCol), lit(pick([1, 2, 3, null])));
      const p1 = cmp(pick(['<', '>=', '='] as const), col(valCol), lit(Math.floor(rand() * 50)));
      const p2 = isNotNullP(col(keyCol));
      return pick([p0, andP(p0, p1), orP(p1, p2), notP(andP(p0, p2))]);
    };

    // 计划：scan → (filter)? → join → (filter)? → project | aggregate
    let plan: PlanNode = scan('tl');
    let ref: RefRelation = refScan(left);
    if (rand() < 0.5) {
      const pred = randPred('lk', 'v');
      plan = filter(plan, pred);
      ref = refFilter(ref, pred);
    }
    let rightPlan: PlanNode = scan('tr');
    let rightRef: RefRelation = refScan(right);
    if (rand() < 0.5) {
      const pred = randPred('rk', 'w');
      rightPlan = filter(rightPlan, pred);
      rightRef = refFilter(rightRef, pred);
    }
    plan = join(plan, rightPlan, 'lk', 'rk');
    ref = refJoin(ref, rightRef, 'lk', 'rk');

    if (rand() < 0.5) {
      const pred = cmp('>=', col('v'), lit(Math.floor(rand() * 50)));
      plan = filter(plan, pred);
      ref = refFilter(ref, pred);
    }

    if (rand() < 0.5) {
      plan = project(plan, ['v', 'w', { name: 'tag', as: 'label' }]);
      ref = refProject(ref, ['v', 'w', 'tag']);
      ref.columns[2] = { name: 'label', type: 'string' };
    } else {
      const groupBy = rand() < 0.6 ? ['tag'] : [];
      const aggs = [
        { func: 'countStar', as: 'n' },
        { func: 'count', column: 'v', as: 'cv' },
        { func: 'sum', column: 'v', as: 'sv' },
        { func: 'sum', column: 'w', as: 'sw' },
      ] as const;
      plan = aggregate(plan, groupBy, [...aggs]);
      ref = refAggregate(ref, groupBy, [...aggs]);
    }

    const engine = executeQuery({ tables: [left, right], plan });
    assert.ok(engine.ok, `iter ${iter}: ${JSON.stringify(engine)}`);
    assert.deepEqual(
      engine.columns.map((c) => c.name),
      ref.columns.map((c) => c.name),
      `iter ${iter} column names`,
    );
    assert.deepEqual(
      engine.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
      ref.rows.map((r) => ({ values: r.values, sourceIds: r.sourceIds })),
      `iter ${iter} rows`,
    );
  }
});

test('HTTP 服务：/execute 执行、校验错误返回 422、坏 JSON 返回 400', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);

    const good = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tables: [
          {
            name: 't',
            columns: [{ name: 'n', type: 'number' }],
            rows: [
              { id: 'a', values: [1] },
              { id: 'b', values: [null] },
            ],
          },
        ],
        plan: {
          op: 'aggregate',
          input: { op: 'scan', table: 't' },
          groupBy: [],
          aggregates: [
            { func: 'countStar', as: 'n' },
            { func: 'sum', column: 'n', as: 'total' },
          ],
        },
      }),
    });
    assert.equal(good.status, 200);
    const goodBody = (await good.json()) as {
      ok: true;
      rows: { values: unknown[]; sourceIds: string[] }[];
    };
    assert.deepEqual(goodBody.rows, [{ values: [2, 1], sourceIds: ['a', 'b'] }]);

    const invalid = await fetch(`${base}/execute`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tables: [{ name: 't', columns: [{ name: 'n', type: 'number' }], rows: [] }],
        plan: { op: 'project', input: { op: 'scan', table: 't' }, columns: [{ name: 'ghost' }] },
      }),
    });
    assert.equal(invalid.status, 422);
    const invalidBody = (await invalid.json()) as { ok: false; errors: string[] };
    assert.equal(invalidBody.ok, false);
    assert.match(invalidBody.errors.join('\n'), /unknown column 'ghost'/);
    assert.ok(!('rows' in invalidBody));

    const badJson = await fetch(`${base}/execute`, {
      method: 'POST',
      body: 'not json{',
    });
    assert.equal(badJson.status, 400);

    const notFound = await fetch(`${base}/nope`);
    assert.equal(notFound.status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
