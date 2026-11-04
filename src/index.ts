/**
 * dsh-superagent-qq — QQ official bot Source for dsh-superagent.
 *
 * Registers the 'qq' Source kind through the same extension seam the
 * bundled watchers use (inject 'orchestrator'), then keeps a WebSocket
 * gateway connection per configured bot alive: group @-messages and C2C
 * messages arrive in real time, become Triggers, and replies go back through
 * the OpenAPI as passive replies.
 *
 * @module dsh-superagent-qq
 */
import type { Context } from '@deepseek-ai/cordis'
import type { OrchestratorLike } from './types.ts'
import { qqKind, HEALTH_ENTRY } from './qq-kind.ts'
import { watch } from './watch.ts'

export const name: string = 'dsh-superagent-qq'
export const inject: string[] = ['orchestrator']

export function apply(ctx: Context): void {
  const orchestrator = (ctx as unknown as { orchestrator: OrchestratorLike }).orchestrator
  ctx.effect(() => orchestrator.sources.register(qqKind), 'qq: source kind')
  ctx.effect(() => {
    const source = orchestrator.context(qqKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report(HEALTH_ENTRY, { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  })
}
export { qqKind, QqConfigSchema } from './qq-kind.ts'
export { buildTrigger } from './watch.ts'
