// Debug-log plumbing shared by the HDMI-UVC sender and receiver: bounded
// ring buffer, panel factory (throttled render + debugLog/debugCurrent
// primitives), and the diagnostics-panel visibility toggle.

// Master switch for debug-log collection. Lines always accumulate in the
// ring buffer (cheap); all DOM output is gated separately by the
// user-facing Diagnostics toggle.
const DEBUG_MODE = true

// Mirror debug lines to the browser console only when explicitly flipped on;
// the panel (and Copy Log) is the supported way to read them.
const DEBUG_CONSOLE = false

export function createDebugLogBuffer({ maxLines = 500, visibleLines = 120 } = {}) {
  const lines = []
  let copyTextCache = ''
  let renderTextCache = ''
  let copyDirty = true
  let renderDirty = true

  const normalizeLine = (line) => String(line ?? '')
  const boundedVisibleLines = Math.max(1, visibleLines | 0)
  const boundedMaxLines = Math.max(boundedVisibleLines, maxLines | 0)

  return {
    append(line) {
      lines.push(normalizeLine(line))
      if (lines.length > boundedMaxLines) {
        lines.splice(0, lines.length - boundedMaxLines)
      }
      copyDirty = true
      renderDirty = true
    },

    clear() {
      lines.length = 0
      copyTextCache = ''
      renderTextCache = ''
      copyDirty = false
      renderDirty = false
    },

    get length() {
      return lines.length
    },

    getCopyText() {
      if (copyDirty) {
        copyTextCache = lines.join('\n')
        copyDirty = false
      }
      return copyTextCache
    },

    getRenderText() {
      if (renderDirty) {
        const start = Math.max(0, lines.length - boundedVisibleLines)
        renderTextCache = lines.slice(start).join('\n')
        renderDirty = false
      }
      return renderTextCache
    }
  }
}

// A debug panel: ring buffer plus the throttled DOM rendering around it.
// The sender and receiver each create one with their own element ids and
// cadence; everything else (timestamping, visibility gating, console mirror)
// is identical between the two sides.
export function createDebugLogPanel({
  logElementId,
  currentElementId,
  consoleTag,
  maxLines = 500,
  visibleLines = 120,
  renderIntervalMs = 120
}) {
  const buffer = createDebugLogBuffer({ maxLines, visibleLines })
  let renderTimer = null
  // The diagnostics panel ships hidden; while hidden we keep appending to the
  // buffer (so history is there when it opens) but skip all DOM writes.
  let panelVisible = false

  function render() {
    const el = typeof document !== 'undefined'
      ? document.getElementById(logElementId)
      : null
    if (!el) return
    el.textContent = buffer.getRenderText()
    el.scrollTop = el.scrollHeight
  }

  function scheduleRender() {
    if (!panelVisible || renderTimer !== null) return
    renderTimer = setTimeout(() => {
      renderTimer = null
      if (panelVisible) render()
    }, renderIntervalMs)
  }

  return {
    buffer,
    render,

    flush() {
      if (renderTimer !== null) {
        clearTimeout(renderTimer)
        renderTimer = null
      }
      if (panelVisible) render()
    },

    setVisible(visible) {
      panelVisible = visible
    },

    isVisible() {
      return panelVisible
    },

    debugLog(text) {
      if (!DEBUG_MODE) return
      const timestamp = new Date().toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        fractionalSecondDigits: 3
      })
      buffer.append(timestamp + ' ' + text)
      scheduleRender()
      if (DEBUG_CONSOLE) {
        console.log(consoleTag, text)
      }
    },

    debugCurrent(text) {
      if (!DEBUG_MODE || !panelVisible) return
      const el = document.getElementById(currentElementId)
      if (el) el.textContent = text
    }
  }
}

// Show/hide toggle for a diagnostics panel. Panels ship hidden; the choice is
// persisted per storageKey so people debugging a rig keep the panel open
// across reloads. onChange(visible) fires on init and every toggle so callers
// can pause per-frame DOM writes while the panel is hidden.
export function initDiagnosticsPanelToggle({ button, panel, storageKey, onChange }) {
  if (!button || !panel) return
  let visible = false
  try { visible = localStorage.getItem(storageKey) === '1' } catch (_) { /* storage disabled */ }
  const apply = () => {
    panel.style.display = visible ? '' : 'none'
    button.textContent = visible ? 'Hide diagnostics' : 'Show diagnostics'
    if (onChange) onChange(visible)
  }
  button.onclick = () => {
    visible = !visible
    try { localStorage.setItem(storageKey, visible ? '1' : '0') } catch (_) { /* ignore */ }
    apply()
  }
  apply()
}

export function testDebugLogBufferKeepsCopyFullAndRenderBounded() {
  try {
    const buffer = createDebugLogBuffer({ maxLines: 6, visibleLines: 3 })
    for (let i = 1; i <= 7; i++) buffer.append(`line ${i}`)
    const copyText = buffer.getCopyText()
    const renderText = buffer.getRenderText()
    const pass = copyText === ['line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7'].join('\n') &&
      renderText === ['line 5', 'line 6', 'line 7'].join('\n')
    console.log('Debug log bounded render test:', pass ? 'PASS' : 'FAIL', { copyText, renderText })
    return pass
  } catch (err) {
    console.log('Debug log bounded render test: FAIL', err?.message || err)
    return false
  }
}
