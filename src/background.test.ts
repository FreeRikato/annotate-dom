import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const QUOTA_MESSAGE = 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.'

function inertChrome(captureVisibleTab: (windowId: number, options: { format: string }) => Promise<string>): unknown {
  const inert: unknown = new Proxy(function () {}, { get: () => inert, apply: () => inert })
  return new Proxy({}, { get: (_, key) => (key === 'tabs' ? new Proxy({}, { get: (__, name) => (name === 'captureVisibleTab' ? captureVisibleTab : inert) }) : inert) })
}

async function captureVisibleWith(captureVisibleTab: Parameters<typeof inertChrome>[0]) {
  vi.stubGlobal('chrome', inertChrome(captureVisibleTab))
  return (await import('./background')).captureVisible
}

describe('captureVisible', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('returns the shot at once when the quota allows it', async () => {
    const capture = vi.fn(async () => 'data:shot')
    const captureVisible = await captureVisibleWith(capture)
    expect(await captureVisible(1)).toBe('data:shot')
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('keeps retrying while the quota refuses, so a third rapid open still gets its shot', async () => {
    const firstCall = Date.now()
    const capture = vi.fn(async () => {
      if (Date.now() < firstCall + 1000) throw new Error(QUOTA_MESSAGE)
      return 'data:third'
    })
    const captureVisible = await captureVisibleWith(capture)
    const shot = captureVisible(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(await shot).toBe('data:third')
    expect(capture.mock.calls.length).toBeGreaterThan(2)
  })

  it('gives up with the quota error after about 1.5 s', async () => {
    const capture = vi.fn(async () => {
      throw new Error(QUOTA_MESSAGE)
    })
    const captureVisible = await captureVisibleWith(capture)
    const shot = captureVisible(1)
    const outcome = shot.then(() => 'shot', (err: unknown) => (err instanceof Error ? err.message : 'other'))
    await vi.advanceTimersByTimeAsync(1600)
    expect(await outcome).toBe(QUOTA_MESSAGE)
    expect(capture).toHaveBeenCalledTimes(7)
  })

  it('does not retry any other error', async () => {
    const capture = vi.fn(async () => {
      throw new Error('No window with id: 1')
    })
    const captureVisible = await captureVisibleWith(capture)
    await expect(captureVisible(1)).rejects.toThrow('No window with id')
    expect(capture).toHaveBeenCalledTimes(1)
  })
})
