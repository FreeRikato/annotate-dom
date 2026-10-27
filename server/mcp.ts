import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { type ExtensionLink, recapture } from './recapture'
import { AmbiguousAnnotationError, getAnnotation, listAnnotations, resolveAnnotation } from './store'

const PROJECT_HINT = 'Pass your current working directory as `project`.'

const projectArg = z.string().optional().describe('Absolute path of your working directory')

const asText = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] })

const notFound = (id: string) => toolError(`annotation not found: ${id}`)

const toolError = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

function reportAmbiguity<Args, Result>(run: (args: Args) => Promise<Result>) {
  return async (args: Args) => {
    try {
      return await run(args)
    } catch (err: unknown) {
      if (err instanceof AmbiguousAnnotationError) return toolError(err.message)
      throw err
    }
  }
}

function buildServer(home: string, link: ExtensionLink): McpServer {
  const server = new McpServer({ name: 'annotate-dom', version: '0.0.0' })
  server.registerTool('list_annotations', {
    description: `List annotations the user pinned on their running app, newest first. ${PROJECT_HINT}`,
    inputSchema: { project: projectArg, status: z.enum(['open', 'resolved']).default('open') },
  }, async ({ project, status }) => asText(await listAnnotations({ home, project, status })))
  server.registerTool('get_annotation', {
    description: `Get one annotation in full, with absolute paths to its screenshots. ${PROJECT_HINT}`,
    inputSchema: { id: z.string().describe('Annotation id like 2026-10-27-1405-settings#1'), project: projectArg },
  }, reportAmbiguity(async ({ id, project }) => {
    const found = await getAnnotation({ home, id, project })
    return found ? asText(found) : notFound(id)
  }))
  server.registerTool('resolve_annotation', {
    description: `Mark an annotation as fixed once you have changed the code, with a one-line summary of the change. ${PROJECT_HINT}`,
    inputSchema: { id: z.string(), summary: z.string().describe('One line on what you changed'), project: projectArg },
  }, reportAmbiguity(async ({ id, summary, project }) => {
    const resolved = await resolveAnnotation({ home, id, summary, project, now: Date.now() })
    return resolved ? asText({ id, status: 'resolved', summary }) : notFound(id)
  }))
  server.registerTool('recapture', {
    description: `Re-find an annotated element in the running app after your fix and return the before and after screenshots with a style and HTML diff. ${PROJECT_HINT}`,
    inputSchema: { id: z.string(), project: projectArg },
  }, reportAmbiguity(async ({ id, project }) => {
    const outcome = await recapture({ home, id, project, link, now: Date.now() })
    return outcome.ok ? asText(outcome) : toolError(outcome.error)
  }))
  return server
}

export function isLocalHost(host: string | null, port: number): boolean {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`
}

export async function handleMcp({ req, home, port, link }: {
  readonly req: Request
  readonly home: string
  readonly port: number
  readonly link: ExtensionLink
}): Promise<Response> {
  if (!isLocalHost(req.headers.get('host'), port) || req.headers.has('origin')) {
    return new Response('forbidden', { status: 403 })
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
  await buildServer(home, link).connect(transport)
  return transport.handleRequest(req)
}
