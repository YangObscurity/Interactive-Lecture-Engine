/**
 * groups.ts of the engine's e2e demo content (templates/demo-content, ABOUT.md there).
 * Nine groups in three categories; LOG has an English translation (lectures/en/log/).
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
    summary: '五讲示例课程：真值表、条件语句、从例子走到证明、集合与量词、反例与归谬。',
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
        summary: 'Five demo lectures: truth tables, conditionals, moving from examples to proofs, sets and quantifiers, counterexamples and proof by contradiction.',
        category: 'Foundations'
      }
    }
  },
  {
    id: 'PRB',
    dir: 'prb',
    title: '概率与统计入门',
    tagline: '从频率到抽样：和不确定性打交道',
    summary: '六讲示例课程：随机与频率、条件概率、期望值、分布与直方图、抽样与估计、相关与因果。',
    accent: '#DC2626',
    tags: [
      '示例',
      '概率'
    ],
    category: '基础',
    i18n: {
      en: {
        title: 'Probability and Statistics',
        tagline: 'From frequencies to samples: working with chance',
        summary: 'Six demo lectures: chance and frequency, conditional probability, expected value, distributions and histograms, sampling and estimation, correlation and causation.',
        category: 'Foundations'
      }
    }
  },
  {
    id: 'GEO',
    dir: 'geo',
    title: '几何与作图',
    tagline: '坐标、角度与比例：把形状算清楚',
    summary: '五讲示例课程：坐标与向量、角度与三角、比例与相似、面积与体积估算、坐标变换。',
    accent: '#0891B2',
    tags: [
      '示例',
      '几何'
    ],
    category: '基础',
    i18n: {
      en: {
        title: 'Geometry and Drawing',
        tagline: 'Coordinates, angles and scale: shapes you can compute',
        summary: 'Five demo lectures: coordinates and vectors, angles and trigonometry, scale and similarity, estimating area and volume, coordinate transforms.',
        category: 'Foundations'
      }
    }
  },
  {
    id: 'PLN',
    dir: 'pln',
    title: '计划与排程',
    tagline: '拆任务、找依赖、留缓冲',
    summary: '五讲示例课程：任务拆分、关键路径、估算缓冲、资源平衡与复盘迭代。',
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
        summary: 'Five demo lectures: breaking work down, the critical path, estimation buffers, resource levelling and retrospectives.',
        category: 'Applications'
      }
    }
  },
  {
    id: 'DAT',
    dir: 'dat',
    title: '表格与数据整理',
    tagline: '一行一条记录，再谈汇总',
    summary: '五讲示例课程：整齐的表格、分组汇总、缺失值与清洗、透视与重塑、可复现的整理流程。',
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
        summary: 'Five demo lectures: tidy tables, grouped summaries, missing values and cleaning, pivoting and reshaping, a reproducible tidying workflow.',
        category: 'Applications'
      }
    }
  },
  {
    id: 'VIS',
    dir: 'vis',
    title: '图表与可视化',
    tagline: '选对图，画清楚，不误导',
    summary: '五讲示例课程：选对图表、坐标轴与刻度、颜色与对比、会误导的图、用数据讲故事。',
    accent: '#DB2777',
    tags: [
      '示例',
      '可视化'
    ],
    category: '应用',
    i18n: {
      en: {
        title: 'Charts and Visualisation',
        tagline: 'Pick the right chart, draw it clearly, never mislead',
        summary: 'Five demo lectures: choosing a chart, axes and scales, colour and contrast, misleading charts, telling a story with data.',
        category: 'Applications'
      }
    }
  },
  {
    id: 'EXP',
    dir: 'exp',
    title: '实验设计',
    tagline: '先问能检验的问题，再设计对照',
    summary: '五讲示例课程：可检验的问题、变量与对照、随机化与重复、记录与复现、从结果到结论。',
    accent: '#65A30D',
    tags: [
      '示例',
      '实验'
    ],
    category: '方法',
    i18n: {
      en: {
        title: 'Experiment Design',
        tagline: 'Ask a testable question, then design the comparison',
        summary: 'Five demo lectures: testable questions, variables and controls, randomisation and replication, records and reproducibility, from results to conclusions.',
        category: 'Methods'
      }
    }
  },
  {
    id: 'WRT',
    dir: 'wrt',
    title: '技术写作',
    tagline: '先说结论，再给依据',
    summary: '四讲示例课程：先写结论、段落与结构、图表的说明文字、审稿与修改。',
    accent: '#475569',
    tags: [
      '示例',
      '写作'
    ],
    category: '方法',
    i18n: {
      en: {
        title: 'Technical Writing',
        tagline: 'Lead with the conclusion, then the evidence',
        summary: 'Four demo lectures: leading with the conclusion, paragraphs and structure, captions for charts and figures, reviewing and revising.',
        category: 'Methods'
      }
    }
  }
]
