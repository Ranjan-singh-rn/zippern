/**
 * QA #39 (3 Nov 2026) — the staff invitation, in plain words.
 *
 * Inviting an address on a reserved domain (`.test`, `example.com`, …) showed
 * the API's raw validator text — "email value is not a valid email address:
 * The domain name x.test is a special-use or reserved name that cannot be used
 * with email." Now the reason is said as an instruction. The role names the
 * invitation email uses are the CRM's own ("Support Team", not "Support
 * Member"); that half is in `backend/app/core/role_labels.py`, and
 * `staffInvite.spec.ts` checks the two lists agree.
 *
 * No imports: the spec runs the shipped module standalone.
 */

/** The obvious mistakes, caught before the request. The API stays the judge. */
export function inviteEmailProblem(email: string): string | null {
  const v = (email ?? '').trim()
  if (!v) return 'Enter the person\'s email address.'
  if ((v.match(/@/g) ?? []).length !== 1) return 'Enter one email address.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'That is not a valid email address.'
  return null
}

/** The API's refusal of an invitation, worded for the person inviting. */
export function inviteErrorText(message: string): string {
  const m = String(message ?? '')
  if (/value is not a valid email address/i.test(m)) {
    if (/special-use or reserved name|reserved/i.test(m)) {
      return 'That address is on a reserved test domain and cannot receive email. Use the person\'s own working address.'
    }
    if (/does not accept email|does not exist|no MX/i.test(m)) {
      return 'That address\'s domain does not accept email. Check the spelling, or use another address.'
    }
    return 'That is not a valid email address. Check it and try again.'
  }
  return m
}
