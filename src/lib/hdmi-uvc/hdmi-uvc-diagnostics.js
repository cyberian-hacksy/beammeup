// HDMI-UVC diagnostic settings. Single source of truth for the runtime
// A/B toggles exposed on the sender/receiver screens.
//
// Precedence: URL params (highest, for shareable one-off links) →
// localStorage (persistent user choice) → module default. Setters write
// both localStorage and the URL (via history.replaceState) so a copy of
// the current URL reproduces the config.
//
//   captureMethod   'auto'|'main'|'worker'|'offscreen'   reload  (?capture=)
//   wasmClassifier  'on'|'off'                           live    (?wasm-classifier=)
//   perf            'on'|'off'                           reload  (?perf=)
//   worker          'off'|'hash'|'anchors'|'full'        reload  (?worker=)
//   pass2           'p2'|'legacy'|'mix'                  live    (?pass2=)
//   binary3Profile  'safe'|'fill99'|'medium'|'large'     live    (?binary3-profile=)
//
// "Live" settings are re-read by the consumer per call; "reload" settings
// are captured at module init time and the UI surfaces a Reload prompt
// when the user changes one so the session picks it up cleanly.

const STORAGE_PREFIX = 'hdmi-uvc-diag-'

const DEFINITIONS = {
  captureMethod: {
    urlKey: 'capture',
    default: 'auto',
    allowed: ['auto', 'main', 'worker', 'offscreen'],
    reloadRequired: true,
    labels: { auto: 'Auto', main: 'Main', worker: 'Worker', offscreen: 'Offscreen' },
    title: 'Capture'
  },
  wasmClassifier: {
    urlKey: 'wasm-classifier',
    default: 'on',
    allowed: ['on', 'off'],
    reloadRequired: false,
    labels: { on: 'On', off: 'Off' },
    title: 'WASM Cls'
  },
  perf: {
    urlKey: 'perf',
    default: 'off',
    allowed: ['on', 'off'],
    reloadRequired: true,
    labels: { on: 'On', off: 'Off' },
    title: 'Perf',
    parseUrl: (raw, hasKey) => {
      if (!hasKey) return null
      if (raw === '' || raw === null || raw === '1' || raw === 'on' || raw === 'true') return 'on'
      if (raw === '0' || raw === 'off' || raw === 'false') return 'off'
      return 'on'
    }
  },
  worker: {
    urlKey: 'worker',
    default: 'off',
    allowed: ['off', 'hash', 'anchors', 'full'],
    reloadRequired: true,
    labels: { off: 'Off', hash: 'Hash', anchors: 'Anchors', full: 'Full' },
    title: 'Worker',
    parseUrl: (raw, hasKey) => {
      if (!hasKey) return null
      const r = (raw || '').toLowerCase()
      if (r === '' || r === '1' || r === 'hash' || r === 'true') return 'hash'
      if (r === 'anchors') return 'anchors'
      if (r === 'full') return 'full'
      if (r === 'off' || r === '0' || r === 'false') return 'off'
      return 'hash'
    }
  },
  pass2: {
    urlKey: 'pass2',
    default: 'p2',
    allowed: ['p2', 'legacy', 'mix'],
    reloadRequired: false,
    labels: { p2: 'p2 (4S/2P)', legacy: 'legacy (5S/1P)', mix: 'mix (2S/2P/2F)' },
    title: 'Pass-2'
  },
  binary3Profile: {
    urlKey: 'binary3-profile',
    default: 'safe',
    allowed: ['safe', 'fill99', 'medium', 'large'],
    reloadRequired: false,
    labels: {
      safe: 'safe',
      fill99: 'fill99',
      medium: 'medium',
      large: 'large'
    },
    title: 'B3 Batch'
  }
}

function readUrlParam(urlKey, parser) {
  if (typeof location === 'undefined') return null
  let params
  try { params = new URLSearchParams(location.search) } catch (_) { return null }
  const hasKey = params.has(urlKey)
  if (parser) return parser(params.get(urlKey), hasKey)
  if (!hasKey) return null
  return params.get(urlKey)
}

function readStorage(key) {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage.getItem(STORAGE_PREFIX + key)
  } catch (_) { return null }
}

function writeStorage(key, value) {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(STORAGE_PREFIX + key, value)
  } catch (_) { /* storage disabled or full; ignore */ }
}

