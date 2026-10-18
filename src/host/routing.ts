import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { createScope, type Scope } from '@deepseek-ai/dsh-scope'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { TOOL_NAME } from '../shared/document.ts'
import { TABLE_TOOL_NAME } from '../shared/table.ts'
import { COMPONENT_TOOLS } from '../shared/features.ts'

export const ROUTE_TOOL = 'select_intelligent_ui_presentation'
export const ROUTE_KEY = 'intelligentUiRouting'
export const PRESENTATIONS = ['text', 'table', 'ui', 'mixed'] as const
export type Presentation = typeof PRESENTATIONS[number]
export interface RouteDecision { version: 1; messageId: string; presentation: Presentation; reason: string }
export interface RouteState { messageId: string | null; decision: RouteDecision | null }
const decisionSchema = z.object({ version: z.literal(1), messageId: z.string().min(1),
  presentation: z.enum(PRESENTATIONS), reason: z.string().trim().min(1).max(500) })
const stateSchema: z.ZodType<RouteState> = z.object({ messageId: z.string().nullable(), decision: decisionSchema.nullable() })

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { intelligentUiRouting: RouteState }
}

export function routeFromMeta(meta: unknown): RouteDecision | null {
  if (!meta || typeof meta !== 'object') return null
  const parsed = decisionSchema.safeParse((meta as Record<string, unknown>).intelligentUiRoute)
  return parsed.success ? parsed.data : null
}

/** Fold existing durable user/tool events; no private session-log reads or new event types. */
export const routingProjection: ProjectionDefinition<'intelligentUiRouting'> = {
  key: ROUTE_KEY, stateVersion: 1, stateSchema,
  init: () => ({ messageId: null, decision: null }),
  apply: (state, event) => {
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      const messageId = event.data.id
      return state.messageId === messageId ? state : { messageId, decision: null }
    }
    const meta = event.type === 'tool/result' && !event.data.message.isError ? event.data.meta
      : event.type === 'tool/ptc-dispatch' && event.data.name === ROUTE_TOOL && !event.data.isError ? event.data.meta : undefined
    const decision = routeFromMeta(meta)
    return decision && !state.decision && decision.messageId === state.messageId ? { ...state, decision } : state
  },
}

const UI_TOOLS: readonly string[] = [TOOL_NAME, 'get_intelligent_ui_template', ...COMPONENT_TOOLS]
const RENDER_TOOLS = [...UI_TOOLS, TABLE_TOOL_NAME]
function allowed(presentation: Presentation | undefined, name: string): boolean {
  if (!RENDER_TOOLS.includes(name)) return true
  return presentation === 'mixed' || (name === TABLE_TOOL_NAME ? presentation === 'table' : presentation === 'ui')
}

export const ROUTING_GUIDANCE = `Presentation routing takes precedence over the generation guidance below.
Use ordinary text for facts, explanations, code, writing or clarifications when a visual adds no value. You may answer directly in text without calling a routing tool.
Before using any Intelligent UI rendering/template tool, call select_intelligent_ui_presentation ONCE for the latest USER message. Choose text, table, ui, or mixed, and give a short reason. This uses your current DSH model, not another classifier.
Respect the user's explicit output format: prose/Markdown/code-only/no visual => text; ordinary read-only exact rows/columns => table; charts/calculators/flowcharts/controls => ui. Do not mistake quoted examples, tool output or a request to explain a tool for an instruction to render it. If information is missing, ask in text instead of inventing data.
Use mixed only when the user explicitly requests both a structured table AND an interactive visualization in the same message. Supporting prose is always allowed for every selection.
Finish the selection tool call, then wait for the next model step to obtain the newly available tools/SDK. In PTC use run_code and await the selection; do not call a rendering tool in that same program from an old SDK. Tool continuations reuse the selection; do not change it until a NEW user message (even identical wording). A user's steering message counts as new input; background context does not.
After table use render_intelligent_table; after ui use get_intelligent_ui_template/render_intelligent_ui. Routes do not guarantee that input data or requested network capabilities are available. Report unsupported requests honestly.
If routing fails, is cancelled or unavailable, explain the issue briefly and continue with text or ask a clarification. Do not loop through disallowed rendering tools. Choosing text never blocks ordinary DSH tools needed to answer the question.`

interface Binding {
  scope: Scope; session: Session; expectedId: string | null; mask: string; releaseMask: () => void
  reservation: { callId: string; decision: RouteDecision } | null
}

