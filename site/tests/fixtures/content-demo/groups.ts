export const SITE_META = {
  name: 'Fixture Content Demo',
  shortName: 'Demo',
  text: 'Fixture Content Demo',
  tagline: 'Fixture content repository for S1 content loading verification',
  i18n: {
    en: {
      name: 'Fixture Content Demo',
      shortName: 'Demo',
      text: 'Fixture Content Demo',
      tagline: 'Fixture content repository for S1 content loading verification',
    },
  },
}

export const GROUPS = [
  {
    id: 'D01',
    dir: 'demo-alpha',
    title: 'Demo Alpha Signals',
    tagline: 'Fixture group alpha with an ECharts diagram and an SVG figure',
    summary: 'Two fixture lectures verifying separated content syncing and VitePress rendering.',
    accent: '#2563EB',
    tags: ['fixture', 'alpha'],
    category: 'Fixture Core',
    i18n: {
      en: {
        title: 'Demo Alpha Signals',
        tagline: 'Fixture group alpha with an ECharts diagram and an SVG figure',
        summary: 'Two fixture lectures verifying separated content syncing and VitePress rendering.',
      },
    },
  },
  {
    id: 'D02',
    dir: 'demo-beta',
    title: 'Demo Beta Systems',
    tagline: 'Fixture group beta for multi-group routing and build checks',
    summary: 'One fixture lecture verifying second group routes and English fallback pages.',
    accent: '#059669',
    tags: ['fixture', 'beta'],
    category: 'Fixture Systems',
    i18n: {
      en: {
        title: 'Demo Beta Systems',
        tagline: 'Fixture group beta for multi-group routing and build checks',
        summary: 'One fixture lecture verifying second group routes and English fallback pages.',
      },
    },
  },
]

export const GROUP_META = GROUPS
