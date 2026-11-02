<script setup>
/**
 * Fila de KPIs en pastillas: ícono, número y nombre. El texto de ayuda va en el tooltip
 * y queda disponible para lectores de pantalla.
 *
 * items: [{ key, tone: 'blue'|'green'|'amber'|'orange'|'red', icon, label, short?, value,
 *           total?, hint?, alert?, link?: { to, label } }]
 * inline: versión compacta para ir en la fila de los botones del encabezado; muestra `short` si existe
 *         (el nombre completo queda en el tooltip y para lectores de pantalla) y baja a su propia fila
 *         cuando no hay espacio al lado de los botones.
 */
const props = defineProps({
  items: { type: Array, required: true },
  ariaLabel: { type: String, default: undefined },
  busy: { type: Boolean, default: false },
  inline: { type: Boolean, default: false },
})

function tooltip(item) {
  const name = props.inline && item.short ? item.label : ''
  return [name, item.hint].filter(Boolean).join(' · ') || undefined
}
</script>

<template>
  <section
    class="kpi-pills"
    :class="{ 'kpi-pills--inline': inline }"
    :aria-label="ariaLabel"
    :aria-busy="busy ? 'true' : 'false'"
    :style="{ '--pill-count': items.length }"
  >
    <article
      v-for="item in items"
      :key="item.key"
      class="kpi-pill"
      :class="`kpi-pill--${item.tone}`"
      :title="tooltip(item)"
    >
      <h2 v-if="inline && item.short" class="kpi-pill__label">
        <span aria-hidden="true">{{ item.short }}</span>
        <span class="bf-sr-only">{{ item.label }}</span>
      </h2>
      <h2 v-else class="kpi-pill__label">{{ item.label }}</h2>
      <span class="kpi-pill__icon" aria-hidden="true"><i class="pi" :class="item.icon" /></span>
      <!-- Sin espacios entre el número y el total: se lee "4/40" como una sola cifra. -->
      <p class="kpi-pill__value" :class="{ 'is-alert': item.alert }">
        <span>{{ item.value }}</span><small v-if="item.total != null" class="kpi-pill__total">/{{ item.total }}</small>
      </p>
      <p v-if="item.hint" class="bf-sr-only">{{ item.hint }}</p>
      <RouterLink v-if="item.link" class="kpi-pill__link" :to="item.link.to">
        {{ item.link.label }}
        <i class="pi pi-arrow-right" aria-hidden="true" />
      </RouterLink>
    </article>
  </section>
</template>

<style scoped>
.kpi-pills {
  display: grid;
  grid-template-columns: repeat(var(--pill-count, 4), minmax(0, 1fr));
  gap: 0.6rem;
}

.kpi-pill {
  --pill-bg: #f1f5f9;
  --pill-ink: #334155;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.45rem 1rem 0.45rem 0.5rem;
  border-radius: 999px;
  background: var(--pill-bg);
}

.kpi-pill--blue { --pill-bg: #e8eefc; --pill-ink: #1e3a8a; }
.kpi-pill--green { --pill-bg: #e3f4e8; --pill-ink: #15803d; }
.kpi-pill--amber { --pill-bg: #fdf3dc; --pill-ink: #b45309; }
.kpi-pill--orange { --pill-bg: #fdeee2; --pill-ink: #c2410c; }
.kpi-pill--red { --pill-bg: #fde4e4; --pill-ink: #b42318; }

.kpi-pill__icon {
  flex-shrink: 0;
  width: 2.1rem;
  height: 2.1rem;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  background: #fff;
  color: var(--pill-ink);
}

.kpi-pill__value {
  flex-shrink: 0;
  margin: 0;
  color: #0f172a;
  font-family: var(--bf-font-heading, inherit);
  font-weight: 700;
  font-size: 1.2rem;
  letter-spacing: -0.02em;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.kpi-pill__value.is-alert {
  color: #b42318;
}

.kpi-pill__total {
  margin-left: 0.08em;
  font-size: 0.74em;
  font-weight: 700;
  color: #64748b;
  letter-spacing: -0.01em;
}

/* Heading first in the markup for screen readers, shown after the number. */
.kpi-pill__label {
  order: 1;
  min-width: 0;
  margin: 0;
  color: #334155;
  font-weight: 600;
  font-size: 0.8rem;
  line-height: 1.2;
}

.kpi-pill__link {
  order: 2;
  margin-left: auto;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.3rem 0.65rem;
  border-radius: 999px;
  background: #fff;
  color: var(--pill-ink);
  font-size: 0.72rem;
  font-weight: 650;
  text-decoration: none;
  white-space: nowrap;
}

.kpi-pill__link .pi {
  font-size: 0.6rem;
}

.kpi-pill__link:hover {
  text-decoration: underline;
}

.kpi-pill__link:focus-visible {
  outline: 2px solid var(--pill-ink);
  outline-offset: 2px;
}

/*
 * Compacta, en la fila del encabezado. Cada pastilla mide al menos lo que su contenido (nunca se
 * enciman); si no caben al lado de los botones, el grupo baja a su propia fila.
 */
.kpi-pills--inline {
  flex: 1 1 auto;
  grid-template-columns: repeat(var(--pill-count, 4), minmax(max-content, 1fr));
  gap: 0.5rem;
}

.kpi-pills--inline .kpi-pill__label {
  white-space: nowrap;
}

.kpi-pills--inline .kpi-pill {
  gap: 0.5rem;
  padding: 0.3rem 0.85rem 0.3rem 0.35rem;
}

.kpi-pills--inline .kpi-pill__icon {
  width: 1.75rem;
  height: 1.75rem;
  font-size: 0.75rem;
}

.kpi-pills--inline .kpi-pill__value {
  font-size: 1.02rem;
}

.kpi-pills--inline .kpi-pill__label {
  font-size: 0.76rem;
  line-height: 1.15;
}

@media (max-width: 1180px) {
  .kpi-pills:not(.kpi-pills--inline) {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

/* Pantallas medianas: no caben al lado de los botones; van en su propia fila, en partes iguales. */
@media (min-width: 721px) and (max-width: 1180px) {
  .kpi-pills--inline {
    flex-basis: 100%;
    min-width: 0;
    grid-template-columns: repeat(var(--pill-count, 4), minmax(0, 1fr));
  }
  .kpi-pills--inline .kpi-pill__label {
    white-space: normal;
  }
}

@media (max-width: 720px) {
  .kpi-pills {
    gap: 0.5rem;
  }
  /* En celular van debajo de los botones, en dos columnas. */
  .kpi-pills--inline {
    order: 2;
    flex-basis: 100%;
    min-width: 0;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .kpi-pills--inline .kpi-pill__label {
    white-space: normal;
  }
  /* Number above the name so amounts like "S/ 565.00" fit in half the width. */
  .kpi-pill {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas:
      'icon value'
      'icon label';
    align-content: center;
    column-gap: 0.55rem;
    row-gap: 0.15rem;
    padding: 0.45rem 0.9rem 0.45rem 0.45rem;
    border-radius: 22px;
  }
  .kpi-pill__icon {
    grid-area: icon;
  }
  .kpi-pill__value {
    grid-area: value;
    font-size: 1.05rem;
  }
  .kpi-pill__label {
    grid-area: label;
    font-size: 0.74rem;
    color: #475569;
  }
  .kpi-pill__link {
    grid-column: 2;
    margin: 0.2rem 0 0;
    justify-self: start;
  }
}
</style>