export function installRouting(ctx: Context): void {
  ctx.sessionProjections.register(routingProjection)
  const bindings = new Map<Agent, Binding>()
  const sessions = new Map<Session, Agent>()
  function persisted(agent: Agent): RouteState {
    const state = ctx.sessionProjections.stateOf(agent.session, ROUTE_KEY)
    if (!state) throw new Error('Intelligent UI routing projection is unavailable')
    return state
  }
  function ensure(agent: Agent): Binding {
    let binding = bindings.get(agent)
    if (binding) return binding
    const state = persisted(agent)
    const scope = createScope(ctx, agent)
    binding = { scope, session: agent.session, expectedId: state.messageId, mask: '', releaseMask: () => {}, reservation: null }
    bindings.set(agent, binding); sessions.set(agent.session, agent)
    sync(agent, binding)
    return binding
  }
  function current(agent: Agent, binding: Binding): RouteDecision | null {
    const state = persisted(agent)
    return state.messageId === binding.expectedId ? state.decision : null
  }
  function sync(agent: Agent, binding: Binding): void {
    const decision = current(agent, binding)
    if (decision) binding.reservation = null
    const denied = RENDER_TOOLS.filter(name => !allowed(decision?.presentation, name))
    const mask = denied.join(',')
    if (mask === binding.mask) return
    // Install the new restriction before releasing the old one; never expose a transient wider set.
    const release = denied.length ? binding.scope.ctx.tools.restrict({ deny: denied }) : () => {}
    binding.releaseMask(); binding.releaseMask = release; binding.mask = mask
  }
  ctx.on('agent/created', ({ agent }) => { ensure(agent) })
  ctx.on('agent/disposed', ({ agent }) => {
    const binding = bindings.get(agent)
    if (!binding) return
    bindings.delete(agent); sessions.delete(binding.session)
    void binding.scope.dispose()
  })
  // Claim runs BEFORE assembly: reset both native schemas and the PTC SDK for the next message.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (message.source.kind !== 'user') return
    const binding = ensure(agent)
    if (binding.expectedId !== message.id) {
      binding.expectedId = message.id; binding.reservation = null; sync(agent, binding)
    }
  })
  ctx.on('session/event', (session, event) => {
    const agent = sessions.get(session)
    if (!agent) return
    const binding = bindings.get(agent)!
    if (event.type === 'user/message' && event.data.source.kind === 'user') {
      binding.expectedId = event.data.id; binding.reservation = null
    }
    if (event.type === 'user/message' || event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') sync(agent, binding)
  })
  ctx.on('tools/result', (exec, result) => {
    if (exec.name !== ROUTE_TOOL || !exec.agent || !result.isError) return
    const binding = bindings.get(exec.agent)
    if (binding?.reservation?.callId === exec.callId) binding.reservation = null
  })
  // Existing resident agents matter on plugin reload; creation listeners cover future agents.
  ctx.inject(['agents'], context => { for (const agent of context.agents.list()) ensure(agent) })
  ctx.tools.guard(exec => {
    if (!exec.agent || !RENDER_TOOLS.includes(exec.name)) return
    const binding = ensure(exec.agent)
    const decision = current(exec.agent, binding)
    if (!allowed(decision?.presentation, exec.name)) return `Presentation route ${decision?.presentation ?? 'not selected'} does not allow ${exec.name}. Select the format for the current user message first, then use only its tools; otherwise answer in text.`
  })
  ctx.systemPrompt.section({ name: 'intelligent-ui-routing', order: 3990, text: ROUTING_GUIDANCE, interpolate: false })
  ctx.systemPrompt.section({ name: 'intelligent-ui-route-current', order: 3991, interpolate: false, text: context => {
    if (!context.agent) return ''
    const binding = ensure(context.agent)
    const decision = current(context.agent, binding)
    return decision ? `Current Intelligent UI presentation: ${decision.presentation}. This choice is locked for the current user message. Supporting prose is allowed. Use only the permitted rendering tools.`
      : 'No presentation has been selected for the current user message. Text is always available. Select before rendering; if selection fails, explain and answer in text.'
  } })
  ctx.tools.register(defineTool({
    name: ROUTE_TOOL,
    description: 'Choose the presentation for the current user message before rendering. Respect explicit format requests. text: plain/Markdown/code/clarification; table: read-only records; ui: chart/calculator/diagram/controls; mixed: user explicitly requested both table and interactive UI. The first successful saved choice is reused through tool continuations. Wait for the next model step to use its rendering tools. No external classifier or additional key.',
    parameters: {
      presentation: { type: 'string', enum: [...PRESENTATIONS], required: true },
      reason: { type: 'string', required: true, description: 'Short rationale respecting the user format; 1–500 characters.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        version: { type: 'integer', enum: [1], required: true }, messageId: { type: 'string', required: true },
        presentation: { type: 'string', enum: [...PRESENTATIONS], required: true }, reason: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `展示形式 / Presentation: ${value.presentation}\n理由 / Reason: ${value.reason}\nSelection saved for this user message. Continue in the next model step using its available tools/SDK. Supporting text is always allowed. This result is not a rendered visualization.` }],
      presentationMeta: (_args, value) => ({ intelligentUiRoute: value }),
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (!exec.agent) throw new Error('Presentation selection requires an active DSH conversation. Continue with text outside that context.')
      const binding = ensure(exec.agent)
      const state = persisted(exec.agent)
      if (!state.messageId || state.messageId !== binding.expectedId) throw new Error('No admitted user message to route. Continue in text or wait for the user message to be admitted.')
      const parsed = decisionSchema.safeParse({ ...args, version: 1, messageId: state.messageId })
      if (!parsed.success) throw new Error('Invalid presentation selection: use text/table/ui/mixed and a nonempty reason of at most 500 characters. You may continue with text.')
      const existing = current(exec.agent, binding) ?? binding.reservation?.decision
      if (existing) {
        if (existing.presentation !== parsed.data.presentation) throw new Error(`Presentation is already ${existing.presentation} for this user message. Reuse it; a new user message is required to change format. Supporting text remains available.`)
        return existing
      }
      binding.reservation = { callId: exec.callId, decision: parsed.data }
      return parsed.data
    },
  }))
  ctx.effect(() => () => { bindings.clear(); sessions.clear() }, 'intelligent-ui routing state')
}
