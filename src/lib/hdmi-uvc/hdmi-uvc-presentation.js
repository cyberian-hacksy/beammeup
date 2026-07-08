// Presentation-side helpers for the HDMI-UVC sender: external-screen
// selection, popup window features, presentation-document scaffolding,
// fullscreen options/requests, and viewport geometry math. Everything here
// operates on explicit parameters (screens, targets, metrics) — the sender
// keeps the state-bound orchestration (which screen is active, retries,
// canvas application).

import { debugLog } from './hdmi-uvc-sender-debug.js'
import {
  hasEffectiveOneToOnePresentation,
  isNative1080pGeometry
} from './hdmi-uvc-frame.js'

function screenDimension(screen, primary, fallback = 0) {
  const value = screen?.[primary]
  if (Number.isFinite(value)) return Math.round(value)
  const fallbackValue = screen?.[fallback]
  return Number.isFinite(fallbackValue) ? Math.round(fallbackValue) : 0
}

export function screenLeft(screen) {
  return screenDimension(screen, 'availLeft', 'left')
}

export function screenTop(screen) {
  return screenDimension(screen, 'availTop', 'top')
}

export function screenWidth(screen) {
  return screenDimension(screen, 'availWidth', 'width')
}

export function screenHeight(screen) {
  return screenDimension(screen, 'availHeight', 'height')
}

function screenHasUsableBounds(screen) {
  return screenWidth(screen) > 0 && screenHeight(screen) > 0
}

function screenArea(screen) {
  return screenWidth(screen) * screenHeight(screen)
}

function sameScreen(a, b) {
  if (!a || !b) return false
  return screenLeft(a) === screenLeft(b) &&
    screenTop(a) === screenTop(b) &&
    screenWidth(a) === screenWidth(b) &&
    screenHeight(a) === screenHeight(b)
}

export function chooseExternalPresentationScreen(screens, currentScreen = null) {
  const candidates = Array.from(screens || []).filter((screen) =>
    screen && !sameScreen(screen, currentScreen)
  )
  if (candidates.length === 0) return null

  const ranked = candidates.slice().sort((a, b) => {
    const aUsable = screenHasUsableBounds(a) ? 1 : 0
    const bUsable = screenHasUsableBounds(b) ? 1 : 0
    if (aUsable !== bUsable) return bUsable - aUsable

    const aExact1080 = screenWidth(a) === 1920 && screenHeight(a) === 1080 ? 1 : 0
    const bExact1080 = screenWidth(b) === 1920 && screenHeight(b) === 1080 ? 1 : 0
    if (aExact1080 !== bExact1080) return bExact1080 - aExact1080

    const aPrimary = a.isPrimary ? 1 : 0
    const bPrimary = b.isPrimary ? 1 : 0
    if (aPrimary !== bPrimary) return aPrimary - bPrimary

    return screenArea(b) - screenArea(a)
  })

  return ranked[0]
}

function rawScreenDimension(screen, key) {
  const value = screen?.[key]
  return Number.isFinite(value) ? Math.round(value) : 'n/a'
}

export function describeScreen(screen) {
  if (!screen) return 'none'
  const label = typeof screen.label === 'string' && screen.label
    ? ` label="${screen.label}"`
    : ''
  const dpr = Number.isFinite(screen.devicePixelRatio)
    ? ` dpr=${Number(screen.devicePixelRatio).toFixed(3)}`
    : ''
  return (
    `${screenWidth(screen)}x${screenHeight(screen)}@(${screenLeft(screen)},${screenTop(screen)}) ` +
    `raw=avail(${rawScreenDimension(screen, 'availWidth')}x${rawScreenDimension(screen, 'availHeight')}@` +
    `${rawScreenDimension(screen, 'availLeft')},${rawScreenDimension(screen, 'availTop')}) ` +
    `screen(${rawScreenDimension(screen, 'width')}x${rawScreenDimension(screen, 'height')}@` +
    `${rawScreenDimension(screen, 'left')},${rawScreenDimension(screen, 'top')}) ` +
    `primary=${screen.isPrimary === true} internal=${screen.isInternal === true}${dpr}${label}`
  )
}

export function describeScreenList(screens) {
  return Array.from(screens || [])
    .map((screen, index) => `${index}:${describeScreen(screen)}`)
    .join('; ')
}

export function buildPresentationWindowFeatures(screen) {
  const left = screenLeft(screen)
  const top = screenTop(screen)
  const width = screenWidth(screen) || 1920
  const height = screenHeight(screen) || 1080
  return [
    'popup=yes',
    'toolbar=no',
    'location=no',
    'menubar=no',
    'status=no',
    'scrollbars=no',
    'resizable=no',
    `left=${left}`,
    `top=${top}`,
    `width=${width}`,
    `height=${height}`
  ].join(',')
}

export function getExternalDisplayReadiness(useExternalDisplay, hasScreenDetails = true) {
  if (!useExternalDisplay) return null
  if (!hasScreenDetails) {
    return 'External display requires Chrome/Edge with Window Management API support. Uncheck External screen to use this window.'
  }
  return null
}

