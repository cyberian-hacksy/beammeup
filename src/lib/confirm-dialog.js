// Styled, promise-based replacement for window.confirm(), backed by the
// <dialog id="confirm-dialog"> in index.html. Resolves true when the user
// picks the confirm action, false on Cancel or Escape.

export function confirmDialog(message, { confirmText = 'Discard', cancelText = 'Cancel' } = {}) {
  const dialog = typeof document !== 'undefined' && document.getElementById('confirm-dialog')
  // <dialog> unsupported (or markup missing): fall back to the native prompt.
  if (!dialog || typeof dialog.showModal !== 'function') {
    return Promise.resolve(confirm(message))
  }

  document.getElementById('confirm-dialog-message').textContent = message
  const btnConfirm = document.getElementById('confirm-dialog-confirm')
  const btnCancel = document.getElementById('confirm-dialog-cancel')
  btnConfirm.textContent = confirmText
  btnCancel.textContent = cancelText

  return new Promise(resolve => {
    const settle = (result) => {
      btnConfirm.removeEventListener('click', onConfirm)
      btnCancel.removeEventListener('click', onCancel)
      dialog.removeEventListener('cancel', onEscape)
      if (dialog.open) dialog.close()
      resolve(result)
    }
    const onConfirm = () => settle(true)
    const onCancel = () => settle(false)
    const onEscape = () => settle(false) // Esc fires 'cancel', then closes

    btnConfirm.addEventListener('click', onConfirm)
    btnCancel.addEventListener('click', onCancel)
    dialog.addEventListener('cancel', onEscape)
    dialog.showModal()
  })
}
