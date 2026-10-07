import type { CellValue } from '../types/sheet'
import { expandRange } from './cells'

// 循环引用迭代求解参数：
// 连续两次代入结果的变化（绝对量或相对量）小于阈值即判定稳定；
// 代入次数达到上限仍未稳定，则保留最近一次结果并标出不收敛。
export const CYCLE_ABS_TOLERANCE = 1e-4
export const CYCLE_REL_TOLERANCE = 1e-6
export const MAX_CYCLE_ITERATIONS = 500

export interface CycleSolution {
  values: Map<string, CellValue>
  errors: Map<string, string>
  converged: boolean
  iterations: number
}

/**
 * Tarjan 强连通分量算法。
 * 入参为公式单元格 id 列表与公式依赖图（id -> 其引用的公式单元格集合），
 * 返回若干 SCC，每个 SCC 是一组互相可达的单元格 id。
 */
export function tarjanScc(nodeIds: string[], depsOf: Map<string, Set<string>>): string[][] {
  let index = 0
  const stack: string[] = []
  const onStack = new Set<string>()
  const indices = new Map<string, number>()
  const lowlink = new Map<string, number>()
  const sccs: string[][] = []

  const strongconnect = (id: string) => {
    indices.set(id, index)
    lowlink.set(id, index)
    index += 1
    stack.push(id)
    onStack.add(id)
    for (const dep of depsOf.get(id) ?? []) {
      if (!indices.has(dep)) {
        strongconnect(dep)
        lowlink.set(id, Math.min(lowlink.get(id) as number, lowlink.get(dep) as number))
      } else if (onStack.has(dep)) {
        lowlink.set(id, Math.min(lowlink.get(id) as number, indices.get(dep) as number))
      }
    }
    if (lowlink.get(id) === indices.get(id)) {
      const scc: string[] = []
      let w: string
      do {
        w = stack.pop() as string
        onStack.delete(w)
        scc.push(w)
      } while (w !== id)
      sccs.push(scc)
    }
  }

  for (const id of nodeIds) {
    if (!indices.has(id)) strongconnect(id)
  }
  return sccs
}

/** 判断 SCC 是否构成循环引用：大小大于 1，或单个单元格自引用。 */
export function isCyclicScc(scc: string[], depsOf: Map<string, Set<string>>): boolean {
  if (scc.length > 1) return true
  if (scc.length === 1) return depsOf.get(scc[0])?.has(scc[0]) ?? false
  return false
}

function isStable(a: number, b: number): boolean {
  if (Math.abs(a - b) <= CYCLE_ABS_TOLERANCE) return true
  return Math.abs(a - b) <= CYCLE_REL_TOLERANCE * Math.max(Math.abs(a), Math.abs(b))
}

/**
 * 对一个循环组执行反复代入（高斯-赛德尔迭代），直到连续两次结果稳定或达到次数上限。
 * 组内引用始终取最新代入值（本轮已更新的用本轮结果，否则沿用上一轮），
 * 组外引用通过 readRef / readRange 读取已算好的最新值。
 */
export function solveCycleGroup(
  group: string[],
  currentValue: (id: string) => CellValue,
  evaluateCell: (id: string, resolveRef: (ref: string) => CellValue, resolveRange: (range: string) => CellValue[]) => CellValue,
  readRef: (ref: string) => CellValue,
): CycleSolution {
  const groupSet = new Set(group)
  let prev = new Map<string, number | null>()
  for (const id of group) {
    const value = currentValue(id)
    prev.set(id, typeof value === 'number' && Number.isFinite(value) ? value : 0)
  }

  let converged = false
  let iterations = 0
  let errors = new Map<string, string>()

  for (let iter = 1; iter <= MAX_CYCLE_ITERATIONS; iter += 1) {
    iterations = iter
    const next = new Map<string, number | null>()
    errors = new Map<string, string>()
    // 组内引用：本轮已更新的用 next，否则沿用上一轮 prev
    const resolveRef = (ref: string): CellValue => {
      if (groupSet.has(ref)) return next.get(ref) ?? prev.get(ref) ?? 0
      return readRef(ref)
    }
    const resolveRange = (range: string): CellValue[] => {
      const [start, end] = range.split(':')
      return expandRange(start, end).map((id) => resolveRef(id))
    }
    for (const id of group) {
      try {
        const value = evaluateCell(id, resolveRef, resolveRange)
        next.set(id, typeof value === 'number' && Number.isFinite(value) ? value : null)
      } catch (error) {
        errors.set(id, error instanceof Error ? error.message : '#ERROR!')
        next.set(id, null)
      }
    }
    let stable = true
    for (const id of group) {
      const a = next.get(id)
      const b = prev.get(id)
      if (a === null || a === undefined || b === null || b === undefined || !isStable(a, b)) { stable = false; break }
    }
    prev = next
    if (stable) { converged = true; break }
  }

  return { values: prev, errors, converged, iterations }
}
