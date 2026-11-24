<script setup lang="ts">
/**
 * PageChecks.vue — 内容检查: the last `check:content` run (the same checks the build relies on), every problem with its
 * next step (open the file at the line, copy a brief for the coding agent, rerun), the author rules, and the latest
 * `check:content` / `doctor` output. Local author mode only: the online site has no content folder to check.
 */
import { computed, onMounted, reactive, ref } from 'vue'
import { useT } from '../../../i18n/useT.ts'
import type { MessageKey } from '../../../i18n/index.ts'
import { fetchSnippet, type CheckIssue, type Snippet } from '../../api/devDashboard'
import DbHead from '../DbHead.vue'
import DbUnavailable from '../DbUnavailable.vue'
import { checkState, dashboardState, ensureCheckRun, isReadOnly, runChecks, say } from '../useDashboard'
import { agentBrief, groupIssuesByCode, shortDateTime } from '../dashboardData'

const { t } = useT()
const report = computed(() => checkState.run?.report ?? null)
const groups = computed(() => (report.value ? groupIssuesByCode(report.value).filter((g) => g.level !== 'info') : []))
const infos = computed(() => (report.value ? groupIssuesByCode(report.value).filter((g) => g.level === 'info') : []))
const expanded = reactive(new Set<string>())
const snippets = reactive(new Map<string, Snippet | 'loading' | 'none'>())
const showAll = ref(new Set<string>())

const CATEGORIES = ['lecture', 'chart', 'link', 'translation', 'concept', 'figure', 'graph', 'texts', 'group'] as const
const CAT_LABEL: Record<(typeof CATEGORIES)[number], MessageKey> = {
  lecture: 'dsh.chk.catLecture',
  chart: 'dsh.chk.catChart',
  link: 'dsh.chk.catLink',
  translation: 'dsh.chk.catTranslation',
  concept: 'dsh.chk.catConcept',
  figure: 'dsh.chk.catFigure',
  graph: 'dsh.chk.catGraph',
  texts: 'dsh.chk.catTexts',
  group: 'dsh.chk.catGroup',
}
const categories = computed(() =>
  CATEGORIES.map((c) => {
    const list = report.value?.issues.filter((i) => i.code.split('.')[0] === c) ?? []
    const fail = list.filter((i) => i.level === 'fail').length
    const warn = list.filter((i) => i.level === 'warn').length
    const info = list.filter((i) => i.level === 'info').length
    return { c, label: t(CAT_LABEL[c]), fail, warn, info, k: fail ? 'bad' : warn ? 'warn' : 'ok' }
  }),
)

const RULES: ReadonlyArray<[MessageKey, 'check' | 'doctor' | 'dashboard' | 'convention']> = [
  ['dsh.chk.rule1', 'check'],
  ['dsh.chk.rule2', 'check'],
  ['dsh.chk.rule3', 'check'],
  ['dsh.chk.rule4', 'dashboard'],
  ['dsh.chk.rule5', 'check'],
  ['dsh.chk.rule6', 'convention'],
]
const ruleTag = (k: 'check' | 'doctor' | 'dashboard' | 'convention') =>
  k === 'convention' ? t('dsh.chk.byConvention') : t('dsh.chk.checkedBy', { by: k === 'check' ? 'check:content' : k === 'doctor' ? 'doctor' : 'Dashboard' })

const issueKey = (i: CheckIssue, n: number) => `${i.code}|${i.file ?? ''}|${i.line ?? ''}|${n}`

async function toggleFile(i: CheckIssue, n: number): Promise<void> {
  const key = issueKey(i, n)
  if (expanded.has(key)) {
    expanded.delete(key)
    return
  }
  expanded.add(key)
  if (!i.file || snippets.has(key)) return
  snippets.set(key, 'loading')
  const s = await fetchSnippet(dashboardState.token, i.file, i.line)
  snippets.set(key, s ?? 'none')
}

async function copyBrief(i: CheckIssue): Promise<void> {
  try {
    await navigator.clipboard.writeText(agentBrief(i))
    say(t('dsh.chk.copied'))
  } catch {
    say(t('dsh.common.copyFailed'))
  }
}

function visible(code: string, list: CheckIssue[]): CheckIssue[] {
  return showAll.value.has(code) ? list : list.slice(0, 12)
}
function showMore(code: string): void {
  showAll.value = new Set([...showAll.value, code])
}

const levelText = (l: CheckIssue['level']) => (l === 'fail' ? t('dsh.chk.fail') : l === 'warn' ? t('dsh.chk.warn') : t('dsh.chk.info'))
const levelMark = (l: CheckIssue['level']) => (l === 'fail' ? 'bad' : l === 'warn' ? 'warn' : 'off')

const meta = computed<Array<[string, string]>>(() =>
  checkState.run
    ? [
        [t('dsh.chk.lastRun'), shortDateTime(checkState.run.at)],
        [t('dsh.chk.duration'), `${(checkState.run.ms / 1000).toFixed(1)} s`],
        ...(checkState.run.only?.length ? [[t('dsh.chk.rerun'), checkState.run.only.map(catLabel).join(', ')] as [string, string]] : []),
      ]
    : [],
)

