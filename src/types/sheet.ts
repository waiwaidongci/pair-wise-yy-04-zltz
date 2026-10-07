export type CellValue = string | number | boolean | null

export interface CellRecord {
  raw: string
  value: CellValue
  error?: string
  /** 非致命警示：仍保留 value（例如循环代入达上限未收敛时的末次结果） */
  warning?: string
}

export interface CellCoord {
  row: number
  col: number
}

export interface CellRange {
  start: CellCoord
  end: CellCoord
}

export interface FormulaAst {
  type: 'number' | 'string' | 'boolean' | 'reference' | 'range' | 'binary' | 'unary' | 'function'
  value?: string | number | boolean
  left?: FormulaAst
  right?: FormulaAst
  operator?: string
  name?: string
  args?: FormulaAst[]
}

export type CellMap = Record<string, CellRecord>

/** 循环引用反复代入的求解参数 */
export interface IterationOptions {
  /** 总开关：关闭后循环引用仍按 #CYCLE! 处理 */
  enabled: boolean
  /** 代入次数上限 */
  maxIterations: number
  /** 稳定阈值：同一循环组连续两轮每个单元格变化都小于它即视为收敛 */
  tolerance: number
}

export const DEFAULT_ITERATION: IterationOptions = {
  enabled: true,
  maxIterations: 100,
  tolerance: 0.001,
}

/** 不收敛警示码：单元格保留最后一次代入的数字 */
export const NOCONV_WARNING = '#NOCONV!'
/** 循环引用未开启迭代时的错误码 */
export const CYCLE_ERROR = '#CYCLE!'
