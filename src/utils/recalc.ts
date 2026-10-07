import type { CellMap, CellValue, IterationOptions } from '../types/sheet'
import { CYCLE_ERROR, NOCONV_WARNING } from '../types/sheet'
import { expandRange, literalValue } from './cells'
import { FormulaError, collectDependencies, evaluateAst, parseFormula } from './formula'
import type { FormulaAst } from '../types/sheet'

/** 每批求值的单元格预算：超出后让出事件循环，避免上千行表格长时间阻塞 UI */
const YIELD_BUDGET = 300
/** AST 缓存上限，超过后整体重建（按 raw 内容缓存，raw 相同则公式相同） */
const AST_CACHE_LIMIT = 6000

export interface UnitResult {
  value: CellValue
  error?: string
  warning?: string
}

export interface RecalcOutcome {
  /** 本次需要写回的单元格结果（仅包含受影响闭包内的公式格） */
  updates: Map<string, UnitResult>
  closureSize: number
  cycleGroups: number
  convergedGroups: number
  unconvergedGroups: string[][]
  /** 每个循环组实际代入的轮数 */
  iterations: number[]
}

type IterState = { kind: 'ok'; value: CellValue } | { kind: 'error'; code: string }

const astCache = new Map<string, FormulaAst | FormulaError>()

/** 解析结果按 raw 缓存；解析失败同样缓存错误，避免每轮重复抛投 */
function getAst(raw: string): FormulaAst {
  const cached = astCache.get(raw)
  if (cached instanceof FormulaError) throw cached
  if (cached) return cached
  if (astCache.size >= AST_CACHE_LIMIT) astCache.clear()
  try {
    const ast = parseFormula(raw)
    astCache.set(raw, ast)
    return ast
  } catch (error) {
    const formulaError = error instanceof FormulaError ? error : new FormulaError('#ERROR!')
    astCache.set(raw, formulaError)
    throw formulaError
  }
}

/** 依赖图：dependsOn 为出边（公式格引用了谁），dependents 为反向边（谁引用了它） */
export class DependencyGraph {
  readonly dependsOn = new Map<string, Set<string>>()
  private readonly dependents = new Map<string, Set<string>>()

  /** 全量重建（加载、撤销/重做/重置等整表替换场景） */
  sync(cells: CellMap) {
    this.dependsOn.clear()
    this.dependents.clear()
    for (const [id, record] of Object.entries(cells)) {
      if (record.raw.startsWith('=')) this.addEdges(id, record.raw)
    }
  }

  /** 增量更新单个单元格的边 */
  setCell(id: string, raw: string) {
    this.removeEdges(id)
    if (raw.startsWith('=')) this.addEdges(id, raw)
  }

  private addEdges(id: string, raw: string) {
    const deps = new Set<string>()
    try {
      collectDependencies(getAst(raw)).forEach((dep) => deps.add(dep))
    } catch {
      // 解析失败的公式没有可跟踪的边，求值阶段会返回解析错误
    }
    this.dependsOn.set(id, deps)
    for (const dep of deps) {
      let set = this.dependents.get(dep)
      if (!set) {
        set = new Set()
        this.dependents.set(dep, set)
      }
      set.add(id)
    }
  }

  private removeEdges(id: string) {
    const deps = this.dependsOn.get(id)
    if (!deps) return
    for (const dep of deps) this.dependents.get(dep)?.delete(id)
    this.dependsOn.delete(id)
  }

  /** 沿反向边求全部（传递）依赖者闭包 */
  closure(roots: Iterable<string>): Set<string> {
    const reached = new Set<string>()
    const queue: string[] = []
    for (const root of roots) {
      if (!reached.has(root)) {
        reached.add(root)
        queue.push(root)
      }
    }
    while (queue.length) {
      const id = queue.pop()!
      for (const dependent of this.dependents.get(id) ?? []) {
        if (!reached.has(dependent)) {
          reached.add(dependent)
          queue.push(dependent)
        }
      }
    }
    return reached
  }
}

