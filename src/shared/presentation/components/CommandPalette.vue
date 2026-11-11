<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { AppRouteNames } from '@/shared/domain/appRoutes.js'
import { residentsApi } from '@/residents/infrastructure/residentsApi.js'

/**
 * Buscador global (⌘K / Ctrl+K): salta a cualquier sección, ejecuta las acciones frecuentes y, para
 * la administración, encuentra a un residente por nombre o departamento.
 *
 * `commands`: [{ id, group: 'pages' | 'actions', label, icon, keywords?, hint?, to? | run? }].
 */
const props = defineProps({
  open: { type: Boolean, default: false },
  commands: { type: Array, default: () => [] },
  /** Solo la administración busca residentes (la junta y el residente no ven esa lista). */
  searchResidents: { type: Boolean, default: false },
})

const emit = defineEmits(['update:open'])

const { t } = useI18n()
const router = useRouter()

const MAX_RESIDENT_RESULTS = 5
const MIN_RESIDENT_QUERY = 2
const GROUP_ORDER = ['pages', 'actions', 'residents']

const query = ref('')
const activeIndex = ref(0)
const inputEl = ref(null)
const listEl = ref(null)
const residents = ref(null)
let restoreFocusEl = null

/** "Depósito" y "deposito" son la misma búsqueda. */
function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

const tokens = computed(() => normalize(query.value).split(/\s+/).filter(Boolean))

/** 0 = el nombre empieza con lo escrito, 1 = alguna palabra empieza así, 2 = aparece en otra parte. */
function rank(label, haystack) {
  if (!tokens.value.length) return 0
  if (!tokens.value.every((token) => haystack.includes(token))) return -1
  const first = tokens.value[0]
  if (label.startsWith(first)) return 0
  if (label.split(/\s+/).some((word) => word.startsWith(first))) return 1
  return 2
}

