import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CellCoord, CellMap, CellRange, CellRecord, CellValue, FormulaAst } from '../types/sheet'
import { cellId, displayValue, expandRange, literalValue, normalizeRange, rangeContains } from '../utils/cells'
import { isCyclicScc, solveCycleGroup, tarjanScc } from '../utils/cycles'
import { FormulaError, evaluateAst, formulaDependencies, parseFormula } from '../utils/formula'

const ROWS = 1000
const COLS = 26

function createStarterCells(): CellMap {
  const cells: CellMap = {}
  const put = (id: string, raw: string) => { cells[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) } }
  put('A1', '区域')
  put('B1', '一月')
  put('C1', '二月')
  put('D1', '三月')
  put('E1', '季度合计')
  put('A2', '华北')
  put('B2', '128000')
  put('C2', '143500')
  put('D2', '151200')
  put('A3', '华东')
  put('B3', '186000')
  put('C3', '193400')
  put('D3', '205800')
  put('A4', '华南')
  put('B4', '97000')
  put('C4', '118600')
  put('D4', '126900')
  put('A5', '西南')
  put('B5', '76000')
  put('C5', '83400')
  put('D5', '92100')
  put('E2', '=SUM(B2:D2)')
  put('E3', '=SUM(B3:D3)')
  put('E4', '=SUM(B4:D4)')
  put('E5', '=SUM(B5:D5)')
  put('A6', '合计')
  put('B6', '=SUM(B2:B5)')
  put('C6', '=SUM(C2:C5)')
  put('D6', '=SUM(D2:D5)')
  put('E6', '=SUM(E2:E5)')
  put('A8', '月均销售')
  put('B8', '=ROUND(AVERAGE(B2:B5),0)')
  put('C8', '=ROUND(AVERAGE(C2:C5),0)')
  put('D8', '=ROUND(AVERAGE(D2:D5),0)')
  put('E8', '=ROUND(AVERAGE(E2:E5),0)')
  put('A10', '最高区域')
  put('B10', '=MAX(E2:E5)')
  put('A11', '最低区域')
  put('B11', '=MIN(E2:E5)')
  put('A13', '达标说明')
  put('B13', '=IF(E6>1500000,"达成季度目标","需要关注")')
  // 滚动预算示例：返点与毛利互相引用，形成循环引用，由迭代代入求解
  put('A15', '滚动预算示例')
  put('A16', '收入')
  put('B16', '100000')
  put('A17', '成本')
  put('B17', '=B16*0.6')
  put('A18', '返点')
  put('B18', '=B19*0.05')
  put('A19', '毛利')
  put('B19', '=B16-B17-B18')
  return cells
}

interface HistorySnapshot {
  cells: CellMap
  active: CellCoord
  selection: CellRange
}