/** 迭代版 Tarjan：避免上千行长依赖链导致递归爆栈，返回强连通分量列表 */
function tarjan(nodes: Set<string>, deps: Map<string, Set<string>>): string[][] {
  const indexOf = new Map<string, number>()
  const low = new Map<string, number>()
  const onStack = new Set<string>()
  const stack: string[] = []
  const sccs: string[][] = []
  let counter = 0

  for (const root of nodes) {
    if (indexOf.has(root)) continue
    indexOf.set(root, counter)
    low.set(root, counter)
    counter += 1
    stack.push(root)
    onStack.add(root)

    // 每个帧记录当前节点与下一条待处理边的下标
    const callStack: Array<[string, number]> = [[root, 0]]

    while (callStack.length) {
      const frame = callStack[callStack.length - 1]
      const v = frame[0]
      const neighbors = deps.get(v)
      if (neighbors && frame[1] < neighbors.size) {
        const edgeIndex = frame[1]
        frame[1] += 1
        const w = [...neighbors][edgeIndex]
        // 闭包外的依赖不参与分量划分，也不影响 low 值
        if (!nodes.has(w)) continue
        if (!indexOf.has(w)) {
          indexOf.set(w, counter)
          low.set(w, counter)
          counter += 1
          stack.push(w)
          onStack.add(w)
          callStack.push([w, 0])
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, indexOf.get(w)!))
        }
      } else {
        callStack.pop()
        if (low.get(v) === indexOf.get(v)) {
          const component: string[] = []
          while (true) {
            const w = stack.pop()!
            onStack.delete(w)
            component.push(w)
            if (w === v) break
          }
          sccs.push(component)
        }
        const parentFrame = callStack[callStack.length - 1]
        if (parentFrame) low.set(parentFrame[0], Math.min(low.get(parentFrame[0])!, low.get(v)!))
      }
    }
  }
  return sccs
}

function valuesClose(a: CellValue, b: CellValue, tolerance: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    // 非有限值（发散到无穷等）不允许被判为稳定
    if (!Number.isFinite(a) || !Number.isFinite(b)) return false
    return Math.abs(a - b) < tolerance
  }
  return a === b
}

function statesClose(a: IterState, b: IterState, tolerance: number): boolean {
  if (a.kind === 'error' || b.kind === 'error') {
    return a.kind === 'error' && b.kind === 'error' && a.code === b.code
  }
  return valuesClose(a.value, b.value, tolerance)
}

function seedState(value: CellValue | undefined): IterState {
  return { kind: 'ok', value: value ?? null }
}

function yieldToEventLoop(): Promise<void> {
  // 用宏任务真正让出：微任务链在清空之前不会让浏览器插入渲染与输入响应
  return new Promise((resolve) => {
    if (typeof MessageChannel !== 'undefined') {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => {
        channel.port1.close()
        resolve()
      }
      channel.port2.postMessage(null)
    } else {
      setTimeout(resolve, 0)
    }
  })
}

/**
 * 增量重算：
 * 1. 只取受影响闭包；闭包内做 Tarjan 强连通分量，多节点分量（或自环）即循环组；
 * 2. 分量按依赖拓扑排序，环外公式单次求值，环外依赖直接读到最新值；
 * 3. 循环组做 Jacobi 反复代入，连续两轮每个成员变化都小于阈值才判收敛；
 * 4. 达到上限未收敛时保留最后一轮数值并打 #NOCONV! 警示；
 * 5. 按单元格预算分批让出事件循环。
 * 本函数只读 cells、只返回结果，不修改入参，因此失败后整体重试是安全的。
 */
