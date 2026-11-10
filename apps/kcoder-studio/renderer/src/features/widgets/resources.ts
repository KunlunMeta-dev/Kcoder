import chartLicense from './resources/chart_js.LICENSE?no-inline&url'
import colorLicense from './resources/kurkle_color.LICENSE?no-inline&url'
import d3License from './resources/d3.LICENSE?no-inline&url'
import topojsonLicense from './resources/topojson.LICENSE?no-inline&url'
import atlasLicense from './resources/world_atlas.LICENSE?no-inline&url'
import naturalEarthNotice from './resources/NaturalEarth.NOTICE?no-inline&url'
import hashLicense from './resources/noble_hashes.LICENSE?no-inline&url'

/** Lazy raw assets execute exclusively inside the CSP-bound opaque document. */
export async function loadWidgetResources(libraries: readonly string[]) {
  if (libraries.some(id => !['chart_js', 'd3', 'topojson'].includes(id))) {
    throw new Error('resource_blocked: unsupported widget library')
  }
  const sources: Record<string, string> = {}
  const licenses: { title: string; url: string }[] = [{ title: 'noble-hashes 2.0.1', url: hashLicense }]
  let topology: unknown
  await Promise.all(libraries.map(async id => {
    if (id === 'chart_js') {
      sources.chartjs = (await import('./resources/chartjs.js?raw')).default
      licenses.push({ title: 'Chart.js 4.5.1', url: chartLicense }, { title: '@kurkle/color 0.3.4', url: colorLicense })
    }
    if (id === 'd3') { sources.d3 = (await import('./resources/d3.js?raw')).default; licenses.push({ title: 'D3 7.9.0', url: d3License }) }
    if (id === 'topojson') {
      sources.topojson = (await import('./resources/topojson.js?raw')).default
      topology = (await import('./resources/countries-110m.json')).default
      licenses.push({ title: 'TopoJSON 3.1.0', url: topojsonLicense }, { title: 'world-atlas 2.0.2', url: atlasLicense }, { title: 'Natural Earth', url: naturalEarthNotice })
    }
  }))
  return { librarySources: sources, topology, licenses }
}
