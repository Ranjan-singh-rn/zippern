/**
 * ONE DEVICE, ONE GUEST ACCOUNT — the decision, with no Firestore in it.
 *
 * ── WHY THIS IS A SEPARATE, PURE FUNCTION ────────────────────────────────────
 *
 * The rule it encodes is the kind that is obvious in prose and wrong in code:
 * every branch either hands out a session for somebody's account or creates a
 * new one, and the two failures look nothing alike from the outside. Handing out
 * the wrong session is a takeover. Creating one account too many is the original
 * bug — a guest's diamonds, level and history stranded on a uid nothing can
 * reach, with a fresh empty account in front of the person and nothing anywhere
 * saying why.
 *
 * Inside the callable those branches are reachable only with an Auth record, a
 * Firestore document, a transaction and a device that has been through a
 * particular history. Out here they are eight booleans, so all of them can be
 * asserted — including the ones that need two processes racing, an account
 * purged by the sweeper, or a handset whose Block Store was wiped.
 *
 * `claimGuestIdentity` in identity.ts gathers the inputs and performs the write.
 * It makes no decisions of its own.
 */

export type GuestClaimStatus =
  /** Nothing is bound to this device. The caller may create a guest and bind it. */
  | 'no_guest'
  /** A guest is bound and a custom token should be issued for it. */
  | 'existing_guest'
  /** A guest is bound and this install cannot prove it owns it. No token, no replacement. */
  | 'unrecoverable'
  /** The binding was just created for the uid the caller supplied. */
  | 'bound'
  /** Barred handset. No new guest will be created here. */
  | 'device_banned'
  /**
   * The caller holds one account with real data, the device is bound to another.
   * Both sides may matter, so neither is chosen. Nothing is written.
   */
  | 'conflict'
  /**
   * The bound account has grown into a full one — Google or a phone attached.
   *
   * The binding stands, so the device still gets no second guest, but no session
   * is handed out for it either: an account with its own credentials should be
   * reached with them, not by holding the handset.
   */
  | 'upgraded'
  /**
   * The uid the CALLER offered is not a guest, so it is not a candidate for this
   * device's guest slot and nothing was written.
   *
   * Reached when a saved quick-login credential turns out to belong to a full
   * account. "Continue as guest" then has nothing to do with it: the caller
   * should let go of that account and ask again for the device's actual guest.
   */
  | 'not_a_guest'

export type GuestClaimWrite =
  /** Write the binding, replacing a released one if there was one. */
  | 'bind'
  /** Keep the uid, store the presented secret's hash over the old one. */
  | 'rekey'
  /** Bump `lastSeenAt` only. */
  | 'touch'
  | 'none'

export interface GuestClaimInput {
  /** Is the handset barred. Consulted only when a guest would be CREATED. */
  deviceBanned: boolean
  /** The uid this device is bound to, or '' for none. */
  boundUid: string
  /** Does `sha256(presented secret)` equal the stored hash. */
  secretMatches: boolean
  /** Does `users/{boundUid}` exist. Meaningless when `boundUid` is ''. */
  boundUserExists: boolean
  /**
   * Has the bound account attached a provider of its own — Google, a phone.
   * Such an account can sign in without the binding, so it releases the device.
   */
  boundIsUpgraded: boolean
  /** Age of the binding, or null when it has no `createdAt`. */
  bindingAgeMs: number | null
  /** The uid the caller wants bound, or '' when it is only asking. */
  wantedUid: string
  /**
   * Does `users/{wantedUid}` exist — i.e. does the caller's own account hold
   * anything.
   *
   * This is what separates a genuine identity conflict from a race that has
   * already been lost. A uid created seconds ago by a client that read `no_guest`
   * has no document, no balance and no history, so discarding it costs nothing
   * and the caller should simply take the account that won. A uid with a document
   * behind it is somebody's data, and choosing between two of those is not a
   * decision to make inside a login flow.
   */
  wantedUserExists: boolean
  /**
   * Has the caller's own account got a provider attached — i.e. is it NOT a guest.
   *
   * A full account must never be written into the guest slot. Doing so is not a
   * harmless mislabelling: it blocks that handset from ever having a real guest,
   * and it makes "Continue as guest" a credential-free door into somebody's email
   * account for as long as the binding stands.
   */
  wantedIsUpgraded: boolean
  /**
   * Is the caller already signed in AS the bound account — a verified Firebase
   * ID token for that uid, checked by Firebase before this ran.
   *
   * Stronger proof than the device secret, and the only thing that lets a
   * handset which lost its secret keep its account instead of being told it
   * cannot have it back.
   */
  callerIsBoundUid: boolean
}