export async function recalculate(
  cells: CellMap,
  graph: DependencyGraph,
  roots: Set<string>,
  options: IterationOptions,
): Promise<RecalcOutcome> {
  const closure = graph.closure(roots)

  const formulaNodes = new Set<string>()
  for (const id of closure) {
    if (cells[id]?.raw.startsWith('=')) formulaNodes.add(id)
  }

  // 求值环境：非公式格取字面值；循环组成员用上次结果作为迭代种子，
  // 环外公式格不预播种，保证按拓扑序新鲜求值（旧值不能当成本轮结果）。
  const env = new Map<string, CellValue>()
  for (const id of closure) {
    const record = cells[id]
    if (!record) {
      env.set(id, null)
    } else if (!record.raw.startsWith('=')) {
      env.set(id, literalValue(record.raw))
    }
  }

  const resolveRef = (id: string): unknown => {
    if (env.has(id)) return env.get(id) ?? null
    // 闭包外依赖：惰性单次求值（不可能再绕回闭包，否则它本就在闭包内）
    const value = evaluateFormula(id)
    return value
  }

  const resolveRange = (range: string): unknown[] => {
    const [start, end] = range.split(':')
    return expandRange(start, end).map((id) => resolveRef(id))
  }

  function evaluateFormula(id: string): CellValue {
    if (env.has(id)) return env.get(id) ?? null
    const record = cells[id]
    if (!record) {
      env.set(id, null)
      return null
    }
    if (!record.raw.startsWith('=')) {
      const value = literalValue(record.raw)
      env.set(id, value)
      return value
    }
    const ast = getAst(record.raw)
    const value = evaluateAst(ast, resolveRef, resolveRange) as CellValue
    env.set(id, value)
    return value
  }

  function evalState(id: string): IterState {
    try {
      return { kind: 'ok', value: evaluateFormulaFresh(id) }
    } catch (error) {
      return { kind: 'error', code: error instanceof FormulaError ? error.code : '#ERROR!' }
    }
  }

  // 循环代入时成员每轮必须重新求值，不能命中 env 中自身的旧结果
  function evaluateFormulaFresh(id: string): CellValue {
    const record = cells[id]
    if (!record) return null
    const ast = getAst(record.raw)
    return evaluateAst(ast, resolveRef, resolveRange) as CellValue
  }

  // 闭包内的强连通分量
  const components = tarjan(formulaNodes, graph.dependsOn)
  const componentOf = new Map<string, number>()
  const isCycleComponent = components.map((component, index) => {
    component.forEach((id) => componentOf.set(id, index))
    if (component.length > 1) return true
    const only = component[0]
    return graph.dependsOn.get(only)?.has(only) ?? false
  })

  // 分量级依赖图 + 拓扑序（被依赖的分量先算）
  const predecessors = components.map(() => new Set<number>())
  const successors = components.map(() => new Set<number>())
  for (const [id, deps] of graph.dependsOn) {
    const ci = componentOf.get(id)
    if (ci === undefined) continue
    for (const dep of deps) {
      const cj = componentOf.get(dep)
      if (cj === undefined || cj === ci || !formulaNodes.has(dep)) continue
      predecessors[ci].add(cj)
      successors[cj].add(ci)
    }
  }
  const indegree = predecessors.map((set) => set.size)
  const ready = indegree.map((degree, index) => (degree === 0 ? index : -1)).filter((index) => index >= 0)
  const ordered: number[] = []
  while (ready.length) {
    const ci = ready.pop()!
    ordered.push(ci)
    for (const next of successors[ci]) {
      indegree[next] -= 1
      if (indegree[next] === 0) ready.push(next)
    }
  }

  const updates = new Map<string, UnitResult>()
  const unconvergedGroups: string[][] = []
  const iterations: number[] = []
  let cycleGroups = 0
  let convergedGroups = 0
  let budgetUsed = 0

  const maybeYield = async (weight: number) => {
    budgetUsed += weight
    if (budgetUsed >= YIELD_BUDGET) {
      budgetUsed = 0
      await yieldToEventLoop()
    }
  }

  for (const ci of ordered) {
    const component = components[ci]
    if (!isCycleComponent[ci]) {
      const id = component[0]
      try {
        const value = evaluateFormula(id)
        updates.set(id, { value })
      } catch (error) {
        const code = error instanceof FormulaError ? error.code : '#ERROR!'
        updates.set(id, { value: null, error: code })
      }
      await maybeYield(1)
      continue
    }

    // 循环组：Jacobi 反复代入
    cycleGroups += 1
    if (!options.enabled) {
      iterations.push(0)
      for (const id of component) {
        // 显示 #CYCLE!，但记录中保留上次数值，重新开启迭代时可直接作为种子
        const previous = cells[id]?.value ?? null
        env.set(id, previous)
        updates.set(id, { value: previous, error: CYCLE_ERROR })
      }
      await maybeYield(component.length)
      continue
    }

    let prev = new Map<string, IterState>()
    // 成员以现有结果为迭代初值（首次为 null），基础格调整后通常几步即可重新收敛
    component.forEach((id) => {
      const seed = cells[id]?.value ?? null
      if (!env.has(id)) env.set(id, seed)
      prev.set(id, seedState(seed))
    })
    let last = prev
    let stableRuns = 0
    let converged = false
    let round = 0

    while (round < options.maxIterations) {
      round += 1
      const next = new Map<string, IterState>()
      for (const id of component) next.set(id, evalState(id))

      let stable = true
      for (const id of component) {
        if (!statesClose(prev.get(id)!, next.get(id)!, options.tolerance)) {
          stable = false
          break
        }
      }

      // 本轮成功值发布到环境，供下一轮与环外公式读取；失败格保留旧值继续参与代入
      for (const [id, state] of next) {
        if (state.kind === 'ok') env.set(id, state.value)
      }
      prev = next
      last = next

      if (stable) {
        stableRuns += 1
        // 连续两轮变化都小于阈值才确认稳定，避免恰好一轮抖动造成的假收敛
        if (stableRuns >= 2) {
          converged = true
          break
        }
      } else {
        stableRuns = 0
      }
      await maybeYield(component.length)
    }

    iterations.push(round)
    if (converged) {
      convergedGroups += 1
      for (const [id, state] of last) {
        if (state.kind === 'ok') updates.set(id, { value: state.value })
        else updates.set(id, { value: env.get(id) ?? null, error: state.code })
      }
    } else {
      unconvergedGroups.push(component)
      for (const [id, state] of last) {
        if (state.kind === 'ok') {
          // 未收敛也不丢数字：保留最后一轮结果，仅打警示
          updates.set(id, { value: state.value, warning: NOCONV_WARNING })
        } else {
          updates.set(id, { value: env.get(id) ?? null, error: state.code, warning: NOCONV_WARNING })
        }
      }
    }
  }

  return {
    updates,
    closureSize: closure.size,
    cycleGroups,
    convergedGroups,
    unconvergedGroups,
    iterations,
  }
}
