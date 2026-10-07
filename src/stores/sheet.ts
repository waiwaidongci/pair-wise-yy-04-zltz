import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { CellCoord, CellMap, CellRange, CellRecord, CellValue, IterationOptions } from '../types/sheet'
import { DEFAULT_ITERATION, NOCONV_WARNING } from '../types/sheet'
import { cellId, displayValue, literalValue, normalizeRange, rangeContains } from '../utils/cells'
import { DependencyGraph, recalculate } from '../utils/recalc'

const ROWS = 1000
const COLS = 26
/** 重算中途失败后的重试次数：成功算出结果后才允许覆盖旧值 */
const RECALC_RETRIES = 2
const RETRY_DELAY_MS = 120

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

  // 滚动预算示例：成本、返点、毛利互相引用，依赖反复代入求解
  put('A16', '滚动预算示例（循环代入）')
  put('A17', '收入基数')
  put('B17', '40000')
  put('A18', '成本率')
  put('B18', '0.6')
  put('A19', '返点率')
  put('B19', '0.01')
  put('A21', '收入')
  put('B21', '=B17+B23')
  put('A22', '成本')
  put('B22', '=ROUND(B21*B18,2)')
  put('A23', '返点')
  put('B23', '=ROUND(B21*B19,2)')
  put('A24', '毛利')
  put('B24', '=ROUND(B21-B22-B23,2)')
  put('C21', '收入 = 基数+返点')
  put('C22', '成本 = 收入×成本率')
  put('C23', '返点 = 收入×返点率')
  put('C24', '毛利 = 收入-成本-返点')

  // 结构性不收敛示例：两格互相加 1，到达代入上限后保留末次数字并标出
  put('A27', '不收敛示例（保留末次值）')
  put('A28', '振荡X')
  put('B28', '=B29+1')
  put('A29', '振荡Y')
  put('B29', '=B28+1')
  return cells
}

interface HistorySnapshot {
  cells: CellMap
  active: CellCoord
  selection: CellRange
}