function filterAndSort(items) {
  return items
    .map((item, order) => {
      const label = normalize(item.label)
      return { item, order, score: rank(label, `${label} ${normalize(item.keywords)} ${normalize(item.hint)}`) }
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => a.score - b.score || a.order - b.order)
    .map((entry) => entry.item)
}

const residentCommands = computed(() => {
  if (!props.searchResidents || normalize(query.value).length < MIN_RESIDENT_QUERY) return []
  const items = (residents.value ?? []).map((resident) => {
    const place = [
      resident.floor ? t('palette.floor', { floor: resident.floor }) : '',
      resident.code ? t('palette.department', { department: resident.code }) : '',
    ].filter(Boolean)
    return {
      id: `resident-${resident.id}`,
      group: 'residents',
      label: resident.name,
      icon: 'pi pi-user',
      hint: place.join(' · '),
      keywords: `${resident.code} ${resident.floor}-${resident.code}`,
      enterLabel: t('palette.openCollections'),
      to: { name: AppRouteNames.APP_FINANCE, query: { q: resident.name } },
    }
  })
  return filterAndSort(items).slice(0, MAX_RESIDENT_RESULTS)
})

const groups = computed(() => {
  const matches = [...filterAndSort(props.commands), ...residentCommands.value]
  return GROUP_ORDER.map((key) => ({
    key,
    label: t(`palette.group.${key}`),
    items: matches.filter((item) => item.group === key),
  })).filter((group) => group.items.length)
})

/** Lista plana en el orden en que se ve: es la que recorren las flechas. */
const flatItems = computed(() => groups.value.flatMap((group) => group.items))
const activeItem = computed(() => flatItems.value[activeIndex.value] ?? null)

function optionId(item) {
  return `bf-palette-option-${item.id}`
}

/** Parte el nombre en [antes, coincidencia, después] para resaltar lo escrito. */
function labelParts(label) {
  const text = String(label ?? '')
  const needle = tokens.value[0]
  const at = needle ? normalize(text).indexOf(needle) : -1
  // normalize() conserva la longitud solo cuando el texto ya viene compuesto (NFC); si no, no se resalta.
  if (at < 0 || normalize(text).length !== text.length) return [text, '', '']
  return [text.slice(0, at), text.slice(at, at + needle.length), text.slice(at + needle.length)]
}

function close() {
  emit('update:open', false)
}

function runItem(item) {
  if (!item) return
  close()
  if (item.to) router.push(item.to)
  else item.run?.()
}

function move(delta) {
  const count = flatItems.value.length
  if (!count) return
  activeIndex.value = (activeIndex.value + delta + count) % count
}

function onKeydown(event) {
  switch (event.key) {
    case 'ArrowDown':
      event.preventDefault()
      move(1)
      break
    case 'ArrowUp':
      event.preventDefault()
      move(-1)
      break
    case 'Home':
      if (!query.value) {
        event.preventDefault()
        activeIndex.value = 0
      }
      break
    case 'End':
      if (!query.value) {
        event.preventDefault()
        activeIndex.value = Math.max(flatItems.value.length - 1, 0)
      }
      break
    case 'Enter':
      // Enter durante la composición de un IME confirma el texto, no ejecuta el comando.
      if (event.isComposing) return
      event.preventDefault()
      runItem(activeItem.value)
      break
    case 'Escape':
      event.preventDefault()
      event.stopPropagation()
      close()
      break
    case 'Tab':
      // El campo es el único punto de foco del diálogo (aria-modal): las opciones se recorren con flechas.
      event.preventDefault()
      break
  }
}

async function loadResidents() {
  if (!props.searchResidents || residents.value) return
  try {
    residents.value = await residentsApi.list()
  } catch {
    // Sin la lista, el buscador sigue sirviendo para secciones y acciones.
    residents.value = null
  }
}

watch(query, () => {
  activeIndex.value = 0
})

watch(flatItems, (items) => {
  if (activeIndex.value >= items.length) activeIndex.value = Math.max(items.length - 1, 0)
})

watch(activeItem, async (item) => {
  if (!item) return
  await nextTick()
  listEl.value?.querySelector(`#${CSS.escape(optionId(item))}`)?.scrollIntoView({ block: 'nearest' })
})

watch(
  () => props.open,
  async (open) => {
    document.documentElement.classList.toggle('bf-palette-open', open)
    if (open) {
      restoreFocusEl = document.activeElement
      query.value = ''
      activeIndex.value = 0
      void loadResidents()
      await nextTick()
      inputEl.value?.focus({ preventScroll: true })
    } else {
      restoreFocusEl?.focus?.({ preventScroll: true })
      restoreFocusEl = null
    }
  },
)

// La lista de residentes es del edificio activo: al cambiar de sesión o de vista se vuelve a pedir.
watch(
  () => props.searchResidents,
  () => {
    residents.value = null
  },
)

onMounted(() => {
  if (props.open) document.documentElement.classList.add('bf-palette-open')
})

onBeforeUnmount(() => {
  document.documentElement.classList.remove('bf-palette-open')
})
</script>

<template>
  <Teleport to="body">
    <Transition name="bf-palette">
      <div v-if="open" class="bf-palette" @mousedown.self="close">
        <div
          class="bf-palette__panel"
          role="dialog"
          aria-modal="true"
          :aria-label="t('palette.title')"
          @keydown="onKeydown"
        >
          <div class="bf-palette__search">
            <i class="pi pi-search" aria-hidden="true" />
            <input
              ref="inputEl"
              v-model="query"
              class="bf-palette__input"
              type="text"
              role="combobox"
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              aria-expanded="true"
              aria-controls="bf-palette-list"
              aria-autocomplete="list"
              :aria-activedescendant="activeItem ? optionId(activeItem) : undefined"
              :aria-label="t('palette.title')"
              :placeholder="
                searchResidents ? t('palette.placeholderWithResidents') : t('palette.placeholder')
              "
            />
            <button type="button" class="bf-palette__esc" tabindex="-1" @click="close">
              <kbd>esc</kbd>
              <span class="bf-sr-only">{{ t('palette.close') }}</span>
            </button>
          </div>

          <div
            id="bf-palette-list"
            ref="listEl"
            class="bf-palette__list"
            role="listbox"
            :aria-label="t('palette.results')"
          >
            <div
              v-for="group in groups"
              :key="group.key"
              class="bf-palette__group"
              role="group"
              :aria-labelledby="`bf-palette-group-${group.key}`"
            >
              <p :id="`bf-palette-group-${group.key}`" class="bf-palette__group-label">
                {{ group.label }}
              </p>
              <div
                v-for="item in group.items"
                :id="optionId(item)"
                :key="item.id"
                class="bf-palette__option"
                :class="{
                  'is-active': item === activeItem,
                  'bf-palette__option--danger': item.danger,
                }"
                role="option"
                :aria-selected="item === activeItem ? 'true' : 'false'"
                @mousemove="activeIndex = flatItems.indexOf(item)"
                @click="runItem(item)"
              >
                <span class="bf-palette__option-icon" aria-hidden="true"><i :class="item.icon" /></span>
                <span class="bf-palette__option-text">
                  <span class="bf-palette__option-label">
                    <template v-for="(part, index) in labelParts(item.label)" :key="index">
                      <mark v-if="index === 1 && part">{{ part }}</mark>
                      <template v-else>{{ part }}</template>
                    </template>
                  </span>
                  <span v-if="item.hint" class="bf-palette__option-hint">{{ item.hint }}</span>
                </span>
                <span v-if="item.current" class="bf-palette__option-tag">{{ t('palette.current') }}</span>
                <span v-else class="bf-palette__option-enter" aria-hidden="true">
                  {{ item.enterLabel ?? (item.group === 'pages' ? t('palette.open') : t('palette.run')) }}
                  <kbd>↵</kbd>
                </span>
              </div>
            </div>

            <div v-if="!flatItems.length" class="bf-palette__empty" role="status">
              <i class="pi pi-search" aria-hidden="true" />
              <strong>{{ t('palette.emptyTitle', { query: query.trim() }) }}</strong>
              <span>{{ t('palette.emptyHint') }}</span>
            </div>
          </div>

          <footer class="bf-palette__foot" aria-hidden="true">
            <span><kbd>↑</kbd><kbd>↓</kbd> {{ t('palette.hintNavigate') }}</span>
            <span><kbd>↵</kbd> {{ t('palette.hintSelect') }}</span>
            <span><kbd>esc</kbd> {{ t('palette.hintClose') }}</span>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style>
