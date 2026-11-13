// Writes icons.js from the icons of lucide-static that are named below.
//
//   npm pack lucide-static@1.72.0 && tar xzf lucide-static-1.72.0.tgz
//   node build-icons.mjs package
//
// Not a bundled library itself: it stays out of what apps get.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const NAMES = `
plus minus x check chevron-left chevron-right chevron-up chevron-down arrow-left arrow-right arrow-up arrow-down
menu search settings sliders-horizontal ellipsis external-link link house info circle-question-mark
circle-exclamation-point triangle-exclamation-point circle-check circle-x bell eye eye-off lock share-2 funnel list
layout-grid refresh-cw rotate-ccw undo-2 redo-2 maximize minimize pencil trash copy clipboard download upload save
send printer qr-code wifi play pause square skip-forward skip-back volume-2 volume-x eighth-notes gamepad-2 dice-5
trophy crown flag target zap flame timer alarm-clock hourglass keyboard clock clock-arrow-left calendar calendar-days
user users heart star thumbs-up thumbs-down message-circle message-square face-slightly-smiling face-slightly-frowning
shopping-cart shopping-bag wallet banknote coins piggy-bank receipt tag percent calculator chart-column chart-line
chart-pie trending-up trending-down euro dollar-sign map-pin map compass navigation globe plane car bike bus
train-front footprints book-open bookmark file-text folder image camera lightbulb key gift coffee utensils apple
dumbbell bed briefcase graduation-cap palette paintbrush ruler scale thermometer droplet droplets leaf tree-pine
mountain paw-print sun moon sun-moon cloud cloudy cloud-sun cloud-moon cloud-rain cloud-drizzle cloud-snow
cloud-lightning cloud-fog cloud-hail snowflake wind umbrella sunrise sunset sparkles shield-check circle triangle
hash languages
`
  .split(/\s+/)
  .filter(Boolean)

const from = process.argv[2]
if (!from) throw new Error('usage: node build-icons.mjs <folder of the unpacked lucide-static package>')
const all = JSON.parse(readFileSync(join(from, 'icon-nodes.json'), 'utf8'))
const { version } = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'))
const missing = NAMES.filter((name) => !all[name])
if (missing.length) throw new Error(`lucide-static ${version} has no icon named: ${missing.join(', ')}`)
const icons = Object.fromEntries(NAMES.toSorted().map((name) => [name, all[name]]))
const licence = readFileSync(join(from, 'LICENSE'), 'utf8').trim()

writeFileSync(
  new URL('./icons.js', import.meta.url),
  `/*
 * icons.js: line icons for an app made with App Generator.
 *
 *   button.append(icons.svg('trash'))
 *   title.prepend(icons.svg('cloud-rain', { size: 32, label: 'Rain' }))
 *
 * icons.svg(name, options) returns an <svg> element drawn in the colour of the
 * text around it. Options: size in pixels (24), strokeWidth (2), label (a name
 * for screen readers; without one the icon is hidden from them). icons.names
 * lists every name. An unknown name gives an empty circle and an error in the
 * console.
 *
 * The ${NAMES.length} icons are from lucide-static ${version}, written out by build-icons.mjs:
 *
${licence
  .split('\n')
  .map((text) => ` * ${text}`.trimEnd())
  .join('\n')}
 */
;(function () {
  'use strict'

  var ICONS = ${JSON.stringify(icons)}
  var NS = 'http://www.w3.org/2000/svg'

  function svg(name, options) {
    var nodes = Object.prototype.hasOwnProperty.call(ICONS, name) ? ICONS[name] : null
    if (!nodes) {
      console.error('icons.js has no icon named "' + String(name).slice(0, 40) + '". The names are in icons.names.')
      nodes = [['circle', { cx: '12', cy: '12', r: '9' }]]
    }
    var size = (options && Number(options.size)) || 24
    var element = document.createElementNS(NS, 'svg')
    var attributes = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': (options && Number(options.strokeWidth)) || 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }
    Object.keys(attributes).forEach(function (key) {
      element.setAttribute(key, attributes[key])
    })
    if (options && options.label) {
      element.setAttribute('role', 'img')
      element.setAttribute('aria-label', String(options.label))
    } else element.setAttribute('aria-hidden', 'true')
    nodes.forEach(function (node) {
      var child = document.createElementNS(NS, node[0])
      Object.keys(node[1]).forEach(function (key) {
        child.setAttribute(key, node[1][key])
      })
      element.appendChild(child)
    })
    return element
  }

  window.icons = { svg: svg, names: Object.keys(ICONS) }
})()
`,
)
console.log(`icons.js: ${NAMES.length} icons from lucide-static ${version}`)
