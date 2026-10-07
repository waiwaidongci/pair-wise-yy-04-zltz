<script setup lang="ts">
import { computed } from 'vue'
import { useSheetStore } from '../stores/sheet'
import { displayValue } from '../utils/cells'

const props = defineProps<{ row: number; col: number }>()
const store = useSheetStore()

const record = computed(() => store.getRecord(props.row, props.col))
const shown = computed(() => record.value?.error ?? displayValue(record.value?.value))
</script>

<template>
  <span
    class="cell-value"
    :class="{ error: record?.error, warning: !record?.error && record?.warning }"
    :title="record?.warning && !record?.error ? `${record.warning}：已达代入上限未收敛，显示末次代入结果` : undefined"
  >
    <span class="value-text">{{ shown }}</span>
    <span v-if="record?.warning && !record?.error" class="warning-flag" :title="record.warning">!</span>
  </span>
</template>

<style scoped>
.cell-value { width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.value-text { width: 100%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.cell-value.error { color: #dc2626; font-family: ui-monospace, monospace; font-size: 11px; }
.cell-value.warning { display: flex; align-items: center; gap: 3px; color: #b45309; }
.warning-flag {
  flex: 0 0 auto;
  width: 12px;
  height: 12px;
  display: inline-grid;
  place-items: center;
  border-radius: 50%;
  background: #f59e0b;
  color: #fff;
  font-size: 9px;
  font-weight: 800;
}
</style>
