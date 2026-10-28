// @vitest-environment happy-dom
import { Window } from 'happy-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { freezePage } from './freeze'

interface FakeAnimation {
  readonly animation: Animation
  readonly pause: ReturnType<typeof vi.fn>
  readonly play: ReturnType<typeof vi.fn>
}

function animation(playState: AnimationPlayState): FakeAnimation {
  const pause = vi.fn()
  const play = vi.fn()
  const fake = new Animation()
  Object.defineProperties(fake, {
    playState: { value: playState },
    pause: { value: pause },
    play: { value: play },
  })
  return { animation: fake, pause, play }
}

function stubAnimations(doc: Document | ShadowRoot, animations: readonly FakeAnimation[]) {
  Object.defineProperty(doc, 'getAnimations', { value: () => animations.map(a => a.animation), configurable: true })
}

function video(playing: boolean): HTMLVideoElement {
  const el = document.createElement('video')
  Object.defineProperty(el, 'paused', { value: !playing, configurable: true })
  Object.defineProperty(el, 'ended', { value: false, configurable: true })
  el.pause = vi.fn()
  el.play = vi.fn(async () => {})
  document.body.append(el)
  return el
}

const host = document.createElement('annotate-dom-root')

afterEach(() => {
  document.body.replaceChildren()
  document.head.replaceChildren()
  Reflect.deleteProperty(document, 'getAnimations')
})