export const useSheetStore = defineStore('sheet', () => {
  const rows = ROWS
  const cols = COLS
  const cells = ref<CellMap>(createStarterCells())
  const active = ref<CellCoord>({ row: 1, col: 4 })
  const selection = ref<CellRange>({ start: { row: 1, col: 4 }, end: { row: 1, col: 4 } })
  const freezeRows = ref(1)
  const freezeCols = ref(1)
  const lastRecalculated = ref<string[]>([])
  const history = ref<HistorySnapshot[]>([])
  const future = ref<HistorySnapshot[]>([])
  const status = ref('工作簿已加载，公式引擎待命')

  const activeRaw = computed(() => getRaw(active.value.row, active.value.col))
  const activeValue = computed(() => cells.value[cellId(active.value.row, active.value.col)]?.value ?? null)
  const canUndo = computed(() => history.value.length > 0)
  const canRedo = computed(() => future.value.length > 0)

  function idFor(row: number, col: number) {
    return cellId(row, col)
  }

  function getRaw(row: number, col: number) {
    return cells.value[idFor(row, col)]?.raw ?? ''
  }

  function getRecord(row: number, col: number): CellRecord | undefined {
    return cells.value[idFor(row, col)]
  }

  function buildGraph() {
    const formulaIds = Object.keys(cells.value).filter((id) => cells.value[id]?.raw.startsWith('='))
    const formulaSet = new Set(formulaIds)
    const depsOf = new Map<string, Set<string>>()
    const dependentsOf = new Map<string, Set<string>>()
    for (const id of formulaIds) {
      const deps = formulaDependencies(cells.value[id].raw)
      const filtered = new Set([...deps].filter((dep) => formulaSet.has(dep)))
      depsOf.set(id, filtered)
      for (const dep of filtered) {
        if (!dependentsOf.has(dep)) dependentsOf.set(dep, new Set())
        dependentsOf.get(dep)!.add(id)
      }
    }
    return { formulaIds, depsOf, dependentsOf }
  }

  function computeAffected(startIds: Set<string>, dependentsOf: Map<string, Set<string>>): Set<string> {
    const affected = new Set(startIds)
    const queue = [...startIds]
    while (queue.length) {
      const id = queue.shift()!
      for (const dependent of dependentsOf.get(id) ?? []) {
        if (!affected.has(dependent)) {
          affected.add(dependent)
          queue.push(dependent)
        }
      }
    }
    return affected
  }

  function recalculate(startIds: Set<string>) {
    // 先在临时缓冲区里算，失败重试，成功后再整体写回，避免中途失败覆盖旧结果
    let result: BatchResult | null = null
    for (let attempt = 0; attempt < 2 && !result; attempt += 1) {
      try {
        result = computeBatch(startIds)
      } catch {
        // 中途失败：重试一次；仍失败则保留上一次结果
      }
    }
    if (!result) {
      status.value = '重算失败，已保留上一次结果'
      return
    }
    const { out, convergedGroups, nonConvergedGroups } = result
    const next = { ...cells.value }
    for (const [id, record] of out) next[id] = record
    cells.value = next
    lastRecalculated.value = [...out.keys()]
    if (nonConvergedGroups > 0) {
      status.value = `已重算 ${out.size} 个受影响单元格，${convergedGroups} 个循环组收敛，${nonConvergedGroups} 个未收敛（保留最近代入结果）`
    } else if (convergedGroups > 0) {
      status.value = `已重算 ${out.size} 个受影响单元格，${convergedGroups} 个循环组已迭代收敛`
    } else {
      status.value = `已重算 ${out.size} 个受影响单元格`
    }
  }

  interface BatchResult {
    out: Map<string, CellRecord>
    convergedGroups: number
    nonConvergedGroups: number
  }

  function computeBatch(startIds: Set<string>): BatchResult {
    const { formulaIds, depsOf, dependentsOf } = buildGraph()
    const affected = computeAffected(startIds, dependentsOf)

    const sccs = tarjanScc(formulaIds, depsOf)
    const sccOf = new Map<string, number>()
    sccs.forEach((scc, index) => scc.forEach((id) => sccOf.set(id, index)))
    const cyclicFlags = sccs.map((scc) => isCyclicScc(scc, depsOf))

    // 预解析所有公式，避免迭代时重复解析
    const astCache = new Map<string, FormulaAst>()
    for (const id of formulaIds) astCache.set(id, parseFormula(cells.value[id].raw))

    const resolved = new Map<string, CellValue>()
    const out = new Map<string, CellRecord>()
    let convergedGroups = 0
    let nonConvergedGroups = 0

    // 字面量单元格直接入解析缓存
    for (const [id, record] of Object.entries(cells.value)) {
      if (!record.raw.startsWith('=')) resolved.set(id, literalValue(record.raw))
    }

    // 环外读取：已解析的用最新值，未受影响的公式格沿用旧值
    const readRef = (id: string): CellValue => {
      if (resolved.has(id)) return resolved.get(id) as CellValue
      const record = cells.value[id]
      if (!record) return null
      if (!record.raw.startsWith('=')) {
        const value = literalValue(record.raw)
        resolved.set(id, value)
        return value
      }
      return record.value ?? null
    }
    const readRange = (range: string): CellValue[] => {
      const [start, end] = range.split(':')
      return expandRange(start, end).map((id) => readRef(id))
    }

    const evaluateCell = (id: string, resolveRef: (ref: string) => CellValue, resolveRange: (range: string) => CellValue[]): CellValue => {
      const ast = astCache.get(id) ?? parseFormula(cells.value[id].raw)
      return evaluateAst(ast, resolveRef, resolveRange) as CellValue
    }

    const evaluating = new Set<number>()
    const evaluateScc = (sccId: number) => {
      if (sccs[sccId].every((id) => resolved.has(id))) return
      if (evaluating.has(sccId)) throw new FormulaError('#CYCLE!')
      evaluating.add(sccId)
      const scc = sccs[sccId]

      // 先计算本 SCC 依赖的其他 SCC，保证环外公式读到最新值
      const depSccs = new Set<number>()
      for (const id of scc) {
        for (const dep of depsOf.get(id) ?? []) {
          const depScc = sccOf.get(dep)
          if (depScc !== undefined && depScc !== sccId) depSccs.add(depScc)
        }
      }
      depSccs.forEach((dep) => evaluateScc(dep))

      const sccAffected = scc.some((id) => affected.has(id))
      if (!sccAffected) {
        for (const id of scc) {
          if (!resolved.has(id)) resolved.set(id, cells.value[id]?.value ?? null)
        }
        evaluating.delete(sccId)
        return
      }

      if (cyclicFlags[sccId]) {
        const solution = solveCycleGroup(
          scc,
          (id) => cells.value[id]?.value ?? null,
          evaluateCell,
          readRef,
        )
        if (solution.converged) convergedGroups += 1
        else nonConvergedGroups += 1
        for (const id of scc) {
          const record = cells.value[id]
          const error = solution.errors.get(id)
          const value = solution.values.get(id) ?? null
          resolved.set(id, value)
          out.set(id, {
            raw: record.raw,
            value,
            error,
            converged: error ? undefined : solution.converged ? undefined : false,
          })
        }
      } else {
        for (const id of scc) {
          const record = cells.value[id]
          try {
            const value = evaluateCell(id, readRef, readRange)
            resolved.set(id, value)
            out.set(id, { raw: record.raw, value })
          } catch (error) {
            const code = error instanceof FormulaError ? error.code : '#ERROR!'
            resolved.set(id, null)
            out.set(id, { raw: record.raw, value: null, error: code })
          }
        }
      }
      evaluating.delete(sccId)
    }

    // 只代入受影响的循环组，不整表一起算
    const affectedSccs = new Set<number>()
    for (const id of affected) {
      const sccId = sccOf.get(id)
      if (sccId !== undefined) affectedSccs.add(sccId)
    }
    affectedSccs.forEach((sccId) => evaluateScc(sccId))

    // 受影响的字面量单元格也写回，保持 value 与 raw 一致
    for (const id of affected) {
      const record = cells.value[id]
      if (record && !record.raw.startsWith('=') && !out.has(id)) {
        out.set(id, { raw: record.raw, value: literalValue(record.raw) })
      }
    }

    return { out, convergedGroups, nonConvergedGroups }
  }

  function snapshot(): HistorySnapshot {
    return {
      cells: JSON.parse(JSON.stringify(cells.value)) as CellMap,
      active: { ...active.value },
      selection: { start: { ...selection.value.start }, end: { ...selection.value.end } },
    }
  }

  function recordHistory() {
    history.value.push(snapshot())
    if (history.value.length > 80) history.value.shift()
    future.value = []
  }

  function setRaw(row: number, col: number, raw: string, record = true) {
    if (record) recordHistory()
    const id = idFor(row, col)
    const existing = cells.value[id]
    if ((existing?.raw ?? '') === raw) return
    cells.value[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
    recalculate(new Set([id]))
  }

  function setManyRaw(start: CellCoord, matrix: string[][]) {
    recordHistory()
    const changed: string[] = []
    matrix.forEach((rowValues, rowOffset) => {
      rowValues.forEach((raw, colOffset) => {
        const row = start.row + rowOffset
        const col = start.col + colOffset
        if (row >= rows || col >= cols) return
        const id = idFor(row, col)
        cells.value[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
        changed.push(id)
      })
    })
    recalculate(new Set(changed))
  }

  function setActive(row: number, col: number, extend = false) {
    const next = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    }
    active.value = next
    if (!extend) selection.value = { start: { ...next }, end: { ...next } }
    else selection.value.end = { ...next }
  }

  function setSelectionEnd(row: number, col: number) {
    selection.value.end = {
      row: Math.max(0, Math.min(rows - 1, row)),
      col: Math.max(0, Math.min(cols - 1, col)),
    }
  }

  function selectedMatrix() {
    const range = normalizeRange(selection.value)
    const matrix: string[][] = []
    for (let row = range.start.row; row <= range.end.row; row += 1) {
      const values: string[] = []
      for (let col = range.start.col; col <= range.end.col; col += 1) values.push(getRaw(row, col))
      matrix.push(values)
    }
    return matrix
  }

  function selectedText() {
    return selectedMatrix().map((row) => row.map((cell) => cell.replace(/\t/g, ' ')).join('\t')).join('\n')
  }

  function pasteText(text: string) {
    const matrix = text.replace(/\r/g, '').split('\n').filter((row, index, list) => row.length || index < list.length - 1).map((row) => row.split('\t'))
    if (matrix.length) setManyRaw(active.value, matrix)
  }

  function clearSelection() {
    const range = normalizeRange(selection.value)
    const matrix = Array.from({ length: range.end.row - range.start.row + 1 }, () => Array(range.end.col - range.start.col + 1).fill(''))
    setManyRaw(range.start, matrix)
  }

  function undo() {
    const previous = history.value.pop()
    if (!previous) return
    future.value.push(snapshot())
    // 快照里已是同一批计算结果，直接恢复，不再重算
    cells.value = previous.cells
    active.value = previous.active
    selection.value = previous.selection
    status.value = '已撤销上一步编辑'
  }

  function redo() {
    const next = future.value.pop()
    if (!next) return
    history.value.push(snapshot())
    // 快照里已是同一批计算结果，直接恢复，不再重算
    cells.value = next.cells
    active.value = next.active
    selection.value = next.selection
    status.value = '已恢复编辑'
  }

  function isSelected(row: number, col: number) {
    return rangeContains(selection.value, row, col)
  }

  function exportCsv() {
    const lines: string[] = []
    for (let row = 0; row < Math.min(rows, 80); row += 1) {
      const values: string[] = []
      let hasData = false
      for (let col = 0; col < cols; col += 1) {
        const record = getRecord(row, col)
        if (record?.raw) hasData = true
        values.push(`"${displayValue(record?.value ?? '').replace(/"/g, '""')}"`)
      }
      if (hasData || row < 15) lines.push(values.join(','))
    }
    const blob = new Blob([`\uFEFF${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = '季度销售公式表.csv'
    anchor.click()
    URL.revokeObjectURL(url)
    status.value = 'CSV 已导出'
  }

  function reset() {
    recordHistory()
    cells.value = createStarterCells()
    recalculate(new Set(Object.keys(cells.value)))
    status.value = '已恢复示例工作簿'
  }

  recalculate(new Set(Object.keys(cells.value)))

  return {
    rows,
    cols,
    cells,
    active,
    selection,
    activeRaw,
    activeValue,
    freezeRows,
    freezeCols,
    lastRecalculated,
    canUndo,
    canRedo,
    status,
    idFor,
    getRaw,
    getRecord,
    setRaw,
    setManyRaw,
    setActive,
    setSelectionEnd,
    selectedMatrix,
    selectedText,
    pasteText,
    clearSelection,
    undo,
    redo,
    isSelected,
    exportCsv,
    reset,
  }
})
