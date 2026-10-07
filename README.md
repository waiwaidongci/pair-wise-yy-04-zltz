# GridFormula 类电子表格公式编辑器

技术栈：Vue 3、TypeScript、Vite、Vuetify、Pinia、Vue Router。

## 功能

- 1000 行、26 列虚拟滚动表格，支持编辑、区域选择、复制粘贴与键盘导航。
- 支持冻结首行、首列。
- 公式支持四则运算、括号、单元格引用、区域引用、SUM、AVERAGE、MIN、MAX、COUNT、IF、ROUND、ABS。
- 基于依赖图与 Tarjan 强连通分量识别循环组；循环引用默认按反复代入（Jacobi 迭代）求解，连续两轮每个成员变化均小于阈值即判定收敛。达到次数上限未收敛时保留最后一次代入结果并标注 `#NOCONV!`；关闭迭代开关后循环组仍显示 `#CYCLE!`。
- 编辑后只重算受影响闭包及其循环组，环外公式单次求值并读到最新值；循环组分批代入并让出事件循环；计算中途失败自动重试，成功后才原子覆盖旧结果。
- 撤销/重做恢复同一批已算结果，导出排在重算队列之后，界面与 CSV 始终使用同一批结果。
- 支持撤销重做和 CSV 导出。

## 运行

```bash
corepack pnpm install
corepack pnpm dev
corepack pnpm build
```