export interface GuestClaimDecision {
  status: GuestClaimStatus
  /** The uid the answer is about. '' when there is nothing to talk about. */
  uid: string
  write: GuestClaimWrite
  /** Why a binding was released, for the support trail. */
  replacedReason: 'account_purged' | 'account_upgraded' | ''
}

/**
 * How long a binding with no `users` document behind it is treated as live.
 *
 * The client binds its new uid and then writes the profile, so for a moment a
 * binding legitimately points at a document that does not exist yet. Inside this
 * window that is read as in flight and recovered; outside it, as a uid that has
 * been purged.
 *
 * Without the window, a first launch killed between those two writes would read
 * its own half-finished binding as dead on the next launch and abandon it.
 */
export const BINDING_GRACE_MS = 10 * 60 * 1000

/**
 * The identity half of a new binding document: the uid, and the record of what
 * it displaced.
 *
 * Separate and pure because of the bug it is named after. This used to be built
 * inline with `FieldValue.delete()` standing in for "no previous binding" — and
 * that sentinel is only legal in `update()` or in `set()` with `{merge: true}`.
 * In the plain `set` this goes into, the SDK throws, the callable framework
 * reports a non-HttpsError as the opaque code INTERNAL, and the very first guest
 * on every new handset failed with "internal error" and no explanation. The
 * decision logic was tested to death; the three lines that wrote the result were
 * not tested at all, and that is where it was.
 *
 * Keys are omitted rather than deleted. A `set` without merge replaces the whole
 * document, so an absent key IS a deleted one.
 */
export function bindingPayload(
  decision: GuestClaimDecision,
  previousUid: string,
): Record<string, string> {
  const out: Record<string, string> = { uid: decision.uid }
  // Only when something was actually displaced, so a support question about a
  // released device has an answer and a first binding carries no empty fields.
  if (previousUid !== '') {
    out.replaced = previousUid
    out.replacedReason = decision.replacedReason
  }
  return out
}