/** 深拷贝单元格结果；非有限数（极端发散）序列化为 null，防止 JSON 丢失成 null 造成歧义 */
function cloneCells(source: CellMap): CellMap {
  return JSON.parse(JSON.stringify(source)) as CellMap
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export const useSheetStore = defineStore('sheet', () => {
  const rows = ROWS
  const cols = COLS
  const cells = ref<CellMap>(createStarterCells())
  const active = ref<CellCoord>({ row: 1, col: 4 })
  const selection = ref<CellRange>({ start: { row: 1, col: 4 }, end: { row: 1, col: 4 } })
  const freezeRows = ref(1)
  const freezeCols = ref(1)
  const lastRecalculated = ref<string[]>([])
  const iteration = ref<IterationOptions>({ ...DEFAULT_ITERATION })
  const busy = ref(false)
  const history = ref<HistorySnapshot[]>([])
  const future = ref<HistorySnapshot[]>([])
  const status = ref('工作簿已加载，公式引擎待命')

  const graph = new DependencyGraph()
  /** 串行任务队列：所有编辑/重算/撤销/导出排队执行，保证“算完再覆盖” */
  const taskQueue: Array<() => Promise<void>> = []
  let draining = false

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

  function snapshot(): HistorySnapshot {
    return {
      cells: cloneCells(cells.value),
      active: { ...active.value },
      selection: { start: { ...selection.value.start }, end: { ...selection.value.end } },
    }
  }

  function enqueue(task: () => Promise<void>) {
    taskQueue.push(task)
    void drainQueue()
  }

  async function drainQueue() {
    if (draining) return
    draining = true
    busy.value = true
    try {
      while (taskQueue.length) {
        const task = taskQueue.shift()!
        await task()
      }
    } finally {
      busy.value = false
      draining = false
    }
  }

  /**
   * 计算受影响闭包并重试：计算过程不触碰当前结果，只有成功后才整体覆盖。
   * 中途失败（意外异常）先重试，仍失败则保留旧结果并报错，绝不半写。
   */
  async function recomputeAndCommit(changedIds: string[]): Promise<boolean> {
    const roots = graph.closure(changedIds)
    let lastError: unknown
    for (let attempt = 0; attempt <= RECALC_RETRIES; attempt += 1) {
      try {
        const outcome = await recalculate(cells.value, graph, roots, iteration.value)
        // 成功算出后才覆盖旧结果（同一批结果一次性提交）
        for (const [id, result] of outcome.updates) {
          const record = cells.value[id]
          if (record) cells.value[id] = { ...record, ...result }
        }
        lastRecalculated.value = [...outcome.updates.keys()]
        if (outcome.cycleGroups === 0) {
          status.value = `已重算 ${outcome.updates.size} 个受影响单元格`
        } else if (outcome.unconvergedGroups.length) {
          const count = outcome.unconvergedGroups.reduce((sum, group) => sum + group.length, 0)
          status.value = `循环代入：${outcome.convergedGroups} 组已收敛，${outcome.unconvergedGroups.length} 组达上限未收敛，${count} 格保留末次值并标 ${NOCONV_WARNING}`
        } else {
          const rounds = Math.max(...outcome.iterations, 0)
          status.value = `循环代入 ${outcome.cycleGroups} 组全部收敛（最多 ${rounds} 轮），共重算 ${outcome.updates.size} 格`
        }
        return true
      } catch (error) {
        lastError = error
        if (attempt < RECALC_RETRIES) await wait(RETRY_DELAY_MS * (attempt + 1))
      }
    }
    status.value = `重算失败，已重试 ${RECALC_RETRIES} 次，旧结果保留未覆盖`
    console.error('[sheet] recalculate failed after retries', lastError)
    return false
  }

  function pushHistory() {
    history.value.push(snapshot())
    if (history.value.length > 80) history.value.shift()
    future.value = []
  }

  /** 单格编辑：先入历史，再改 raw、更新依赖图边，然后只重算受影响闭包（含受影响循环组） */
  function setRaw(row: number, col: number, raw: string, record = true) {
    enqueue(async () => {
      const id = idFor(row, col)
      if ((cells.value[id]?.raw ?? '') === raw) return
      if (record) pushHistory()
      cells.value[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
      graph.setCell(id, raw)
      await recomputeAndCommit([id])
    })
  }

  function setManyRaw(start: CellCoord, matrix: string[][]) {
    enqueue(async () => {
      pushHistory()
      const changed: string[] = []
      matrix.forEach((rowValues, rowOffset) => {
        rowValues.forEach((raw, colOffset) => {
          const row = start.row + rowOffset
          const col = start.col + colOffset
          if (row >= rows || col >= cols) return
          const id = idFor(row, col)
          cells.value[id] = { raw, value: raw.startsWith('=') ? null : literalValue(raw) }
          graph.setCell(id, raw)
          changed.push(id)
        })
      })
      if (changed.length) await recomputeAndCommit(changed)
    })
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

  /** 撤销/重做恢复的快照已带同一批算好的结果，直接连同结果一起恢复，不再重算 */
  function restoreSnapshot(next: HistorySnapshot) {
    cells.value = next.cells
    active.value = next.active
    selection.value = next.selection
    graph.sync(cells.value)
    lastRecalculated.value = Object.keys(cells.value).filter((id) => cells.value[id].raw.startsWith('='))
  }

  function undo() {
    enqueue(async () => {
      const previous = history.value.pop()
      if (!previous) return
      future.value.push(snapshot())
      restoreSnapshot(previous)
      status.value = '已撤销上一步编辑（恢复同批计算结果）'
    })
  }

  function redo() {
    enqueue(async () => {
      const next = future.value.pop()
      if (!next) return
      history.value.push(snapshot())
      restoreSnapshot(next)
      status.value = '已恢复编辑（使用同一批结果）'
    })
  }

  function isSelected(row: number, col: number) {
    return rangeContains(selection.value, row, col)
  }

  /** 导出排在队列尾部：等在途重算完成，导出的就是屏幕上同一批结果 */
  function exportCsv() {
    enqueue(async () => {
      const lines: string[] = []
      for (let row = 0; row < Math.min(rows, 80); row += 1) {
        const values: string[] = []
        let hasData = false
        for (let col = 0; col < cols; col += 1) {
          const record = getRecord(row, col)
          if (record?.raw) hasData = true
          // 错误码照导出；不收敛警示不影响数值，导出保留的末次结果
          const shown = record?.error ?? displayValue(record?.value ?? '')
          values.push(`"${shown.replace(/"/g, '""')}"`)
        }
        if (hasData || row < 30) lines.push(values.join(','))
      }
      const blob = new Blob([`﻿${lines.join('\n')}`], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = '季度销售公式表.csv'
      anchor.click()
      URL.revokeObjectURL(url)
      status.value = 'CSV 已导出（使用当前同一批结果）'
    })
  }

  function reset() {
    enqueue(async () => {
      pushHistory()
      cells.value = createStarterCells()
      graph.sync(cells.value)
      await recomputeFromScratch()
      status.value = '已恢复示例工作簿'
    })
  }

  /** 整表重算：仅用于首次加载（撤销/重做/恢复直接带结果，不走这里，避免整表一起算） */
  async function recomputeFromScratch() {
    const formulaIds = Object.entries(cells.value)
      .filter(([, record]) => record.raw.startsWith('='))
      .map(([id]) => id)
    await recomputeAndCommit(formulaIds)
  }

  function updateIterationOptions(patch: Partial<IterationOptions>) {
    enqueue(async () => {
      iteration.value = { ...iteration.value, ...patch }
      // 参数变化属于全局重算：仍按循环组分批代入，不是整表一把算
      await recomputeFromScratch()
    })
  }

  graph.sync(cells.value)
  // 首次重算也走同一串行队列，避免与用户的即时编辑并发写结果
  enqueue(recomputeFromScratch)

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
    iteration,
    busy,
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
    updateIterationOptions,
  }
})
