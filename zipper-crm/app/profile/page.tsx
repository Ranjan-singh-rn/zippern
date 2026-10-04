'use client'

/**
 * /profile — one screen, three audiences.
 *
 * Every person who can sign into the CRM has a record somewhere: a member of
 * staff has a `crmUsers` document and a Mongo `staff` row, an agency owner has
 * an `agencies` document, a coin seller has a `sellers` document. Before this
 * page existed, none of them could see their own record, and none of them could
 * correct a phone number without asking somebody with a team screen open.
 *
 * ── THE FIELD RULE ───────────────────────────────────────────────────────────
 *
 * Three tiers, and the whole design of this file is making the difference
 * visible rather than discovering it when a save is refused.
 *
 *   1. YOURS.      Contact detail — how to reach you. Display name, phone,
 *                  personal email, address, photo; a coin seller's city and
 *                  desk description. You own these and you should not have to
 *                  ask anybody. Written from the browser, straight to
 *                  Firestore, under rules that admit these keys and no others.
 *
 *   2. THEIRS.     Business fact — what you are paid, what your id is, what you
 *                  are responsible for, which department you sit in, what role
 *                  you hold, when you started. Shown, clearly locked, with the
 *                  name of whoever can change it. Written only through the API,
 *                  with a reason, into the audit log. Somebody editing their
 *                  own salary is the obvious thing this prevents; somebody
 *                  editing their own ROLE is the serious one, because in these
 *                  rules a role is access to money.
 *
 *   3. NOBODY'S.   The sign-in email, the CRM id, approval state, whether the
 *                  account is active. Not editable here by anyone at any level,
 *                  because each of them moves through a flow of its own —
 *                  an account change, a one-time issue, an approval queue, a
 *                  revocation. Showing them with a lock is honest; showing them
 *                  with a disabled input would imply the right person could
 *                  type in the box, and there is no such person on this screen.
 *
 * ── WHERE SALARY LIVES, AND WHY NOT IN FIRESTORE ─────────────────────────────
 *
 * `firestore.rules` says `match /crmUsers/{uid} { allow read: if isStaff() ||
 * isOwner(uid) }`. Every member of staff can read every `crmUsers` document. So
 * a salary mirrored onto that document is a salary published to the entire
 * team, silently, with no screen showing it and nobody meaning to.
 *
 * It is therefore on the Mongo `staff` row only, and reaches this page through
 * `GET /api/staff/me` — a route that accepts no uid at all, so there is no id
 * to substitute for somebody else's.
 */

import UploadField from '@/components/UploadField'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Building2,
  CheckCircle,
  Clock,
  Fingerprint,
  KeyRound,
  Loader2,
  Lock,
  Save,
  ShieldCheck,
  ShoppingBag,
  User as UserIcon,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import api, { ApiError, type StaffMember } from '@/lib/api'
import {
  DEPT_LABELS,
  PARTNER_ROLE_LABEL,
  ROLE_COLORS,
  ROLE_LABELS,
  connectGoogleToCurrentAccount,
  currentAuthProviders,
  refreshEmailVerified,
  sendCrmEmailVerification,
  partnerRecordId,
  partnerRoleStatus,
  primaryPartnerRole,
  partnerRolesOf,
  updateOwnContactDetails,
  type CrmUser,
  type Dept,
  type PartnerRole,
} from '@/lib/auth'
import { getAgency, updateOwnAgencyProfile, type Agency } from '@/lib/agencies'
import { getSeller, updateOwnSellerProfile, type Seller } from '@/lib/sellers'
import { labelOf, type Proposer } from '@/lib/pendingChanges'
import { inrExact } from '@/lib/apiPartners'

// Same idiom as app/app-config/payment-creds — one place for the two classes
// that repeat, so an added field cannot drift out of the house style.
const inputCls =
  'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-pink-500'
const labelCls =
  'block text-slate-400 text-xs font-medium mb-1.5 uppercase tracking-wide'
const cardCls = 'bg-slate-900 border border-slate-800 rounded-2xl p-6 mb-5'

// ── The lock ─────────────────────────────────────────────────────────────────

/**
 * A field its viewer may not change, drawn so that it reads as locked before
 * anybody clicks it.
 *
 * Deliberately NOT a disabled `<input>`. A greyed-out text box says "you can
 * type here later" and leaves the reader to work out why they cannot, usually
 * by trying. This says who owns the field, in a sentence, under the value. A
 * locked field that explains itself is the difference between a rule and a
 * malfunction.
 */
function LockedField({
  label,
  value,
  who,
  mono,
}: {
  label: string
  value: string
  who: string
  mono?: boolean
}) {
  return (
    <div className="min-w-0">
      <span className={labelCls}>{label}</span>
      <div className="flex items-center gap-2 bg-slate-950/60 border border-dashed border-slate-700 rounded-lg px-3 py-2.5">
        <Lock size={13} className="text-slate-600 shrink-0" />
        <span
          className={`text-slate-300 text-sm break-words min-w-0 ${mono ? 'font-mono' : ''}`}
        >
          {value || '—'}
        </span>
      </div>
      <p className="text-slate-600 text-[11px] mt-1.5 leading-relaxed">{who}</p>
    </div>
  )
}

