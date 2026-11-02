<script setup>
import { computed } from 'vue'

/** Mini gráfico de línea (sin ejes) para la tendencia de un KPI. Colores sólidos, sin degradados. */
const props = defineProps({
  points: { type: Array, default: () => [] },
  color: { type: String, default: '#1e3a8a' },
  width: { type: Number, default: 120 },
  height: { type: Number, default: 38 },
})

const geometry = computed(() => {
  const values = props.points.map((v) => Number(v) || 0)
  if (values.length < 2) return null
  const pad = 4
  const max = Math.max(...values)
  const min = Math.min(...values)
  const range = max - min
  const step = (props.width - pad * 2) / (values.length - 1)
  const coords = values.map((v, i) => {
    const x = pad + i * step
    // Serie plana: línea al medio para que no se pegue al borde.
    const y = range === 0 ? props.height / 2 : props.height - pad - ((v - min) / range) * (props.height - pad * 2)
    return [x, y]
  })
  const d = coords.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ')
  const [lastX, lastY] = coords[coords.length - 1]
  return { d, lastX, lastY }
})
</script>

<template>
  <svg
    v-if="geometry"
    class="kpi-sparkline"
    :viewBox="`0 0 ${width} ${height}`"
    :width="width"
    :height="height"
    aria-hidden="true"
    focusable="false"
  >
    <path
      :d="geometry.d"
      fill="none"
      :stroke="color"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
    <circle :cx="geometry.lastX" :cy="geometry.lastY" r="3.5" :fill="color" />
  </svg>
</template>

<style scoped>
.kpi-sparkline {
  display: block;
  flex-shrink: 0;
  overflow: visible;
}
</style>
