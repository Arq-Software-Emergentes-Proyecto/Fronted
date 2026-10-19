<script setup>
/**
 * Ilustración de marca (banner del panel, login y registro): un edificio residencial con su
 * barrio de noche. Colores sólidos sobre el azul de marca, sin degradados.
 */
const LIT = '#fde68a'
const SKY_STARS = [
  [18, 18], [52, 34], [84, 12], [150, 10], [204, 26], [238, 8], [262, 44], [312, 58],
]

/** Rejilla de ventanas; `lit` decide de forma fija cuáles tienen luz (el dibujo no cambia entre renders). */
function windows({ x, y, cols, rows, w, h, gapX, gapY, off, lit }) {
  const cells = []
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      cells.push({
        x: x + c * (w + gapX),
        y: y + r * (h + gapY),
        w,
        h,
        fill: lit(r, c) ? LIT : off,
      })
    }
  }
  return cells
}

// Torre principal: 4 columnas x 6 pisos, con balcón bajo cada piso.
const TOWER = { x: 112, y: 30, w: 96, floorH: 17, floors: 6 }
const towerWindows = windows({
  x: TOWER.x + 10, y: TOWER.y + 12, cols: 4, rows: TOWER.floors, w: 14, h: 9, gapX: 7, gapY: 8,
  off: '#2c4a9e', lit: (r, c) => (r * 5 + c * 3) % 7 < 3,
})
const towerBalconies = Array.from({ length: TOWER.floors }, (_, r) => TOWER.y + 23 + r * TOWER.floorH)

const leftWindows = windows({
  x: 30, y: 76, cols: 3, rows: 5, w: 8, h: 8, gapX: 6, gapY: 8,
  off: '#2a4694', lit: (r, c) => (r + c * 2) % 4 === 1,
})
const rightWindows = windows({
  x: 230, y: 62, cols: 3, rows: 6, w: 8, h: 8, gapX: 6, gapY: 7,
  off: '#2a4694', lit: (r, c) => (r * 2 + c) % 5 === 2,
})
const farWindows = windows({
  x: 9, y: 104, cols: 2, rows: 3, w: 4, h: 4, gapX: 5, gapY: 6,
  off: '#2a4797', lit: (r, c) => (r + c) % 3 === 0,
}).concat(
  windows({
    x: 300, y: 94, cols: 2, rows: 4, w: 4, h: 4, gapX: 5, gapY: 6,
    off: '#2a4797', lit: (r, c) => (r * 2 + c) % 3 === 1,
  }),
)
</script>

