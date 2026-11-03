/**
 * QA #43 (3 Nov 2026) — "Change role" opens on the person's CURRENT role.
 *
 * The picker left the current role out and pre-selected the first role the
 * Owner may assign — "App Admin" — so an Owner who typed a reason and pressed
 * Change role without touching the list promoted a Support member to App
 * Admin. Now the current role is the first option and the one selected; the
 * button stays disabled until a DIFFERENT role is chosen, and the change is
 * spelled out ("Support Team → Finance Team") before it is confirmed.
 *
 * No imports, so the shipped module runs standalone (`rolePicker.spec.ts`).
 */

export interface RoleOption {
  value: string
  /** The person's role now — listed first, selected when the picker opens. */
  current: boolean
}

/** The current role first, then every OTHER role the actor may assign. */
export function rolePickerOptions(current: string, assignable: readonly string[]): RoleOption[] {
  const now = (current ?? '').trim()
  const others = assignable.filter((r) => r !== now)
  return [{ value: now, current: true }, ...others.map((value) => ({ value, current: false }))]
}

/** What the picker opens on: the role the person already holds. */
export function rolePickerInitial(current: string): string {
  return (current ?? '').trim()
}

/** Confirm is offered only for a real change, with a reason long enough. */
export function roleChangeReady(current: string, chosen: string, reason: string, minReason: number): boolean {
  return !!chosen && chosen !== (current ?? '').trim() && (reason ?? '').trim().length >= minReason
}

/** The change in words, shown above the button. */
export function roleChangeSummary(current: string, chosen: string, label: (role: string) => string): string {
  if (!chosen || chosen === current) return `No change yet — ${label(current)} is their role now. Choose the new role.`
  return `${label(current)} → ${label(chosen)}`
}
