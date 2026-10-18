import source from '../../vendor/chartjs/4.5.1/chart.umd.min.js.txt'
import chartLicense from '../../vendor/chartjs/4.5.1/LICENSE.Chart.js.txt'
import colorLicense from '../../vendor/chartjs/4.5.1/LICENSE.kurkle-color.txt'
import leaflet from '../../vendor/leaflet/1.9.4/leaflet.js.txt'
import leafletCss from '../../vendor/leaflet/1.9.4/leaflet.css.txt'
import leafletLicense from '../../vendor/leaflet/1.9.4/LICENSE.txt'
import { CHART_LIBRARY, MAP_LIBRARY } from '../shared/libraries.ts'
import type { UiDocument } from '../shared/document.ts'

/** Bundled as inert text in the parent; executed only inside a successful chart document's frame. */
export function libraryPayload(document: UiDocument) {
  const libraries = document.libraries ?? []
  return { libraries, librarySource: (libraries.includes(CHART_LIBRARY) ? source : '') + '\n' + (libraries.includes(MAP_LIBRARY) ? leaflet : ''),
    libraryCss: libraries.includes(MAP_LIBRARY) ? leafletCss.replace(/url\([^)]*\)/g, 'none') : '' }
}
export const CHART_NOTICES = `Chart.js 4.5.1\n${chartLicense}\nBundled @kurkle/color 0.3.2\n${colorLicense}\nLeaflet 1.9.4\n${leafletLicense}`
