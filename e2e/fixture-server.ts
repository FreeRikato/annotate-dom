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

const animatedPage = () => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture animated</title>
<style>
body{font-family:sans-serif;margin:40px}
.row{display:block;height:24px;margin:6px 0;background:#9cf}
@keyframes grow{from{width:50px}to{width:250px}}
#spin{animation:grow 2s linear infinite alternate}
#fade{width:50px;transition:width 3s linear}
#fade.on{width:300px}
#target{padding:8px 24px;font-size:16px}
#late{display:inline-block;width:140px;height:40px;line-height:40px;text-align:center;background:#0c0}
#late.done{background:#c00;color:#fff}
</style></head>
<body>
<div id="spin" class="row"></div>
<div id="fade" class="row"></div>
<div id="waapi" class="row" style="width:200px"></div>
<video id="clip" muted playsinline width="80" height="45"></video>
<canvas id="feed" width="80" height="45" hidden></canvas>
<p><button id="target" type="button">Pin me</button></p>
<p><span id="late">Loading</span></p>
<script>
document.getElementById('fade').addEventListener('mouseenter', e => e.currentTarget.classList.add('on'))
document.getElementById('waapi').animate([{ opacity: 1 }, { opacity: 0.2 }], { duration: 2000, iterations: Infinity, direction: 'alternate' })
const late = document.getElementById('late')
late.addEventListener('mouseenter', () => setTimeout(() => { late.textContent = 'Done'; late.className = 'done' }, 1000), { once: true })
const feed = document.getElementById('feed')
const paint = feed.getContext('2d')
setInterval(() => { paint.fillStyle = 'hsl(' + (Date.now() / 10 % 360) + ',80%,50%)'; paint.fillRect(0, 0, 80, 45) }, 30)
const clip = document.getElementById('clip')
clip.srcObject = feed.captureStream(30)
clip.play()
</script></body>
</html>`

const shadowPage = () => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture shadow</title>
<style>body{font-family:sans-serif;margin:40px}</style></head>
<body><h1>Shadow</h1><div id="host"></div>
<script>
const root = document.getElementById('host').attachShadow({ mode: 'open' })
root.innerHTML = '<style>button{padding:8px 24px;font-size:16px;background:#0c0}</style><button id="inner" type="button">Inside shadow</button>'
</script></body>
</html>`

const innerFramePage = () => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture inner frame</title>
<style>body{font-family:sans-serif;margin:8px}#plain{padding:8px 24px;font-size:16px;background:#0c0}</style></head>
<body><button id="plain" type="button">Inside frame</button><div id="host"></div>
<script>
const root = document.getElementById('host').attachShadow({ mode: 'open' })
root.innerHTML = '<style>button{padding:8px 24px;font-size:16px;background:#0c0}</style><button id="nested" type="button">Shadow inside frame</button>'
</script></body>
</html>`

const framesPage = (foreignPort: number) => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture frames</title>
<style>body{font-family:sans-serif;margin:40px}iframe{display:block;width:420px;height:120px;border:2px solid #888;margin:16px 0}</style></head>
<body><h1>Frames</h1>
<iframe id="same" src="/inner-frame"></iframe>
<iframe id="foreign" src="http://localhost:${foreignPort}/foreign"></iframe>
</body>
</html>`

const motionFramesPage = () => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture motion frames</title>
<style>body{font-family:sans-serif;margin:40px}iframe{display:block;width:320px;height:60px;border:2px solid #888;margin:8px 0}#target{padding:8px 24px;font-size:16px}</style></head>
<body><iframe id="html" src="/inner-motion"></iframe><iframe id="svg" src="/inner-motion.svg"></iframe>
<p><button id="target" type="button">Pin me</button></p></body>
</html>`

const innerMotionPage = () => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Inner motion</title>
<style>body{margin:8px}@keyframes grow{from{width:20px}to{width:240px}}#bar{height:20px;background:#9cf;animation:grow 2s linear infinite alternate}</style></head>
<body><div id="bar"></div></body>
</html>`

const innerMotionSvg = () => `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="60">
<style>@keyframes grow{from{width:20px}to{width:240px}}#bar{animation:grow 2s linear infinite alternate}</style>
<rect id="bar" x="8" y="8" width="20" height="20" fill="#0c0"/></svg>`

const foreignPage = () => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Foreign</title></head>
<body style="margin:8px"><button id="outside" type="button" style="padding:8px 24px;font-size:16px">Other origin</button></body>
</html>`

const foreignPort = Number(process.env.FIXTURE_FOREIGN_PORT)

if (foreignPort) Bun.serve({
  port: foreignPort,
  hostname: 'localhost',
  fetch: req => (new URL(req.url).pathname === '/foreign' ? new Response(foreignPage(), { headers: { 'content-type': 'text/html' } }) : new Response('not found', { status: 404 })),
})

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
    if (url.pathname === '/shadow') return new Response(shadowPage(), { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/inner-frame') return new Response(innerFramePage(), { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/frames') return new Response(framesPage(foreignPort), { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/motion-frames') return new Response(motionFramesPage(), { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/inner-motion') return new Response(innerMotionPage(), { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/inner-motion.svg') return new Response(innerMotionSvg(), { headers: { 'content-type': 'image/svg+xml' } })
    if (url.pathname === '/animated') return new Response(animatedPage(), { headers: { 'content-type': 'text/html' } })
    return new Response('not found', { status: 404 })
  },
})
