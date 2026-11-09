/**
 * Provider-route failover for the main Session and its Executors.
 *
 * Each role owns an ordered chain: its configured primary model followed by the fallbacks saved in the management panel.
 * A provider-side failure opens a cooldown on the route that failed, and the next attempt of the same step runs on the
 * first route whose cooldown has passed. Every request re-reads the chain, so a session that fell back returns to its
 * primary as soon as that route is usable again — and a model changed in the panel takes effect on the next request
 * instead of needing the Session to be recreated.
 *
 * The main Session is probed while its primary route is cooling down, so a real Eval is never the experiment.
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, LlmFailure } from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { HealthEntry } from '../infra/health.ts'
import type { RoleModel, Settings } from '../policy.ts'
import type { Store } from './store.ts'

declare module '@deepseek-ai/dsh-session' {
  interface PluginRecordMap {
    /** One route switch of one Session; the record is audit only and never enters model-visible history. */
    'plugin:iflink/model-fallback': { kind: 'fallback'; from: string; to: string; code: string; at: number }
  }
}

/** Which chain a Session draws on: the main Session routes, every other managed Session executes. */
export type RouteRole = 'router' | 'worker'
/** One row of a role's chain with its live cooldown state, as the management panel shows it. */
export interface RouteState { role: RouteRole; provider: string; model: string; state: 'ready' | 'cooling'; until?: string }
/** Failures that mean the route is unavailable rather than the request being wrong. */
const FAILOVER_CODES = new Set([
  'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'EMPTY_RESPONSE', 'QUOTA', 'ACCOUNT_QUOTA',
  // A rejected key or an exhausted subscription on one route is a reason to try another provider, not to end the turn.
  'AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'NO_ADAPTER', 'UNKNOWN_MODEL',
])
/** How long a failed route is skipped before it may be tried again. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000
/** How often the main Session's primary route is probed while it is cooling down. */
const DEFAULT_PROBE_MS = 60_000
/** Whether `error` carries one of the provider-side codes this router fails over on. */
export const isFailoverError = (error: unknown): boolean =>
  typeof (error as { code?: unknown } | undefined)?.code === 'string' && FAILOVER_CODES.has((error as { code: string }).code)
/** Tokens a probe may spend; providers still bill the request, so it stays minimal. */
const PROBE_TOKENS = 8

const routeKey = (route: { provider: string; model: string }): string => `${route.provider}/${route.model}`
const sameRoute = (a: { provider: string; model: string }, b: { provider: string; model: string }): boolean =>
  a.provider === b.provider && a.model === b.model
/** The resolved request config with one chain route applied; an inherited effort never leaks onto a model that did not choose it. */
function routeConfig(resolved: LlmCallConfig, route: RoleModel): LlmCallConfig {
  const { reasoningEffort: _inherited, ...rest } = resolved
  return { ...rest, provider: route.provider, model: route.model,
    ...route.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(route.reasoningEffort) } }
}

/** Host dependencies of the router. */
export interface ModelRouterHost {
  readonly context: Context
  readonly store: Pick<Store, 'settings'>
  /** The main Session's id: its chain is the router's, every other Session's is the Executor's. */
  readonly masterId: string
  /** The `model-fallback` health entry; it reports an error while a role runs off its primary route. */
  readonly health: HealthEntry
}

/** Options that tests shorten; production uses the defaults. */
export interface ModelRouterOptions { cooldownMs?: number; probeMs?: number }

/**
 * Routes model requests across each role's chain of providers and models.
 *
 * It reads settings on every request, so a saved chain or a repaired provider applies without restarting anything. It
 * keeps no per-Session state: the cooldown table alone decides, which also means a restarted process tries its primary
 * models again first.
 */
export class ModelRouter {
  private readonly cooldownMs: number
  private readonly probeMs: number
  private readonly cooling = new Map<string, { until: number; code: string; role: RouteRole }>()
  private readonly hops = new Map<string, { turn: number; step: number; count: number }>()
  private readonly switches = new Map<string, number>()
  private timer?: ReturnType<typeof setInterval>
  private probing = false
  private disposed = false

  constructor(private readonly host: ModelRouterHost, options: ModelRouterOptions = {}) {
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS
    this.probeMs = options.probeMs ?? DEFAULT_PROBE_MS
  }

