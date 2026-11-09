/** Keeping a chat's pace of social reactions: a person is not answered twice in a row, and a chat gets few. */
import type { Gesture, GestureBudget, Trigger } from '../core/index.ts'
import { KV } from '../kv.ts'
import type { Store } from './store.ts'

/** How long a person waits before the agent may react to them again, and how many a chat gets in an hour. */
export const PERSON_MINUTES = 30, PER_HOUR = 2
/**
 * Gestures admits a social reaction only when the chat has room for it: no reaction to the same person within
 * `PERSON_MINUTES`, and fewer than `PER_HOUR` in the rolling hour. A refusal is recorded by the Decision, so a chat that
 * has had its share is visible rather than silent, and the pace lives in the Store so a restart does not start it over.
 */
export class Gestures implements GestureBudget {
  constructor(private readonly store: Pick<Store, 'get' | 'set'>, private readonly now: () => number = Date.now) {}
  admit(trigger: Trigger, _gesture: Gesture): boolean {
    const at = new Date(this.now()).toISOString()
    const chat = String(trigger.meta.chatId ?? '')
    const person = trigger.actor.id
    const last = this.store.get(KV.gestures.person(person))
    if (last && this.now() - Date.parse(last) < PERSON_MINUTES * 60_000) return false
    const pace = this.store.get(KV.gestures.pace(chat))
    const within = pace && this.now() - Date.parse(pace.at) < 3600_000 ? pace.count : 0
    if (within >= PER_HOUR) return false
    this.store.set(KV.gestures.pace(chat), { at, count: within + 1 })
    this.store.set(KV.gestures.person(person), at)
    return true
  }
}
