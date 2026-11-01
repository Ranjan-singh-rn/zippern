/**
 * THE PUBLIC FACE OF A COIN SELLER — an allowlist, with no Firestore in it.
 *
 * ── WHY A SECOND COLLECTION AND NOT A RULE ──────────────────────────────────
 *
 * `sellers/{id}` was `allow read: if request.auth != null`, and `read` is `get`
 * AND `list`, so any signed-in account could page the whole collection: every
 * seller's `idDocUrls` (their KYC documents), `coinBalance` and
 * `totalCoinsSold` (inventory — money), `commissionRate`, `email`,
 * `registrationProofUrl`, and the approval trail.
 *
 * Narrowing the list rule to approved-and-active sellers — which was the
 * previous step — stops pending and rejected records being enumerated, and does
 * nothing for the rest: Firestore returns a document whole or not at all, so an
 * approved seller's KYC was still one directory query away. Rules cannot filter
 * fields. The only real fix is a second document that never contains the
 * sensitive fields in the first place.
 *
 * ── WHY AN ALLOWLIST AND NOT A DENYLIST ─────────────────────────────────────
 *
 * A denylist is a promise to remember. The next field added to a seller — a tax
 * id, a payout reference, an internal note — would be published by default, and
 * the person adding it would have no reason to think about this file. [PUBLIC_FIELDS]
 * is the complete list, [toPublicSeller] copies only those names, and
 * `test/publicSeller.test.js` fails if a sensitive field ever appears in the
 * output. Forgetting is the failure mode this shape removes.
 *
 * The private document is unchanged and stays private. Staff read it exactly as
 * they did; a seller reads their own exactly as they did.
 */

/**
 * Everything the public directory is allowed to know.
 *
 * Derived from the one screen that consumes it — `ResellerListScreen` in the
 * Android app, which reads precisely these and the document id. Not "the fields
 * that seem harmless": the fields something actually renders.
 *
 *   displayName  the name shown in the list
 *   phone        how a buyer contacts the seller to pay them. Public BY PURPOSE
 *                — a directory of sellers nobody can reach is not a directory —
 *                but it is the one entry here worth a second thought, and it is
 *                flagged rather than buried.
 *   qrCodeUrl    the seller's own receiving QR, which they publish deliberately
 *   description  free text the seller writes about themselves
 *   photoUrl     their avatar
 *   isOnline     whether they are available right now; the seller toggles it
 */
export const PUBLIC_FIELDS = [
  'displayName',
  'phone',
  'qrCodeUrl',
  'description',
  'photoUrl',
  'isOnline',
  // ── Payment DESTINATIONS, derived from the private `payment` block ─────
  // A buyer paying a seller outside the app has to be told where to send
  // the money. A UPI id, a UPI QR and a Binance UID are receiving addresses
  // the seller publishes for exactly that purpose; they identify where money
  // goes TO, not the seller's own funds. The bank ACCOUNT NUMBER, IFSC,
  // holder name and branch are not here and never will be — a bank account
  // can be debited with a mandate, and it is reviewed by staff in the CRM
  // like any KYC field.
  'upiId',
  'upiQrUrl',
  'binanceUid',
  'paymentMethods',
] as const

/**
 * Fields that must NEVER reach the public document.
 *
 * Redundant by construction — [toPublicSeller] copies from [PUBLIC_FIELDS] and
 * could not emit these if it tried. Listed anyway because the test asserts
 * against this list by name, so a future change that widens the allowlist to
 * include one of them fails loudly and specifically rather than subtly.
 */
export const NEVER_PUBLIC = [
  // KYC and identity
  'idDocUrls', 'registrationProofUrl', 'kycDocUrls', 'kycStatus',
  // Money
  'coinBalance', 'totalCoinsSold', 'commissionRate', 'registrationFeePaid',
  'credit', 'creditLimit', 'outstanding',
  // Contact beyond what the directory needs
  'email', 'city', 'address',
  // Internal state, decisions and reasons
  'status', 'isApproved', 'isActive', 'approvedBy', 'approvedAt',
  'rejectionReason', 'rejectedAt', 'rejectedBy', 'suspendedAt', 'notes',
  'pendingChanges', 'source', '_resendEmail',
  // Account and linkage metadata
  'crmId', 'crmUid', 'ownerUid', 'secondRoleOwnerUid', 'linkedAgencyId',
  'isAgency', 'createdAt', 'updatedAt',
  // The private settlement block itself, and every bank field inside it.
  // Only the three receiving addresses above are lifted out of it.
  'payment', 'accountNumber', 'accountHolderName', 'ifscCode', 'bankName',
  'branch', 'internationalDetails',
] as const

