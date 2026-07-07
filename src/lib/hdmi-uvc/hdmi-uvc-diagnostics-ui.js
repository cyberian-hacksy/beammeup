// Renders the tunable part of the diagnostics registry (keys with more than
// one allowed value) as dropdowns inside the receiver's diagnostics panel.
// Locked single-value keys are baselines, not choices, so they render
// nothing — with everything locked the whole section stays hidden.

import {
  getDiagnostic,
  getDiagnosticDefinition,
  listDiagnosticKeys,
  listModifiedDiagnostics,
  setDiagnostic
} from './hdmi-uvc-diagnostics.js'

const ROW_STYLE = 'display:flex;align-items:center;gap:8px;margin:2px 0;font-size:12px;color:#9ab;'
const LABEL_STYLE = 'width:110px;text-align:right;color:#9ab;'
const SELECT_STYLE = 'font-size:12px;background:#16213e;color:#00d4ff;border:1px solid #333;border-radius:3px;padding:2px 4px;'

export function updateModifiedBadge(badge) {
  if (!badge) return
  const modified = listModifiedDiagnostics()
  if (modified.length > 0) {
    badge.classList.remove('hidden')
    badge.title = 'Non-default: ' + modified.join(', ')
  } else {
    badge.classList.add('hidden')
    badge.title = ''
  }
}

export function renderDiagnosticSettings(container, { modifiedBadge = null } = {}) {
  if (!container) return
  while (container.firstChild) container.removeChild(container.firstChild)
  updateModifiedBadge(modifiedBadge)

  // With every key locked to a single value there is nothing to render; the
  // section reappears as soon as a key's `allowed` list is widened again.
  const tunableKeys = listDiagnosticKeys()
    .filter(key => (getDiagnosticDefinition(key)?.allowed.length ?? 0) > 1)
  if (tunableKeys.length === 0) {
    container.style.display = 'none'
    return
  }
  container.style.display = ''

  const heading = document.createElement('div')
  heading.textContent = 'Settings (persisted; also mirrored into the URL for shareable repro links)'
  heading.style.cssText = 'font-size:11px;color:#667;margin-bottom:4px;'
  container.appendChild(heading)

  let reloadNote = null

  for (const key of tunableKeys) {
    const def = getDiagnosticDefinition(key)

    const row = document.createElement('div')
    row.style.cssText = ROW_STYLE

    const label = document.createElement('label')
    label.textContent = def.title
    label.style.cssText = LABEL_STYLE
    label.htmlFor = 'hdmi-uvc-diag-setting-' + key

    const select = document.createElement('select')
    select.id = 'hdmi-uvc-diag-setting-' + key
    select.style.cssText = SELECT_STYLE
    for (const value of def.allowed) {
      const option = document.createElement('option')
      option.value = value
      option.textContent = def.labels?.[value] ?? value
      select.appendChild(option)
    }
    select.value = getDiagnostic(key)
    select.onchange = () => {
      setDiagnostic(key, select.value)
      updateModifiedBadge(modifiedBadge)
      if (def.reloadRequired && reloadNote) reloadNote.classList.remove('hidden')
    }

    row.appendChild(label)
    row.appendChild(select)
    if (def.reloadRequired) {
      const tag = document.createElement('span')
      tag.textContent = 'reload required'
      tag.style.cssText = 'font-size:10px;color:#667;'
      row.appendChild(tag)
    }
    container.appendChild(row)
  }

  reloadNote = document.createElement('div')
  reloadNote.textContent = 'A changed reload-required setting takes effect after reloading the page.'
  reloadNote.style.cssText = 'font-size:11px;color:#ffd400;margin-top:4px;'
  reloadNote.classList.add('hidden')
  container.appendChild(reloadNote)
}
