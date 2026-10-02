/**
 * 入口：executeQuery(request) —— 先完成全部校验，再执行；
 * 任何校验错误都返回 { ok: false, errors }，绝不返回部分结果。
 */
import { checkPlan } from './check.js';
import { executePlan } from './execute.js';
import { parseRequest } from './parse.js';
import type { InputTable, QueryResult } from './types.js';

export function executeQuery(request: unknown): QueryResult {
  try {
    const errors: string[] = [];

    // 第一阶段：结构校验（形状、枚举、上限、行值类型、行 ID 唯一性）
    const parsed = parseRequest(request, errors);
    if (parsed === null || errors.length > 0) {
      return { ok: false, errors };
    }

    // 第二阶段：语义校验（列名引用、类型一致性、计划合法性）
    const tables = new Map<string, InputTable>(parsed.tables.map((t) => [t.name, t]));
    checkPlan(parsed.plan, tables, errors, 'plan');
    if (errors.length > 0) {
      return { ok: false, errors };
    }

    // 第三阶段：执行
    const result = executePlan(parsed.plan, tables);
    return {
      ok: true,
      columns: result.schema.columns,
      rows: result.rows.map((r) => ({ values: r.values, sourceIds: r.provenance })),
    };
  } catch (err) {
    // 校验通过后的执行不应失败；此处兜底，保证服务不因异常中断
    return {
      ok: false,
      errors: [`internal error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

export * from './types.js';
export { compareValues, triAnd, triNot, triOr } from './trilogic.js';
export type { Tri } from './trilogic.js';
