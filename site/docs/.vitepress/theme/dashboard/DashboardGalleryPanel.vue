<script setup lang="ts">
/**
 * View-only Dashboard "图库 / Gallery" panel (WP-F8).
 * Matches the dashboard prototype:
 *   - 3 key metric cards (total, cited, uncited)
 *   - 4 filters (group, source paper, citation state, free-text search)
 *   - Thumbnail cards grid (caption, source, used-in badge)
 *   - Read-only `<dialog>` lightbox with source, DOI, lectures using it, file path & size
 * The engine keeps no licence or copyright bookkeeping for figures (owner decision 2026-11-22):
 * the source citation (paper, figure number, page, DOI) is the only provenance shown.
 * Uses `--lec-*` tokens only (zero raw color literals) and `useT()` (zero CJK literals).
 */
import { computed, onMounted, ref } from 'vue'
import { withBase } from 'vitepress'
import type { FigureGalleryItem, GalleryPayload } from '../../figures/types.ts'
import { useT } from '../../i18n/useT.ts'
import { fetchTierJson, tierUrl } from '../access/resolve'
import { currentAccessConfig, getAccess } from '../access/store'
import { openUnifiedViewer } from '../charts/modal'

const props = defineProps<{
  isDevMode: boolean
}>()

const { t, lang } = useT()

const loading = ref(false)
const loadError = ref('')
const items = ref<FigureGalleryItem[]>([])

const filterGroup = ref('')
const filterPaper = ref('')
const filterState = ref<'all' | 'cited' | 'uncited'>('all')
const filterSearch = ref('')

const dialogRef = ref<HTMLDialogElement | null>(null)
const selected = ref<FigureGalleryItem | null>(null)

function localizedCaption(item: FigureGalleryItem): string {
  return lang.value === 'en' ? (item.caption.en || item.caption.zh) : (item.caption.zh || item.caption.en)
}

function localizedGroupTitle(item: FigureGalleryItem): string {
  return lang.value === 'en' ? (item.groupTitle.en || item.groupTitle.zh) : (item.groupTitle.zh || item.groupTitle.en)
}

function sourceLine(item: FigureGalleryItem): string {
  const parts = [item.source.paper]
  if (item.source.number) parts.push(item.source.number)
  if (item.source.page !== undefined && item.source.page !== '') parts.push(`p.${item.source.page}`)
  return parts.join(' · ')
}