  /** Subscribe the routing listeners and start probing the main Session's primary route. */
  install(): void {
    const ctx = this.host.context
    this.host.context.effect(() => {
      const disposeRequest = ctx.on('agent/request', async (payload, next) => {
        const resolved = await next()
        try {
          const target = this.target(this.roleOf(payload.agent), resolved)
          return target ? routeConfig(resolved, target) : resolved
        } catch (error) {
          ctx.logger.warn('model-router: could not route a request, using the resolved model: %s', String(error))
          return resolved
        }
      })
      // Registered after the loop's own retry policy, so this listener only sees attempts whose retries are exhausted.
      const disposeError = ctx.on('agent/request-error', async (payload, next) => {
        const downstream = await next()
        if (downstream?.kind === 'retry') return downstream
        try {
          return this.failed(payload.agent, payload.provider, payload.failure, payload.turn, payload.step) ? { kind: 'retry' as const }
            : downstream
        } catch (error) {
          ctx.logger.warn('model-router: could not fail over a model request: %s', String(error))
          return downstream
        }
      })
      return () => { disposeRequest(); disposeError(); this.stopProbe() }
    }, 'model-router: routing listeners')
    this.startProbe()
  }

  /** Stop probing and drop every cooldown, as a disposing host expects. */
  dispose(): void {
    this.disposed = true
    this.stopProbe()
    this.cooling.clear()
    this.hops.clear()
  }

  /** When this Session last moved to another route, so a failed main-Session turn can be resumed instead of waiting out its Eval. */
  lastSwitchAt(sessionId: string): number | undefined { return this.switches.get(sessionId) }

  /** Whether any route of `role` is usable now; resuming a turn while every route cools down would only fail again. */
  hasRoute(role: RouteRole): boolean { return this.chain(role).some(route => this.closed(route)) }

  /** Which chain the Session draws on: only the main Session routes. */
  roleOf(agent: Agent): RouteRole { return agent.id === this.host.masterId ? 'router' : 'worker' }

  /** The route the next request of `role` should use, or `null` when its chain is empty. */
  preferred(role: RouteRole): RoleModel | null {
    const chain = this.chain(role)
    if (!chain.length) return null
    return chain.find(route => this.closed(route)) ?? chain[0]!
  }

  /** The route a request currently resolved to `resolved` should use instead, or `undefined` to leave it alone. */
  target(role: RouteRole, resolved: { provider: string; model: string }): RoleModel | undefined {
    const chain = this.chain(role)
    if (!chain.length) return undefined
    if (this.primary(role) === null) {
      // No configured primary: the Session's own model leads, and fallbacks apply only once it is cooling down.
      if (this.closed(resolved)) return undefined
      return chain.find(route => this.closed(route) && !sameRoute(route, resolved))
    }
    // An Executor Session a person pointed at some other model keeps it; the configured role model is what this router manages.
    if (role === 'worker' && !chain.some(route => sameRoute(route, resolved))) return undefined
    const next = chain.find(route => this.closed(route))
    return next && !sameRoute(next, resolved) ? next : undefined
  }

  /** Record a failed attempt, open its cooldown, and return whether a different route can take over. */
  private failed(agent: Agent, provider: string, failure: LlmFailure, turn: number, step: number): boolean {
    if (!FAILOVER_CODES.has(failure.code)) return false
    const role = this.roleOf(agent)
    const chain = this.chain(role)
    if (!chain.length) return false
    const model = agent.session.requestHeader()?.config.model
    if (!model) return false
    const failedRoute = { provider, model }
    const primary = this.primary(role)
    if (primary !== null && !chain.some(route => sameRoute(route, failedRoute))) return false
    if (this.hop(agent.id, turn, step) >= chain.length) return false
    this.open(failedRoute, role, failure.code)
    const next = chain.find(route => this.closed(route) && !sameRoute(route, failedRoute))
    if (!next) { this.report(); return false }
    this.bump(agent.id, turn, step)
    this.switches.set(agent.id, Date.now())
    // The record is audit only: a Session that cannot take one still fails over.
    try {
      appendPluginRecord(agent.session, 'plugin:iflink/model-fallback',
        { kind: 'fallback', from: routeKey(failedRoute), to: routeKey(next), code: failure.code, at: Date.now() })
    } catch (error) { this.host.context.logger.warn('model-router: could not record a route switch: %s', String(error)) }
    this.host.context.logger.warn('model-router: %s → %s after %s', routeKey(failedRoute), routeKey(next), failure.code)
    this.report()
    return true
  }