export interface PublicSeller {
  sellerId: string
  displayName: string
  phone: string
  qrCodeUrl: string
  description: string
  photoUrl: string
  isOnline: boolean
  /** Where a buyer sends money. Receiving addresses only; never a bank account. */
  upiId: string
  upiQrUrl: string
  binanceUid: string
  /** Which of `upi | qr | binance | bank | international` the seller accepts. */
  paymentMethods: string[]
}

/** A seller document, as Firestore hands it over. */
export type SellerDoc = Record<string, unknown>

/**
 * Should this seller appear in the public directory at all?
 *
 * The same question the app's query used to ask — `isApproved == true` and
 * `isActive == true` — plus the `status` field, which exists on newer records
 * and is the one a rejection or suspension actually moves. Both are consulted
 * because many older seller documents have no `status` at all; `isApproved`
 * alone was the decision for a long time.
 *
 * Fails CLOSED: a document with neither field, or with a status this build does
 * not recognise, is not published. An unknown state is not a reason to show
 * somebody's phone number to every user of the app.
 */
export function isPubliclyVisible(doc: SellerDoc | undefined | null): boolean {
  if (!doc) return false
  if (doc.isApproved !== true) return false
  if (doc.isActive !== true) return false
  // GOV C4 (B06): the OWNER's account is suspended or banned. The backend
  // writes `ownerRestricted` on every seller record the person owns when the
  // account is restricted, and clears it when the restriction is lifted. The
  // seller's own status — the role — is not touched by an account action, so
  // without this a suspended person stayed in the public directory and buyers
  // went on paying them. Clients cannot write the field (the sellers update
  // rules are allow-lists that do not name it).
  if (doc.ownerRestricted === true) return false
  const status = String(doc.status ?? '').trim()
  if (status === '') return true // legacy record, decided by the two flags above
  return status === 'approved'
}

/**
 * Build the public document. Only [PUBLIC_FIELDS], nothing else, ever.
 *
 * Every value is coerced to its declared type rather than copied through, so a
 * malformed private field cannot change the SHAPE of the public one — a number
 * where the app expects a string is a crash on somebody's phone.
 */
export function toPublicSeller(sellerId: string, doc: SellerDoc): PublicSeller {
  const str = (key: string): string => {
    const v = doc[key]
    return typeof v === 'string' ? v : ''
  }
  // The settlement block the application wrote (`payment: {...}`), read
  // defensively: it is a private sub-document and may be absent on older
  // records.
  const payment = (doc.payment && typeof doc.payment === 'object')
    ? doc.payment as Record<string, unknown>
    : {}
  const pstr = (key: string): string => {
    const v = payment[key]
    return typeof v === 'string' ? v : ''
  }
  const upiId = pstr('upiId')
  const upiQrUrl = pstr('upiQrUrl') || str('qrCodeUrl')
  const binanceUid = pstr('binanceUid')
  const methods: string[] = []
  if (upiId) methods.push('upi')
  if (upiQrUrl) methods.push('qr')
  if (binanceUid) methods.push('binance')
  // A bank account is OFFERED without being PUBLISHED: the buyer is told the
  // seller accepts bank transfer and gets the details from the seller
  // directly, in chat — the account number itself never leaves the CRM.
  if (pstr('accountNumber')) methods.push('bank')
  if (pstr('internationalDetails') || pstr('internationalMethod')) methods.push('international')

  return {
    sellerId,
    displayName: str('displayName'),
    phone: str('phone'),
    qrCodeUrl: str('qrCodeUrl'),
    description: str('description'),
    photoUrl: str('photoUrl'),
    isOnline: doc.isOnline === true,
    upiId,
    upiQrUrl,
    binanceUid,
    paymentMethods: methods,
  }
}

/**
 * Has anything the public document carries actually changed?
 *
 * The trigger fires on every write to a seller — a balance movement, an
 * approval stamp, a note — and almost none of those touch the public view.
 * Rewriting it anyway would fan one private write out into a second write and a
 * second trigger for no reason.
 */
export function publicViewChanged(
  before: SellerDoc | undefined,
  after: SellerDoc | undefined,
): boolean {
  const wasVisible = isPubliclyVisible(before)
  const isVisible = isPubliclyVisible(after)
  if (wasVisible !== isVisible) return true
  if (!isVisible) return false

  const a = toPublicSeller('x', before ?? {})
  const b = toPublicSeller('x', after ?? {})
  return (PUBLIC_FIELDS as readonly string[]).some(
    (f) => JSON.stringify((a as unknown as Record<string, unknown>)[f])
        !== JSON.stringify((b as unknown as Record<string, unknown>)[f]),
  )
}
