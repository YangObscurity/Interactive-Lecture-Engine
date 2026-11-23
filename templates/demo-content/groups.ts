/**
 * groups.ts of the engine's e2e demo content (templates/demo-content, ABOUT.md there).
 * Four groups in two categories; LOG has an English translation (lectures/en/log/).
 */

export const GROUPS = [
  {
    id: 'MEA',
    dir: 'mea',
    title: '测量与估算',
    tagline: '从单位到误差：把数字读准',
    summary: '六讲示例课程：单位、有效数字、误差、离散程度、读图与量纲检查。',
    accent: '#2563EB',
    tags: [
      '示例',
      '测量'
    ],
    category: '基础',
    i18n: {
      en: {
        title: 'Measurement and Estimation',
        tagline: 'From units to error bars: reading numbers well',
        summary: 'Six demo lectures: units, significant figures, error, spread, reading plots and dimension checks.',
        category: 'Foundations'
      }
    }
  },
  {
    id: 'LOG',
    dir: 'log',
    title: '逻辑与推理',
    tagline: '命题、条件与简单证明',
    summary: '三讲示例课程：真值表、条件语句与从例子走到证明。',
    accent: '#7C3AED',
    tags: [
      '示例',
      '逻辑'
    ],
    category: '基础',
    i18n: {
      en: {
        title: 'Logic and Reasoning',
        tagline: 'Propositions, conditionals and short proofs',
        summary: 'Three demo lectures: truth tables, conditionals and moving from examples to proofs.',
        category: 'Foundations'
      }
    }
  },
  {
    id: 'PLN',
    dir: 'pln',
    title: '计划与排程',
    tagline: '拆任务、找依赖、留缓冲',
    summary: '三讲示例课程：任务拆分、关键路径与估算缓冲。',
    accent: '#059669',
    tags: [
      '示例',
      '计划'
    ],
    category: '应用',
    i18n: {
      en: {
        title: 'Planning and Scheduling',
        tagline: 'Split the work, find the order, keep a buffer',
        summary: 'Three demo lectures: breaking work down, the critical path and estimation buffers.',
        category: 'Applications'
      }
    }
  },
  {
    id: 'DAT',
    dir: 'dat',
    title: '表格与数据整理',
    tagline: '一行一条记录，再谈汇总',
    summary: '两讲示例课程：整齐的表格与分组汇总。',
    accent: '#D97706',
    tags: [
      '示例',
      '数据'
    ],
    category: '应用',
    i18n: {
      en: {
        title: 'Tables and Tidy Data',
        tagline: 'One row per record, then summaries',
        summary: 'Two demo lectures: tidy tables and grouped summaries.',
        category: 'Applications'
      }
    }
  }
]