  /** The saved primary of one role, which may be absent when the role inherits the DSH default model. */
  private primary(role: RouteRole): RoleModel | null {
    const settings = this.settings()
    return role === 'router' ? settings.eval.model : settings.executor.model
  }

  /** The ordered routes of one role: primary first, then the saved fallbacks. */
  private chain(role: RouteRole): RoleModel[] {
    const settings = this.settings()
    const model = role === 'router' ? settings.eval.model : settings.executor.model
    const fallbacks = role === 'router' ? settings.eval.fallbacks : settings.executor.fallbacks
    return model ? [model, ...fallbacks] : [...fallbacks]
  }

  private settings(): Settings { return this.host.store.settings() }

  private closed(route: { provider: string; model: string }): boolean {
    const entry = this.cooling.get(routeKey(route))
    return entry === undefined || entry.until <= Date.now()
  }

  private open(route: { provider: string; model: string }, role: RouteRole, code: string): void {
    this.cooling.set(routeKey(route), { until: Date.now() + this.cooldownMs, code, role })
  }

  /** How many routes this step already switched through, resetting when the Session moves to another step. */
  private hop(sessionId: string, turn: number, step: number): number {
    const state = this.hops.get(sessionId)
    return state?.turn === turn && state.step === step ? state.count : 0
  }

  private bump(sessionId: string, turn: number, step: number): void {
    const count = this.hop(sessionId, turn, step) + 1
    this.hops.set(sessionId, { turn, step, count })
  }

  /** Whether the main Session currently runs off its primary route, which makes its assessment provisional. */
  degraded(): boolean {
    const primary = this.primary('router')
    return primary !== null && !this.closed(primary)
  }

  /** Every chain route of both roles with its cooldown state, for the management panel. */
  routeStates(): RouteState[] {
    return (['router', 'worker'] as const).flatMap(role => this.chain(role).map(route => {
      const entry = this.cooling.get(routeKey(route))
      const cooling = entry !== undefined && entry.until > Date.now()
      return { role, provider: route.provider, model: route.model, state: cooling ? 'cooling' as const : 'ready' as const,
        ...cooling ? { until: new Date(entry.until).toISOString() } : {} }
    }))
  }

  /** Mirror the routing state into the health board; a degraded main Session is an error the panel and the monitor both show. */
  private report(): void {
    const primary = this.primary('router')
    const cooling = [...this.cooling.values()].filter(entry => entry.until > Date.now())
    if (!primary || cooling.length === 0) {
      this.host.health.set({ state: 'ready', detail: 'Every model route in both backup chains is available', at: new Date().toISOString() })
      return
    }
    const active = cooling.find(entry => entry.role === 'router')
    this.host.health.set({ state: 'error', at: new Date().toISOString(), detail: active
      ? `The main Session runs on a backup model: ${active.code} on one of its routes; ${cooling.length} route(s) cooling down`
      : `${cooling.length} model route(s) cooling down after a provider failure` })
  }

  private startProbe(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.probeMs)
    this.timer.unref?.()
  }

  private stopProbe(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** Probe the main Session's primary route while it cools down, and close the cooldown once it answers. */
  private async tick(): Promise<void> {
    if (this.disposed || this.probing) return
    // Cooldowns lapse with the clock, not with a failure: refresh the health entry so a recovered provider clears the alert.
    this.report()
    const primary = this.primary('router')
    if (primary === null || this.closed(primary)) return
    this.probing = true
    try {
      // Only success ends the cooldown early: a failed probe changes nothing, so a dead provider stays cooling for the
      // rest of its cooldown instead of being retried by every Executor between probes.
      if (await this.probe(primary)) {
        this.cooling.delete(routeKey(primary))
        this.host.context.logger.warn('model-router: %s answers again; the main Session returns to it', routeKey(primary))
        this.report()
      }
    } finally { this.probing = false }
  }

  /** Send one minimal request through a route; true when it produced a usable finish. */
  private async probe(route: RoleModel): Promise<boolean> {
    try {
      const stream = this.host.context.llm.stream({ provider: route.provider, model: route.model, maxTokens: PROBE_TOKENS,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] })
      for await (const chunk of stream) {
        if (chunk.type !== 'finish') continue
        return chunk.reason.kind !== 'error' && chunk.reason.kind !== 'aborted'
      }
      return false
    } catch { return false }
  }
}
