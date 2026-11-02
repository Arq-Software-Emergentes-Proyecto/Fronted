<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import Dialog from 'primevue/dialog'
import { membersApi } from '@/iam/infrastructure/membersApi.js'
import { AppPaths } from '@/shared/domain/appRoutes.js'
import KpiPills from '@/shared/presentation/components/KpiPills.vue'
import ConfirmActions from '@/shared/presentation/components/ConfirmActions.vue'
import LoadErrorRetry from '@/shared/presentation/components/LoadErrorRetry.vue'
import { useConfirmDialog } from '@/shared/presentation/composables/useConfirmDialog.js'
import '@/shared/presentation/assets/bf-workspace.css'

/**
 * Junta y accesos: quién gestiona el condominio activo.
 * - Si la cuenta la creó la junta, la junta asigna aquí a su administrador (persona o empresa).
 * - Si la cuenta es de una empresa administradora, la empresa invita aquí a la junta para que vea los datos.
 * Cada invitación es un enlace de un solo uso, ligado a un correo y válido 7 días.
 */
const { t, locale } = useI18n()
const askConfirm = useConfirmDialog()

const isLoading = ref(true)
const loadFailed = ref(false)
const data = ref({ owner: null, myRole: null, canManage: false, members: [], invitations: [] })

const filter = ref('all')
const search = ref('')
const busyKey = ref('')
const copiedKey = ref('')

const inviteOpen = ref(false)
const form = ref({ email: '', name: '', role: 'board' })
const formError = ref('')
const sending = ref(false)
const created = ref(null)

const ownerIsBoard = computed(() => data.value.owner?.accountKind === 'board')

const ERROR_KEYS = {
  INVALID_EMAIL: 'access.errorEmail',
  INVALID_MEMBER_ROLE: 'access.errorRole',
  ALREADY_MEMBER: 'access.errorAlreadyMember',
  EMAIL_USED_BY_RESIDENT: 'access.errorResident',
  MANAGE_REQUIRED: 'access.errorManage',
  BOARD_READ_ONLY: 'access.errorManage',
}

function inviteLink(token) {
  if (!token || typeof window === 'undefined') return ''
  return `${window.location.origin}${AppPaths.MEMBER_INVITE.replace(':token', token)}`
}

function roleLabel(role) {
  return role === 'admin' ? t('access.roleAdmin') : t('access.roleBoard')
}

function shortDate(value) {
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return new Intl.DateTimeFormat(locale.value === 'es' ? 'es-PE' : 'en-US', { day: 'numeric', month: 'short' }).format(d)
}

