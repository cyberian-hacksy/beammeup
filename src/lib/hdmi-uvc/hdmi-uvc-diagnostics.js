// HDMI-UVC diagnostic settings. Single source of truth for hidden runtime
// switches and locked sender defaults.
//
// Precedence: URL params (highest, for shareable one-off links) →
// localStorage (persistent user choice) → module default. Setters write
// both localStorage and the URL (via history.replaceState) so a copy of
// the current URL reproduces the config. Sender experiment settings allow only
// the live baseline, so stale URL/localStorage values are ignored.
//
//   captureMethod   'auto'|'main'|'worker'|'offscreen'   reload  (?capture=)
//   wasmClassifier  'on'|'off'                           live    (?wasm-classifier=)
//   perf            'on'|'off'                           reload  (?perf=)
//   worker          'off'|'hash'|'anchors'|'full'        reload  (?worker=)
// Sender experiment settings are intentionally locked to the current live
// baseline. Older tests can still exercise explicit helper arguments.
//
// "Live" settings are re-read by the consumer per call; "reload" settings
// are captured at module init time.

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
    allowed: ['p2'],
    reloadRequired: false,
    labels: { p2: 'p2 (4S/2P)' },
    title: 'Pass-2'
  },
  denseBinaryProfile: {
    urlKey: 'dense-profile',
    default: 'xlarge',
    allowed: ['xlarge'],
    reloadRequired: false,
    labels: {
      xlarge: 'xlarge'
    },
    title: 'Dense Batch'
  },
  denseBinaryLateMix: {
    urlKey: 'dense-late',
    default: 'fountain',
    allowed: ['fountain'],
    reloadRequired: false,
    labels: {
      fountain: 'fountain'
    },
    title: 'Dense Tail'
  },
  denseBinaryPass3Mix: {
    urlKey: 'dense-pass3',
    default: 'balanced',
    allowed: ['balanced'],
    reloadRequired: false,
    labels: {
      balanced: 'balanced'
    },
    title: 'Dense P3'
  },
  denseBinaryPass2SweepMix: {
    urlKey: 'dense-pass2',
    default: 'source7',
    allowed: ['source7'],
    reloadRequired: false,
    labels: {
      source7: '7S/1P'
    },
    title: 'Dense P2'
  },
  denseBinaryDegree: {
    urlKey: 'dense-degree',
    default: 'classic',
    allowed: ['classic'],
    reloadRequired: true,
    labels: { classic: 'classic' },
    title: 'Dense Degree'
  },
  txPace: {
    urlKey: 'tx-pace',
    default: 'timer',
    allowed: ['timer'],
    reloadRequired: false,
    labels: { timer: 'timer' },
    title: 'TX Pace'
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
export function getDenseBinaryProfile() { return getDiagnostic('denseBinaryProfile') }
export function getDenseBinaryLateMix() { return getDiagnostic('denseBinaryLateMix') }
export function getDenseBinaryPass3Mix() { return getDiagnostic('denseBinaryPass3Mix') }
export function getDenseBinaryPass2SweepMix() { return getDiagnostic('denseBinaryPass2SweepMix') }
// Fountain degree distribution. Read by BOTH encoder (sender) and decoder
// (receiver), locked to the shared classic baseline.
export function getDenseBinaryDegree() { return getDiagnostic('denseBinaryDegree') }
export function getTxPace() { return getDiagnostic('txPace') }
