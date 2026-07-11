// Drop-zone wiring shared by the QR, CIMBAR, and HDMI-UVC senders: hidden
// file-input change, click/Enter/Space to open the picker, and the
// drag-over/leave/drop trio with the .dragover highlight. The zone stops
// accepting input once a file is loaded (`hasFile()`), matching all three
// senders' historical behavior.
//
// opts:
//   container            – drop-zone element (role="button"; gets .dragover)
//   fileInput            – hidden <input type="file">
//   hasFile()            – true when a file is already loaded
//   onFile(file)         – called with the picked/dropped File
//   onClickCapture()     – optional; return true to consume the click before
//                          the picker opens (HDMI-UVC armed-start tap)
//   canOpenViaKeyboard() – optional; gates Enter/Space (defaults to !hasFile())
export function wireDropZone({
  container,
  fileInput,
  hasFile,
  onFile,
  onClickCapture = null,
  canOpenViaKeyboard = null
}) {
  const acceptsFile = () => !hasFile()
  const kbdOk = canOpenViaKeyboard || acceptsFile

  fileInput.onchange = (e) => { void onFile(e.target.files[0]) }

  container.onclick = () => {
    if (onClickCapture && onClickCapture()) return
    if (acceptsFile()) fileInput.click()
  }

  // The drop zone is a div with role="button"; Enter/Space must work like click
  container.onkeydown = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && kbdOk()) {
      e.preventDefault()
      fileInput.click()
    }
  }

  container.ondragover = (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (acceptsFile()) container.classList.add('dragover')
  }

  container.ondragleave = (e) => {
    e.preventDefault()
    e.stopPropagation()
    container.classList.remove('dragover')
  }

  container.ondrop = (e) => {
    e.preventDefault()
    e.stopPropagation()
    container.classList.remove('dragover')
    if (!acceptsFile()) return
    const files = e.dataTransfer.files
    if (files.length > 0) void onFile(files[0])
  }
}
