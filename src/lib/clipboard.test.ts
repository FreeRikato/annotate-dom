// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyText } from './clipboard'

function stubWriteText(writeText: (text: string) => Promise<void>) {
  vi.stubGlobal('navigator', { clipboard: { writeText } })
}

const copiedData = new DataTransfer()

function stubExecCommand(run: () => boolean) {
  const execCommand = vi.fn((command: string) => {
    if (command !== 'copy') return false
    document.dispatchEvent(new ClipboardEvent('copy', { clipboardData: copiedData, bubbles: true, cancelable: true }))
    return run()
  })
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true })
  return execCommand
}

afterEach(() => {
  vi.unstubAllGlobals()
  copiedData.clearData()
  Reflect.deleteProperty(document, 'execCommand')
})

describe('copyText', () => {
  it('uses the async clipboard and leaves execCommand alone when writeText resolves', async () => {
    const writeText = vi.fn(async () => {})
    stubWriteText(writeText)
    const execCommand = stubExecCommand(() => true)

    expect(await copyText('hello')).toBe('clipboard')
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(execCommand).not.toHaveBeenCalled()
  })

  it('copies through execCommand with the text as text/plain when writeText rejects', async () => {
    stubWriteText(async () => {
      throw new DOMException('blocked', 'NotAllowedError')
    })
    const execCommand = stubExecCommand(() => true)

    expect(await copyText('hello')).toBe('clipboard')
    expect(execCommand).toHaveBeenCalledWith('copy')
    expect(copiedData.getData('text/plain')).toBe('hello')
  })

  it('reports manual when a page listener swallows the copy event before ours runs', async () => {
    stubWriteText(async () => {
      throw new DOMException('blocked', 'NotAllowedError')
    })
    stubExecCommand(() => true)
    const swallow = (event: Event) => event.stopImmediatePropagation()
    window.addEventListener('copy', swallow, true)
    try {
      expect(await copyText('hello')).toBe('manual')
    } finally {
      window.removeEventListener('copy', swallow, true)
    }
  })

  it('keeps the annotations on the clipboard when a page document copy handler sets its own text', async () => {
    stubWriteText(async () => {
      throw new DOMException('blocked', 'NotAllowedError')
    })
    stubExecCommand(() => true)
    const attribute = (event: ClipboardEvent) => {
      event.preventDefault()
      event.clipboardData?.setData('text/plain', 'PAGE ATTRIBUTION')
    }
    document.addEventListener('copy', attribute)
    try {
      expect(await copyText('hello')).toBe('clipboard')
      expect(copiedData.getData('text/plain')).toBe('hello')
    } finally {
      document.removeEventListener('copy', attribute)
    }
  })

  it('reports manual when writeText rejects and execCommand returns false', async () => {
    stubWriteText(async () => {
      throw new DOMException('blocked', 'NotAllowedError')
    })
    stubExecCommand(() => false)

    expect(await copyText('hello')).toBe('manual')
  })

  it('reports manual when writeText rejects and execCommand throws', async () => {
    stubWriteText(async () => {
      throw new DOMException('blocked', 'NotAllowedError')
    })
    Object.defineProperty(document, 'execCommand', {
      value: () => {
        throw new Error('not allowed')
      },
      configurable: true,
    })

    expect(await copyText('hello')).toBe('manual')
  })

  it('removes its copy listener after the command so later copies are untouched', async () => {
    stubWriteText(async () => {
      throw new Error('blocked')
    })
    stubExecCommand(() => true)
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')

    await copyText('hello')

    const added = add.mock.calls.filter(([type]) => type === 'copy')
    const removed = remove.mock.calls.filter(([type]) => type === 'copy')
    expect(added).toHaveLength(1)
    expect(removed).toHaveLength(1)
    expect(removed[0]?.[1]).toBe(added[0]?.[1])
  })
})
