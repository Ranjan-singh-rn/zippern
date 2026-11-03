/**
 * QA #46 (3 Nov 2026) — the "Forgot password" box.
 *
 * The box opens pre-filled with the address typed on the sign-in form, with
 * the cursor at its end. A person who typed their address again got it twice
 * ("a@x.testa@x.test") and the vague "Could not send reset email. Check the
 * address and try again." Now the pre-filled address is selected when the box
 * opens (typing replaces it), an address that is not ONE address is caught
 * before sending, and Firebase's refusals are worded as what they are.
 *
 * No imports: `passwordReset.spec.ts` runs the shipped module standalone.
 */

/** A deliberately plain check — the server is the judge; this only catches the obvious. */
const ONE_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Why this text cannot be sent as a reset address, or null when it can. */
export function resetEmailProblem(text: string): string | null {
  const v = (text ?? '').trim()
  if (!v) return 'Enter your email address.'
  if ((v.match(/@/g) ?? []).length > 1) {
    return 'That looks like more than one email address. Enter just the one you sign in with.'
  }
  if (!ONE_ADDRESS.test(v)) return 'That is not a valid email address. Check it and try again.'
  return null
}

/** A refused reset request, in words a person can act on. */
export function resetErrorText(err: unknown): string {
  const code = String((err as { code?: unknown })?.code ?? '')
  switch (code) {
    case 'auth/invalid-email':
    case 'auth/missing-email':
      return 'That is not a valid email address. Check it and try again.'
    case 'auth/too-many-requests':
      return 'Too many reset requests from this browser. Wait a few minutes, then try again.'
    case 'auth/network-request-failed':
      return 'Could not reach the server. Check your connection and try again.'
    default:
      return 'Could not send the reset email just now. Try again in a minute.'
  }
}
