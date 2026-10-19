<script setup>
/**
 * Fila de KPIs en pastillas: ícono, número y nombre. El texto de ayuda va en el tooltip
 * y queda disponible para lectores de pantalla.
 *
 * items: [{ key, tone: 'blue'|'green'|'amber'|'orange'|'red', icon, label, value,
 *           total?, hint?, alert?, link?: { to, label } }]
 */
defineProps({
  items: { type: Array, required: true },
  ariaLabel: { type: String, default: undefined },
  busy: { type: Boolean, default: false },
})
</script>

<template>
  <section class="kpi-pills" :aria-label="ariaLabel" :aria-busy="busy ? 'true' : 'false'">
    <article
      v-for="item in items"
      :key="item.key"
      class="kpi-pill"
      :class="`kpi-pill--${item.tone}`"
      :title="item.hint || undefined"
    >
      <h2 class="kpi-pill__label">{{ item.label }}</h2>
      <span class="kpi-pill__icon" aria-hidden="true"><i class="pi" :class="item.icon" /></span>
      <p class="kpi-pill__value" :class="{ 'is-alert': item.alert }">
        {{ item.value }}
        <small v-if="item.total != null">/ {{ item.total }}</small>
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
  grid-template-columns: repeat(4, minmax(0, 1fr));
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

.kpi-pill__value small {
  font-size: 0.8rem;
  font-weight: 600;
  color: #64748b;
  letter-spacing: 0;
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

@media (max-width: 1180px) {
  .kpi-pills {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .kpi-pills {
    gap: 0.5rem;
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
