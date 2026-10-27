const port = Number(process.env.FIXTURE_PORT)
let padding = '24px'

const page = () => `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture settings</title>
<style>body{font-family:sans-serif;margin:40px}#theme{padding:8px ${padding};font-size:16px}</style></head>
<body><h1>Settings</h1><button id="theme" type="button">Toggle dark mode</button></body>
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
    return new Response('not found', { status: 404 })
  },
})