<template>
  <svg class="hero-art" viewBox="0 0 320 176" aria-hidden="true" focusable="false">
    <!-- Cielo -->
    <circle
      v-for="([cx, cy], i) in SKY_STARS"
      :key="`s${i}`"
      :cx="cx"
      :cy="cy"
      :r="i % 3 === 0 ? 1.3 : 0.9"
      fill="#dbe4ff"
      opacity="0.7"
    />
    <circle cx="282" cy="28" r="19" :fill="LIT" opacity="0.14" />
    <circle cx="282" cy="28" r="12" :fill="LIT" />
    <rect x="14" y="24" width="44" height="8" rx="4" fill="#ffffff" opacity="0.12" />
    <rect x="26" y="19" width="20" height="8" rx="4" fill="#ffffff" opacity="0.12" />
    <rect x="186" y="7" width="32" height="6" rx="3" fill="#ffffff" opacity="0.1" />

    <!-- Fondo: siluetas lejanas -->
    <g fill="#264292">
      <rect x="4" y="96" width="20" height="80" rx="3" />
      <rect x="10" y="88" width="10" height="10" rx="2" />
      <rect x="62" y="116" width="18" height="60" rx="3" />
      <rect x="266" y="84" width="20" height="92" rx="3" />
      <rect x="280" y="70" width="14" height="106" rx="3" />
      <rect x="294" y="86" width="22" height="90" rx="3" />
    </g>
    <rect v-for="(w, i) in farWindows" :key="`f${i}`" :x="w.x" :y="w.y" :width="w.w" :height="w.h" rx="1" :fill="w.fill" />

    <!-- Edificio izquierdo con tanque de agua -->
    <rect x="22" y="66" width="54" height="110" rx="3" fill="#2f4fa8" />
    <rect x="22" y="66" width="54" height="5" fill="#3a5bb8" />
    <rect x="44" y="52" width="16" height="11" rx="2" fill="#3a5bb8" />
    <rect x="47" y="63" width="2" height="4" fill="#3a5bb8" />
    <rect x="55" y="63" width="2" height="4" fill="#3a5bb8" />
    <rect v-for="(w, i) in leftWindows" :key="`l${i}`" :x="w.x" :y="w.y" :width="w.w" :height="w.h" rx="1.5" :fill="w.fill" />

    <!-- Edificio derecho con antena -->
    <rect x="222" y="52" width="50" height="124" rx="3" fill="#2f4fa8" />
    <rect x="222" y="52" width="50" height="5" fill="#3a5bb8" />
    <rect x="246" y="30" width="2" height="22" fill="#9fb2e8" />
    <circle cx="247" cy="29" r="2.2" fill="#f87171" />
    <rect v-for="(w, i) in rightWindows" :key="`r${i}`" :x="w.x" :y="w.y" :width="w.w" :height="w.h" rx="1.5" :fill="w.fill" />

    <!-- Torre principal: cara lateral (volumen) + fachada -->
    <path :d="`M${TOWER.x + TOWER.w} ${TOWER.y + 6}h10v${176 - TOWER.y - 6}h-10z`" fill="#3150a9" />
    <rect :x="TOWER.x" :y="TOWER.y" :width="TOWER.w" :height="176 - TOWER.y" rx="3" fill="#4767c6" />
    <rect :x="TOWER.x + 30" :y="TOWER.y - 12" :width="36" height="13" rx="2" fill="#5577d2" />
    <rect :x="TOWER.x + 40" :y="TOWER.y - 8" width="16" height="4" rx="2" :fill="LIT" />
    <rect :x="TOWER.x - 3" :y="TOWER.y" :width="TOWER.w + 6" height="5" rx="2" fill="#5b7dd8" />
    <rect v-for="(w, i) in towerWindows" :key="`t${i}`" :x="w.x" :y="w.y" :width="w.w" :height="w.h" rx="1.5" :fill="w.fill" />
    <rect
      v-for="(y, i) in towerBalconies"
      :key="`b${i}`"
      :x="TOWER.x + 6"
      :y="y"
      :width="TOWER.w - 12"
      height="2.5"
      rx="1.25"
      fill="#a9bdf0"
      opacity="0.55"
    />

    <!-- Entrada -->
    <rect :x="TOWER.x + 32" y="142" width="32" height="5" rx="2.5" fill="#e8eefc" />
    <rect :x="TOWER.x + 38" y="147" width="20" height="29" rx="2" fill="#1b3480" />
    <rect :x="TOWER.x + 47.5" y="149" width="1" height="27" fill="#4767c6" />
    <rect :x="TOWER.x + 42" y="160" width="3" height="1.5" rx="0.75" :fill="LIT" />
    <rect :x="TOWER.x + 51" y="160" width="3" height="1.5" rx="0.75" :fill="LIT" />

    <!-- Farol -->
    <rect x="94" y="132" width="2" height="44" fill="#9fb2e8" />
    <rect x="90" y="128" width="10" height="5" rx="2.5" fill="#9fb2e8" />
    <circle cx="95" cy="135" r="6" :fill="LIT" opacity="0.18" />
    <circle cx="95" cy="134" r="2.4" :fill="LIT" />

    <!-- Árboles -->
    <rect x="80" y="152" width="3" height="24" fill="#1b3480" />
    <circle cx="81.5" cy="150" r="9" fill="#2f9a6a" />
    <circle cx="77" cy="154" r="6" fill="#3bb07c" />
    <rect x="224" y="150" width="3" height="26" fill="#1b3480" />
    <circle cx="225.5" cy="147" r="11" fill="#2f9a6a" />
    <circle cx="231" cy="152" r="7" fill="#3bb07c" />
    <rect x="290" y="156" width="3" height="20" fill="#1b3480" />
    <circle cx="291.5" cy="154" r="8" fill="#3bb07c" />

    <!-- Suelo -->
    <rect x="2" y="166" width="316" height="10" rx="4" fill="#17306f" />
    <rect x="2" y="166" width="316" height="2.5" rx="1.25" fill="#2a4aa6" />
  </svg>
</template>

<style scoped>
.hero-art {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
