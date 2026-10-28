const port = Number(process.env.FIXTURE_PORT)
let padding = '24px'

const page = () => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture settings</title>
<style>body{font-family:sans-serif;margin:40px}#theme{padding:8px ${padding};font-size:16px}</style></head>
<body><h1>Settings</h1><button id="theme" type="button">Toggle dark mode</button></body>
</html>`

const routerPage = () => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture router</title>
<style>body{font-family:sans-serif;margin:40px}button{padding:8px 24px;font-size:16px}</style></head>
<body><h1 id="top">Router</h1><main id="view"></main>
<script>
const views = { '#/a': 'Save page A', '#/b': 'Save page B' }
function render() {
  const label = views[location.hash]
  document.getElementById('view').innerHTML = label ? '<button id="action" type="button">' + label + '</button>' : ''
}
addEventListener('hashchange', render)
render()
</script></body>
</html>`

const backdropPage = () => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture backdrop</title>
<style>body{font-family:sans-serif;margin:40px}#backdrop{position:fixed;inset:0}#go{padding:8px 24px;font-size:16px}</style></head>
<body><h1>Backdrop</h1><button id="go" type="button">Continue</button><div id="backdrop"></div></body>
</html>`

const nestedPage = () => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture nested</title>
<style>body{font-family:sans-serif;margin:40px;height:3000px}#outer{padding:24px;background:#eef}#inner{padding:16px;background:#dde}#deep{padding:8px 24px;font-size:16px}</style></head>
<body><main id="outer"><section id="inner"><button id="deep" type="button">Deep</button></section></main></body>
</html>`

Bun.serve({
  port,
  hostname: 'localhost',
  fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === '/set-padding') {
      padding = url.searchParams.get('value') ?? padding
      return new Response('ok')
    }
    if (url.pathname === '/settings') return new Response(page(), { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/router') return new Response(routerPage(), { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/backdrop') return new Response(backdropPage(), { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/nested') return new Response(nestedPage(), { headers: { 'content-type': 'text/html' } })
    return new Response('not found', { status: 404 })
  },
})
