/**
 * The two JSON routes behind the update card.
 *
 * Kept apart from the login routes because they answer a different question and
 * fail differently: a login route drives one attempt, while these read the
 * network and the running installation and must never present a failure as a
 * normal answer.
 *
 * Both are registered on the same fenced `/api/channel-wechat` prefix, so they
 * inherit the harness's own token and cookie check rather than re-implementing
 * one.
 *
 * @module dsh-channel-wechat/channel/update-routes
 */

import type { UpdateCheck } from './update-check.ts'
import type { UpdateCommand } from './update-command.ts'

/** What the update routes read. */
export interface UpdateRoutesOptions {
  /** Read the registry's latest version. */
  check: () => Promise<UpdateCheck>
  /** Build the command for this profile, or undefined when none can be built. */
  command: () => UpdateCommand | undefined
}

/** The update route handlers. */
export interface UpdateRoutes {
  /** GET the version comparison. */
  check: () => Promise<Response>
  /** GET the copy-pasteable command. */
  command: () => Promise<Response>
}

/** JSON response no cache may hold, so a reopened page re-reads the registry. */
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

/**
 * Build the update routes.
 * @param options - the version check and the command builder.
 * @returns one handler per route.
 */
export function createUpdateRoutes(options: UpdateRoutesOptions): UpdateRoutes {
  return {
    async check(): Promise<Response> {
      // Served with its own status field rather than mapped to an HTTP status:
      // the page renders "could not check" differently from "no update", and a
      // non-200 would reach the page as a generic network failure carrying no
      // reason at all.
      return json(await options.check())
    },

    async command(): Promise<Response> {
      const command = options.command()
      if (command === undefined) {
        // A Desktop profile with no carrier path is the one case with no honest
        // command: answering with an empty string would render a copy button
        // that copies nothing.
        return json({ error: '此部署无法生成更新命令' }, 501)
      }
      return json(command)
    },
  }
}