export function buildPresentationFullscreenOptions(target) {
  const options = { navigationUI: 'hide' }
  if (target?.external && target.screen) {
    options.screen = target.screen
  }
  return options
}

export function writeExternalPresentationDocument(popup, screen) {
  const doc = popup.document
  doc.open()
  doc.write(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Beam Me Up HDMI-UVC Display</title>
  <style>
    html, body {
      margin: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #000;
    }
    #presentation-container {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100vh;
      background: #000;
      overflow: hidden;
      cursor: none;
    }
    #presentation-canvas {
      display: block;
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      image-rendering: pixelated;
      background: #000;
    }
    #presentation-overlay {
      position: absolute;
      top: 8px;
      left: 8px;
      color: #00d4ff;
      background: rgba(0, 0, 0, 0.7);
      font: 12px monospace;
      padding: 4px 8px;
      border-radius: 4px;
    }
  </style>
</head>
<body>
  <div id="presentation-container">
    <canvas id="presentation-canvas"></canvas>
    <div id="presentation-overlay"><span id="presentation-frame-count">0</span> <span id="presentation-progress">0%</span></div>
  </div>
</body>
</html>`)
  doc.close()

  return {
    external: true,
    screen,
    win: popup,
    doc,
    container: doc.getElementById('presentation-container'),
    canvas: doc.getElementById('presentation-canvas'),
    frameCount: doc.getElementById('presentation-frame-count'),
    progressDisplay: doc.getElementById('presentation-progress')
  }
}

export async function requestPresentationFullscreen(target) {
  const container = target.container
  if (!container?.requestFullscreen) {
    if (target.external) {
      throw new Error('External fullscreen is unavailable in this browser window. Transfer was not started on the main screen.')
    }
    debugLog('Fullscreen unavailable: falling back to window bounds')
    return
  }

  try {
    await container.requestFullscreen(buildPresentationFullscreenOptions(target))
    debugLog(target.external ? 'External fullscreen: OK (selected screen)' : 'Fullscreen: OK')
  } catch (e) {
    if (target.external) {
      throw new Error(
        `External fullscreen failed on selected screen (${describeScreen(target.screen)}): ${e.message}. ` +
        'Transfer was not started on the main screen.'
      )
    }
    try {
      await container.requestFullscreen()
      debugLog(target.external ? 'External fullscreen: OK (default navigation UI)' : 'Fullscreen: OK (default navigation UI)')
    } catch (fallbackErr) {
      debugLog(`Fullscreen failed: ${fallbackErr.message}, falling back to fixed window`)
    }
  }
}

export function waitForLayoutFrames(count = 2, targetWindow = window) {
  const raf = targetWindow?.requestAnimationFrame?.bind(targetWindow) || requestAnimationFrame
  return new Promise((resolve) => {
    const step = () => {
      if (count <= 0) {
        resolve()
        return
      }
      count--
      raf(step)
    }
    raf(step)
  })
}

export function viewportMetricsEqual(a, b, tolerance = 1) {
  if (!a || !b) return false
  return (
    Math.abs(a.width - b.width) <= tolerance &&
    Math.abs(a.height - b.height) <= tolerance &&
    Math.abs(a.rectWidth - b.rectWidth) <= tolerance &&
    Math.abs(a.rectHeight - b.rectHeight) <= tolerance
  )
}

export function fitRectWithin(boundsWidth, boundsHeight, contentWidth, contentHeight) {
  if (!boundsWidth || !boundsHeight || !contentWidth || !contentHeight) {
    return {
      width: Math.max(1, contentWidth || boundsWidth || 1),
      height: Math.max(1, contentHeight || boundsHeight || 1),
      x: 0,
      y: 0,
      scale: 1
    }
  }

  const scale = Math.min(boundsWidth / contentWidth, boundsHeight / contentHeight)
  const width = Math.max(1, Math.round(contentWidth * scale))
  const height = Math.max(1, Math.round(contentHeight * scale))

  return {
    width,
    height,
    x: Math.max(0, Math.floor((boundsWidth - width) / 2)),
    y: Math.max(0, Math.floor((boundsHeight - height) / 2)),
    scale
  }
}

// Every live call site passes the active presentation target explicitly; the
// null default keeps the "no target" behavior (leave metrics untouched).
export function normalizeExternalPresentationMetrics(metrics, target = null) {
  if (!target?.external || metrics?.renderPresetId !== '1080p') return metrics
  if (metrics.width !== 1920 || metrics.height !== 1080) return metrics

  metrics.displayWidth = metrics.width
  metrics.displayHeight = metrics.height
  metrics.displayX = 0
  metrics.displayY = 0
  metrics.displayScale = 1
  metrics.physicalDisplayWidth = metrics.width
  metrics.physicalDisplayHeight = metrics.height
  metrics.effectiveDisplayScale = 1
  metrics.externalNativePresentation = true
  return metrics
}

export function testPresentationScreenSelection() {
  const current = { availLeft: 0, availTop: 0, availWidth: 1728, availHeight: 1084, isPrimary: true }
  const ugreen = { availLeft: 1728, availTop: 0, availWidth: 1920, availHeight: 1080, isPrimary: false }
  const largerPrimary = { availLeft: -2560, availTop: 0, availWidth: 2560, availHeight: 1440, isPrimary: true }
  const zeroSized = { availLeft: 0, availTop: 0, availWidth: 0, availHeight: 0, isPrimary: false }

  const selected = chooseExternalPresentationScreen([current, largerPrimary, zeroSized, ugreen], current)
  const none = chooseExternalPresentationScreen([current], current)
  const onlyZeroSized = chooseExternalPresentationScreen([current, zeroSized], current)
  const pass = selected === ugreen && none === null && onlyZeroSized === zeroSized
  console.log('Presentation screen selection test:', pass ? 'PASS' : 'FAIL', {
    selected: selected ? `${screenWidth(selected)}x${screenHeight(selected)}@(${screenLeft(selected)},${screenTop(selected)})` : null,
    onlyZeroSized: onlyZeroSized ? `${screenWidth(onlyZeroSized)}x${screenHeight(onlyZeroSized)}@(${screenLeft(onlyZeroSized)},${screenTop(onlyZeroSized)})` : null
  })
  return pass
}

export function testPresentationWindowFeatures() {
  const features = buildPresentationWindowFeatures({
    availLeft: -1920,
    availTop: 0,
    availWidth: 1920,
    availHeight: 1080
  })
  const required = [
    'popup=yes',
    'left=-1920',
    'top=0',
    'width=1920',
    'height=1080',
    'resizable=no'
  ]
  const missing = required.filter((token) => !features.includes(token))
  const pass = missing.length === 0
  console.log('Presentation window features test:', pass ? 'PASS' : `FAIL missing ${missing.join(', ')}`)
  return pass
}

export function testExternalDisplayReadiness() {
  const currentWindow = getExternalDisplayReadiness(false, false)
  const noApi = getExternalDisplayReadiness(true, false)
  const ready = getExternalDisplayReadiness(true, true)
  const pass = currentWindow === null &&
    noApi?.includes('Chrome/Edge') &&
    ready === null
  console.log('External display readiness test:', pass ? 'PASS' : 'FAIL', {
    currentWindow, noApi, ready
  })
  return pass
}

export function testExternalPresentationNativeMetrics() {
  const cssScaledMetrics = {
    renderPresetId: '1080p',
    renderPresetName: '1080p',
    width: 1920,
    height: 1080,
    displayWidth: 1652,
    displayHeight: 929,
    displayScale: 0.86,
    devicePixelRatio: 2,
    physicalDisplayWidth: 3304,
    physicalDisplayHeight: 1858,
    effectiveDisplayScale: 1.72,
    displayX: 0,
    displayY: 11,
    fullscreenActive: true
  }
  const normalized = normalizeExternalPresentationMetrics(cssScaledMetrics, { external: true })
  const pass = normalized === cssScaledMetrics &&
    normalized.displayWidth === 1920 &&
    normalized.displayHeight === 1080 &&
    normalized.displayScale === 1 &&
    normalized.displayX === 0 &&
    normalized.displayY === 0 &&
    normalized.physicalDisplayWidth === 1920 &&
    normalized.physicalDisplayHeight === 1080 &&
    normalized.effectiveDisplayScale === 1 &&
    normalized.externalNativePresentation === true &&
    hasEffectiveOneToOnePresentation(normalized) &&
    isNative1080pGeometry(normalized)
  console.log('External presentation native metrics test:', pass ? 'PASS' : 'FAIL', normalized)
  return pass
}

export function testExternalFullscreenUsesSelectedScreen() {
  const screen = { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080 }
  const externalOptions = buildPresentationFullscreenOptions({ external: true, screen })
  const localOptions = buildPresentationFullscreenOptions({ external: false })
  const pass = externalOptions.navigationUI === 'hide' &&
    externalOptions.screen === screen &&
    localOptions.navigationUI === 'hide' &&
    !('screen' in localOptions)
  console.log('External fullscreen screen option test:', pass ? 'PASS' : 'FAIL', {
    externalOptions,
    localOptions
  })
  return pass
}

export async function testExternalFullscreenFailureStopsBeforeMainFallback() {
  let calls = 0
  const target = {
    external: true,
    screen: { availLeft: 1920, availTop: 0, availWidth: 1920, availHeight: 1080 },
    container: {
      requestFullscreen: async () => {
        calls++
        throw new Error('Permissions check failed')
      }
    }
  }

  let message = ''
  try {
    await requestPresentationFullscreen(target)
  } catch (err) {
    message = err.message
  }

  const pass = calls === 1 && message.includes('External fullscreen failed') && message.includes('Permissions check failed')
  console.log('External fullscreen failure stop test:', pass ? 'PASS' : 'FAIL', { calls, message })
  return pass
}
