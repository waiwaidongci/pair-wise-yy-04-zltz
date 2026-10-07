export type CellValue = string | number | boolean | null

export interface CellRecord {
  raw: string
  value: CellValue
  error?: string
  /** 循环组迭代求解结果：false 表示代入到次数上限仍未收敛（保留最近一次结果） */
  converged?: boolean
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
