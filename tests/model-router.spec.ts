/** Routing, cooldown, hop-guard, probe and degraded-state tests for the model router. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelRouter } from '../src/app/model-router.ts'
import { SettingsSchema, type Settings } from '../src/policy.ts'

type Route = { provider: string; model: string }
const route = (provider: string, model: string): Route => ({ provider, model })
const A = route('alpha', 'alpha-1'), B = route('beta', 'beta-1'), C = route('gamma', 'gamma-1')

const settings = (role: 'router' | 'worker', primary: Route, fallbacks: Route[]): Settings =>
  SettingsSchema.parse(role === 'router' ? { eval: { model: primary, fallbacks } } : { executor: { model: primary, fallbacks } })

interface Agent {
  id: string
  /** The route the Session would send with now, which the loop records in its request header before calling the provider. */
  sent: Route
  session: { requestHeader: () => { config: Route }; append: (type: string, data: unknown) => void }
}
const agent = (id: string, current: Route): Agent => ({ id, sent: current, session: { requestHeader: () => ({ config: current }),
  append: () => { throw new Error('no session log in this test') } } })

function harness(initial: Settings, probe: (route: Route) => 'ok' | 'fail' = () => 'ok') {
  const listeners = new Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>()
  let current = initial
  const probeCalls: Route[] = []
  const ctx = {
    on: (name: string, callback: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>) => {
      listeners.set(name, callback)
      return () => { listeners.delete(name) }
    },
    effect: (setup: () => () => void) => { setup() },
    logger: { warn: () => {} },
    llm: {
      async *stream(request: Route) {
        probeCalls.push({ provider: request.provider, model: request.model })
        yield { type: 'finish', reason: { kind: probe(request) === 'ok' ? 'stop' : 'error' } }
      },
    },
  }
  const health = { state: undefined as unknown, set: (value: unknown) => { health.state = value }, get: () => undefined, release: () => {} }
  const router = new ModelRouter({ context: ctx as never, store: { settings: () => current }, masterId: 'master', health: health as never },
    { cooldownMs: 60_000, probeMs: 30_000 })
  router.install()
  const request = async (who: Agent, resolved: Route) => {
    const listener = listeners.get('agent/request')!
    const applied = await listener({ agent: who, turn: 1, step: 1, signal: new AbortController().signal }, async () => resolved) as Route
    // The loop writes the applied route into the request header before the provider sees the request.
    who.sent = applied
    who.session.requestHeader = () => ({ config: applied })
    return applied
  }
  const error = async (who: Agent, provider: string, code: string, turn = 1, step = 1) => {
    const listener = listeners.get('agent/request-error')!
    return await listener({ agent: who, turn, step, provider, failure: { code, message: code }, retryPolicy: undefined,
      signal: new AbortController().signal }, async () => undefined)
  }
  return { router, health, request, error, probeCalls, setSettings: (next: Settings) => { current = next } }
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-08T00:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

describe('model router', () => {
  it('moves the main Session to the first fallback after a provider failure, and back once the cooldown passes', async () => {
    const h = harness(settings('router', A, [B]))
    const master = agent('master', A)
    expect(await h.request(master, A)).toEqual(A)
    expect(await h.error(master, 'alpha', 'SERVER')).toEqual({ kind: 'retry' })
    expect(await h.request(master, A)).toEqual(B)
    expect(h.router.degraded()).toBe(true)
    expect(h.health.state).toMatchObject({ state: 'error' })
    // After the cooldown the primary is tried again, which is the half-open attempt.
    vi.setSystemTime(new Date('2026-11-08T00:02:00Z'))
    expect(await h.request(master, B)).toEqual(A)
  })

  it('leaves a Session alone while its primary route is healthy and when the failure is not a provider failure', async () => {
    const h = harness(settings('router', A, [B]))
    const master = agent('master', A)
    expect(await h.request(master, A)).toEqual(A)
    expect(await h.error(master, 'alpha', 'CONTEXT_WINDOW_EXCEEDED')).toBeUndefined()
    expect(await h.request(master, A)).toEqual(A)
  })

  it('fails over when a route rejects the key or reports an exhausted subscription', async () => {
    const h = harness(settings('router', A, [B]))
    const master = agent('master', A)
    expect(await h.error(master, 'alpha', 'AUTH')).toEqual({ kind: 'retry' })
    expect(await h.request(master, A)).toEqual(B)
  })

  it('walks the rest of the chain and stops when every route is cooling down', async () => {
    const h = harness(settings('router', A, [B, C]))
    const master = agent('master', A)
    expect(await h.error(master, 'alpha', 'RATE_LIMIT')).toEqual({ kind: 'retry' })
    expect(await h.request(master, A)).toEqual(B)
    expect(await h.error(master, 'beta', 'SERVER')).toEqual({ kind: 'retry' })
    expect(await h.request(master, B)).toEqual(C)
    expect(await h.error(master, 'gamma', 'SERVER')).toBeUndefined()
    expect(await h.request(master, C)).toEqual(C)
  })

  it('routes Executor Sessions only while they run their configured model', async () => {
    const h = harness(settings('worker', A, [B]))
    const managed = agent('worker-t1', A), personal = agent('worker-t2', C)
    expect(await h.error(managed, 'alpha', 'SERVER')).toEqual({ kind: 'retry' })
    expect(await h.request(managed, A)).toEqual(B)
    expect(await h.error(personal, 'gamma', 'SERVER')).toBeUndefined()
    expect(await h.request(personal, C)).toEqual(C)
  })

  it('probes the main Session primary while it cools down and reports recovery', async () => {
    const h = harness(settings('router', A, [B]))
    const master = agent('master', A)
    await h.error(master, 'alpha', 'SERVER')
    expect(h.router.degraded()).toBe(true)
    await vi.advanceTimersByTimeAsync(31_000)
    expect(h.probeCalls).toEqual([A])
    expect(h.router.degraded()).toBe(false)
    expect(h.health.state).toMatchObject({ state: 'ready' })
  })

  it('keeps the main Session on its backup while the probe fails', async () => {
    const h = harness(settings('router', A, [B]), () => 'fail')
    const master = agent('master', A)
    await h.error(master, 'alpha', 'SERVER')
    await vi.advanceTimersByTimeAsync(31_000)
    expect(h.router.degraded()).toBe(true)
    expect(await h.request(master, B)).toEqual(B)
  })

  it('stops switching after one step used every route in the chain', async () => {
    const h = harness(settings('router', A, [B]))
    const master = agent('master', A)
    expect(await h.error(master, 'alpha', 'SERVER', 1, 1)).toEqual({ kind: 'retry' })
    // The same step cannot fail over twice: two routes were already tried.
    expect(await h.error(master, 'beta', 'SERVER', 1, 1)).toBeUndefined()
    // A later step starts its own budget.
    expect(await h.error(master, 'alpha', 'SERVER', 1, 2)).toEqual({ kind: 'retry' })
  })

  it('lists both chains with their cooldown state for the panel', async () => {
    const h = harness(SettingsSchema.parse({ eval: { model: A, fallbacks: [B] }, executor: { model: A, fallbacks: [C] } }))
    expect(h.router.routeStates().map(state => `${state.role}:${state.provider}/${state.model}:${state.state}`))
      .toEqual(['router:alpha/alpha-1:ready', 'router:beta/beta-1:ready', 'worker:alpha/alpha-1:ready', 'worker:gamma/gamma-1:ready'])
    await h.error(agent('master', A), 'alpha', 'SERVER')
    // Both chains lead with the same route, so one failure cools it for both roles.
    expect(h.router.routeStates().filter(state => state.state === 'cooling').map(state => `${state.role}:${state.model}`))
      .toEqual(['router:alpha-1', 'worker:alpha-1'])
  })
})
