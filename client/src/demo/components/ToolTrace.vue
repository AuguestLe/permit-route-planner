<script setup>
defineProps({ trace: { type: Array, default: () => [] } })
</script>

<template>
  <details class="trace" data-testid="tool-trace" open>
    <summary>工具与管线轨迹 <span>{{ trace.length }} 条</span></summary>
    <div v-if="!trace.length" class="quiet">尚未运行。</div>
    <ol v-else>
      <li v-for="(step, index) in trace" :key="index">
        <strong>{{ step.stage }}</strong>
        <span v-if="step.attempt">第 {{ step.attempt }} 次</span>
        <span v-if="step.code">错误 {{ step.code }}</span>
        <span v-if="step.status">状态 {{ step.status }}</span>
        <span v-if="step.level">分级 {{ step.level }} · {{ step.action }}</span>
        <span v-if="step.durationMs != null">{{ step.durationMs }} ms</span>
        <span v-if="step.repairCount != null">修正 {{ step.repairCount }} 次</span>
      </li>
    </ol>
  </details>
</template>

<style scoped>
.trace { margin-top: 18px; border: 1px solid #d8d1c2; background: #fffdf7; border-radius: 10px; padding: 12px 14px; }
.trace summary { cursor: pointer; font-weight: 700; color: #173330; }
.trace summary span { color: #70807c; font-weight: 500; margin-left: 8px; }
.trace ol { margin: 12px 0 0; padding-left: 20px; color: #405450; font-size: 13px; }
.trace li { margin-bottom: 7px; display: flex; flex-wrap: wrap; gap: 10px; }
.trace li strong { color: #0f6b62; }
.quiet { color: #72807c; margin-top: 8px; }
</style>