function initials(value) {
  const parts = String(value ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase()
  return String(parts[0] ?? '?').slice(0, 2).toUpperCase()
}

/** Dueño, miembros e invitaciones en una sola lista: es lo que se filtra y se busca. */
const people = computed(() => {
  const list = []
  const owner = data.value.owner
  if (owner) {
    list.push({
      key: `owner-${owner.id}`,
      kind: 'owner',
      id: owner.id,
      name: owner.name,
      email: owner.email,
      role: ownerIsBoard.value ? 'board' : 'admin',
    })
  }
  for (const m of data.value.members ?? []) {
    list.push({
      key: `member-${m.id}`,
      kind: 'member',
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role === 'admin' ? 'admin' : 'board',
      since: m.since,
    })
  }
  for (const inv of data.value.invitations ?? []) {
    list.push({
      key: `invite-${inv.id}`,
      kind: 'invite',
      id: inv.id,
      name: inv.name,
      email: inv.email,
      role: inv.role === 'admin' ? 'admin' : 'board',
      expiresAt: inv.expiresAt,
      expired: inv.status === 'expired',
      token: inv.token,
    })
  }
  return list
})

const counts = computed(() => {
  const active = people.value.filter((p) => p.kind !== 'invite')
  return {
    all: people.value.length,
    admin: active.filter((p) => p.role === 'admin').length,
    board: active.filter((p) => p.role === 'board').length,
    pending: people.value.length - active.length,
  }
})

const filters = computed(() => [
  { id: 'all', tone: '', label: t('access.filterAll'), count: counts.value.all },
  { id: 'admin', tone: 'green', label: t('access.filterAdmin'), count: counts.value.admin },
  { id: 'board', tone: 'blue', label: t('access.filterBoard'), count: counts.value.board },
  { id: 'pending', tone: 'amber', label: t('access.filterPending'), count: counts.value.pending },
])

const isFiltered = computed(() => filter.value !== 'all' || search.value.trim() !== '')

const visiblePeople = computed(() => {
  const q = search.value.trim().toLowerCase()
  return people.value.filter((p) => {
    if (filter.value === 'pending' && p.kind !== 'invite') return false
    if ((filter.value === 'admin' || filter.value === 'board') && (p.kind === 'invite' || p.role !== filter.value)) return false
    return !q || `${p.name ?? ''} ${p.email ?? ''}`.toLowerCase().includes(q)
  })
})

const kpiPills = computed(() => [
  { key: 'admin', tone: 'green', icon: 'pi-briefcase', label: t('access.kpiAdmins'), value: counts.value.admin },
  { key: 'board', tone: 'blue', icon: 'pi-users', label: t('access.kpiBoard'), value: counts.value.board },
  {
    key: 'pending',
    tone: 'amber',
    icon: 'pi-envelope',
    label: t('access.kpiPending'),
    short: t('access.filterPending'),
    value: counts.value.pending,
  },
])

async function load() {
  isLoading.value = true
  loadFailed.value = false
  try {
    data.value = await membersApi.list()
  } catch {
    loadFailed.value = true
  } finally {
    isLoading.value = false
  }
}

function openInvite() {
  // La junta que creó la cuenta suele invitar primero a su administrador; la empresa, a la junta.
  const needsAdmin = ownerIsBoard.value && !data.value.members.some((m) => m.role === 'admin')
  form.value = { email: '', name: '', role: needsAdmin ? 'admin' : 'board' }
  formError.value = ''
  created.value = null
  inviteOpen.value = true
}

function closeInvite() {
  if (!sending.value) inviteOpen.value = false
}

async function onInvite() {
  if (sending.value) return
  formError.value = ''
  const email = form.value.email.trim()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    formError.value = t('access.errorEmail')
    return
  }
  sending.value = true
  try {
    const result = await membersApi.invite({ email, name: form.value.name.trim() || null, role: form.value.role })
    created.value = { email, role: form.value.role, link: inviteLink(result?.token), expiresAt: result?.expiresAt }
    await load()
  } catch (error) {
    formError.value = t(ERROR_KEYS[error?.code] ?? 'access.errorGeneric')
  } finally {
    sending.value = false
  }
}

async function copy(link, key) {
  if (!link) return
  try {
    await navigator.clipboard.writeText(link)
    copiedKey.value = key
    setTimeout(() => {
      if (copiedKey.value === key) copiedKey.value = ''
    }, 1800)
  } catch {
    copiedKey.value = ''
  }
}

async function revoke(person) {
  busyKey.value = person.key
  try {
    await membersApi.revokeInvitation(person.id)
    await load()
  } finally {
    busyKey.value = ''
  }
}

async function removeMember(person) {
  const confirmed = await askConfirm({
    header: t('access.removeHeader'),
    message: t('access.removeConfirm', { name: person.name }),
    acceptLabel: t('access.removeAccept'),
    icon: 'pi pi-user-minus',
    danger: true,
  })
  if (!confirmed) return
  busyKey.value = person.key
  try {
    await membersApi.remove(person.id)
    await load()
  } finally {
    busyKey.value = ''
  }
}

onMounted(load)
</script>

