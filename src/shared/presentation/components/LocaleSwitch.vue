<script setup>
import { useI18n } from 'vue-i18n'

/**
 * RF011 / US011: ES / EN segmented switch (same pattern as the app shell sidebar toggle).
 * The choice is persisted globally from main.js (localStorage) and mirrored to `<html lang>`.
 */
const { t, locale } = useI18n({ useScope: 'global' })

function toggleLocale() {
  locale.value = locale.value === 'es' ? 'en' : 'es'
}
</script>

<template>
  <button
    type="button"
    class="bf-locale-switch"
    role="switch"
    :aria-label="t('app.languageSwitch')"
    :aria-checked="locale === 'en'"
    @click="toggleLocale"
  >
    <span class="bf-locale-switch__track">
      <span
        class="bf-locale-switch__pill"
        :class="{ 'bf-locale-switch__pill--right': locale === 'en' }"
        aria-hidden="true"
      />
      <span
        class="bf-locale-switch__label"
        :class="{ 'bf-locale-switch__label--active': locale === 'es' }"
        aria-hidden="true"
      >ES</span>
      <span
        class="bf-locale-switch__label"
        :class="{ 'bf-locale-switch__label--active': locale === 'en' }"
        aria-hidden="true"
      >EN</span>
    </span>
  </button>
</template>

<style scoped>
.bf-locale-switch {
  display: inline-block;
  width: 5.5rem;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  line-height: 0;
  border-radius: 999px;
  font-family: inherit;
}

.bf-locale-switch:focus {
  outline: none;
}

.bf-locale-switch:focus-visible {
  outline: var(--apple-focus-ring, 2px solid var(--apple-blue));
  outline-offset: 2px;
}

.bf-locale-switch__track {
  --seg-p: 0.15rem;
  --seg-gap: 0.18rem;

  position: relative;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--seg-gap);
  padding: var(--seg-p);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.06);
}

.bf-locale-switch__pill {
  position: absolute;
  top: var(--seg-p);
  bottom: var(--seg-p);
  left: var(--seg-p);
  z-index: 0;
  width: calc((100% - 2 * var(--seg-p) - var(--seg-gap)) / 2);
  border-radius: 999px;
  background: #ffffff;
  box-shadow: 0 1px 5px rgba(0, 0, 0, 0.07);
  pointer-events: none;
  transition: transform 0.42s cubic-bezier(0.34, 1.2, 0.64, 1);
}

.bf-locale-switch__pill--right {
  transform: translateX(calc(100% + var(--seg-gap)));
}

.bf-locale-switch__label {
  position: relative;
  z-index: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0.25rem 0.3rem;
  min-height: 1.6rem;
  font-size: 0.75rem;
  line-height: 1.2;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: #6e6e73;
  pointer-events: none;
  user-select: none;
}

.bf-locale-switch__label--active {
  color: #1d1d1f;
  font-weight: 700;
}

@media (prefers-reduced-motion: reduce) {
  .bf-locale-switch__pill {
    transition-duration: 0.01ms;
  }
}
</style>