function isSvg(src: string): boolean {
  return src.toLowerCase().split(/[?#]/, 1)[0]!.endsWith('.svg')
}

function formatBytes(bytes: number): string {
  if (bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  return kb >= 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`
}

const groupOptions = computed(() => {
  const map = new Map<string, string>()
  for (const it of items.value) {
    if (!map.has(it.group)) map.set(it.group, `${it.groupId} · ${localizedGroupTitle(it)}`)
  }
  return Array.from(map.entries()).map(([value, label]) => ({ value, label }))
})

const paperOptions = computed(() =>
  Array.from(new Set(items.value.map((it) => it.source.paper).filter(Boolean))).sort(),
)

const filtered = computed(() => {
  const q = filterSearch.value.trim().toLowerCase()
  return items.value.filter((it) => {
    if (filterGroup.value && it.group !== filterGroup.value) return false
    if (filterPaper.value && it.source.paper !== filterPaper.value) return false
    if (filterState.value === 'cited' && it.usedIn.length === 0) return false
    if (filterState.value === 'uncited' && it.usedIn.length > 0) return false
    if (q) {
      const hay = [
        it.id,
        it.file,
        it.caption.zh,
        it.caption.en,
        it.source.paper,
        it.source.number ?? '',
        it.doi ?? '',
      ]
        .join(' ')
        .toLowerCase()
      if (!hay.includes(q)) return false
    }
    return true
  })
})

const stats = computed(() => ({
  total: items.value.length,
  cited: items.value.filter((x) => x.usedIn.length > 0).length,
  uncited: items.value.filter((x) => x.usedIn.length === 0).length,
}))

async function loadGallery(): Promise<void> {
  loading.value = true
  loadError.value = ''
  try {
    if (import.meta.env.DEV && props.isDevMode) {
      const res = await fetch(withBase('/__lecture/api/figures'), { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { items?: FigureGalleryItem[] }
      items.value = Array.isArray(data.items) ? data.items : []
      return
    }

    const res = await fetch(withBase('/figures-gallery.json'), { cache: 'no-store' })
    const basePayload = res.ok ? ((await res.json()) as GalleryPayload) : null
    const merged: FigureGalleryItem[] = Array.isArray(basePayload?.items) ? [...basePayload.items] : []

    const tiers = currentAccessConfig()?.tiers ?? []
    if (tiers.length > 0) {
      const access = await getAccess()
      for (const tier of access.tiers) {
        const raw = await fetchTierJson({ fetch: window.fetch.bind(window) }, tierUrl({ withBase }, tier.id, 'figures-gallery.json'))
        const payload = raw as GalleryPayload | undefined
        if (Array.isArray(payload?.items)) {
          merged.push(...payload.items)
        }
      }
    }
    items.value = merged
  } catch (err) {
    loadError.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function openLightbox(item: FigureGalleryItem): void {
  selected.value = item
  const dlg = dialogRef.value
  if (dlg && !dlg.open) {
    if (typeof dlg.showModal === 'function') dlg.showModal()
    else dlg.setAttribute('open', '')
  }
}

function closeLightbox(): void {
  const dlg = dialogRef.value
  if (dlg?.open && typeof dlg.close === 'function') dlg.close()
  else dlg?.removeAttribute('open')
  selected.value = null
}

function onDialogClick(ev: MouseEvent): void {
  if (ev.target === dialogRef.value) closeLightbox()
}

function openInFullViewer(): void {
  const item = selected.value
  if (!item) return
  closeLightbox()
  openUnifiedViewer(
    {
      kind: 'figure',
      id: item.id,
      title: `${item.group}/${item.id} · ${localizedCaption(item)}`,
      src: withBase(item.src),
      width: item.width,
      height: item.height,
      caption: localizedCaption(item),
      sourceText: sourceLine(item),
      originalUrl: item.originalSrc ? withBase(item.originalSrc) : undefined,
    },
    null,
  )
}

onMounted(() => {
  void loadGallery()
})
</script>

<template>
  <div class="db-gal" data-gallery-panel>
    <div class="db-panel">
      <h2 class="db-section-title">{{ t('dashboard.gallery.title') }}</h2>
      <p class="db-muted">{{ t('dashboard.gallery.subtitle') }}</p>

      <div class="db-grid-3 db-gal-stats">
        <div class="db-stat-card" data-gallery-stat="total">
          <span class="db-stat-label">{{ t('dashboard.gallery.statTotal') }}</span>
          <strong class="db-stat-value">{{ stats.total }}</strong>
        </div>
        <div class="db-stat-card" data-gallery-stat="cited">
          <span class="db-stat-label">{{ t('dashboard.gallery.statCited') }}</span>
          <strong class="db-stat-value">{{ stats.cited }}</strong>
        </div>
        <div class="db-stat-card" data-gallery-stat="uncited">
          <span class="db-stat-label">{{ t('dashboard.gallery.statUncited') }}</span>
          <strong class="db-stat-value">{{ stats.uncited }}</strong>
        </div>
      </div>

      <div class="db-gal-filters">
        <select v-model="filterGroup" class="db-gal-ctl" data-gallery-filter="group" :aria-label="t('dashboard.gallery.filterGroup')">
          <option value="">{{ t('dashboard.gallery.allGroups') }}</option>
          <option v-for="g in groupOptions" :key="g.value" :value="g.value">{{ g.label }}</option>
        </select>

        <select v-model="filterPaper" class="db-gal-ctl" data-gallery-filter="paper" :aria-label="t('dashboard.gallery.filterPaper')">
          <option value="">{{ t('dashboard.gallery.allPapers') }}</option>
          <option v-for="p in paperOptions" :key="p" :value="p">{{ p }}</option>
        </select>

        <select v-model="filterState" class="db-gal-ctl" data-gallery-filter="state" :aria-label="t('dashboard.gallery.filterState')">
          <option value="all">{{ t('dashboard.gallery.stateAll') }}</option>
          <option value="cited">{{ t('dashboard.gallery.stateCited') }}</option>
          <option value="uncited">{{ t('dashboard.gallery.stateUncited') }}</option>
        </select>

        <input
          v-model="filterSearch"
          type="search"
          class="db-gal-ctl db-gal-search"
          data-gallery-filter="search"
          :placeholder="t('dashboard.gallery.filterSearch')"
          :aria-label="t('dashboard.gallery.filterSearch')"
        />
      </div>

      <p v-if="loading" class="db-muted">{{ t('dashboard.loading') }}</p>
      <p v-else-if="loadError" class="db-err-text">{{ loadError }}</p>
      <p v-else-if="filtered.length === 0" class="db-muted" data-gallery-empty>{{ t('dashboard.gallery.empty') }}</p>

      <div v-else class="db-gal-grid" data-gallery-grid>
        <button
          v-for="item in filtered"
          :key="`${item.group}:${item.id}`"
          type="button"
          class="db-gal-card"
          :data-gallery-card="item.id"
          :data-group="item.group"
          @click="openLightbox(item)"
        >
          <div class="db-gal-thumb" :data-format="isSvg(item.src) ? 'svg' : 'raster'">
            <img :src="withBase(item.src)" :width="item.width" :height="item.height" :alt="localizedCaption(item)" loading="lazy" />
          </div>
          <div class="db-gal-body">
            <div class="db-gal-title">{{ localizedCaption(item) }}</div>
            <div class="db-gal-src">{{ sourceLine(item) }}</div>
            <div class="db-gal-tags">
              <span class="db-gal-pill" :class="item.usedIn.length > 0 ? 'is-ok' : 'is-muted'">
                {{ item.usedIn.length > 0 ? t('dashboard.gallery.usedIn', { n: item.usedIn.length }) : t('dashboard.gallery.unused') }}
              </span>
            </div>
          </div>
        </button>
      </div>
    </div>

    <dialog ref="dialogRef" class="db-gal-lb" data-gallery-lightbox @click="onDialogClick" @cancel.prevent="closeLightbox">
      <div v-if="selected" class="db-gal-lb-panel">
        <header class="db-gal-lb-head">
          <div class="db-gal-lb-heading">
            <strong>{{ localizedCaption(selected) }}</strong>
            <span class="db-muted"> · {{ selected.group }}/{{ selected.id }}</span>
          </div>
          <button type="button" class="db-btn" data-gallery-lb-close @click="closeLightbox">
            {{ t('dashboard.gallery.close') }}
          </button>
        </header>

        <div class="db-gal-lb-media" :data-format="isSvg(selected.src) ? 'svg' : 'raster'">
          <img :src="withBase(selected.src)" :width="selected.width" :height="selected.height" :alt="localizedCaption(selected)" />
        </div>

        <dl class="db-gal-lb-meta">
          <dt>{{ t('dashboard.gallery.fieldSource') }}</dt>
          <dd>{{ sourceLine(selected) }}</dd>

          <dt>{{ t('dashboard.gallery.fieldDoi') }}</dt>
          <dd>
            <a
              v-if="selected.doi"
              :href="`https://doi.org/${selected.doi}`"
              target="_blank"
              rel="noopener noreferrer"
            >{{ selected.doi }}</a>
            <a
              v-else-if="selected.url"
              :href="selected.url"
              target="_blank"
              rel="noopener noreferrer"
            >{{ selected.url }}</a>
            <span v-else class="db-muted">{{ t('dashboard.gallery.missing') }}</span>
          </dd>

          <dt>{{ t('dashboard.gallery.fieldFile') }}</dt>
          <dd><code>{{ selected.group }}/{{ selected.file }}</code> · {{ selected.width }} × {{ selected.height }} · {{ formatBytes(selected.bytes) }}</dd>

          <dt>{{ t('dashboard.gallery.fieldLectures') }}</dt>
          <dd>
            <div v-if="selected.usedIn.length" class="db-gal-lb-links">
              <a v-for="u in selected.usedIn" :key="u.route" :href="withBase(u.route)">{{ u.route }} · {{ u.title }}</a>
            </div>
            <span v-else class="db-muted">{{ t('dashboard.gallery.unused') }}</span>
          </dd>
        </dl>

        <footer class="db-gal-lb-foot">
          <a
            v-if="selected.originalSrc"
            class="db-btn"
            :href="withBase(selected.originalSrc)"
            target="_blank"
            rel="noopener noreferrer"
          >{{ t('lecture.fig.openOriginal') }}</a>
          <button type="button" class="db-btn db-btn-primary" @click="openInFullViewer">
            {{ t('dashboard.gallery.viewFullscreen') }}
          </button>
        </footer>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.db-panel,
.db-stat-card {
  background: var(--lec-surface);
  border: 1px solid var(--lec-border);
  border-radius: var(--lec-radius-2);
  padding: 1rem;
}
.db-section-title {
  margin: 0 0 0.75rem;
  font-size: 1.08rem;
  font-family: var(--lec-font-heading);
}
.db-muted {
  color: var(--lec-text-muted);
  font-size: 0.88rem;
  margin: 0;
}
.db-err-text {
  color: var(--lec-danger);
  font-size: 0.88rem;
}
.db-grid-3 {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
  gap: 0.9rem;
}
.db-stat-card {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.db-stat-label {
  color: var(--lec-text-muted);
  font-size: 0.82rem;
}
.db-stat-value {
  font-size: 1.45rem;
  font-family: var(--lec-font-mono);
}
.db-btn {
  padding: 0.45rem 0.9rem;
  border-radius: var(--lec-radius-1);
  border: 1px solid var(--lec-border);
  background: var(--lec-bg);
  color: var(--lec-text);
  font-size: 0.88rem;
  text-decoration: none;
  cursor: pointer;
}
.db-btn-primary {
  background: var(--lec-accent);
  color: var(--lec-on-accent);
  border-color: var(--lec-accent);
}
.db-gal-stats {
  margin: var(--lec-space-4) 0;
}
.db-gal-filters {
  display: flex;
  flex-wrap: wrap;
  gap: var(--lec-space-2);
  margin-bottom: var(--lec-space-4);
}
.db-gal-ctl {
  font: inherit;
  font-size: 13px;
  padding: 6px 10px;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-1);
  background: var(--lec-bg);
  color: var(--lec-text);
}
.db-gal-search {
  flex: 1 1 220px;
  min-width: 180px;
}
.db-gal-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: var(--lec-space-4);
}
.db-gal-card {
  display: flex;
  flex-direction: column;
  text-align: left;
  padding: var(--lec-space-3);
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-2);
  background: var(--lec-bg);
  color: var(--lec-text);
  cursor: pointer;
  transition: border-color 0.15s ease;
}
.db-gal-card:hover {
  border-color: var(--lec-accent);
}
.db-gal-thumb {
  width: 100%;
  height: 150px;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
  border-radius: var(--lec-radius-1);
  background: var(--lec-surface);
  margin-bottom: var(--lec-space-2);
}
html.dark .db-gal-thumb[data-format='raster'],
html.dark .db-gal-lb-media[data-format='raster'] {
  background: var(--lec-text);
  border: var(--lec-line-hair) solid var(--lec-border);
  padding: var(--lec-space-1);
}
.db-gal-thumb img {
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
}
.db-gal-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.db-gal-title {
  font-size: 13px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--lec-text);
}
.db-gal-src {
  font-size: 12px;
  color: var(--lec-text-muted);
}
.db-gal-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 4px;
}
.db-gal-pill {
  font-size: 11px;
  padding: 2px 6px;
  border-radius: var(--lec-radius-1);
  border: var(--lec-line-hair) solid var(--lec-border);
}
.db-gal-pill.is-ok {
  background: var(--lec-accent-tint);
  color: var(--lec-accent);
  border-color: var(--lec-accent);
}
.db-gal-pill.is-muted {
  background: var(--lec-surface);
  color: var(--lec-text-muted);
}
.db-gal-lb {
  max-width: min(760px, 94vw);
  width: 100%;
  padding: 0;
  border: var(--lec-line-hair) solid var(--lec-border);
  border-radius: var(--lec-radius-2);
  background: var(--lec-surface);
  color: var(--lec-text);
}
.db-gal-lb::backdrop {
  background: color-mix(in srgb, var(--lec-text) 45%, transparent);
}
.db-gal-lb-panel {
  display: flex;
  flex-direction: column;
  gap: var(--lec-space-3);
  padding: var(--lec-space-4);
}
.db-gal-lb-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--lec-space-3);
}
.db-gal-lb-media {
  display: flex;
  justify-content: center;
  max-height: 45vh;
  overflow: hidden;
  border-radius: var(--lec-radius-1);
  background: var(--lec-bg);
  padding: var(--lec-space-2);
}
.db-gal-lb-media img {
  max-width: 100%;
  max-height: 42vh;
  width: auto;
  height: auto;
  object-fit: contain;
}
.db-gal-lb-meta {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 6px 12px;
  margin: 0;
  font-size: 13px;
}
.db-gal-lb-meta dt {
  color: var(--lec-text-muted);
  font-weight: 600;
}
.db-gal-lb-meta dd {
  margin: 0;
  min-width: 0;
  overflow-wrap: anywhere;
}
.db-gal-lb-links {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.db-gal-lb-links a {
  color: var(--lec-accent);
}
.db-gal-lb-foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--lec-space-2);
}
</style>
