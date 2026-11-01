/**
 * Unguessable object names for the two unauthenticated signup upload paths.
 *
 * ── WHY THE OLD NAMES WERE A PROBLEM ─────────────────────────────────────────
 *
 * `kyc/agencies/signup/` and `sellerDocs/signup/` are the only paths in the
 * bucket an unauthenticated caller may write, and they have to be: the agency
 * and seller signup forms upload identity documents at step 2 and only create
 * the Firebase account at submit, so there is no uid to bind the object to.
 *
 * `storage.rules` therefore cannot authorise a reader there either, and leaves
 * `allow get: if true` — the uploader's own `getDownloadURL()` immediately
 * after the upload is what mints the stored URL, and nothing else can be
 * distinguished from it. Enumeration is denied (`allow list: if false`) and so
 * is overwriting (`resource == null`), so the only remaining way in is to
 * guess an object name.
 *
 * The names were `doc1_<epoch-ms>`, `doc2_<epoch-ms>`, `doc3_<epoch-ms>` and
 * `<epoch-ms>_<the applicant's own filename>`. A millisecond timestamp is not
 * a secret: an attacker who knows roughly when somebody applied is searching a
 * few hundred thousand values for a named person's Aadhaar, and the three
 * documents of one application share a timestamp to within a few seconds of
 * each other. The filename variant was worse — it published the applicant's
 * own file naming to anyone who guessed the rest.
 *
 * ── WHAT REPLACES THEM ───────────────────────────────────────────────────────
 *
 * 122 random bits from the platform CSPRNG. That is the same entropy class as
 * the `?alt=media&token=` UUID Firebase itself puts on a download URL, so the
 * object name is no longer the weakest part of the chain.
 *
 * The `doc1`/`doc2`/`doc3` prefix is kept in front of it. It carries no
 * secret, costs nothing, and is what makes a bucket listing in the Firebase
 * console readable by a human looking for which of three documents is which.
 *
 * ── THE ORIGINAL FILENAME IS DROPPED, DELIBERATELY ───────────────────────────
 *
 * `sellerDocs/signup/` used to append `file.name`. An applicant's filename
 * routinely carries their real name, their employer, a scan date or a device
 * path, and none of that belongs in a world-readable object name. The content
 * type is preserved on the upload itself, which is what actually decides how
 * the file opens.
 */

/** Hex, from the platform CSPRNG. Never `Math.random`. */
function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes)
  crypto.getRandomValues(buf)
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * An object name for a public signup upload.
 *
 * @param slot `doc1` | `doc2` | `doc3` for the agency form's three documents,
 *             or `proof` for the seller form's single one. Human labelling
 *             only — it is not relied on for anything.
 *
 * `crypto.getRandomValues` rather than `crypto.randomUUID()`: the latter needs
 * a secure context and is absent in a few older mobile browsers, and a signup
 * form that throws on an older phone fails the applicant with no way forward.
 * `getRandomValues` is available wherever the Firebase SDK is.
 */
export function signupDocName(slot: string): string {
  const safeSlot = /^[a-z0-9]{1,12}$/.test(slot) ? slot : 'doc'
  return `${safeSlot}_${randomHex(16)}`
}