// "rerun this check": one category (the first part of the issue code) on top of the last full report
const catOf = (code: string): string => code.split('.')[0] ?? code
const catLabel = (c: string): string => (c in CAT_LABEL ? t(CAT_LABEL[c as (typeof CATEGORIES)[number]]) : c)
const canRerun = (c: string): boolean => (CATEGORIES as readonly string[]).includes(c)
async function rerun(cat: string): Promise<void> {
  if (!canRerun(cat)) return
  const ok = await runChecks(cat)
  if (!ok || !report.value) return
  const list = report.value.issues.filter((i) => catOf(i.code) === cat)
  say(t('dsh.chk.rerunDone', { cat: catLabel(cat), fail: list.filter((i) => i.level === 'fail').length, warn: list.filter((i) => i.level === 'warn').length }))
}

onMounted(() => {
  void ensureCheckRun()
})
</script>

<template>
  <div class="db-page" data-page="checks">
    <DbHead :title="t('dsh.nav.checks')" :lead="t('dsh.chk.lead')" :meta="meta" />

    <DbUnavailable v-if="isReadOnly" id="checks" :what="t('dsh.nav.checks')" :why="t('dsh.chk.onlineWhy')" />
    <template v-else>
      <div class="db-figs">
        <div><b>{{ report?.totals.fail ?? '—' }}</b><span>{{ t('dsh.chk.fail') }}</span><small>{{ t('dsh.chk.failHint') }}</small></div>
        <div><b>{{ report?.totals.warn ?? '—' }}</b><span>{{ t('dsh.chk.warn') }}</span><small>{{ t('dsh.chk.warnHint') }}</small></div>
        <div><b>{{ report?.totals.info ?? '—' }}</b><span>{{ t('dsh.chk.info') }}</span></div>
        <div><b>{{ report?.counts.lectures ?? '—' }}</b><span>{{ t('dsh.chk.lecturesChecked') }}</span><small>{{ report ? t('dsh.chk.countsLine', { g: report.counts.groups, c: report.counts.charts, f: report.counts.figures }) : '' }}</small></div>
      </div>

      <section class="db-panel" data-checks-problems>
        <header>
          <h3>{{ t('dsh.chk.problems') }}</h3>
          <span class="db-hm">
            {{ checkState.running ? t('dsh.chk.running') : report ? t('dsh.common.nItems', { n: report.totals.fail + report.totals.warn }) : '' }}
            <button type="button" class="db-btn sm primary" :disabled="checkState.running" data-checks-rerun @click="runChecks()">{{ t('dsh.chk.rerunAll') }}</button>
          </span>
        </header>
        <div v-if="checkState.error" class="db-pbody db-err">{{ t('dsh.chk.runFailed') }}</div>
        <div v-else-if="checkState.run && !report" class="db-pbody"><pre class="db-codeb">{{ checkState.run.error }}</pre></div>
        <div v-else-if="!report" class="db-empty"><span>{{ checkState.running ? t('dsh.chk.running') : t('dsh.chk.notRun') }}</span></div>
        <div v-else-if="groups.length === 0" class="db-empty" data-checks-allpass>
          <b>{{ t('dsh.chk.allPass') }}</b><span>{{ t('dsh.chk.allPassDetail') }}</span>
        </div>
        <div v-else class="db-wl">
          <details v-for="g in groups" :key="g.code" class="db-ig" :open="g.level === 'fail'" :data-checks-code="g.code">
            <summary>
              <span class="db-stat"><span class="dm" :data-k="levelMark(g.level)" aria-hidden="true"></span>{{ levelText(g.level) }}</span>
              <code>{{ g.code }}</code>
              <span class="db-muted">{{ t('dsh.common.nItems', { n: g.issues.length }) }}</span>
            </summary>
            <div v-for="(i, n) in visible(g.code, g.issues)" :key="issueKey(i, n)" class="db-wi">
              <span class="dm" :data-k="levelMark(i.level)" aria-hidden="true"></span>
              <div>
                <div class="db-wt">{{ i.message }}</div>
                <div v-if="i.file" class="db-wf">{{ i.file }}{{ i.line ? `:${i.line}` : '' }}</div>
              </div>
              <div class="db-btns">
                <button v-if="i.file" type="button" class="db-btn sm" :aria-expanded="expanded.has(issueKey(i, n))" data-checks-open @click="toggleFile(i, n)">
                  {{ expanded.has(issueKey(i, n)) ? t('dsh.common.collapse') : t('dsh.chk.openFile') }}
                </button>
                <button type="button" class="db-btn sm" data-checks-copy @click="copyBrief(i)">{{ t('dsh.chk.copyAgent') }}</button>
                <button
                  v-if="canRerun(catOf(i.code))"
                  type="button"
                  class="db-btn sm"
                  :disabled="checkState.running"
                  :data-checks-rerun-one="catOf(i.code)"
                  @click="rerun(catOf(i.code))"
                >
                  {{ checkState.scope === catOf(i.code) ? t('dsh.chk.running') : t('dsh.chk.rerunOne') }}
                </button>
              </div>
              <div v-if="expanded.has(issueKey(i, n))" class="db-wx">
                <span v-if="snippets.get(issueKey(i, n)) === 'loading'" class="db-muted">{{ t('dsh.common.loading') }}</span>
                <span v-else-if="snippets.get(issueKey(i, n)) === 'none' || !snippets.get(issueKey(i, n))" class="db-muted">{{ t('dsh.chk.snippetNone') }}</span>
                <pre v-else class="db-snip" :aria-label="t('dsh.chk.snippet')" data-checks-snippet
                  ><span
                    v-for="(line, k) in (snippets.get(issueKey(i, n)) as Snippet).lines"
                    :key="k"
                    :class="{ hit: (snippets.get(issueKey(i, n)) as Snippet).from + k === (snippets.get(issueKey(i, n)) as Snippet).hit }"
                    ><i>{{ (snippets.get(issueKey(i, n)) as Snippet).from + k }}</i>{{ line }}</span
                  ></pre>
              </div>
            </div>
            <button v-if="g.issues.length > 12 && !showAll.has(g.code)" type="button" class="db-btn sm db-more" @click="showMore(g.code)">{{ t('dsh.chk.showAll', { n: g.issues.length }) }}</button>
          </details>
        </div>
      </section>

      <section class="db-panel" data-checks-all>
        <header><h3>{{ t('dsh.chk.allChecks') }}</h3><span class="db-hm"><code>npm run check:content</code></span></header>
        <div class="db-tw">
          <table class="db-t">
            <thead><tr><th>{{ t('dsh.chk.colCheck') }}</th><th>{{ t('dsh.chk.colResult') }}</th><th>{{ t('dsh.chk.fail') }}</th><th>{{ t('dsh.chk.warn') }}</th><th>{{ t('dsh.chk.info') }}</th><th></th></tr></thead>
            <tbody>
              <tr v-for="c in categories" :key="c.c" :class="{ cur: checkState.scope === c.c }">
                <td :data-l="t('dsh.chk.colCheck')"><b>{{ c.label }}</b> <code>{{ c.c }}.*</code></td>
                <td :data-l="t('dsh.chk.colResult')"><span class="db-stat"><span class="dm" :data-k="report ? c.k : 'off'" aria-hidden="true"></span>{{ !report ? t('dsh.chk.notRun') : c.fail ? t('dsh.chk.fail') : c.warn ? t('dsh.chk.warn') : t('dsh.chk.pass') }}</span></td>
                <td :data-l="t('dsh.chk.fail')" class="n">{{ c.fail }}</td>
                <td :data-l="t('dsh.chk.warn')" class="n">{{ c.warn }}</td>
                <td :data-l="t('dsh.chk.info')" class="n">{{ c.info }}</td>
                <td class="n">
                  <button type="button" class="db-btn sm" :disabled="checkState.running || !report" :aria-label="t('dsh.chk.rerunLabel', { cat: c.label })" :data-checks-rerun-cat="c.c" @click="rerun(c.c)">
                    {{ checkState.scope === c.c ? t('dsh.chk.running') : t('dsh.chk.rerun') }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="infos.length" class="db-pbody db-sep db-muted">
          {{ t('dsh.chk.infoLine') }} <span v-for="g in infos" :key="g.code" class="db-tag">{{ g.code }} × {{ g.issues.length }}</span>
        </div>
      </section>

      <div class="db-cols">
        <section class="db-panel" data-checks-rules>
          <header><h3>{{ t('dsh.chk.rulesTitle') }}</h3><span class="db-hm">{{ t('dsh.chk.rulesHint') }}</span></header>
          <div class="db-wl">
            <div v-for="[k, by] in RULES" :key="k" class="db-wi db-wi-rule">
              <div class="db-wt">{{ t(k) }}</div>
              <span class="db-tag">{{ ruleTag(by) }}</span>
            </div>
          </div>
          <div class="db-pbody db-sep">
            <b>AUTHORING.local.md</b>
            <pre v-if="checkState.run?.authoringLocal" class="db-codeb db-wrap" data-checks-authoring>{{ checkState.run.authoringLocal }}</pre>
            <p v-else class="db-muted">{{ t('dsh.chk.noLocalRules') }}</p>
          </div>
        </section>
        <section class="db-panel" data-checks-output>
          <header><h3>{{ t('dsh.chk.outputTitle') }}</h3></header>
          <div class="db-pbody">
            <b>check:content</b>
            <pre class="db-codeb">{{ report ? `$ npm run check:content\nFAIL ${report.totals.fail}, WARN ${report.totals.warn}, INFO ${report.totals.info}\n${report.ok ? 'PASS' : 'FAIL'} (exit ${checkState.run?.exitCode ?? ''})` : '—' }}</pre>
          </div>
          <div class="db-pbody db-sep">
            <b>doctor</b>
            <pre class="db-codeb db-doctor" data-checks-doctor>{{ checkState.run?.doctor?.text ?? '—' }}</pre>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>
