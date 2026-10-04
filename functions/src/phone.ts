/**
 * PHONE NUMBERS AS IDENTITY — the canonical key, with no Firestore in it.
 *
 * ── WHAT THIS REPLACES, AND WHY IT HAD TO GO ────────────────────────────────
 *
 * The key was the LAST TEN DIGITS:
 *
 *     digits.length > 10 ? digits.slice(-10) : digits
 *
 * with the reasoning, written out in `hosts.ts`, that "an Indian mobile number
 * is ten digits and everything to the left is a country code or a trunk prefix
 * that one side has and the other does not". That is true of India and false of
 * the world, and three things followed from it:
 *
 *   1. `+1 415 555 0100` and `+91 41555 50100` produce the same key. They are
 *      two people in two countries.
 *   2. `bindVerifiedIdentity` looks an account up by that key and, when the
 *      holder is permanently deactivated, BLANKS its `phoneKey`, `phoneNumber`
 *      and `email`. So a US sign-in could erase the phone identity of an
 *      unrelated Indian account. That is the worst outcome in this file and it
 *      is why this module exists.
 *   3. When the holder is active, the newcomer is told "this phone number is
 *      already used by another Zipper account" — a legitimate foreign user,
 *      refused, pointing at an account that is not theirs.
 *
 * ── THE MODEL ───────────────────────────────────────────────────────────────
 *
 * The canonical key is every digit of the E.164 number — country code included.
 * `+14155550100` keys as `14155550100`; `+914155550100` keys as `914155550100`.
 * They are different strings, so they are different identities, which is the
 * whole requirement.
 *
 * ── THE PART THAT CANNOT SIMPLY BE SWITCHED ─────────────────────────────────
 *
 * Every `users.phoneKey` already written is a ten-digit value. Changing the
 * function alone would make every existing lookup miss, and a miss on
 * `findExistingAccount` reads as "no account exists" — which is how a returning
 * Indian user would be handed a second account. So the legacy key stays
 * readable: [legacyPhoneKey] computes it, lookups try it as a FALLBACK, and
 * [sameNumber] decides whether a legacy hit is really the same person rather
 * than a ten-digit coincidence.
 *
 * Nothing here writes, migrates or deletes. The survey script
 * `backend/scripts/survey_phone_keys.py` reports what a migration would face.
 */

/** Digits only, country code included. '' when there is nothing usable. */
export function digitsOf(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '')
}

/**
 * The canonical identity key: every digit, country code and all.
 *
 * Deliberately NOT a validator. A number this cannot make sense of still gets a
 * key, because refusing to key a number means refusing the person — and the
 * place that decides whether a number is acceptable is the form that collects
 * it, not the function that compares it.
 */
export function phoneE164Key(raw: unknown): string {
  return digitsOf(raw)
}

/**
 * The OLD key — last ten digits — for reading records written before this
 * change. Never write this, and never trust a match on it alone: see
 * [sameNumber], which is what a fallback hit has to pass.
 */
export function legacyPhoneKey(raw: unknown): string {
  const digits = digitsOf(raw)
  return digits.length > 10 ? digits.slice(-10) : digits
}

/**
 * Does this look like a full international number rather than a local one?
 *
 * A leading zero on a number with no `+` is a TRUNK PREFIX, not a country code —
 * `098765 43210` is how an Indian number is commonly written down, and reading
 * its eleven digits as "already international" would make it a number no
 * country owns. Stripped before the length is judged.
 */
export function hasCountryCode(raw: unknown): boolean {
  const s = String(raw ?? '').trim()
  if (s.startsWith('+')) return true
  return digitsOf(s).replace(/^0+/, '').length > 10
}

/**
 * Are these two the same telephone number?
 *
 * Three cases, and the third is the one that matters:
 *
 *   * BOTH carry a country code → exact digit equality. `+14155550100` and
 *     `+914155550100` are not equal, and that is the point.
 *   * NEITHER carries one → compare them as typed. Two bare national numbers
 *     from the same form, so there is nothing to disambiguate.
 *   * ONE carries one and the other does not → the bare one is a national
 *     number whose country we do not know. It matches only if it is the tail of
 *     the other AND what remains in front is a plausible country code (1–3
 *     digits). `4155550100` therefore matches both `+14155550100` and
 *     `+914155550100`, and the caller must not treat that as proof of identity
 *     on its own — which is why `activateHost` also requires the email, and why
 *     `bindVerifiedIdentity` requires [sameNumberStrict].
 */
export function sameNumber(a: unknown, b: unknown): boolean {
  const x = digitsOf(a)
  const y = digitsOf(b)
  if (x === '' || y === '') return false
  if (x === y) return true

  const ax = hasCountryCode(a)
  const by = hasCountryCode(b)
  if (ax === by) return false // both full, or both bare, and they differ

  const [bare, full] = ax ? [y, x] : [x, y]
  if (!full.endsWith(bare)) return false
  const prefix = full.slice(0, full.length - bare.length)
  return prefix.length >= 1 && prefix.length <= 3
}

/**
 * The same question, with no benefit of the doubt.
 *
 * Used wherever a match CHANGES something: releasing a phone claim from another
 * account, deciding two records are one person, refusing a sign-up because the
 * number is taken. An ambiguous pair — one bare number, one international — is
 * not a match here, because the cost of being wrong is somebody else's account.
 */
export function sameNumberStrict(a: unknown, b: unknown): boolean {
  const x = digitsOf(a)
  const y = digitsOf(b)
  return x !== '' && x === y
}
