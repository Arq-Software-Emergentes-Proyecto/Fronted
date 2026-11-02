<script setup>
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
</script>

<template>
  <a href="#main-content" class="skip-link">{{ t('a11y.skipToContent') }}</a>
</template>

<style scoped>
/* Oculto visualmente pero enfocable; sin trozo azul en pantalla hasta :focus-visible */
.skip-link {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
  background: transparent;
}

.skip-link:focus,
.skip-link:focus-visible {
  position: fixed;
  top: max(0.75rem, env(safe-area-inset-top));
  left: max(0.75rem, env(safe-area-inset-left));
  z-index: 10000;
  width: auto;
  height: auto;
  margin: 0;
  clip: auto;
  overflow: visible;
  padding: 0.55rem 1rem;
  border-radius: var(--apple-radius-pill, 980px);
  background: var(--apple-blue, #1e3a8a);
  color: #ffffff;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  font-family: var(--apple-font, -apple-system, system-ui, sans-serif);
  text-decoration: none;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
  -webkit-font-smoothing: antialiased;
}

.skip-link:focus {
  outline: 2px solid #ffffff;
  outline-offset: 2px;
}
</style>
