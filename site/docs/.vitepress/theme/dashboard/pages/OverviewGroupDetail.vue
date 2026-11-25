<script setup lang="ts">
/**
 * OverviewGroupDetail.vue — the opened course group on the overview: every lecture number, the ones with check issues
 * marked, and a way to the content checks. Shown under the group tile (reader) or in the row under it (datasheet table).
 */
import { useT } from '../../../i18n/useT.ts'
import type { CheckReport } from '../../api/devDashboard'
import type { DashboardPageId } from '../useDashboard'
import { groupIssueCounts, issuesOfLecture, type DashGroup } from '../dashboardData'

const props = defineProps<{ group: DashGroup; report: CheckReport | null }>()
const emit = defineEmits<{ go: [page: DashboardPageId, tab?: string] }>()
const { t } = useT()

const pad = (n: number) => String(n).padStart(2, '0')
function lectureNumbers(): number[] {
  const g = props.group
  const fromLectures = Array.isArray(g.lectures) ? g.lectures.map((l) => l.n) : []
  return fromLectures.length ? fromLectures : Array.from({ length: g.lectureCount ?? 0 }, (_, i) => i + 1)
}
const issuesOf = (n: number) => (props.report ? issuesOfLecture(props.report, props.group.dir, n) : [])
const hasIssues = () => {
  if (!props.report) return false
  const c = groupIssueCounts(props.report, props.group.dir)
  return c.fail + c.warn > 0
}
</script>

<template>
  <div class="db-glist" :data-overview-detail="group.id">
    <p>{{ t('dsh.ov.groupDetail', { id: group.id, n: group.lectureCount ?? 0 }) }}</p>
    <p v-if="group.temp" class="db-muted" data-overview-detail-temp>{{ t('dsh.ov.tempGroupHint') }}</p>
    <div class="db-lecs">
      <template v-for="n in lectureNumbers()" :key="n">
        <span v-if="issuesOf(n).length" class="db-lc x">
          <span class="dm" :data-k="issuesOf(n).some((x) => x.level === 'fail') ? 'bad' : 'warn'" aria-hidden="true"></span>L{{ pad(n) }}
        </span>
        <span v-else class="db-lc">L{{ pad(n) }}</span>
      </template>
    </div>
    <div v-if="hasIssues()"><button type="button" class="db-btn sm" @click="emit('go', 'checks')">{{ t('dsh.ov.toChecks') }}</button></div>
  </div>
</template>