/* Buscador abierto: la página de atrás no se desplaza. */
html.bf-palette-open,
html.bf-palette-open body {
  overflow: hidden;
}
</style>

<style scoped>
.bf-palette {
  position: fixed;
  inset: 0;
  /* Sobre el menú lateral (300) y los diálogos de PrimeVue (~1100). */
  z-index: 1300;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding: min(14vh, 7.5rem) 1rem 1rem;
  background: rgba(15, 23, 42, 0.38);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  font-family: var(--bf-font-body, system-ui, sans-serif);
  letter-spacing: -0.01em;
}

.bf-palette__panel {
  width: min(100%, 37.5rem);
  max-height: min(31rem, 100%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: 18px;
  background: #fff;
  border: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow:
    0 24px 64px rgba(15, 23, 42, 0.24),
    0 2px 8px rgba(15, 23, 42, 0.08);
}

/* ---------- Search field ---------- */
.bf-palette__search {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.3rem 0.85rem 0.3rem 1.1rem;
  border-bottom: 1px solid #e8e8ed;
}

.bf-palette__search > .pi {
  font-size: 0.95rem;
  color: #6e6e73;
}

.bf-palette__input {
  flex: 1;
  min-width: 0;
  height: 3rem;
  padding: 0;
  border: none;
  outline: none;
  background: transparent;
  color: #0f172a;
  font-size: 1rem;
  letter-spacing: inherit;
}

.bf-palette__input::placeholder {
  color: #8a8a8f;
}

.bf-palette__esc {
  flex-shrink: 0;
  padding: 0.2rem;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
  line-height: 0;
}

kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 1.35rem;
  height: 1.35rem;
  padding: 0 0.35rem;
  box-sizing: border-box;
  border-radius: 6px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: #f5f5f7;
  color: #475569;
  font-family: inherit;
  font-size: 0.68rem;
  font-weight: 600;
  line-height: 1;
}

/* ---------- Results ---------- */
.bf-palette__list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0.4rem 0.5rem 0.5rem;
  scroll-padding-block: 2rem 0.5rem;
}

.bf-palette__group-label {
  margin: 0;
  padding: 0.6rem 0.6rem 0.3rem;
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: #6e6e73;
}

.bf-palette__option {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-height: 2.75rem;
  padding: 0.3rem 0.6rem;
  border-radius: 12px;
  color: #0f172a;
  cursor: pointer;
}