function updateUrl(urlKey, value, isDefault) {
  if (typeof location === 'undefined' || typeof history === 'undefined') return
  try {
    const url = new URL(location.href)
    if (isDefault) url.searchParams.delete(urlKey)
    else url.searchParams.set(urlKey, value)
    history.replaceState({}, '', url.toString())
  } catch (_) { /* cross-origin or history unavailable; ignore */ }
}

function resolveInitial(key) {
  const def = DEFINITIONS[key]
  if (!def) return null
  const fromUrl = readUrlParam(def.urlKey, def.parseUrl)
  if (fromUrl !== null && def.allowed.includes(fromUrl)) return fromUrl
  const fromStorage = readStorage(key)
  if (fromStorage !== null && def.allowed.includes(fromStorage)) return fromStorage
  return def.default
}

const state = {}
const frozenAtInit = {}
for (const key of Object.keys(DEFINITIONS)) {
  state[key] = resolveInitial(key)
  frozenAtInit[key] = state[key]
}

const listeners = new Set()

export function getDiagnostic(key) {
  return state[key] ?? DEFINITIONS[key]?.default ?? null
}

export function getDiagnosticAtInit(key) {
  return frozenAtInit[key] ?? null
}

export function setDiagnostic(key, value) {
  const def = DEFINITIONS[key]
  if (!def) return false
  if (!def.allowed.includes(value)) return false
  if (state[key] === value) return false
  state[key] = value
  writeStorage(key, value)
  updateUrl(def.urlKey, value, value === def.default)
  for (const fn of listeners) {
    try { fn(key, value) } catch (_) { /* ignore */ }
  }
  return true
}

export function onDiagnosticChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function getDiagnosticDefinition(key) {
  return DEFINITIONS[key] ?? null
}

export function listDiagnosticKeys() {
  return Object.keys(DEFINITIONS)
}

// Convenience accessors used by hot-path modules. Keep them one-liners so
// the call sites stay terse.
export function getCaptureMethod() { return getDiagnostic('captureMethod') }
export function getWasmClassifierEnabled() { return getDiagnostic('wasmClassifier') !== 'off' }
export function isPerfMode() { return getDiagnostic('perf') === 'on' }
export function getWorkerMode() { return getDiagnostic('worker') }
export function getPass2Variant() { return getDiagnostic('pass2') }
export function getBinary3Profile() { return getDiagnostic('binary3Profile') }

// Render a segmented-button diagnostics panel into `container`. `keys` is
// the ordered list of setting keys to show — sender uses just ['pass2'],
// receiver uses the full set minus 'pass2'. The panel re-renders itself
// on state change, and surfaces a Reload button when any reload-required
// setting differs from the value captured at module init time.
export function renderDiagnosticsPanel(container, keys, options = {}) {
  if (!container) return
  if (typeof document === 'undefined') return

  const title = options.title || 'Diagnostics'

  const refresh = () => {
    container.textContent = ''

    const heading = document.createElement('div')
    heading.className = 'hdmi-diagnostics-title'
    heading.textContent = title
    container.appendChild(heading)

    let anyDirty = false
    for (const key of keys) {
      const def = DEFINITIONS[key]
      if (!def) continue

      const row = document.createElement('div')
      row.className = 'hdmi-diagnostics-row'

      const label = document.createElement('div')
      label.className = 'hdmi-diagnostics-label'
      label.textContent = def.title
      row.appendChild(label)

      const buttons = document.createElement('div')
      buttons.className = 'hdmi-diagnostics-buttons'

      const current = state[key]
      for (const value of def.allowed) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.textContent = def.labels?.[value] ?? value
        if (value === current) btn.classList.add('active')
        btn.addEventListener('click', () => {
          if (setDiagnostic(key, value)) refresh()
        })
        buttons.appendChild(btn)
      }
      row.appendChild(buttons)

      if (def.reloadRequired && current !== frozenAtInit[key]) {
        anyDirty = true
        const hint = document.createElement('span')
        hint.className = 'hdmi-diagnostics-hint'
        hint.textContent = '(reload)'
        row.appendChild(hint)
      }

      container.appendChild(row)
    }

    if (anyDirty) {
      const reload = document.createElement('button')
      reload.type = 'button'
      reload.className = 'hdmi-diagnostics-badge'
      reload.textContent = 'Reload to apply'
      reload.addEventListener('click', () => {
        if (typeof location !== 'undefined') location.reload()
      })
      container.appendChild(reload)
    }
  }

  refresh()
  return refresh
}
