import { describe, expect, it } from 'vitest'
import { pageKey } from './page'

describe('pageKey', () => {
  it('keeps a #/ route in the key', () => {
    expect(pageKey({ pathname: '/app', hash: '#/users' })).toBe('/app#/users')
  })

  it('keeps a #!/ route in the key', () => {
    expect(pageKey({ pathname: '/app', hash: '#!/x' })).toBe('/app#!/x')
  })

  it('drops an anchor hash', () => {
    expect(pageKey({ pathname: '/app', hash: '#section-2' })).toBe('/app')
  })

  it('never counts the query string', () => {
    expect(pageKey(new URL('http://localhost/app?q=1'))).toBe('/app')
    expect(pageKey(new URL('http://localhost/app?q=1#/users?tab=2'))).toBe('/app#/users')
  })

  it('drops a query inside a !/ route too', () => {
    expect(pageKey({ pathname: '/app', hash: '#!/x?token=abc' })).toBe('/app#!/x')
  })
})
