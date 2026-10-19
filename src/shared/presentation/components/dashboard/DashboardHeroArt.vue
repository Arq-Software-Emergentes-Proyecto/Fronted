<script setup>
/** Ilustración decorativa del banner del panel: edificios planos con ventanas encendidas (sin degradados). */
const LIT = '#fde68a'

function windows(originX, originY, cols, rows, size, gap, litEvery, fill) {
  const cells = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      cells.push({
        x: originX + c * (size + gap),
        y: originY + r * (size + gap),
        size,
        fill: (r * cols + c) % litEvery === 1 ? LIT : fill,
      })
    }
  }
  return cells
}

const towers = [
  ...windows(28, 82, 3, 4, 11, 8, 5, '#4a6ac4'),
  ...windows(108, 32, 4, 6, 13, 8, 4, '#5b7bd1'),
  ...windows(214, 68, 2, 5, 12, 10, 3, '#4a6ac4'),
]
</script>

<template>
  <svg class="hero-art" viewBox="0 0 320 176" aria-hidden="true" focusable="false">
    <rect x="0" y="168" width="320" height="8" fill="#2c4a9e" />
    <rect x="18" y="70" width="70" height="98" rx="4" fill="#2c4a9e" />
    <rect x="98" y="20" width="96" height="148" rx="4" fill="#3b5bb5" />
    <rect x="204" y="56" width="58" height="112" rx="4" fill="#2c4a9e" />
    <rect x="270" y="98" width="40" height="70" rx="4" fill="#3b5bb5" />
    <rect
      v-for="(w, i) in towers"
      :key="i"
      :x="w.x"
      :y="w.y"
      :width="w.size"
      :height="w.size"
      rx="2"
      :fill="w.fill"
    />
    <rect x="136" y="146" width="20" height="22" rx="2" fill="#1e3a8a" />
    <circle cx="292" cy="26" r="12" :fill="LIT" />
  </svg>
</template>

<style scoped>
.hero-art {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
