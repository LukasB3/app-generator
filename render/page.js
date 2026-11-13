// Runs inside the page under test before any of its own scripts. It measures
// and reports; what counts as a problem is decided outside the container. The
// page could tamper with it, which costs nothing: the check is a quality step
// and no rule depends on it.
;(() => {
  const BADGE = 'AI-generated demo from App Generator'
  const ODD = /\bundefined\b|\bNaN\b|\[object [A-Za-z]+\]/
  const MAX_HITS = 10
  const clip = (text, max) => String(text).replace(/\s+/g, ' ').trim().slice(0, max)

  let lastChange = performance.now()
  new MutationObserver(() => (lastChange = performance.now())).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })

  // Text drawn on a canvas is not in the document, so it is noted on its way there.
  const drawn = new Set()
  for (const method of ['fillText', 'strokeText']) {
    const original = CanvasRenderingContext2D.prototype[method]
    CanvasRenderingContext2D.prototype[method] = function (text, ...rest) {
      if (drawn.size < 300) drawn.add(clip(text, 200))
      return original.call(this, text, ...rest)
    }
  }

  const badge = () => [...document.querySelectorAll('a[rel="noopener"]')].find((link) => link.textContent.startsWith(BADGE))
  const shown = (element) => element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
  const describe = (element) => {
    const safe = (name) => name.replace(/[^a-z0-9_-]/gi, '').slice(0, 24)
    const classes = [...element.classList].slice(0, 2).map((name) => `.${safe(name)}`)
    return `${element.tagName.toLowerCase()}${element.id ? `#${safe(element.id)}` : ''}${classes.join('')}`
  }
  // The odd word together with the up to three words before it.
  const hit = (where, before, text) => {
    const found = ODD.exec(text)
    if (!found) return null
    const lead = clip(`${before} ${text.slice(0, found.index)}`, 400).split(' ').filter(Boolean).slice(-3)
    return { where, token: found[0], snippet: clip([...lead, found[0]].join(' '), 120) }
  }

  const measure = () => {
    const notice = badge()
    const odd = []
    let text = 0
    let before = ''
    if (document.body) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const parent = node.parentElement
        if (!parent || parent.closest('script, style, noscript, template') || (notice && notice.contains(node)) || !shown(parent)) continue
        const value = clip(node.nodeValue, 2000)
        if (!value) continue
        text += value.length
        const found = odd.length < MAX_HITS && hit('text', before, value)
        if (found) odd.push(found)
        before = clip(`${before} ${value}`, 400).slice(-200)
      }
      for (const field of document.querySelectorAll('input, textarea, output')) {
        if (odd.length >= MAX_HITS || !shown(field) || ['hidden', 'password', 'file'].includes(field.type)) continue
        const found = hit('field', '', clip(field.value ?? '', 200))
        if (found) odd.push(found)
      }
    }
    for (const value of drawn) {
      text += value.length
      const found = odd.length < MAX_HITS && hit('canvas', '', value)
      if (found) odd.push(found)
    }

    const root = document.documentElement
    const by = root.scrollWidth - root.clientWidth
    let overflow = null
    if (by > 4 && document.body) {
      const offenders = []
      const clipped = (element) => {
        for (let up = element.parentElement; up && up !== document.body; up = up.parentElement) if (getComputedStyle(up).overflowX !== 'visible') return true
        return false
      }
      for (const element of [...document.body.querySelectorAll('*')].slice(0, 3000)) {
        if (offenders.length >= 3) break
        if (element === notice || offenders.some((seen) => seen.contains(element))) continue
        const box = element.getBoundingClientRect()
        if (box.width > 0 && box.right > root.clientWidth + 4 && !clipped(element)) offenders.push(element)
      }
      overflow = { by: Math.round(by), offenders: offenders.map(describe) }
    }

    const box = notice && notice.getBoundingClientRect()
    return {
      text,
      odd,
      overflow,
      // Without a viewport meta tag a phone lays the page out far wider than its screen.
      noViewport: !document.querySelector('meta[name="viewport"]'),
      badge: box ? { x: Math.floor(box.x), y: Math.floor(box.y), width: Math.ceil(box.width), height: Math.ceil(box.height) } : null,
    }
  }

  Object.defineProperty(window, '__agCheck', { value: { quietFor: () => performance.now() - lastChange, measure } })
})()