.bf-palette__option.is-active {
  background: #eef2fb;
}

.bf-palette__option-icon {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #f5f5f7;
  color: #475569;
  font-size: 0.85rem;
}

.bf-palette__option.is-active .bf-palette__option-icon {
  background: #fff;
  color: #1e3a8a;
}

.bf-palette__option-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
}

.bf-palette__option-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.875rem;
  font-weight: 550;
  line-height: 1.3;
}

.bf-palette__option-label mark {
  background: transparent;
  color: #1e3a8a;
  font-weight: 700;
  text-decoration: underline;
  text-decoration-thickness: 2px;
  text-underline-offset: 3px;
  text-decoration-color: rgba(30, 58, 138, 0.35);
}

.bf-palette__option-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.74rem;
  line-height: 1.3;
  color: #6e6e73;
}

.bf-palette__option-tag {
  flex-shrink: 0;
  padding: 0.14rem 0.5rem;
  border-radius: 999px;
  background: #f1f5f9;
  color: #475569;
  font-size: 0.66rem;
  font-weight: 650;
}

.bf-palette__option.is-active .bf-palette__option-tag {
  background: #fff;
}

.bf-palette__option-enter {
  flex-shrink: 0;
  display: none;
  align-items: center;
  gap: 0.4rem;
  color: #1e3a8a;
  font-size: 0.72rem;
  font-weight: 600;
}

.bf-palette__option.is-active .bf-palette__option-enter {
  display: inline-flex;
}

.bf-palette__option-enter kbd {
  background: #fff;
  color: #1e3a8a;
  border-color: rgba(30, 58, 138, 0.2);
}

.bf-palette__option--danger.is-active {
  background: #fdecee;
}

.bf-palette__option--danger .bf-palette__option-label,
.bf-palette__option--danger.is-active .bf-palette__option-icon,
.bf-palette__option--danger .bf-palette__option-enter {
  color: #b42318;
}

.bf-palette__option--danger .bf-palette__option-enter kbd {
  color: #b42318;
  border-color: rgba(180, 35, 24, 0.22);
}

.bf-palette__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 2.25rem 1rem 2rem;
  text-align: center;
  color: #6e6e73;
  font-size: 0.8rem;
}

.bf-palette__empty .pi {
  margin-bottom: 0.5rem;
  font-size: 1.25rem;
  color: #94a3b8;
}

.bf-palette__empty strong {
  max-width: 100%;
  overflow-wrap: anywhere;
  color: #0f172a;
  font-size: 0.9rem;
  font-weight: 600;
}

/* ---------- Footer ---------- */
.bf-palette__foot {
  display: flex;
  align-items: center;
  gap: 1.1rem;
  padding: 0.55rem 1.1rem;
  border-top: 1px solid #e8e8ed;
  background: #fbfbfd;
  color: #6e6e73;
  font-size: 0.72rem;
}

.bf-palette__foot span {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
}

/* ---------- Motion ---------- */
.bf-palette-enter-active,
.bf-palette-leave-active {
  transition: opacity 0.16s ease;
}

.bf-palette-enter-active .bf-palette__panel,
.bf-palette-leave-active .bf-palette__panel {
  transition:
    transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1),
    opacity 0.16s ease;
}

.bf-palette-enter-from,
.bf-palette-leave-to {
  opacity: 0;
}

.bf-palette-enter-from .bf-palette__panel,
.bf-palette-leave-to .bf-palette__panel {
  opacity: 0;
  transform: translateY(-8px) scale(0.98);
}

@media (max-width: 720px) {
  .bf-palette {
    padding: calc(0.75rem + env(safe-area-inset-top, 0px)) 0.75rem 0.75rem;
  }

  /* Sin teclado físico los atajos no aplican. */
  .bf-palette__foot,
  .bf-palette__option-enter {
    display: none !important;
  }

  .bf-palette__input {
    /* 16px: iOS no hace zoom al enfocar. */
    font-size: 1rem;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bf-palette-enter-active,
  .bf-palette-leave-active,
  .bf-palette-enter-active .bf-palette__panel,
  .bf-palette-leave-active .bf-palette__panel {
    transition: none;
  }
}
</style>
