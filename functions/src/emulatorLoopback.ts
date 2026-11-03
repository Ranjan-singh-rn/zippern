/**
 * Plain http to THIS machine, inside the Functions emulator only — the local
 * test copy (~/zipper-release/qa/local-stack.command), whose backend listens on
 * http://127.0.0.1:8000. `FUNCTIONS_EMULATOR` is set to 'true' by the emulator
 * and never on a deployed function, so a deployed function still refuses
 * anything that is not https:// — the service key never crosses a network in
 * clear text.
 *
 * A module of its own on purpose: everything index.ts exports is a deployed
 * function (the release scripts classify every export), so a helper must not be
 * one of them.
 */
export function isEmulatorLoopback(base: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.FUNCTIONS_EMULATOR !== 'true') return false
  return /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(base)
}
