<script setup lang="ts">
/**
 * PageBackup.vue — 备份: what the deployment backs up and how to rehearse a restore. The backup list and the restore drill
 * need a backup script that reports to lecture-api (prototype S9); until then this page says so instead of showing data.
 */
import { useT } from '../../../i18n/useT.ts'
import DbHead from '../DbHead.vue'
import DbUnavailable from '../DbUnavailable.vue'

const { t } = useT()
</script>

<template>
  <div class="db-page" data-page="backup">
    <DbHead :title="t('dsh.nav.backup')" :lead="t('dsh.bk.lead')" />
    <section class="db-panel" data-backup-facts>
      <header><h3>{{ t('dsh.bk.factsTitle') }}</h3><span class="db-hm"><code>docs-dev/BACKUP.md</code></span></header>
      <div class="db-pbody">
        <dl class="db-kv">
          <dt>{{ t('dsh.bk.what') }}</dt><dd>{{ t('dsh.bk.whatValue') }}</dd>
          <dt>{{ t('dsh.bk.when') }}</dt><dd>{{ t('dsh.bk.whenValue') }}</dd>
          <dt>{{ t('dsh.bk.commands') }}</dt><dd><code>npm run db:backup</code> · <code>npm run db:restore</code> <span class="db-muted">({{ t('dsh.bk.inServer') }})</span></dd>
          <dt>{{ t('dsh.bk.content') }}</dt><dd>{{ t('dsh.bk.contentValue') }}</dd>
        </dl>
      </div>
    </section>
    <DbUnavailable id="backup-list" :what="t('dsh.bk.listWhat')" :why="t('dsh.bk.listWhy')" />
    <DbUnavailable id="backup-drill" :what="t('dsh.bk.drillWhat')" :why="t('dsh.bk.drillWhy')" />
  </div>
</template>