<template>
  <div class="ws-view acc">
    <header class="ws-head">
      <h1 class="bf-sr-only">{{ t('access.title') }}</h1>
      <KpiPills v-if="!loadFailed" inline :items="kpiPills" :aria-label="t('access.kpiAria')" :busy="isLoading" />
      <div class="ws-head__actions">
        <span v-if="!isLoading && !data.canManage" class="ws-tag">
          <i class="pi pi-eye" aria-hidden="true" />
          {{ t('access.readOnlyTitle') }}
        </span>
        <button
          type="button"
          class="ws-icon-btn"
          :aria-label="t('access.refresh')"
          :title="t('access.refresh')"
          :disabled="isLoading"
          @click="load"
        >
          <i class="pi" :class="isLoading ? 'pi-spin pi-spinner' : 'pi-refresh'" aria-hidden="true" />
        </button>
        <button v-if="data.canManage" type="button" class="ws-btn ws-btn--primary" @click="openInvite">
          <i class="pi pi-user-plus" aria-hidden="true" />
          {{ t('access.invite') }}
        </button>
      </div>
    </header>

    <LoadErrorRetry v-if="loadFailed" :loading="isLoading" @retry="load" />

    <section v-else class="ws-card" :aria-label="t('access.tableLabel')">
      <div class="ws-toolbar">
        <div class="ws-filters" v-bf-seg role="group" :aria-label="t('access.filterAria')">
          <button
            v-for="f in filters"
            :key="f.id"
            type="button"
            class="ws-filter"
            :class="[f.tone && `ws-filter--${f.tone}`, { 'is-active': filter === f.id }]"
            :aria-pressed="filter === f.id ? 'true' : 'false'"
            @click="filter = f.id"
          >
            {{ f.label }}
            <span class="ws-filter__count">{{ f.count }}</span>
          </button>
        </div>
        <label class="ws-search" for="acc-search">
          <i class="pi pi-search" aria-hidden="true" />
          <input
            id="acc-search"
            v-model="search"
            type="search"
            :placeholder="t('access.searchPlaceholder')"
            :aria-label="t('access.searchPlaceholder')"
          />
        </label>
      </div>

      <p v-if="isLoading && !people.length" class="ws-status" role="status">
        <i class="pi pi-spin pi-spinner" aria-hidden="true" />
        {{ t('board.loading') }}
      </p>

      <div v-else-if="!visiblePeople.length" class="ws-empty">
        <span class="ws-empty__icon"><i class="pi" :class="isFiltered ? 'pi-filter-slash' : 'pi-users'" aria-hidden="true" /></span>
        <span>{{ isFiltered ? t('access.emptyFiltered') : t('access.emptyAll') }}</span>
        <button v-if="data.canManage && !search" type="button" class="ws-btn" @click="openInvite">
          <i class="pi pi-user-plus" aria-hidden="true" />
          {{ t('access.invite') }}
        </button>
      </div>

      <div v-else class="ws-table-wrap">
        <table class="ws-table">
          <thead>
            <tr>
              <th scope="col">{{ t('access.colPerson') }}</th>
              <th scope="col">{{ t('access.colRole') }}</th>
              <th scope="col">{{ t('access.colStatus') }}</th>
              <th scope="col" class="c-actions"><span class="bf-sr-only">{{ t('access.colActions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in visiblePeople" :key="p.key" :class="{ 'is-busy': busyKey === p.key }">
              <td class="c-main">
                <div class="ws-who">
                  <span v-if="p.kind === 'invite'" class="ws-avatar ws-avatar--amber" aria-hidden="true">
                    <i class="pi pi-envelope" />
                  </span>
                  <span v-else class="ws-avatar" :class="{ 'ws-avatar--green': p.role === 'admin' }" aria-hidden="true">
                    {{ initials(p.name || p.email) }}
                  </span>
                  <div class="ws-who__text">
                    <strong>{{ p.name || p.email }}</strong>
                    <small v-if="p.name">{{ p.email }}</small>
                  </div>
                </div>
              </td>
              <td :data-label="t('access.colRole')">
                <span class="ws-pill" :class="p.role === 'admin' ? 'ws-pill--green' : 'ws-pill--blue'">
                  <i class="pi" :class="p.role === 'admin' ? 'pi-briefcase' : 'pi-users'" aria-hidden="true" />
                  {{ roleLabel(p.role) }}
                </span>
              </td>
              <td :data-label="t('access.colStatus')">
                <span v-if="p.kind === 'owner'" class="ws-state acc-state--owner">
                  <i class="pi pi-star-fill" aria-hidden="true" />
                  {{ t('access.statusOwner') }}
                </span>
                <span v-else-if="p.kind === 'member'" class="ws-state acc-state--active">
                  <span class="ws-dot" aria-hidden="true" />
                  {{ p.since ? t('access.statusSince', { date: shortDate(p.since) }) : t('access.statusActive') }}
                </span>
                <span v-else-if="p.expired" class="ws-state acc-state--expired">
                  <span class="ws-dot" aria-hidden="true" />
                  {{ t('access.statusExpired') }}
                </span>
                <span v-else class="ws-state acc-state--pending">
                  <span class="ws-dot" aria-hidden="true" />
                  {{ t('access.statusPending', { date: shortDate(p.expiresAt) }) }}
                </span>
              </td>
              <td class="c-actions">
                <div v-if="data.canManage && p.kind !== 'owner'" class="ws-row-actions">
                  <button
                    v-if="p.kind === 'invite' && p.token"
                    type="button"
                    class="ws-chip"
                    :aria-label="t('access.copyLinkFor', { email: p.email })"
                    @click="copy(inviteLink(p.token), p.key)"
                  >
                    <i class="pi" :class="copiedKey === p.key ? 'pi-check' : 'pi-link'" aria-hidden="true" />
                    {{ copiedKey === p.key ? t('access.copied') : t('access.copyLink') }}
                  </button>
                  <button
                    type="button"
                    class="ws-icon-btn ws-icon-btn--danger"
                    :disabled="busyKey === p.key"
                    :aria-label="p.kind === 'invite' ? t('access.revoke', { email: p.email }) : t('access.remove', { name: p.name })"
                    :title="p.kind === 'invite' ? t('access.revoke', { email: p.email }) : t('access.remove', { name: p.name })"
                    @click="p.kind === 'invite' ? revoke(p) : removeMember(p)"
                  >
                    <i
                      class="pi"
                      :class="busyKey === p.key ? 'pi-spin pi-spinner' : p.kind === 'invite' ? 'pi-times' : 'pi-user-minus'"
                      aria-hidden="true"
                    />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <Dialog
      :visible="inviteOpen"
      modal
      dismissable-mask
      :header="created ? t('access.linkReadyTitle') : t('access.inviteTitle')"
      class="ws-dialog"
      :style="{ width: 'min(30rem, 94vw)' }"
      :draggable="false"
      :closable="!sending"
      :close-on-escape="!sending"
      @update:visible="(visible) => !visible && closeInvite()"
    >
      <div v-if="created" class="ws-form" role="status">
        <div class="acc-ready">
          <span class="ws-avatar ws-avatar--green" aria-hidden="true"><i class="pi pi-check" /></span>
          <div class="ws-who__text">
            <strong>{{ created.email }}</strong>
            <small>
              {{ roleLabel(created.role) }}<template v-if="created.expiresAt"> · {{ t('access.expires', { date: shortDate(created.expiresAt) }) }}</template>
            </small>
          </div>
        </div>
        <div class="acc-link">
          <div class="ws-field">
            <input :value="created.link" readonly :aria-label="t('access.linkLabel')" @focus="$event.target.select()" />
          </div>
          <button type="button" class="ws-btn ws-btn--primary" @click="copy(created.link, 'created')">
            <i class="pi" :class="copiedKey === 'created' ? 'pi-check' : 'pi-copy'" aria-hidden="true" />
            {{ copiedKey === 'created' ? t('access.copied') : t('access.copyLink') }}
          </button>
        </div>
        <div class="acc-done">
          <button type="button" class="ws-btn" @click="closeInvite">{{ t('access.done') }}</button>
        </div>
      </div>

      <form v-else class="ws-form" novalidate @submit.prevent="onInvite">
        <fieldset class="acc-roles">
          <legend class="bf-sr-only">{{ t('access.roleLabel') }}</legend>
          <label v-for="r in ['admin', 'board']" :key="r" class="acc-role" :class="{ 'is-selected': form.role === r }">
            <input v-model="form.role" type="radio" name="member-role" :value="r" />
            <span class="ws-avatar" :class="{ 'ws-avatar--green': r === 'admin' }" aria-hidden="true">
              <i class="pi" :class="r === 'admin' ? 'pi-briefcase' : 'pi-users'" />
            </span>
            <span class="ws-who__text">
              <strong>{{ roleLabel(r) }}</strong>
              <small>{{ r === 'admin' ? t('access.roleAdminShort') : t('access.roleBoardShort') }}</small>
            </span>
            <i class="pi pi-check-circle acc-role__check" aria-hidden="true" />
          </label>
        </fieldset>
        <div class="ws-field">
          <label for="member-email">{{ t('access.email') }}</label>
          <input
            id="member-email"
            v-model="form.email"
            type="email"
            autocomplete="off"
            :aria-invalid="formError ? 'true' : 'false'"
            :aria-describedby="formError ? 'member-form-error' : undefined"
          />
        </div>
        <div class="ws-field">
          <label for="member-name">{{ t('access.name') }} <span class="ws-field__opt">{{ t('access.optional') }}</span></label>
          <input id="member-name" v-model="form.name" type="text" autocomplete="off" />
        </div>
        <p v-if="formError" id="member-form-error" class="ws-form__error" role="alert">{{ formError }}</p>
        <ConfirmActions
          :cancel-label="t('portfolio.cancel')"
          :confirm-label="sending ? t('access.sending') : t('access.send')"
          confirm-type="submit"
          confirm-icon="pi pi-send"
          :loading="sending"
          :cancel-disabled="sending"
          :stagger="false"
          @cancel="closeInvite"
        />
      </form>
    </Dialog>
  </div>
</template>

<style scoped>
.acc-state--owner {
  color: #1e3a8a;
  font-weight: 600;
}

.acc-state--active .ws-dot { color: #16a34a; }
.acc-state--pending .ws-dot { color: #d97706; }
.acc-state--expired { color: #b42318; }

.acc-roles {
  margin: 0;
  padding: 0;
  border: 0;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.55rem;
}

.acc-role {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.75rem 1.6rem 0.75rem 0.75rem;
  border: 1px solid rgba(15, 23, 42, 0.12);
  border-radius: 14px;
  cursor: pointer;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
}

.acc-role input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.acc-role:hover {
  background: #fafbfd;
}

.acc-role.is-selected {
  border-color: #1e3a8a;
  background: #f5f8ff;
  box-shadow: 0 0 0 3px rgba(30, 58, 138, 0.12);
}

.acc-role:has(input:focus-visible) {
  outline: 2px solid #1e3a8a;
  outline-offset: 2px;
}

.acc-role__check {
  position: absolute;
  top: 0.5rem;
  right: 0.55rem;
  font-size: 0.8rem;
  color: #1e3a8a;
  opacity: 0;
}

.acc-role.is-selected .acc-role__check {
  opacity: 1;
}

.acc-ready {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.75rem 0.85rem;
  border-radius: 14px;
  background: #f8fafc;
}

.acc-link {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}

.acc-link .ws-field {
  flex: 1;
}

.acc-link .ws-field input {
  font-size: 0.8rem;
}

.acc-done {
  display: flex;
  justify-content: flex-end;
}

.acc-link .ws-btn {
  min-height: 2.6rem;
}

@media (max-width: 720px) {
  .acc-roles {
    grid-template-columns: minmax(0, 1fr);
  }

  .acc-link {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
