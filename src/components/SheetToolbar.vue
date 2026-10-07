<script setup lang="ts">
import { computed } from 'vue'
import { useSheetStore } from '../stores/sheet'
import { columnLabel } from '../utils/cells'
import type { IterationOptions } from '../types/sheet'

const store = useSheetStore()
const activeLabel = computed(() => `${columnLabel(store.active.col)}${store.active.row + 1}`)
const iterSummary = computed(() =>
  store.iteration.enabled ? `迭代 ${store.iteration.maxIterations} 次 / 阈值 ${store.iteration.tolerance}` : '迭代关闭',
)

function applyIteration(patch: Partial<IterationOptions>) {
  store.updateIterationOptions(patch)
}
</script>

<template>
  <div class="sheet-toolbar">
    <div class="toolbar-left">
      <v-btn size="small" variant="text" prepend-icon="mdi-undo" :disabled="!store.canUndo || store.busy" @click="store.undo">撤销</v-btn>
      <v-btn size="small" variant="text" prepend-icon="mdi-redo" :disabled="!store.canRedo || store.busy" @click="store.redo">重做</v-btn>
      <v-divider vertical class="mx-2" />
      <v-btn-toggle
        :model-value="store.freezeRows"
        density="compact"
        variant="outlined"
        @update:model-value="store.freezeRows = Number($event)"
      >
        <v-btn :value="0" size="small">不冻结行</v-btn>
        <v-btn :value="1" size="small">冻结首行</v-btn>
      </v-btn-toggle>
      <v-btn-toggle
        :model-value="store.freezeCols"
        density="compact"
        variant="outlined"
        @update:model-value="store.freezeCols = Number($event)"
      >
        <v-btn :value="0" size="small">不冻结列</v-btn>
        <v-btn :value="1" size="small">冻结首列</v-btn>
      </v-btn-toggle>
      <v-divider vertical class="mx-2" />
      <v-menu :close-on-content-click="false" location="bottom">
        <template #activator="{ props }">
          <v-btn size="small" variant="outlined" prepend-icon="mdi-autorenew" v-bind="props">
            循环代入
            <v-icon :icon="store.iteration.enabled ? 'mdi-check-circle' : 'mdi-alert-circle-outline'" :color="store.iteration.enabled ? 'success' : 'warning'" size="small" class="ms-1" />
          </v-btn>
        </template>
        <v-card class="iteration-panel" density="compact">
          <v-card-title class="text-subtitle-2 py-2">循环引用反复代入</v-card-title>
          <v-card-text class="pt-0">
            <v-switch
              :model-value="store.iteration.enabled"
              density="compact"
              color="primary"
              hide-details
              label="开启迭代求解（关闭后显示 #CYCLE!）"
              @update:model-value="applyIteration({ enabled: Boolean($event) })"
            />
            <div class="iter-fields">
              <v-text-field
                :model-value="store.iteration.maxIterations"
                type="number"
                density="compact"
                variant="outlined"
                hide-details
                min="1"
                max="10000"
                label="次数上限"
                :disabled="!store.iteration.enabled"
                @change="applyIteration({ maxIterations: Math.max(1, Math.min(10000, Number($event) || 1)) })"
              />
              <v-text-field
                :model-value="store.iteration.tolerance"
                type="number"
                density="compact"
                variant="outlined"
                hide-details
                min="0"
                step="0.0001"
                label="稳定阈值"
                :disabled="!store.iteration.enabled"
                @change="applyIteration({ tolerance: Math.max(0, Number($event) || 0) })"
              />
            </div>
            <p class="iter-hint">连续两轮每个单元格变化均小于阈值即收敛；到上限未收敛则保留末次值并标 #NOCONV!。</p>
          </v-card-text>
        </v-card>
      </v-menu>
      <v-btn size="small" variant="text" prepend-icon="mdi-delete-outline" @click="store.clearSelection">清除内容</v-btn>
    </div>
    <div class="toolbar-right">
      <v-progress-circular v-if="store.busy" indeterminate size="16" width="2" color="primary" />
      <span class="active-badge">{{ activeLabel }}</span>
      <span class="muted">{{ store.status }}</span>
      <span class="iter-badge">{{ iterSummary }}</span>
      <v-btn size="small" variant="text" prepend-icon="mdi-refresh" @click="store.reset">重置</v-btn>
      <v-btn size="small" color="primary" variant="flat" prepend-icon="mdi-download" :loading="store.busy" @click="store.exportCsv">导出 CSV</v-btn>
    </div>
  </div>
</template>

<style scoped>
.sheet-toolbar {
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 12px;
  border-bottom: 1px solid #dce3ec;
  background: #fff;
}
.toolbar-left, .toolbar-right { display: flex; align-items: center; gap: 6px; min-width: 0; }
.active-badge { padding: 4px 8px; border-radius: 5px; color: #1d4ed8; background: #eaf2ff; font: 700 12px ui-monospace, monospace; }
.iter-badge { padding: 3px 7px; border-radius: 5px; color: #6b5a16; background: #fef6e0; font-size: 10px; white-space: nowrap; }
.muted { color: #718096; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }
.iteration-panel { width: 300px; }
.iter-fields { display: flex; gap: 8px; margin-top: 4px; }
.iter-hint { margin: 8px 0 0; color: #718096; font-size: 10px; line-height: 1.5; }
</style>
