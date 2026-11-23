/**
 * renderers/echartsDeps.ts — static named ECharts modular bundle loaded asynchronously via `import('./echartsDeps')`.
 * Named imports let Rollup tree-shake away unused series & components (`FE-041`).
 */
import { getInstanceByDom, init, registerTheme, use } from 'echarts/core'
import { BarChart, HeatmapChart, LineChart, PieChart, RadarChart } from 'echarts/charts'
import {
  GridComponent,
  LegendComponent,
  MarkAreaComponent,
  MarkLineComponent,
  MarkPointComponent,
  RadarComponent,
  TitleComponent,
  ToolboxComponent,
  TooltipComponent,
  VisualMapComponent,
} from 'echarts/components'
import { CanvasRenderer, SVGRenderer } from 'echarts/renderers'

use([
  LineChart,
  BarChart,
  RadarChart,
  HeatmapChart,
  PieChart,
  TitleComponent,
  TooltipComponent,
  LegendComponent,
  GridComponent,
  VisualMapComponent,
  ToolboxComponent,
  RadarComponent,
  MarkLineComponent,
  MarkPointComponent,
  MarkAreaComponent,
  SVGRenderer,
  CanvasRenderer,
])

export { getInstanceByDom, init, registerTheme }