describe('freezePage', () => {
  it('pauses running page animations and plays exactly those again on release', () => {
    const running = animation('running')
    const alreadyPaused = animation('paused')
    const finished = animation('finished')
    stubAnimations(document, [running, alreadyPaused, finished])

    const release = freezePage({ root: document, overlayHost: host })
    expect(running.pause).toHaveBeenCalledOnce()
    expect(alreadyPaused.pause).not.toHaveBeenCalled()
    expect(finished.pause).not.toHaveBeenCalled()

    release()
    expect(running.play).toHaveBeenCalledOnce()
    expect(alreadyPaused.play).not.toHaveBeenCalled()
    expect(finished.play).not.toHaveBeenCalled()
  })

  it('leaves the overlay own animations running and pauses those in the page open shadow roots', () => {
    const overlay = document.createElement('annotate-dom-root')
    const widget = document.createElement('x-widget')
    document.body.append(overlay, widget)
    const overlayAnimation = animation('running')
    const widgetAnimation = animation('running')
    const pageAnimation = animation('running')
    stubAnimations(document, [pageAnimation])
    stubAnimations(overlay.attachShadow({ mode: 'open' }), [overlayAnimation])
    stubAnimations(widget.attachShadow({ mode: 'open' }), [widgetAnimation])

    freezePage({ root: document, overlayHost: overlay })
    expect(overlayAnimation.pause).not.toHaveBeenCalled()
    expect(widgetAnimation.pause).toHaveBeenCalledOnce()
    expect(pageAnimation.pause).toHaveBeenCalledOnce()
  })

  it('pauses only playing videos and plays only those on release', () => {
    stubAnimations(document, [])
    const playing = video(true)
    const idle = video(false)

    const release = freezePage({ root: document, overlayHost: host })
    expect(playing.pause).toHaveBeenCalledOnce()
    expect(idle.pause).not.toHaveBeenCalled()

    release()
    expect(playing.play).toHaveBeenCalledOnce()
    expect(idle.play).not.toHaveBeenCalled()
  })

  it('adds a stylesheet that pauses new css animations and removes it on release', () => {
    stubAnimations(document, [])
    const release = freezePage({ root: document, overlayHost: host })
    expect(document.head.querySelector('style')?.textContent).toContain('animation-play-state: paused')
    release()
    expect(document.head.querySelector('style')).toBeNull()
  })

  it('releasing twice resumes once', () => {
    const running = animation('running')
    stubAnimations(document, [running])
    const release = freezePage({ root: document, overlayHost: host })
    release()
    release()
    expect(running.play).toHaveBeenCalledOnce()
  })

  it('includes same-origin iframe documents', () => {
    stubAnimations(document, [])
    const frame = document.createElement('iframe')
    const inner = document.implementation.createHTMLDocument('frame')
    Object.defineProperty(frame, 'contentDocument', { value: inner })
    document.body.append(frame)
    const frameAnimation = animation('running')
    stubAnimations(inner, [frameAnimation])

    const release = freezePage({ root: document, overlayHost: host })
    expect(frameAnimation.pause).toHaveBeenCalledOnce()
    release()
    expect(frameAnimation.play).toHaveBeenCalledOnce()
  })

  it('skips a cross-origin iframe whose document throws', () => {
    stubAnimations(document, [])
    const frame = document.createElement('iframe')
    Object.defineProperty(frame, 'contentDocument', { get: () => { throw new DOMException('blocked', 'SecurityError') } })
    document.body.append(frame)
    expect(() => freezePage({ root: document, overlayHost: host })()).not.toThrow()
  })

  it('includes an iframe document from another realm', () => {
    stubAnimations(document, [])
    const frame = document.createElement('iframe')
    const inner = new Window().document
    Object.defineProperty(frame, 'contentDocument', { value: inner })
    document.body.append(frame)
    const frameAnimation = animation('running')
    Object.defineProperty(inner, 'getAnimations', { value: () => [frameAnimation.animation] })

    freezePage({ root: document, overlayHost: host })
    expect(frameAnimation.pause).toHaveBeenCalledOnce()
    expect(inner.head.querySelector('style')?.textContent).toContain('animation-play-state: paused')
  })

  it('freezes an iframe document that has no head, and every document after it', () => {
    stubAnimations(document, [])
    const svgFrame = document.createElement('iframe')
    const svg = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'image/svg+xml')
    Object.defineProperty(svgFrame, 'contentDocument', { value: svg })
    const htmlFrame = document.createElement('iframe')
    const inner = document.implementation.createHTMLDocument('frame')
    Object.defineProperty(htmlFrame, 'contentDocument', { value: inner })
    document.body.append(svgFrame, htmlFrame)
    const svgAnimation = animation('running')
    const htmlAnimation = animation('running')
    stubAnimations(svg, [svgAnimation])
    stubAnimations(inner, [htmlAnimation])

    const release = freezePage({ root: document, overlayHost: host })
    expect(svgAnimation.pause).toHaveBeenCalledOnce()
    expect(htmlAnimation.pause).toHaveBeenCalledOnce()
    expect(svg.documentElement.querySelector('style')?.textContent).toContain('animation-play-state: paused')
    release()
    expect(svg.documentElement.querySelector('style')).toBeNull()
    expect(svgAnimation.play).toHaveBeenCalledOnce()
    expect(htmlAnimation.play).toHaveBeenCalledOnce()
  })

  it('still releases what it paused when one document fails halfway', () => {
    const running = animation('running')
    stubAnimations(document, [running])
    const frame = document.createElement('iframe')
    const broken = document.implementation.createHTMLDocument('frame')
    Object.defineProperty(broken, 'getAnimations', { value: () => { throw new Error('frame is gone') } })
    Object.defineProperty(frame, 'contentDocument', { value: broken })
    document.body.append(frame)

    const release = freezePage({ root: document, overlayHost: host })
    expect(running.pause).toHaveBeenCalledOnce()
    release()
    expect(running.play).toHaveBeenCalledOnce()
    expect(document.head.querySelector('style')).toBeNull()
  })

  describe('two freezes at once', () => {
    function stateful(): FakeAnimation & { state: () => AnimationPlayState } {
      let playState: AnimationPlayState = 'running'
      const fake = new Animation()
      const pause = vi.fn(() => { playState = 'paused' })
      const play = vi.fn(() => { playState = 'running' })
      Object.defineProperties(fake, {
        playState: { get: () => playState },
        pause: { value: pause },
        play: { value: play },
      })
      return { animation: fake, pause, play, state: () => playState }
    }

    it('keeps an animation paused until the newer freeze is released too', () => {
      const running = stateful()
      stubAnimations(document, [running])
      const first = freezePage({ root: document, overlayHost: host })
      const second = freezePage({ root: document, overlayHost: host })

      first()
      expect(running.state()).toBe('paused')
      second()
      expect(running.state()).toBe('running')
      expect(running.play).toHaveBeenCalledOnce()
    })

    it('keeps a video paused until the newer freeze is released too', () => {
      stubAnimations(document, [])
      let paused = false
      const el = document.createElement('video')
      Object.defineProperty(el, 'paused', { get: () => paused })
      Object.defineProperty(el, 'ended', { value: false })
      el.pause = vi.fn(() => { paused = true })
      el.play = vi.fn(async () => { paused = false })
      document.body.append(el)

      const first = freezePage({ root: document, overlayHost: host })
      const second = freezePage({ root: document, overlayHost: host })
      first()
      expect(paused).toBe(true)
      second()
      expect(el.play).toHaveBeenCalledOnce()
    })

    it('leaves an animation the page itself paused alone', () => {
      const own = animation('paused')
      stubAnimations(document, [own])
      freezePage({ root: document, overlayHost: host })()
      expect(own.play).not.toHaveBeenCalled()
    })
  })
})
