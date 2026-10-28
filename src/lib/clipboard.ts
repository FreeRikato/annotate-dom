export type CopyResult = 'clipboard' | 'manual'

function copySynchronously(text: string): boolean {
  let listenerRan = false
  const onCopy = (event: ClipboardEvent) => {
    listenerRan = true
    event.preventDefault()
    event.clipboardData?.setData('text/plain', text)
  }
  window.addEventListener('copy', onCopy)
  try {
    return document.execCommand('copy') && listenerRan
  } catch {
    return false
  } finally {
    window.removeEventListener('copy', onCopy)
  }
}

export async function copyText(text: string): Promise<CopyResult> {
  try {
    await navigator.clipboard.writeText(text)
    return 'clipboard'
  } catch {
    return copySynchronously(text) ? 'clipboard' : 'manual'
  }
}