// ── One way of signing in ────────────────────────────────────────────────────

/**
 * A single sign-in method, its state, and — where there is one — the action
 * that adds it.
 *
 * Rendered as a row rather than reusing `LockedField`, because these are not
 * fields at all: nothing here is a value somebody could have typed, and two of
 * the three have no owner to name. What a reader needs is whether the method
 * works on this account today, which is a yes or a no.
 */
function ProviderRow({
  label,
  connected,
  detail,
  action,
}: {
  label: string
  connected: boolean
  /** Shown in place of "Connected" when the method has something to identify it. */
  detail?: string
  action?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 border-b border-slate-800 last:border-b-0">
      <span className="text-slate-300 text-sm min-w-0 flex-1">{label}</span>
      {connected ? (
        <span className="flex items-center gap-1.5 text-green-400 text-sm">
          <CheckCircle size={14} className="shrink-0" />
          {detail || 'Connected'}
        </span>
      ) : (
        <span className="text-slate-500 text-sm">Not connected</span>
      )}
      {action}
    </div>
  )
}

// ── Small formatters ─────────────────────────────────────────────────────────

/** A Firestore Timestamp, an ISO string, or nothing — as a readable date. */
function asDate(value: unknown): string {
  if (!value) return ''
  const ts = value as { toDate?: () => Date }
  const d =
    typeof ts.toDate === 'function'
      ? ts.toDate()
      : new Date(value as string | number)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

/**
 * Pay, from the smallest currency unit it is stored in.
 *
 * Never rounded and never abbreviated: this is the number the person checks
 * against their bank, and ₹42,000.5 is a different figure from ₹42,000.50 to
 * anybody reading quickly.
 */
function asPay(minor: number | null | undefined, currency: string | null | undefined): string {
  if (minor === null || minor === undefined) return ''
  const cur = (currency || 'INR').toUpperCase()
  if (cur === 'INR') return inrExact(minor)
  return `${cur} ${(minor / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

/** Initials for the avatar when no photo is set. */
function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts[1]?.[0] ?? '')).toUpperCase()
}

// ── The editable half ────────────────────────────────────────────────────────

interface ContactForm {
  displayName: string
  phone: string
  personalEmail: string
  address: string
  photoUrl: string
  /** Coin sellers only — both already on the `sellers` rules allow-list. */
  city: string
  description: string
  /**
   * The trading name — `agencyName` or the seller's shop name.
   *
   * It was a locked field, on the reasoning that it appears on every statement
   * and staff identify the business by it. Both true; neither means a business
   * that renamed itself, or was registered with a typo, should have nowhere in
   * the product to correct it. Statements are keyed on the record id, so a
   * rename re-labels history rather than moving any of it.
   */
  businessName: string
}

const EMPTY_FORM: ContactForm = {
  displayName: '',
  phone: '',
  personalEmail: '',
  address: '',
  photoUrl: '',
  city: '',
  description: '',
  businessName: '',
}

export default function ProfilePage() {
  const { crmUser, apiReady } = useAuth()

  const uid = crmUser?.uid ?? ''
  // Null for staff and the superadmin. `primaryPartnerRole` reads `role`, which
  // is the authority field — a dual-capability login shows the record it signed
  // up with, and switches dashboards with the switcher, not here.
  /**
   * Which business this page is showing, for a login that holds two.
   *
   * It was fixed to `primaryPartnerRole` — `crmUsers.role`, the capability the
   * account was created with. So a coin seller who was later granted an agency
   * saw only the seller record, and the agency's name and details were not
   * editable anywhere at all. The capability existed in their sidebar and
   * nowhere else on this page.
   *
   * Contact details below are shared: one person, one phone, one address. The
   * business NAME is per record, which is the reason this has to switch.
   */
  const heldRoles = partnerRolesOf(crmUser)
  const primary: PartnerRole | null = primaryPartnerRole(crmUser)
  const [viewRole, setViewRole] = useState<PartnerRole | null>(null)
  const partnerRole: PartnerRole | null = viewRole ?? primary
  const recordId = partnerRole ? partnerRecordId(crmUser, partnerRole) : ''

  /**
   * Who a proposed change is recorded against — this person, editing their own
   * business. It is what the four-eyes check on the server compares the
   * applying reviewer's uid to, so it is their real login and not a label.
   */
  const proposer: Proposer = {
    uid,
    name: crmUser?.name ?? '',
    role: crmUser?.role ?? '',
  }

  const [form, setForm] = useState<ContactForm>(EMPTY_FORM)
  const [agency, setAgency] = useState<Agency | null>(null)
  const [seller, setSeller] = useState<Seller | null>(null)
  const [staffRow, setStaffRow] = useState<StaffMember | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')

  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [saveError, setSaveError] = useState('')
  /** Which fields went to a reviewer instead of onto the record. */
  const [proposedNote, setProposedNote] = useState('')

  // ── Which doors this login has ────────────────────────────────────────────
  //
  // Held in state and seeded from `currentAuthProviders()` in an effect, not
  // read during render. Two reasons, and either alone would be enough:
  //
  //   · `currentAuthProviders` reads `auth.currentUser`, which is null while
  //     Next pre-renders this page on the server and populated in the browser.
  //     Reading it in the render body makes the first client paint disagree
  //     with the server's and React discards the tree.
  //   · `linkWithPopup` mutates the existing Firebase user in place. The object
  //     identity never changes, so nothing derived from `firebaseUser` would
  //     re-render when Google is connected — the row would stay wrong until the
  //     page was reloaded, which is the one moment it most needs to be right.
  //
  // It is deliberately NOT derived from anything on `crmUser`. A Firestore
  // field saying "has Google" would be a second copy of a fact Firebase already
  // holds, and the copy is what goes stale — a provider unlinked from the
  // Firebase console would leave this screen insisting on a door that is gone.
  const [providers, setProviders] = useState<string[]>([])
  const [googleBusy, setGoogleBusy] = useState(false)
  const [googleError, setGoogleError] = useState('')

  // Whether Firebase has seen this address confirmed, and it is a THIRD state:
  // null is "not asked yet". Rendering `false` before the answer arrives would
  // put a warning about an unverified address in front of somebody whose
  // address is fine, every time the page loads.
  //
  // Read through `refreshEmailVerified` rather than off the cached `User`,
  // because the person most likely to be looking at this card is the one who
  // just opened the verification link — and nothing updates that cache.
  const [emailVerified, setEmailVerified] = useState<boolean | null>(null)
  const [verifyBusy, setVerifyBusy] = useState(false)
  const [verifySent, setVerifySent] = useState(false)
  const [verifyError, setVerifyError] = useState('')

  // `crmUser` is kept live by an onSnapshot in AuthProvider, so it changes
  // identity on every write — including this page's own save. Seeding the form
  // from it as a reactive dependency would wipe whatever the person was typing
  // the moment anything touched their document. It is read through a ref and
  // the seed runs only when the identity or the partner record actually
  // changes.
  const latest = useRef<CrmUser | null>(crmUser)
  latest.current = crmUser

  useEffect(() => {
    if (!uid) return
    let cancelled = false

    async function load() {
      setLoading(true)
      setLoadError('')

      const me = latest.current
      if (!me) return

      let loadedAgency: Agency | null = null
      let loadedSeller: Seller | null = null
      let loadedStaff: StaffMember | null = null
      const problems: string[] = []

      if (partnerRole === 'agency' && recordId) {
        try {
          loadedAgency = await getAgency(recordId, me.crmId)
        } catch (e) {
          problems.push(
            e instanceof Error ? e.message : 'Your agency record could not be read.',
          )
        }
      }

      if (partnerRole === 'seller' && recordId) {
        try {
          loadedSeller = await getSeller(recordId, me.crmId)
        } catch (e) {
          problems.push(
            e instanceof Error ? e.message : 'Your seller record could not be read.',
          )
        }
      }

      // Staff only. An agency or coin seller session is refused this route by
      // the API's partner-reachability gate, and calling it anyway would put a
      // 403 in their console and a scary red banner on a page that is working
      // perfectly.
      if (!partnerRole && apiReady) {
        try {
          const row = await api.staff.me()
          // The route answers `{}` for a session with no staff row — the
          // observer, by design. Nothing recorded is not a failure.
          loadedStaff = row && row.uid ? row : null
        } catch (e) {
          problems.push(
            e instanceof ApiError
              ? `Your employment details could not be read: ${e.message}`
              : 'Your employment details could not be read.',
          )
        }
      }

      if (cancelled) return

      setAgency(loadedAgency)
      setSeller(loadedSeller)
      setStaffRow(loadedStaff)
      setLoadError(problems.join(' '))

      // The seed. Where each value comes from is the same question as where the
      // save sends it back to — the partner record is authoritative for a
      // partner's contact detail, because that is what staff screens and the
      // Android app read; `crmUsers` is authoritative for a member of staff.
      setForm({
        businessName:
          loadedAgency?.agencyName ?? loadedSeller?.displayName ?? '',
        displayName:
          loadedAgency?.ownerName ??
          loadedSeller?.displayName ??
          me.displayName ??
          me.name ??
          '',
        phone:
          loadedAgency?.ownerPhone ?? loadedSeller?.phone ?? me.phone ?? '',
        personalEmail: me.personalEmail ?? '',
        address: loadedAgency?.address ?? me.address ?? '',
        photoUrl: me.photoUrl ?? '',
        city: loadedSeller?.city ?? '',
        description: loadedSeller?.description ?? '',
      })
      setLoading(false)
    }

    load().catch((e: unknown) => {
      if (cancelled) return
      setLoadError(e instanceof Error ? e.message : 'This profile could not be loaded.')
      setLoading(false)
    })

    return () => {
      cancelled = true
    }
  }, [uid, partnerRole, recordId, apiReady])

  // `uid` is the dependency because a `crmUsers` document only ever reaches
  // this page from inside an active Firebase session, so a non-empty uid is
  // the point at which `auth.currentUser` is certain to be resolved.
  useEffect(() => {
    if (!uid) return
    setProviders(currentAuthProviders())
    let cancelled = false
    refreshEmailVerified()
      .then((verified) => { if (!cancelled) setEmailVerified(verified) })
      // A failed reload says nothing about the address, so it must not be
      // reported as "unverified" — that would put a warning and a button in
      // front of somebody with nothing to fix. It stays unresolved instead.
      .catch(() => {})
    return () => { cancelled = true }
  }, [uid])

  const set = useCallback(
    (key: keyof ContactForm) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      const value = e.target.value
      setForm((f) => ({ ...f, [key]: value }))
      setSaved(false)
      setSaveError('')
    },
    [],
  )

  /** Same effect as `set`, for controls that hand back a value rather than an event. */
  const setValue = useCallback((key: keyof ContactForm) => (value: string) => {
    setForm((f) => ({ ...f, [key]: value }))
    setSaved(false)
    setSaveError('')
  }, [])

  async function handleSave() {
    if (!uid) return
    setSaving(true)
    setSaved(false)
    setSaveError('')
    setProposedNote('')

    try {
      // Partner record first, `crmUsers` second, and the order is not
      // cosmetic. The partner document is the one staff screens, the money
      // board and the Android app read; the `crmUsers` copy is what the CRM
      // shell puts in its own header. If only one of the two can land, the
      // authoritative one is the one worth having.
      // Legal identity — the agency's trading name, the owner's name, a
      // seller's shop name and phone — is no longer written straight onto a
      // record somebody has already approved. It is proposed, the live value
      // stays where it is, and a reviewer applies it on /kyc. The result says
      // which fields went which way, and the line below repeats that verbatim
      // rather than claiming everything saved: a person told "Saved" who then
      // reloads and sees the old name will assume the form is broken.
      let proposed: string[] = []
      if (partnerRole === 'agency' && recordId) {
        const result = await updateOwnAgencyProfile(
          recordId,
          {
            ownerName: form.displayName,
            ownerPhone: form.phone,
            address: form.address,
            agencyName: form.businessName,
          },
          proposer,
        )
        proposed = result.proposed
      }
      if (partnerRole === 'seller' && recordId) {
        const result = await updateOwnSellerProfile(
          recordId,
          {
            // A coin seller's shop name IS `displayName` on their record, so the
            // business name is the field that goes here — not the person's name.
            displayName: form.businessName || form.displayName,
            phone: form.phone,
            city: form.city,
            description: form.description,
          },
          proposer,
        )
        proposed = result.proposed
      }
      setProposedNote(
        proposed.length === 0
          ? ''
          : `${proposed.map(labelOf).join(', ')} ${
              proposed.length === 1 ? 'is' : 'are'
            } with a reviewer and has not changed on your record yet. ` +
            'Everything else here is saved. You do not need to send it again.',
      )

      await updateOwnContactDetails(uid, {
        displayName: form.displayName,
        phone: form.phone,
        personalEmail: form.personalEmail,
        address: form.address,
        photoUrl: form.photoUrl,
      })

      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (e) {
      setSaveError(
        e instanceof Error
          ? `That did not save: ${e.message}`
          : 'That did not save, and nothing has been changed.',
      )
    } finally {
      setSaving(false)
    }
  }

  /**
   * Add Google to this account — the same uid, a second way into it.
   *
   * `connectGoogleToCurrentAccount` does the whole of the decision: being
   * signed in here is the proof of ownership, so there is no password step and
   * nothing on this screen compares one email address to another. If the
   * Google address happens to match somebody's, that is not what connects it;
   * the link is made against the session's own uid or not at all.
   */
  async function handleConnectGoogle() {
    setGoogleBusy(true)
    setGoogleError('')
    try {
      await connectGoogleToCurrentAccount()
    } catch (e) {
      // A blank message is the popup being closed — a decision, not a failure,
      // and a red banner saying so would be the CRM complaining about being
      // told no. Anything else is already phrased for the person by lib/auth.
      setGoogleError(
        e instanceof Error ? e.message : 'Could not connect Google. Try again.',
      )
    } finally {
      // Re-read on every outcome, not only on success. The one error that is
      // really a stale row is `auth/provider-already-linked` — Google is on the
      // account and this screen was the last to know, usually because it was
      // connected in another tab. Refreshing here corrects the row while the
      // message still explains why the button did nothing.
      setProviders(currentAuthProviders())
      // `connectGoogleToCurrentAccount` reloads the account before it decides,
      // so a refusal for an unverified address has already been checked against
      // Firebase — and the row below should say the same thing the refusal did.
      refreshEmailVerified().then(setEmailVerified).catch(() => {})
      setGoogleBusy(false)
    }
  }

  /**
   * Send the "confirm this is your address" email to this signed-in account.
   *
   * No password step: the session is the proof, exactly as it is for connecting
   * Google. Verification is what the Google button is waiting on — see
   * `EMAIL_NOT_VERIFIED` in lib/auth — so this is the control that unblocks it.
   */
  async function handleSendVerification() {
    setVerifyBusy(true)
    setVerifyError('')
    setVerifySent(false)
    try {
      await sendCrmEmailVerification()
      setVerifySent(true)
    } catch (e) {
      setVerifyError(
        e instanceof Error && e.message
          ? e.message
          : 'The verification email could not be sent. Try again in a minute.',
      )
    } finally {
      setVerifyBusy(false)
    }
  }

  // ── What the locked half says, per audience ────────────────────────────────

  const dept = crmUser?.dept as Dept | undefined
  const roleLabel = crmUser ? ROLE_LABELS[crmUser.role] ?? crmUser.role : ''
  const roleColor = crmUser ? ROLE_COLORS[crmUser.role] ?? 'bg-slate-700 text-slate-300' : ''

  const partnerStatus = useMemo(() => {
    if (!partnerRole) return ''
    return partnerRoleStatus(crmUser, partnerRole)
  }, [crmUser, partnerRole])

  if (!crmUser) {
    // The shell holds a skeleton until auth resolves, so this is only ever the
    // observer — an API session with no CRM directory record, by design.
    return (
      <div className="max-w-lg mx-auto text-center py-24">
        <UserIcon size={30} className="text-slate-700 mx-auto mb-4" />
        <h1 className="text-white text-xl font-bold">No profile on this account</h1>
        <p className="text-slate-400 text-sm mt-2 leading-relaxed">
          This session has no CRM directory record, so there are no personal
          details to show or edit.
        </p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-32">
        <Loader2 size={28} className="text-pink-500 animate-spin" />
      </div>
    )
  }

  const headerName = form.displayName || crmUser.name || crmUser.email
  const hasPassword = providers.includes('password')
  const hasPhone = providers.includes('phone')
  const hasGoogle = providers.includes('google.com')
  const audienceIcon =
    partnerRole === 'agency' ? (
      <Building2 size={22} className="text-pink-500 shrink-0" />
    ) : partnerRole === 'seller' ? (
      <ShoppingBag size={22} className="text-pink-500 shrink-0" />
    ) : (
      <UserIcon size={22} className="text-pink-500 shrink-0" />
    )

  return (
    <div className="max-w-3xl mx-auto">
      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-start gap-4 mb-7 pt-1">
        <div className="w-16 h-16 rounded-2xl bg-slate-800 border border-slate-700 overflow-hidden shrink-0 flex items-center justify-center">
          {form.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={form.photoUrl}
              alt=""
              className="w-full h-full object-cover"
              onError={(e) => {
                // A broken photo url must not leave a broken-image glyph where
                // somebody's face should be. Fall back to the initials.
                ;(e.currentTarget as HTMLImageElement).style.display = 'none'
              }}
            />
          ) : (
            <span className="text-slate-400 font-bold text-lg">
              {initialsOf(headerName)}
            </span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl font-bold text-white flex items-center gap-2 min-w-0">
            {audienceIcon}
            <span className="truncate">{headerName}</span>
          </h1>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <span className={`px-2 py-0.5 rounded-md text-xs font-semibold ${roleColor}`}>
              {partnerRole ? PARTNER_ROLE_LABEL[partnerRole] : roleLabel}
            </span>
            {crmUser.crmId && (
              <span className="text-slate-500 text-xs font-mono">#{crmUser.crmId}</span>
            )}
            {dept && DEPT_LABELS[dept] && (
              <span className="text-slate-500 text-xs">{DEPT_LABELS[dept]}</span>
            )}
          </div>
        </div>
      </div>

      {loadError && (
        <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-xl px-4 py-3 mb-5 text-sm">
          <AlertTriangle size={15} className="shrink-0 mt-0.5" />
          <span className="leading-relaxed">
            {loadError} Everything below that did load is still correct.
          </span>
        </div>
      )}

      {/* ── 1. YOURS ───────────────────────────────────────────────────────── */}
      <div className={cardCls}>
        <div className="flex items-start gap-2 mb-1">
          <UserIcon size={15} className="text-pink-500 mt-0.5 shrink-0" />
          <h2 className="text-white font-semibold text-sm">Your details</h2>
        </div>
        <p className="text-slate-500 text-xs mb-5 leading-relaxed">
          Yours to change, whenever you like. Nobody needs to approve any of
          this — it says how to reach you and nothing more.
        </p>

        {heldRoles.length > 1 && (
          <div className="mb-5">
            <p className="text-slate-400 text-xs uppercase tracking-wide mb-2">
              Which business
            </p>
            <div className="flex flex-wrap gap-2">
              {heldRoles.map((role) => (
                <button
                  key={role}
                  type="button"
                  onClick={() => setViewRole(role)}
                  className={`rounded-lg border px-3.5 py-2 text-sm transition-colors ${
                    partnerRole === role
                      ? 'border-pink-500 bg-pink-500/10 text-white'
                      : 'border-slate-700 text-slate-300 hover:border-slate-600'
                  }`}
                >
                  {role === 'agency' ? 'Agency' : 'Coin seller'}
                </button>
              ))}
            </div>
            <p className="text-slate-500 text-xs mt-2 leading-relaxed">
              Your phone, email and address are shared across both. The business
              name below belongs to whichever one is selected.
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {partnerRole && (
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="businessName">
                {partnerRole === 'agency' ? 'Agency name' : 'Shop name'}
              </label>
              <input
                id="businessName"
                value={form.businessName}
                onChange={set('businessName')}
                className={inputCls}
                placeholder={
                  partnerRole === 'agency'
                    ? 'The name hosts and Zipper know you by'
                    : 'The name buyers see in the app'
                }
              />
              <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                Your trading name, shown on statements and to Zipper staff.
                Changing it re-labels your record — it moves no money and no
                history, because everything is keyed on your id, not your name.
              </p>
            </div>
          )}
          <div>
            <label className={labelCls} htmlFor="displayName">
              {partnerRole === 'agency' ? 'Owner name' : 'Display name'}
            </label>
            <input
              id="displayName"
              value={form.displayName}
              onChange={set('displayName')}
              className={inputCls}
              placeholder="What you would like to be called"
            />
          </div>

          <div>
            <label className={labelCls} htmlFor="phone">
              Phone
            </label>
            <input
              id="phone"
              value={form.phone}
              onChange={set('phone')}
              className={inputCls}
              placeholder="+91 9XXXXXXXXX"
            />
          </div>

          <div>
            <label className={labelCls} htmlFor="personalEmail">
              Personal email
            </label>
            <input
              id="personalEmail"
              value={form.personalEmail}
              onChange={set('personalEmail')}
              className={inputCls}
              placeholder="Optional — an extra address to reach you on"
            />
              <p className="text-slate-500 text-xs mt-1.5 leading-relaxed">
                Optional, and an addition rather than a replacement. The address
                you registered and sign in with is already on file — it is under
                <strong> Your account</strong> below, and changing it is an
                account change rather than a contact detail, so an owner does
                it. Zipper writes to your registered address unless you put a
                different one here.
              </p>
          </div>

          {partnerRole === 'seller' && (
            <div>
              <label className={labelCls} htmlFor="city">
                City
              </label>
              <input
                id="city"
                value={form.city}
                onChange={set('city')}
                className={inputCls}
                placeholder="Where you operate"
              />
            </div>
          )}

          <div className="sm:col-span-2">
            <label className={labelCls} htmlFor="address">
              Address
            </label>
            <input
              id="address"
              value={form.address}
              onChange={set('address')}
              className={inputCls}
              placeholder="Postal address"
            />
          </div>

          {partnerRole === 'seller' && (
            <div className="sm:col-span-2">
              <label className={labelCls} htmlFor="description">
                About your desk
              </label>
              <textarea
                id="description"
                value={form.description}
                onChange={set('description')}
                rows={3}
                className={`${inputCls} resize-y`}
                placeholder="What buyers see about you"
              />
            </div>
          )}

          <div className="sm:col-span-2">
            <UploadField
              label="Photo"
              value={form.photoUrl}
              onChange={setValue('photoUrl')}
              storagePath="crmProfilePhotos"
              accept="image/*"
              maxSizeMb={5}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 mt-6">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-xl font-semibold text-sm transition-colors"
          >
            {saving ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Save size={14} />
            )}
            Save my details
          </button>
          {saved && (
            <span className="flex items-center gap-1.5 text-green-400 text-sm font-medium">
              <CheckCircle size={14} /> Saved
            </span>
          )}
        </div>

        {proposedNote && (
          <div className="flex items-start gap-2 bg-blue-500/10 border border-blue-500/30 text-blue-200 rounded-xl px-4 py-3 mt-4 text-sm">
            <Clock size={15} className="shrink-0 mt-0.5" />
            <span className="leading-relaxed">{proposedNote}</span>
          </div>
        )}

        {saveError && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 mt-4 text-sm">
            <AlertTriangle size={15} className="shrink-0 mt-0.5" />
            <span className="leading-relaxed">{saveError}</span>
          </div>
        )}
      </div>

      {/* ── 2. THEIRS ──────────────────────────────────────────────────────── */}
      {!partnerRole ? (
        <div className={cardCls}>
          <div className="flex items-start gap-2 mb-1">
            <ShieldCheck size={15} className="text-slate-500 mt-0.5 shrink-0" />
            <h2 className="text-white font-semibold text-sm">Your employment</h2>
          </div>
          <p className="text-slate-500 text-xs mb-5 leading-relaxed">
            Facts about your job rather than preferences, so they are recorded
            for you rather than by you. If any of them is wrong, the person named
            under it is the one who can put it right.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <LockedField
              label="Salary"
              mono
              value={asPay(staffRow?.salary_minor, staffRow?.salary_currency)}
              who="Set by a business owner. Not by your department admin, and not by you."
            />
            <LockedField
              label="Employment ID"
              mono
              value={staffRow?.employment_id ?? ''}
              who="Issued by an owner or your department admin."
            />
            <LockedField
              label="Field charge"
              value={crmUser.fieldCharge ?? staffRow?.field_charge ?? ''}
              who="What you are responsible for — set by an owner or your department admin."
            />
            <LockedField
              label="Department"
              value={dept ? DEPT_LABELS[dept] ?? dept : ''}
              who="Follows your role. It moves when an owner moves your role."
            />
            <LockedField
              label="Role"
              value={roleLabel}
              who="Changed by a business owner only. Your role is what you are allowed to reach."
            />
            <LockedField
              label="Joined"
              value={asDate(staffRow?.joined_at) || asDate(crmUser.createdAt)}
              who="Recorded by an owner or your department admin."
            />
          </div>
        </div>
      ) : (
        <div className={cardCls}>
          <div className="flex items-start gap-2 mb-1">
            <ShieldCheck size={15} className="text-slate-500 mt-0.5 shrink-0" />
            <h2 className="text-white font-semibold text-sm">
              Your {PARTNER_ROLE_LABEL[partnerRole].toLowerCase()} record
            </h2>
          </div>
          <p className="text-slate-500 text-xs mb-5 leading-relaxed">
            The business facts Zipper holds about you. These are set when your
            account is reviewed, and they are not changed from this screen.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            {partnerRole === 'agency' ? (
              <>
                <LockedField
                  label="Referral code"
                  mono
                  value={agency?.referralCode ?? ''}
                  who="Issued by Zipper. Hosts join you with it, so it never changes."
                />
                <LockedField
                  label="Agency type"
                  value={
                    agency?.type === 'sub' ? 'Sub-agency' : agency?.type === 'main' ? 'Main agency' : ''
                  }
                  who="Decided at registration."
                />
                <LockedField
                  label="Commission rate"
                  value={
                    agency?.commissionRate === undefined ? '' : `${agency.commissionRate}%`
                  }
                  who="Set by Zipper finance. It is a commercial term, not a setting."
                />
                <LockedField
                  label="KYC"
                  value={agency?.kycStatus ?? ''}
                  who="Moves as your documents are reviewed. Submit or resubmit from your dashboard."
                />
                <LockedField
                  label="Payout account"
                  value={
                    agency?.paymentType === 'foreign'
                      ? agency?.binanceUid
                        ? `Binance ${agency.binanceUid}`
                        : 'Binance'
                      : agency?.accountNumber
                        ? `${agency.bankName ?? 'Bank'} ····${agency.accountNumber.slice(-4)}`
                        : ''
                  }
                  who="Where your commission is paid. Edited on your dashboard, alongside your KYC documents — never here."
                />
              </>
            ) : (
              <>
                <LockedField
                  label="Coin balance"
                  mono
                  value={
                    seller?.coinBalance === undefined
                      ? ''
                      : seller.coinBalance.toLocaleString('en-IN')
                  }
                  who="Your inventory. It moves only when a coin purchase, a sale or a lending card is signed and executed."
                />
                <LockedField
                  label="Coins sold"
                  mono
                  value={
                    seller?.totalCoinsSold === undefined
                      ? ''
                      : seller.totalCoinsSold.toLocaleString('en-IN')
                  }
                  who="A running total of your approved sales. Nothing writes it from a browser."
                />
                <LockedField
                  label="Registration fee"
                  value={
                    seller === null
                      ? ''
                      : seller.registrationFeePaid
                        ? 'Paid'
                        : 'Not recorded as paid'
                  }
                  who="Recorded by Zipper finance when your payment is verified."
                />
                <LockedField
                  label="Approved"
                  value={seller === null ? '' : seller.isApproved ? 'Yes' : 'Not yet'}
                  who="Decided by Zipper operations, with a reason, in the audit log."
                />
              </>
            )}
          </div>
        </div>
      )}

      {/* ── 3. NOBODY'S ────────────────────────────────────────────────────── */}
      <div className={cardCls}>
        <div className="flex items-start gap-2 mb-1">
          <KeyRound size={15} className="text-slate-500 mt-0.5 shrink-0" />
          <h2 className="text-white font-semibold text-sm">Your account</h2>
        </div>
        <p className="text-slate-500 text-xs mb-5 leading-relaxed">
          Not editable on this screen by anybody, at any level. Each of these
          moves through a flow of its own.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <LockedField
            label="Sign-in email"
            value={crmUser.email}
            who="How you sign in, and how your account is identified. Changing it is an account change — ask an owner."
          />
          <LockedField
            label="CRM ID"
            mono
            value={crmUser.crmId ?? ''}
            who="Issued once when your account was created, and never reissued."
          />
          <LockedField
            label={partnerRole ? 'Approval' : 'Account status'}
            value={
              partnerRole
                ? partnerStatus === 'approved'
                  ? 'Approved'
                  : partnerStatus === 'rejected'
                    ? 'Rejected'
                    : 'Under review'
                : crmUser.status === 'approved'
                  ? 'Approved'
                  : 'Active'
            }
            who={
              partnerRole
                ? 'Moves through the approval queue, with a reason recorded against it.'
                : 'Set when your account was provisioned.'
            }
          />
          <LockedField
            label="Access"
            value={crmUser.isActive === false ? 'Withdrawn' : 'Active'}
            who="Withdrawn or restored by an owner, with a reason, in the audit log."
          />
        </div>
      </div>

      {/* ── Authentication ─────────────────────────────────────────────────
          Not a fourth tier — the three above are about who owns a *value*, and
          nothing here is a value. It sits next to "Your account" because it is
          about the same thing that card is: the login, rather than the person
          or the job.

          Every row is read from the Firebase account's own provider list. That
          is the whole of the check. No row, and no button on this screen, ever
          compares one email address to another to decide that two identities
          are the same person — an address is something you can be given, and
          the only thing that connects a provider here is a session already
          proving it holds the account.

          Empty means "not resolved yet", not "no way to sign in": every CRM
          account is created with a password by the Admin SDK, so a login that
          reached this page has at least one provider. Rendering the card from
          an unseeded list would print "Email / Password — Not connected" at
          somebody who signed in with exactly that, so it waits. */}
      {providers.length > 0 && (
        <div className={cardCls}>
          <div className="flex items-start gap-2 mb-1">
            <Fingerprint size={15} className="text-slate-500 mt-0.5 shrink-0" />
            <h2 className="text-white font-semibold text-sm">Authentication</h2>
          </div>
          <p className="text-slate-500 text-xs mb-4 leading-relaxed">
            Connecting Google lets you sign in to the CRM with one click instead
            of typing your password. It is the same account either way, so the
            Zipper Android app recognises you as the same person rather than as
            somebody new.
          </p>

          <div>
            {/* Verification is stated on this row rather than in a card of its
                own, because it is a fact about this method: an address Firebase
                has not seen confirmed is the one case where signing in with
                Google TAKES THE PASSWORD AWAY. "Connected" alone would read as
                nothing to do. */}
            <ProviderRow
              label="Email / Password"
              connected={hasPassword}
              detail={
                emailVerified === true ? 'Connected · address verified' : undefined
              }
            />
            {/* The saved `crmUser.phone`, not `form.phone`. The form is a draft
                the person may be halfway through editing, and this row would
                otherwise claim their sign-in changed as they typed. */}
            <ProviderRow label="Phone" connected={hasPhone} detail={crmUser.phone} />
            <ProviderRow
              label="Google"
              connected={hasGoogle}
              action={
                hasGoogle ? undefined : (
                  <button
                    onClick={handleConnectGoogle}
                    disabled={googleBusy}
                    className="bg-white hover:bg-slate-100 disabled:bg-slate-300 disabled:cursor-not-allowed text-slate-800 font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2.5"
                  >
                    {googleBusy ? (
                      <>
                        <span className="w-4 h-4 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" />
                        Opening Google…
                      </>
                    ) : (
                      <>
                        <svg className="w-4 h-4" viewBox="0 0 48 48" aria-hidden="true">
                          <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.4 6.6-16.1z" />
                          <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.4l-7.1-5.5c-2 1.3-4.5 2.1-7.4 2.1-5.7 0-10.6-3.9-12.3-9.1H4.3v5.7C7.9 41 15.4 46 24 46z" />
                          <path fill="#FBBC05" d="M11.7 28.1c-.4-1.3-.7-2.7-.7-4.1s.3-2.8.7-4.1v-5.7H4.3A22 22 0 0 0 2 24c0 3.6.9 7 2.3 9.8l7.4-5.7z" />
                          <path fill="#EA4335" d="M24 10.8c3.2 0 6.1 1.1 8.4 3.3l6.3-6.3C34.9 4.2 29.9 2 24 2 15.4 2 7.9 7 4.3 14.2l7.4 5.7c1.7-5.2 6.6-9.1 12.3-9.1z" />
                        </svg>
                        Connect Google
                      </>
                    )}
                  </button>
                )
              }
            />
          </div>

          {/* Said before the button is pressed as well as after, because the
              refusal is the whole point: Google cannot be connected until the
              address is verified, and the person should not have to trip over
              that to find out.

              "Connect Google" above is deliberately left enabled. lib/auth
              refuses it with a sentence saying what linking would have cost,
              and a greyed-out button teaches nobody that. */}
          {emailVerified === false && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3 mt-4">
              <div className="flex items-start gap-2">
                <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-amber-200 text-sm leading-relaxed">
                    <strong className="text-amber-100">
                      Your email address is not verified.
                    </strong>{' '}
                    Google cannot be connected until it is. On an unverified
                    address Firebase treats a Google sign-in as the stronger
                    claim and removes the password from the account — so your
                    CRM password would stop working, with nothing saying why.
                  </p>

                  <button
                    onClick={handleSendVerification}
                    disabled={verifyBusy}
                    className="mt-3 bg-amber-500/20 hover:bg-amber-500/30 disabled:bg-amber-500/10 disabled:cursor-not-allowed border border-amber-500/40 text-amber-100 font-semibold rounded-lg px-4 py-2.5 text-sm transition-colors flex items-center justify-center gap-2.5"
                  >
                    {verifyBusy ? (
                      <>
                        <span className="w-4 h-4 border-2 border-amber-200 border-t-transparent rounded-full animate-spin" />
                        Sending…
                      </>
                    ) : (
                      <>
                        <KeyRound size={14} />
                        Send verification email
                      </>
                    )}
                  </button>

                  {verifySent && (
                    <p className="text-green-400 text-xs mt-2.5 leading-relaxed">
                      Sent to{' '}
                      <span className="text-green-300">{crmUser.email}</span>.
                      Open the link in it, then reload this page — this row is
                      read from Firebase, not from anything stored here, so it
                      will correct itself.
                    </p>
                  )}
                  {verifyError && (
                    <p className="text-red-400 text-xs mt-2.5 leading-relaxed">{verifyError}</p>
                  )}
                </div>
              </div>
            </div>
          )}

          {googleError && (
            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-xl px-4 py-3 mt-4 text-sm">
              <AlertTriangle size={15} className="shrink-0 mt-0.5" />
              <span className="leading-relaxed">{googleError}</span>
            </div>
          )}
        </div>
      )}

      <p className="text-slate-600 text-xs leading-relaxed mb-4">
        A locked field is not a fault. Contact details are yours because they are
        about reaching you; pay, role and approval are recorded by somebody else
        because they are decisions about you, and every one of those decisions
        carries a name and a reason in the audit log.
      </p>
    </div>
  )
}
