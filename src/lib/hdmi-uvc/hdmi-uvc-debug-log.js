export function createReceiverDebugLogBuffer({ maxLines = 500, visibleLines = 120 } = {}) {
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

export function testReceiverDebugLogBufferKeepsCopyFullAndRenderBounded() {
  try {
    const buffer = createReceiverDebugLogBuffer({ maxLines: 6, visibleLines: 3 })
    for (let i = 1; i <= 7; i++) buffer.append(`line ${i}`)
    const copyText = buffer.getCopyText()
    const renderText = buffer.getRenderText()
    const pass = copyText === ['line 2', 'line 3', 'line 4', 'line 5', 'line 6', 'line 7'].join('\n') &&
      renderText === ['line 5', 'line 6', 'line 7'].join('\n')
    console.log('Receiver debug log bounded render test:', pass ? 'PASS' : 'FAIL', { copyText, renderText })
    return pass
  } catch (err) {
    console.log('Receiver debug log bounded render test: FAIL', err?.message || err)
    return false
  }
}