export function decideGuestClaim(input: GuestClaimInput): GuestClaimDecision {
  const {
    deviceBanned, boundUid, secretMatches, boundUserExists,
    boundIsUpgraded, bindingAgeMs, wantedUid, wantedUserExists, wantedIsUpgraded,
    callerIsBoundUid,
  } = input

  /*
   * ── THE CALLER'S ACCOUNT IS NOT A GUEST ──────────────────────────────────
   *
   * Checked before anything else, because it disqualifies the caller's uid from
   * every branch below rather than changing the answer in one of them.
   *
   * This is what stops a saved sign-in for a full account being written into the
   * guest slot. The route in is ordinary: quick login is tried first in the guest
   * flow for speed, it restores whatever account was last signed in, and if that
   * was an email or Google account the client would offer THAT uid for binding.
   * Allowed through, two things break at once — the handset can never have a real
   * guest again, and "Continue as guest" becomes a door into that account with no
   * credential presented.
   *
   * It is deliberately not an error. The caller is told its account is not the
   * one in question and asks again without it; the device's actual guest, if
   * there is one, is then reached by the ordinary route.
   */
  if (wantedUid !== '' && wantedIsUpgraded) {
    return { status: 'not_a_guest', uid: boundUid, write: 'none', replacedReason: '' }
  }

  const settled = bindingAgeMs == null || bindingAgeMs > BINDING_GRACE_MS

  /*
   * A binding whose account has been PURGED is a dead pointer, not an account,
   * and it is the only thing that may be replaced. Holding the device to it for
   * ever would mean that deleting a guest account bars the handset from having
   * another one.
   *
   * Note what is NOT here: an account that grew into a full one keeps its
   * binding. Releasing it would let one person turn one handset into an endless
   * supply of guest accounts — upgrade, release, repeat — and every one of them
   * collects whatever a new guest collects. See the `upgraded` branch below for
   * how the other half of that problem is handled.
   */
  const purged = boundUid !== '' && !boundUserExists && settled

  if (boundUid === '' || purged) {
    // Only asking. Nothing is created on a question.
    if (wantedUid === '') {
      return { status: 'no_guest', uid: '', write: 'none', replacedReason: '' }
    }
    /*
     * The ban is checked HERE and not at the top, because it answers a different
     * question in each direction. Refusing to create a new account on a barred
     * handset is this function's business — that is the abuse the collection
     * exists to stop. Refusing to RECOVER the account already bound is not:
     * `resolveIdentity` owns what a restricted account or barred device is told,
     * and bars the device again on the way past. Two places deciding that would
     * mean one of them is wrong, and it would be this one.
     */
    if (deviceBanned) {
      return { status: 'device_banned', uid: '', write: 'none', replacedReason: '' }
    }
    return {
      status: 'bound',
      uid: wantedUid,
      write: 'bind',
      replacedReason: boundUid === '' ? '' : 'account_purged',
    }
  }

  /*
   * ── A LIVE BINDING ─────────────────────────────────────────────────────────
   *
   * From here nothing is created and nothing is replaced, whatever uid the
   * caller arrived holding. This is the half that enforces one-guest-per-device,
   * and it is why the caller's `uid` is a request rather than an instruction.
   */

  /*
   * TWO ACCOUNTS WITH DATA IN THEM, ONE DEVICE. Fail closed.
   *
   * Neither side is assumed correct: picking the binding would abandon whatever
   * is in the caller's account, picking the caller would hand the device to an
   * account that did not earn it, and creating a third would be the duplicate
   * bug with extra steps. So the answer is to refuse, say so, and leave an
   * audit trail for somebody to look at.
   *
   * A caller whose uid has no document is NOT this case — that is a client that
   * lost a race, holding an account with nothing in it, and it is told to use
   * the one that won.
   */
  if (wantedUid !== '' && wantedUid !== boundUid && wantedUserExists) {
    return { status: 'conflict', uid: boundUid, write: 'none', replacedReason: '' }
  }

  /*
   * THE BOUND ACCOUNT IS NO LONGER A GUEST.
   *
   * The binding stays — the device does not get a second guest — but no session
   * is handed out for an account that has its own way in. Otherwise "Continue as
   * guest" on a handset whose owner has signed out would open their full account
   * for whoever is holding it, with no credential presented at all.
   *
   * Unless the caller already IS that account, with a verified token for it — in
   * which case nothing is being released to anybody, and refusing would log
   * somebody out of their own session for having upgraded it.
   */
  if (boundIsUpgraded && !callerIsBoundUid) {
    return { status: 'upgraded', uid: boundUid, write: 'none', replacedReason: '' }
  }

  /*
   * The secret is what releases the account, never the device id. A device id is
   * an identifier, not a credential: it is stored on `users/{uid}.deviceId`, and
   * `users/{uid}` is readable by any signed-in account — so if the id were
   * enough, every guest balance in the app would be one document read away from
   * a stranger.
   */
  if (!secretMatches) {
    /*
     * ── THE ONE WAY BACK FROM A LOST SECRET ────────────────────────────────
     *
     * A caller already holding a verified session for the bound uid has proved
     * ownership by a route the device secret only approximates — Firebase
     * checked the token before this function ran. So the secret is replaced
     * rather than the account refused, and the handset keeps working after a
     * Block Store wipe instead of being told for ever that it cannot have its
     * own guest account back.
     *
     * This cannot be used to reach an account the caller does not already have:
     * it requires a session for exactly the bound uid, which is the thing being
     * asked for.
     */
    if (callerIsBoundUid) {
      return { status: 'existing_guest', uid: boundUid, write: 'rekey', replacedReason: '' }
    }
    return { status: 'unrecoverable', uid: boundUid, write: 'none', replacedReason: '' }
  }

  return { status: 'existing_guest', uid: boundUid, write: 'touch', replacedReason: '' }
}
