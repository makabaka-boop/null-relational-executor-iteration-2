/**
 * 三值逻辑（TRUE / FALSE / UNKNOWN）。
 * NULL 与任何值（包括 NULL）的比较结果都是 UNKNOWN。
 */
import type { ComparisonOp, Scalar } from './types.js';

export type Tri = 'T' | 'F' | 'U';

export function triNot(a: Tri): Tri {
  return a === 'T' ? 'F' : a === 'F' ? 'T' : 'U';
}

export function triAnd(a: Tri, b: Tri): Tri {
  if (a === 'F' || b === 'F') return 'F';
  if (a === 'U' || b === 'U') return 'U';
  return 'T';
}

export function triOr(a: Tri, b: Tri): Tri {
  if (a === 'T' || b === 'T') return 'T';
  if (a === 'U' || b === 'U') return 'U';
  return 'F';
}

/**
 * 三值比较。任一操作数为 NULL 时结果为 UNKNOWN。
 * 调用前已通过校验保证两侧类型一致（数值/字符串/布尔）。
 */
export function compareValues(op: ComparisonOp, left: Scalar, right: Scalar): Tri {
  if (left === null || right === null) return 'U';
  let result: boolean;
  switch (op) {
    case '=':
      result = left === right;
      break;
    case '!=':
      result = left !== right;
      break;
    case '<':
      result = (left as number) < (right as number);
      break;
    case '<=':
      result = (left as number) <= (right as number);
      break;
    case '>':
      result = (left as number) > (right as number);
      break;
    case '>=':
      result = (left as number) >= (right as number);
      break;
  }
  return result ? 'T' : 'F';
}
