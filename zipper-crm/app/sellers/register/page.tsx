'use client'

/**
 * Register a coin seller.
 *
 * **The opening balance is not typed into this form any more.**
 *
 * It used to be: the seller document was created with `coinBalance` set to
 * whatever number was in the box, a `rechargeHistory` entry was written, and a
 * `coinPurchaseRequests` document was filed already marked `approved` — by the
 * same person, in the same click. That is real, spendable inventory minted from
 * a browser on one person's say-so, with a screenshot as the only evidence and
 * nobody checking whether the UTR had been used before.
 *
 * Seller inventory is money, and money moves through the card board. So:
 *
 *   1. the seller is created holding **zero**, always;
 *   2. if an opening load was paid for, a coin purchase **card** is raised for
 *      it, carrying the amount, the UTR and the payment proof;
 *   3. someone else verifies that card, an owner signs it, and executing it is
 *      what puts the coins there.
 *
 * Until step 3 the seller genuinely has nothing, and this screen says so in
 * those words rather than implying the load is done.
 *
 * ── The order things happen in, and why it changed ───────────────────────────
 *
 * This screen used to `addDoc` the seller and THEN create the Firebase Auth
 * account. A retry against an address that already had a login therefore died on
 * `auth/email-already-in-use` *after* the record was committed, said "A CRM
 * account with this email already exists" and returned — leaving a seller nobody
 * can sign in as. Three of those exist in production for one address.
 *
 * The order now is:
 *
 *   1. refuse outright if this address already holds a seller record;
 *   2. create the **login** — which writes nothing to Firestore, and whose
 *      refusal is therefore free;
 *   3. write the seller document;
 *   4. write the `crmUsers` document and link `crmUid` back;
 *   5. raise the opening coin purchase card.
 *
 * Nothing before step 3 leaves anything behind. A failure at step 4 leaves a
 * seller record with no login attached, which is a real application that
 * somebody must decide about — so it is NOT deleted, it is reported in those
 * words on the screen below, and `/sellers` badges it "no login attached".
 *
 * ── THE PASSWORD IS NOT STORED. ANYWHERE. ────────────────────────────────────
 *
 * A non-superadmin cannot create the seller record, so this screen files an
 * `approvalRequests` document instead. That branch used to create **no login at
 * all**: it asked for a password, threw it away, filed the request, and when an
 * owner approved it `onApprovalApproved` → `applyApproval` wrote the `sellers`
 * document and that seller could never sign in. They landed on `/sellers`
 * badged "no login attached" with no control anywhere to attach one.
 *
 * `/agencies/register` answered this and its answer is copied here: **the login
 * is created at submit time, from the value the person just typed, before
 * anything is written or filed**, on BOTH paths. `createPartnerLogin` puts the
 * password into the Firebase Auth account while it is still only in this
 * browser's memory, and the account is the only place it ever lives after that.
 * The approval request then carries `crmUid` — a public identifier, useless on
 * its own — and never the password. There is no encryption step here and there
 * must never be one: a credential you can decrypt is a credential you have
 * stored.
 *
 * `writePartnerCrmUser` in functions/src/index.ts writes `crmUsers/{crmUid}`
 * against that uid when the request is approved — with `sellerId` set to the
 * new seller's id, matching `createSellerAccount` field for field — and does it
 * BEFORE `ref.set` creates the seller, cleaning up the account it wrote if that
 * set then fails. The `crmUid` back-link needs no separate write on this path:
 * it travels in the payload and `ref.set` puts it on the seller document in the
 * same operation that creates it.
 *
 * So the account IS created at a different point in the flow than the record
 * is: at submit, not at approval. That is the fix. If the request is rejected
 * the login stays behind holding nothing, and the screen below says so — an
 * orphaned Firebase Auth account blocks that address from ever being
 * registered again, so somebody has to remove it in the Firebase console.
 */

import { useState, useRef } from 'react'
import { db, storage } from '@/lib/firebase'
import { addDoc, collection, serverTimestamp, doc, updateDoc } from 'firebase/firestore'
import {
  createPartnerLoginThen, createSellerAccount, generateCrmId, canAccess,
} from '@/lib/auth'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import {
  ArrowLeft, User, Phone, Mail, MapPin, AlignLeft, FileText,
  Upload, CheckCircle, Shield, X, Loader2, Receipt, AlertTriangle, Clock,
  ArrowRight, Coins, ShieldCheck, XCircle, KeyRound, UserX,
} from 'lucide-react'
import Link from 'next/link'
import { useAuth } from '@/components/AuthProvider'
import { submitApproval } from '@/lib/approvals'
import { isRecordNotWritten, recordNotWrittenMessage } from '@/lib/loginThenRecord'
import { ApiError } from '@/lib/api'
import { inventory, coins as coinText, type DuplicateRef } from '@/lib/apiPartners'
import {
  findPartnersByEmail, normaliseEmail, statusPhrase, loginPhrase,
  duplicateHeadline, type ExistingPartner,
} from '@/lib/partnerDuplicates'
import PhoneInput from '@/components/PhoneInput'
import { useRegisteredCheck } from '@/lib/useRegisteredCheck'

/**
 * What happened to the opening load, kept separate from "the seller was
 * created". They are two outcomes and conflating them is how a seller ends up
 * looking funded when nothing was raised.
 */
type OpeningOutcome =
  | { kind: 'none' }
  | { kind: 'raised'; coins: number; cardId: string; stage: string; warning: string }
  | { kind: 'failed'; coins: number; message: string }

/**
 * What happened to the seller's login, kept separate for the same reason. A
 * seller record with no login is the exact failure this screen produced three
 * times in production, and it must never be reported as a plain success.
 */
type LoginOutcome =
  /** C-17: `resetEmailSent` — the seller was emailed a set-password link (false = tell them to use "Forgot password"). */
  | { kind: 'attached'; email: string; resetEmailSent: boolean }
  | { kind: 'failed'; email: string; message: string }

/** The firebase-js-sdk error code, when there is one. */
function errorCode(err: unknown): string {
  return err && typeof err === 'object' && 'code' in err
    ? String((err as { code: unknown }).code)
    : ''
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

const inputClass =
  'bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white w-full ' +
  'focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 ' +
  'placeholder:text-slate-500 transition-colors text-sm'
const labelClass = 'block text-sm font-medium text-slate-300 mb-1.5'
const selectClass =
  'bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5 text-white w-full ' +
  'focus:outline-none focus:border-pink-500 text-sm'

interface DocFile {
  file: File
  progress: number   // 0–100
  url: string        // empty until upload complete
  label: string      // e.g. "Aadhaar", "PAN", "GST"
}

export default function RegisterSellerPage() {
  const { crmUser } = useAuth()

  const [submitting, setSubmitting]             = useState(false)
  const [success, setSuccess]                   = useState(false)
  const [sellerId, setSellerId]                 = useState('')
  const [opening, setOpening]                   = useState<OpeningOutcome>({ kind: 'none' })
  const [login, setLogin]                       = useState<LoginOutcome | null>(null)
  const [submittedForApproval, setSubmittedForApproval] = useState(false)
  const [error, setError]                       = useState('')

  // Existing seller records filed under this address. Non-null means the form
  // refused, and the block below names every one of them.
  const [duplicates, setDuplicates] = useState<ExistingPartner[] | null>(null)

  const isSuperAdmin = crmUser?.role === 'superadmin'

  const [form, setForm] = useState({
    displayName:     '',
    phone:           '',
    email:           '',
    city:            '',
    description:     '',
  })
  // Flags an already-registered email / phone while it is being typed.
  const registered = useRegisteredCheck(form.email, form.phone)

  // ── Opening coin load — raised as a card, never written here ────────────────
  const [initialBalance, setInitialBalance] = useState('0')
  const [paymentMode, setPaymentMode]       = useState('NEFT')
  const [utrNumber, setUtrNumber]           = useState('')
  const [transactionDate, setTransactionDate] = useState('')
  const [amountPaidInr, setAmountPaidInr]   = useState('')
  const [paymentProofUrl, setPaymentProofUrl] = useState('')
  const [paymentProofProgress, setPaymentProofProgress] = useState(0)
  const [paymentProofFile, setPaymentProofFile] = useState<File | null>(null)
  const paymentProofRef = useRef<HTMLInputElement>(null)

  // The reused-UTR check, run before the card is raised rather than after.
  const [refHits, setRefHits] = useState<DuplicateRef[] | null>(null)
  const [checkingRef, setCheckingRef] = useState(false)

  // ── ID document uploads (multiple) ─────────────────────────────────────────
  const [docs, setDocs] = useState<DocFile[]>([])
  const docInputRef = useRef<HTMLInputElement>(null)
  const [pendingDocLabel, setPendingDocLabel] = useState('Aadhaar')

  if (!crmUser || !canAccess(crmUser, ['superadmin', 'app_admin', 'ops_admin', 'ops_member'])) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-slate-400">Access denied.</p>
      </div>
    )
  }

  const set = (field: string, value: string) => setForm(p => ({ ...p, [field]: value }))
  const hasInitialCoins = parseInt(initialBalance) > 0

  // ── Upload helpers ──────────────────────────────────────────────────────────
  function uploadPaymentProof(file: File) {
    setPaymentProofFile(file)
    // Path matches the /sellerPaymentProofs/{fileName} storage rule (CRM write allowed)
    const storageRef = ref(storage, `sellerPaymentProofs/${Date.now()}_${file.name}`)
    const task = uploadBytesResumable(storageRef, file)
    task.on(
      'state_changed',
      snap => setPaymentProofProgress(Math.round(snap.bytesTransferred / snap.totalBytes * 100)),
      err => { console.error(err); setError('Payment proof upload failed.') },
      async () => setPaymentProofUrl(await getDownloadURL(task.snapshot.ref)),
    )
  }

  function addDocFile(file: File, label: string) {
    const idx = docs.length
    setDocs(prev => [...prev, { file, progress: 0, url: '', label }])
    // Path matches the /sellerDocs/crm/{fileName} storage rule (CRM write allowed)
    const storageRef = ref(storage, `sellerDocs/crm/${Date.now()}_${file.name}`)
    const task = uploadBytesResumable(storageRef, file)
    task.on(
      'state_changed',
      snap => setDocs(prev => prev.map((d, i) => i === idx
        ? { ...d, progress: Math.round(snap.bytesTransferred / snap.totalBytes * 100) }
        : d)),
      err => { console.error(err); setError('Document upload failed.') },
      async () => {
        const url = await getDownloadURL(task.snapshot.ref)
        setDocs(prev => prev.map((d, i) => i === idx ? { ...d, url } : d))
      },
    )
  }

  function removeDoc(idx: number) {
    setDocs(prev => prev.filter((_, i) => i !== idx))
  }

  /** Has this UTR been used on an earlier card? Checked before raising, not after. */
  async function checkUtr() {
    const utr = utrNumber.trim()
    if (!utr) { setRefHits(null); return }
    setCheckingRef(true)
    try {
      setRefHits(await inventory.paymentReferenceHistory(utr))
    } catch {
      // The card raises its own authoritative check. Showing nothing here is
      // honest — the UI below says "not checked", never "clean".
      setRefHits(null)
    } finally {
      setCheckingRef(false)
    }
  }

  /**
   * Raise the coin purchase card for the opening load.
   *
   * The seller id is the Firestore document id, which is also the partner id on
   * the API side. If no partner record exists behind it yet the API refuses,
   * and that refusal is carried back verbatim rather than swallowed — a seller
   * created with no card raised is a seller whose payment nobody is holding.
   */
  async function raiseOpeningLoad(newSellerId: string, coins: number): Promise<OpeningOutcome> {
    if (coins <= 0) return { kind: 'none' }

    const paid = parseFloat(amountPaidInr) || 0
    try {
      const card = await inventory.requestCoinPurchase(newSellerId, {
        coins,
        amount_paid_minor: Math.round(paid * 100),
        payment_ref: utrNumber.trim(),
        evidence_url: paymentProofUrl,
        reason:
          `Opening inventory load at account creation — ${coins.toLocaleString('en-IN')} coins `
          + `against ${paymentMode} ${utrNumber.trim()}`
          + (transactionDate ? ` dated ${transactionDate}` : ''),
      })
      return {
        kind: 'raised',
        coins,
        cardId: card.id,
        stage: card.stage,
        warning: card.warning ?? '',
      }
    } catch (err) {
      return {
        kind: 'failed',
        coins,
        message:
          err instanceof ApiError
            ? err.message
            : 'The coin purchase card could not be raised.',
      }
    }
  }

  // ── Submit ──────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    setError('')
    setDuplicates(null)
    if (!form.displayName.trim() || !form.phone.trim() || !form.email.trim()) {
      setError('Name, phone and email are required.'); return
    }
    if (hasInitialCoins) {
      if (!utrNumber.trim()) { setError('UTR / Transaction ID is required when adding initial balance.'); return }
      if (!transactionDate) { setError('Transaction date is required.'); return }
      if (!amountPaidInr || parseFloat(amountPaidInr) <= 0) { setError('Amount paid (₹) is required.'); return }
      if (!paymentProofUrl) { setError('Payment proof screenshot is required when adding initial balance.'); return }
    }
    // Check all docs have finished uploading
    const pendingUploads = docs.filter(d => d.progress > 0 && !d.url)
    if (pendingUploads.length > 0) { setError('Please wait for all document uploads to complete.'); return }

    setSubmitting(true)
    try {
      const balance = parseInt(initialBalance) || 0
      const emailLower = normaliseEmail(form.email)

      // ── Refuse a duplicate before the first write ──────────────────────────
      //
      // `sellers` is readable by any signed-in caller — `allow read: if
      // request.auth != null` — so this query always runs for staff. It looks
      // only at `sellers`: an agency at this address applying to also sell
      // coins is not a duplicate, and that application does not come through
      // this form anyway (see lib/partnerRoles.ts).
      //
      // A refusal or a dropped connection stops the submit rather than being
      // read as "clean". Nothing has been written at this point either way.
      const existing = await findPartnersByEmail('seller', emailLower)
      if (!existing.checked) {
        setError(
          'The check for an existing seller under this address could not be run, '
          + `so nothing was created: ${existing.reason}`,
        )
        return
      }
      if (existing.matches.length > 0) {
        setDuplicates(existing.matches)
        return
      }

      const sellerPayload: Record<string, unknown> = {
        crmId:           generateCrmId(),
        displayName:     form.displayName.trim(),
        phone:           form.phone.replace(/\s/g, ''),
        email:           emailLower,
        city:            form.city.trim(),
        description:     form.description.trim(),
        idDocUrls:       docs.filter(d => d.url).map(d => ({ label: d.label, url: d.url })),
        isApproved:      false,
        isActive:        false,
        status:          'pending',
        // Pinned to zero on every path, with no exception for a superadmin.
        // Inventory is money; it arrives through an executed card and nowhere
        // else. `firestore.rules` refuses a browser write to either of these on
        // update for exactly this reason, and a non-zero opening balance here
        // was the last way round it.
        coinBalance:     0,
        totalCoinsSold:  0,
        qrCodeUrl:       '',
        source:          'crm_admin',
        // NOTE: the password is deliberately NOT stored on the seller document.
        // `sellers` is readable by every authenticated app user (firestore.rules),
        // so persisting it here leaked every seller's password platform-wide.
        // Nothing ever read this field — the auth account is created from the
        // in-memory form value by createPartnerLogin(), before this payload is
        // written at all.
      }

      // ── The login, FIRST, on BOTH paths, before anything is written ────────
      //
      // This writes no Firestore document, so a refusal here costs nothing.
      // It is also the authoritative uniqueness test on the address: the
      // duplicate check above cannot see a login that has no seller record
      // behind it, and this can.
      //
      // And it is where the password goes. The approval path used to skip this
      // entirely — it asked for a password, discarded it, and filed a request
      // that produced a seller nobody could sign in as. Doing it here means the
      // credential is consumed at the moment it is typed: from here on the flow
      // carries `crmUid`, which identifies the login and unlocks nothing.
      // `adminMode: true` runs it on a throwaway secondary Firebase app so the
      // staff member's own session survives.
      //
      // RC: the record is written INSIDE the login's step (`createPartnerLoginThen`),
      // so when it fails the login made a moment ago is removed again rather
      // than left in Auth holding the address with nothing behind it — the
      // retry this page invites would otherwise be refused on the address.
      let crmUid: string
      let createdSellerId = ''
      let resetEmailSent = false
      try {
        const created = await createPartnerLoginThen(
          { email: emailLower, kind: 'seller' },
          async (uid) => {
            if (isSuperAdmin) {
              // Superadmin: create directly, holding nothing.
              //
              // Written WITHOUT `crmUid`. If the two writes below fail, the
              // record is left with no login attached — which is exactly what
              // `/sellers` badges, so the state is visible rather than
              // invisible. Writing the link here would hide it behind a uid
              // whose CRM account does not exist.
              const docRef = await addDoc(collection(db, 'sellers'), {
                ...sellerPayload,
                ownerUid:    '',
                createdBy:   crmUser?.uid ?? '',
                createdAt:   serverTimestamp(),
                /*
                 * `_resendEmail` is NOT written here, and used to be.
                 *
                 * The resend triggers are `onUpdate` and fire only when the
                 * field CHANGES, so a value present from the very first write
                 * fired nothing — the resend was dead on arrival. And had it
                 * ever fired, it would have duplicated the registration email
                 * that `onSellerRegistered` already sends on create,
                 * unconditionally, for staff-registered sellers as well as
                 * self-signed-up ones.
                 *
                 * The field is now written only by the Resend button on the
                 * partner list, which is an update to an existing document and
                 * therefore the state change the trigger was built to watch.
                 */
              })
              return docRef.id
            }
            // ── Admin / other: submit for superadmin approval ──────────────
            //
            // `crmUid` — not a password — is what travels through the queue.
            // It names the Firebase Auth account created moments ago, and it
            // is a public identifier: holding it grants nothing, and nobody,
            // superadmin included, can read the password back out of it.
            //
            // `onApprovalApproved` in functions/src/index.ts writes the
            // `crmUsers` document against that uid when the request is
            // approved, and does it BEFORE it creates the seller, so a failure
            // there leaves no seller behind rather than one nobody can sign in
            // as. `crmUid` is in the payload, so the same `ref.set` that
            // creates the seller also writes the back-link the rules bind on —
            // there is no second write to miss.
            await submitApproval({
              type:             'create_seller',
              description:      `Create coin seller: ${form.displayName.trim()} (${emailLower})`,
              targetLabel:      `Seller: ${form.displayName.trim()}`,
              targetCollection: 'sellers',
              targetDocId:      '',
              operation:        'create',
              payload:          { ...sellerPayload, crmUid: uid },
              requestedBy: {
                uid:  crmUser?.uid  ?? '',
                name: crmUser?.name ?? '',
                role: crmUser?.role ?? '',
              },
            })
            return ''
          },
        )
        crmUid = created.uid
        createdSellerId = created.result
        resetEmailSent = created.resetEmailSent
      } catch (authErr: unknown) {
        if (isRecordNotWritten(authErr)) {
          console.error('Seller record could not be written:', authErr.reason)
          setError(recordNotWrittenMessage(authErr, emailLower, 'coin seller'))
          return
        }
        setError(
          errorCode(authErr) === 'auth/email-already-in-use'
            ? `A login already exists for ${emailLower}, so nothing was created. `
              + 'If they are already a partner, grant the coin-seller capability '
              + 'from their own record instead of registering them again. If this '
              + 'is a stale login from a failed registration, it has to be removed '
              + 'in the Firebase console before this address can be used.'
            : `The login could not be created, so nothing was created: ${errorMessage(authErr)}`,
        )
        return
      }

      if (isSuperAdmin) {
        setSellerId(createdSellerId)

        try {
          await createSellerAccount({
            email:          emailLower,
            name:           form.displayName.trim(),
            phone:          form.phone.replace(/\s/g, ''),
            sellerId:       createdSellerId,
            adminMode:      true,
            uid:            crmUid,
            linkPartnerDoc: false,
          })
          await updateDoc(doc(db, 'sellers', createdSellerId), { crmUid })
          setLogin({ kind: 'attached', email: emailLower, resetEmailSent })
        } catch (linkErr: unknown) {
          // The seller record is committed and is a real application, so it is
          // NOT deleted — somebody has to decide about it. But it has no login,
          // and saying otherwise is the failure that produced this bug.
          console.error('Seller CRM account could not be attached:', linkErr)
          setLogin({
            kind:    'failed',
            email:   emailLower,
            message: errorMessage(linkErr),
          })
        }

        // ── The opening load, as a card ──────────────────────────────────────
        // Raised last, and deliberately not fatal: the seller record is already
        // committed, so a refusal here must not read as "the seller was not
        // created". The outcome is reported separately on the success screen.
        setOpening(await raiseOpeningLoad(createdSellerId, balance))

        setSuccess(true)
      } else {
        setLogin({ kind: 'attached', email: emailLower, resetEmailSent })
        setSubmittedForApproval(true)
      }
    } catch (err: unknown) {
      console.error(err)
      const msg = err instanceof Error ? err.message : String(err)
      setError(`Failed to create seller: ${msg}`)
    } finally {
      setSubmitting(false)
    }
  }

  // ── Submitted for approval (non-superadmin) ────────────────────────────────
  if (submittedForApproval) {
    return (
      <div className="max-w-xl mx-auto text-center py-16">
        <div className="w-20 h-20 bg-blue-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
          <Clock className="text-blue-400 w-12 h-12" />
        </div>
        <h2 className="text-2xl font-bold text-white mb-2">Submitted for Approval</h2>
        <p className="text-slate-400 mb-6">
          The seller registration has been sent to a superadmin for review.
          The account will be created once approved.
        </p>

        {/* The login exists NOW even though the seller does not — that is the
            whole point, and it has to be said, because the person filling this
            in has just been asked for a password and needs to know where it
            went and that nobody can look it up for them. */}
        {login?.kind === 'attached' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 mb-6 text-left">
            <p className="text-white text-sm font-semibold flex items-center gap-2">
              <KeyRound size={15} className="text-slate-500" />
              A login for {login.email} exists already.
            </p>
            <p className="text-slate-400 text-sm mt-1">
              It was created just now with a random password that{' '}
              <span className="text-white font-semibold">nobody knows</span> — not you, not the
              superadmin, and it is stored nowhere.{' '}
              {login.resetEmailSent
                ? <>A set-password email has been sent to the seller; they choose their own password from the link in it.</>
                : <>The set-password email could <span className="text-yellow-400 font-semibold">not</span> be sent just now — tell the seller to use &ldquo;Forgot password&rdquo; on the sign-in page, which sends the same link.</>}
            </p>
            <p className="text-slate-400 text-sm mt-2">
              The login opens nothing yet. Approving this request is what creates
              the seller and writes the CRM account against this login, and the
              account is still <span className="text-yellow-400 font-semibold">pending</span> after
              that until the seller themself is approved.
            </p>
            <p className="text-slate-500 text-sm mt-2">
              If the request is rejected, that login stays behind holding nothing.
              Remove it in the Firebase console, or this address cannot be
              registered again.
            </p>
          </div>
        )}

        {hasInitialCoins && (
          <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl px-5 py-4 mb-6 text-left">
            <p className="text-amber-100 text-sm font-semibold flex items-center gap-2">
              <AlertTriangle size={15} /> The opening load was not raised.
            </p>
            <p className="text-amber-100/80 text-sm mt-1">
              The seller does not exist yet, so there is nothing to raise a coin
              purchase card against. Once the account is approved and created,
              record the{' '}
              {(parseInt(initialBalance) || 0).toLocaleString('en-IN')} coins from{' '}
              <Link
                href="/coin-purchases"
                className="text-amber-200 underline underline-offset-2 hover:text-white"
              >
                Coin Purchases
              </Link>{' '}
              using UTR{' '}
              <span className="font-mono">{utrNumber.trim() || '—'}</span>. Keep the
              payment proof — the card needs it.
            </p>
          </div>
        )}
        <div className="flex justify-center gap-3">
          <Link href="/approvals"
            className="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors text-sm">
            View Approval Queue →
          </Link>
          <Link href="/sellers"
            className="bg-slate-700 hover:bg-slate-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors text-sm">
            Back to Sellers
          </Link>
        </div>
      </div>
    )
  }

  // ── Success screen (superadmin direct create) ───────────────────────────────
  if (success) {
    return (
      <div className="max-w-xl mx-auto py-16">
        <div className="text-center">
          <div className="w-20 h-20 bg-yellow-500/10 rounded-full flex items-center justify-center mx-auto mb-6">
            <CheckCircle className="text-yellow-400 w-12 h-12" />
          </div>
          <h2 className="text-2xl font-bold text-white mb-2">
            {login?.kind === 'failed'
              ? 'Seller Created — but it has no login'
              : 'Seller Created — Pending Approval'}
          </h2>
          <p className="text-slate-400 mb-4">
            The account has been created and a registration confirmation email has been sent to the seller.
            The account is <span className="text-yellow-400 font-semibold">pending</span> — go to the seller detail page to review and approve.
          </p>
          <div className="bg-slate-800 border border-slate-700 rounded-xl px-6 py-4 mb-6 inline-block">
            <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">Seller ID</p>
            <p className="text-pink-400 font-mono font-semibold">{sellerId}</p>
          </div>
        </div>

        {/* The login, said as plainly as the balance is. "A CRM account with
            this email already exists" while silently leaving a half-made seller
            is precisely the failure that produced this screen's rewrite. */}
        {login?.kind === 'attached' && (
          <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 mb-6 text-left">
            <p className="text-white text-sm font-semibold flex items-center gap-2">
              <KeyRound size={15} className="text-slate-500" />
              A login was created for {login.email}.
            </p>
            <p className="text-slate-400 text-sm mt-1">
              It is <span className="text-yellow-400 font-semibold">pending</span> too
              and opens nothing until this seller is approved.
            </p>
            <p className="text-slate-400 text-sm mt-1">
              {login.resetEmailSent
                ? <>A set-password email has been sent to the seller; they choose their own password from it. Nobody here knows it.</>
                : <>The set-password email could <span className="text-yellow-400 font-semibold">not</span> be sent just now — tell the seller to use &ldquo;Forgot password&rdquo; on the sign-in page.</>}
            </p>
          </div>
        )}

        {login?.kind === 'failed' && (
          <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-5 py-4 mb-6 text-left">
            <p className="text-red-200 text-sm font-semibold flex items-center gap-2">
              <UserX size={15} /> This seller has NO login. Nobody can sign in as them.
            </p>
            <p className="text-red-100/85 text-sm mt-1">
              The seller record was created, but the CRM account for{' '}
              <span className="font-mono">{login.email}</span> could not be
              written: {login.message}
            </p>
            <p className="text-red-100/75 text-sm mt-2">
              A Firebase login for that address <strong>does</strong> now exist and
              is not attached to anything, so re-registering this seller will be
              refused. The record below is a real application and has deliberately
              not been deleted — it shows on{' '}
              <Link href="/sellers" className="text-red-200 underline underline-offset-2 hover:text-white">
                /sellers
              </Link>{' '}
              badged <span className="font-semibold">no login attached</span>.
              Reject it there if it is not wanted; the reason goes on the record.
            </p>
          </div>
        )}

        {/* The balance, said plainly. This screen used to imply the opening load
            was done; it never is at this point. */}
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 mb-6 text-left">
          <p className="text-white text-sm font-semibold flex items-center gap-2">
            <Coins size={15} className="text-slate-500" />
            This seller holds nothing.
          </p>
          <p className="text-slate-400 text-sm mt-1">
            They were created with a balance of{' '}
            <span className="text-white font-semibold">zero coins</span>, and they
            stay at zero until a coin purchase card is signed by an owner and
            executed. That is true whatever the form said.
          </p>
        </div>

        {opening.kind === 'raised' && (
          <div className="bg-blue-500/10 border border-blue-500/30 rounded-xl px-5 py-4 mb-6 text-left">
            <p className="text-blue-100 text-sm font-semibold flex items-center gap-2">
              <ShieldCheck size={15} /> Opening load raised as a card —{' '}
              {coinText(opening.coins)}
            </p>
            <p className="text-blue-100/85 text-sm mt-1">
              <strong>No coins have been credited.</strong> The card is at{' '}
              {opening.stage.replace(/_/g, ' ')}. Someone other than you has to
              verify it, an owner has to sign it, and then it has to be executed
              from Coin Purchases. Only that last step gives the seller stock.
            </p>
            {opening.warning && (
              <p className="text-red-300 text-sm mt-2 font-medium">{opening.warning}</p>
            )}
            <p className="text-blue-100/50 text-xs font-mono mt-2">{opening.cardId}</p>
            <div className="flex flex-wrap gap-3 mt-3">
              <Link
                href="/board"
                className="inline-flex items-center gap-1.5 text-blue-200 hover:text-white text-sm underline underline-offset-2"
              >
                Open the money board <ArrowRight size={13} />
              </Link>
              <Link
                href="/coin-purchases"
                className="inline-flex items-center gap-1.5 text-blue-200 hover:text-white text-sm underline underline-offset-2"
              >
                Coin purchases <ArrowRight size={13} />
              </Link>
            </div>
          </div>
        )}

        {opening.kind === 'failed' && (
          <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-5 py-4 mb-6 text-left">
            <p className="text-red-200 text-sm font-semibold flex items-center gap-2">
              <XCircle size={15} /> The opening load was NOT raised.
            </p>
            <p className="text-red-100/85 text-sm mt-1">{opening.message}</p>
            <p className="text-red-100/75 text-sm mt-2">
              The seller exists and holds zero. Nobody is holding a record of the{' '}
              {opening.coins.toLocaleString('en-IN')} coins that were paid for —
              raise it by hand from Coin Purchases against seller{' '}
              <span className="font-mono">{sellerId}</span>, UTR{' '}
              <span className="font-mono">{utrNumber.trim() || '—'}</span>, and keep
              the payment proof.
            </p>
            <Link
              href="/coin-purchases"
              className="inline-flex items-center gap-1.5 text-red-200 hover:text-white text-sm underline underline-offset-2 mt-2"
            >
              Record the payment now <ArrowRight size={13} />
            </Link>
          </div>
        )}

        <div className="flex justify-center gap-3">
          <Link href={`/sellers/${sellerId}`}
            className="bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors text-sm">
            Review & Approve →
          </Link>
          <Link href="/sellers"
            className="bg-slate-700 hover:bg-slate-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors text-sm">
            Back to Sellers
          </Link>
        </div>
      </div>
    )
  }

  // ── Form ────────────────────────────────────────────────────────────────────
  return (
    <div>
      <div className="mb-6 flex items-center gap-3">
        <Link href="/sellers" className="text-slate-400 hover:text-white transition-colors text-sm flex items-center gap-1">
          <ArrowLeft className="w-3.5 h-3.5" /> Sellers
        </Link>
        <span className="text-slate-600">/</span>
        <span className="text-slate-300 text-sm">Add Seller</span>
      </div>
      <h1 className="text-3xl font-bold text-white mb-1">Add Coin Seller</h1>
      <p className="text-slate-400 mb-8 text-sm">
        Creates a seller account in <span className="text-yellow-400 font-medium">Pending</span> status.
        A registration email is sent immediately. Approve the account separately after review.
      </p>

      <div className="max-w-2xl space-y-6">

        {/* ── Basic Info ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-5">
          <h2 className="text-white font-semibold flex items-center gap-2 text-sm"><User size={15} className="text-pink-400" />Basic Information</h2>

          <div>
            <label className={labelClass}>Full Name *</label>
            <input type="text" className={inputClass} placeholder="Seller's full name"
              value={form.displayName} onChange={e => set('displayName', e.target.value)} />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}><Phone className="w-3.5 h-3.5 inline mr-1 text-pink-400" />Phone *</label>
              <PhoneInput className={inputClass} placeholder="Mobile number"
                value={form.phone} onChange={v => set('phone', v)} />
              {registered.phone && <p className="text-xs text-red-400 mt-1">{registered.phone}</p>}
            </div>
            <div>
              <label className={labelClass}><Mail className="w-3.5 h-3.5 inline mr-1 text-pink-400" />Email *</label>
              <input type="email" className={inputClass} placeholder="seller@email.com"
                value={form.email} onChange={e => set('email', e.target.value)} />
              {registered.email && <p className="text-xs text-red-400 mt-1">{registered.email}</p>}
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}><MapPin className="w-3.5 h-3.5 inline mr-1 text-pink-400" />City / Area</label>
              <input type="text" className={inputClass} placeholder="e.g. Mumbai"
                value={form.city} onChange={e => set('city', e.target.value)} />
            </div>
            <div>
              <label className={labelClass}><AlignLeft className="w-3.5 h-3.5 inline mr-1 text-pink-400" />Notes (optional)</label>
              <input type="text" className={inputClass} placeholder="Internal notes"
                value={form.description} onChange={e => set('description', e.target.value)} />
            </div>
          </div>

          {/* Audit C-17 / CRM-FLOW 2.1.3: staff never type the seller's
              password. The login is created with a random one nobody sees and
              the seller is emailed a link to set their own. */}
          <div className="flex items-start gap-2 bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-3">
            <Shield className="w-4 h-4 text-pink-400 mt-0.5 shrink-0" />
            <p className="text-xs text-slate-400 leading-relaxed">
              <span className="text-slate-200 font-medium">No password is typed here.</span> The CRM login is
              created with a random password nobody sees, and a set-password email goes to the seller&rsquo;s
              address above. They choose their own; you never know it.
            </p>
          </div>
        </div>

        {/* ── ID Documents ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <h2 className="text-white font-semibold flex items-center gap-2 text-sm"><FileText size={15} className="text-pink-400" />ID Documents</h2>
          <p className="text-slate-500 text-xs">Upload Aadhaar, PAN, GST certificate, or any other verification documents. Multiple files allowed.</p>

          {docs.length > 0 && (
            <div className="space-y-2">
              {docs.map((d, idx) => (
                <div key={idx} className="flex items-center gap-3 bg-slate-800 border border-slate-700 rounded-lg px-4 py-2.5">
                  <FileText size={14} className="text-pink-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-white text-sm font-medium truncate">{d.label} — {d.file.name}</p>
                    {d.url ? (
                      <p className="text-green-400 text-xs flex items-center gap-1"><CheckCircle size={10} /> Uploaded</p>
                    ) : d.progress > 0 ? (
                      <div className="flex items-center gap-2">
                        <div className="flex-1 bg-slate-700 rounded-full h-1">
                          <div className="bg-pink-500 h-1 rounded-full transition-all" style={{ width: `${d.progress}%` }} />
                        </div>
                        <span className="text-slate-400 text-xs">{d.progress}%</span>
                      </div>
                    ) : (
                      <p className="text-slate-500 text-xs">Queued…</p>
                    )}
                  </div>
                  <button onClick={() => removeDoc(idx)} className="text-slate-600 hover:text-red-400 transition-colors flex-shrink-0">
                    <X size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <select value={pendingDocLabel} onChange={e => setPendingDocLabel(e.target.value)}
              className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-pink-500 flex-shrink-0">
              {['Aadhaar', 'PAN Card', 'GST Certificate', 'Driving Licence', 'Passport', 'Voter ID', 'Other'].map(l => (
                <option key={l} value={l}>{l}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => docInputRef.current?.click()}
              className="flex-1 flex items-center justify-center gap-2 border-2 border-dashed border-slate-600 hover:border-pink-500 rounded-lg py-2 text-slate-400 hover:text-pink-400 transition-colors text-sm"
            >
              <Upload size={14} /> Upload Document
            </button>
            <input
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              ref={docInputRef}
              onChange={e => { const f = e.target.files?.[0]; if (f) { addDocFile(f, pendingDocLabel); e.target.value = '' } }}
            />
          </div>
        </div>

        {/* ── Opening coin load ── */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-4">
          <h2 className="text-white font-semibold flex items-center gap-2 text-sm"><Receipt size={15} className="text-pink-400" />Opening Coin Load</h2>

          <div className="bg-blue-500/5 border border-blue-500/25 rounded-lg px-4 py-3">
            <p className="text-blue-100 text-sm font-semibold">
              The seller is created holding zero. Always.
            </p>
            <p className="text-blue-100/85 text-sm mt-1">
              A number here does not set a balance — it raises a{' '}
              <span className="font-semibold">coin purchase card</span> for the
              inventory that was paid for.{' '}
              <span className="font-semibold">
                Someone else has to verify that card and an owner has to sign it
              </span>
              , and the coins only exist once it is executed. Until then this
              seller has nothing to sell, and the money board is where you follow
              it.
            </p>
          </div>

          <div>
            <label className={labelClass}>Opening coin load (coins)</label>
            <input type="number" min="0" className={inputClass} placeholder="0"
              value={initialBalance} onChange={e => setInitialBalance(e.target.value)} />
            <p className="text-slate-500 text-xs mt-1.5">
              {hasInitialCoins
                ? `A card will be raised for ${(parseInt(initialBalance) || 0).toLocaleString('en-IN')} coins. The seller starts at zero regardless.`
                : 'Leave at 0 if nothing has been paid for yet. Inventory can be recorded any time from Coin Purchases.'}
            </p>
          </div>

          {hasInitialCoins && (
            <div className="space-y-4 pt-3 border-t border-slate-800">
              <div className="flex items-center gap-2 text-yellow-400 text-xs font-medium">
                <AlertTriangle size={13} />
                Payment details are required — they go onto the card for whoever verifies it
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>Payment Mode *</label>
                  <select value={paymentMode} onChange={e => setPaymentMode(e.target.value)} className={selectClass}>
                    {['NEFT', 'IMPS', 'UPI', 'RTGS', 'Cash', 'Cheque', 'Binance', 'USDT'].map(m => (
                      <option key={m} value={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelClass}>Amount Paid (₹) *</label>
                  <input type="number" min="0" step="0.01" className={inputClass} placeholder="e.g. 2290"
                    value={amountPaidInr} onChange={e => setAmountPaidInr(e.target.value)} />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className={labelClass}>UTR / Transaction ID *</label>
                  <input type="text" className={inputClass} placeholder="e.g. UTR123456789"
                    value={utrNumber}
                    onChange={e => { setUtrNumber(e.target.value); setRefHits(null) }}
                    onBlur={checkUtr} />
                  {checkingRef && (
                    <p className="text-slate-500 text-xs mt-1.5 flex items-center gap-1.5">
                      <Loader2 size={11} className="animate-spin" />
                      Checking whether this reference has been used before…
                    </p>
                  )}
                </div>
                <div>
                  <label className={labelClass}>Transaction Date *</label>
                  <input type="date" className={inputClass}
                    value={transactionDate} onChange={e => setTransactionDate(e.target.value)} />
                </div>
              </div>

              {refHits !== null && refHits.length > 0 && (
                <div className="bg-red-500/10 border border-red-500/40 rounded-lg px-4 py-3">
                  <p className="text-red-200 text-sm font-semibold">
                    This reference has been used before.
                  </p>
                  <ul className="mt-1 space-y-0.5">
                    {refHits.map(d => (
                      <li key={d.card_id} className="text-red-200/80 text-xs">
                        {coinText(Number(d.amount ?? 0))} · {d.stage} · seller {d.subject_id}
                      </li>
                    ))}
                  </ul>
                  <p className="text-red-200/70 text-xs mt-1.5">
                    The card can still be raised if this is genuinely a separate
                    payment — it will be flagged for the owner. The same UTR
                    credited twice is money we never received.
                  </p>
                </div>
              )}
              {refHits !== null && refHits.length === 0 && (
                <p className="text-green-300 text-xs flex items-center gap-1.5">
                  <CheckCircle size={11} /> This reference has not been used on any
                  other card.
                </p>
              )}

              <div>
                <label className={labelClass}>Payment Proof Screenshot *</label>
                <div
                  onClick={() => !paymentProofUrl && paymentProofRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-5 text-center cursor-pointer transition-colors ${
                    paymentProofUrl
                      ? 'border-green-500 bg-green-500/5 cursor-default'
                      : paymentProofFile && !paymentProofUrl
                      ? 'border-pink-500/50 bg-pink-500/5'
                      : 'border-slate-600 hover:border-pink-500'
                  }`}
                >
                  <input type="file" accept="image/*,application/pdf" className="hidden" ref={paymentProofRef}
                    onChange={e => { const f = e.target.files?.[0]; if (f) uploadPaymentProof(f) }} />
                  {paymentProofUrl ? (
                    <div className="flex items-center justify-center gap-2 text-green-400 text-sm font-medium">
                      <CheckCircle className="w-4 h-4" /> {paymentProofFile?.name ?? 'Proof uploaded'}
                    </div>
                  ) : paymentProofFile ? (
                    <div>
                      <p className="text-sm text-pink-400 mb-2">Uploading… {paymentProofProgress}%</p>
                      <div className="w-48 bg-slate-700 rounded-full h-1.5 mx-auto">
                        <div className="bg-pink-500 h-1.5 rounded-full" style={{ width: `${paymentProofProgress}%` }} />
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center justify-center gap-2 text-slate-400 text-sm">
                      <Upload className="w-4 h-4" /> Click to upload payment screenshot or receipt
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── Already registered ── */}
        {duplicates && duplicates.length > 0 && (
          <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-5 py-4">
            <p className="text-red-200 text-sm font-semibold flex items-center gap-2">
              <XCircle size={15} className="flex-shrink-0" />
              {duplicateHeadline('seller', duplicates)}
            </p>
            <ul className="mt-3 space-y-3">
              {duplicates.map((m) => (
                <li key={m.id} className="border-l-2 border-red-500/40 pl-3">
                  <Link
                    href={m.href}
                    className="text-white text-sm font-medium underline underline-offset-2 hover:text-pink-400"
                  >
                    {m.name}
                  </Link>
                  <p className="text-red-100/60 text-xs font-mono">{m.id}</p>
                  <p className="text-red-100/85 text-sm mt-0.5">
                    It is {statusPhrase(m)}.
                  </p>
                  {loginPhrase(m) && (
                    <p className="text-amber-200/90 text-sm mt-0.5">{loginPhrase(m)}</p>
                  )}
                  {m.isSecondRole && (
                    <p className="text-indigo-200/90 text-sm mt-0.5">
                      It was filed as a second capability beside an existing agency.
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-red-100/75 text-sm mt-3">
              Reopen the record above rather than filing another. If this person
              genuinely runs a second, separate coin-selling business, register it
              under its own email address — one address, one seller record.
            </p>
            <p className="text-red-100/60 text-sm mt-2">
              An existing <span className="font-semibold">agency</span> at this
              address is a different matter and is not blocked here: grant them the
              coin-seller capability from their own record, which keeps the two
              businesses on one login with separate balances.
            </p>
          </div>
        )}

        {/* ── Error + Submit ── */}
        {error && (
          <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
            <AlertTriangle size={14} className="flex-shrink-0" />
            {error}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 pb-8">
          <div className="text-xs text-slate-500 space-y-1">
            <p className="flex items-center gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 text-yellow-500 flex-shrink-0" />
              Account starts as <span className="text-yellow-400 font-medium">Pending</span> — approve from the seller detail page
            </p>
            <p className="flex items-center gap-1.5">
              <Coins className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />
              {hasInitialCoins
                ? `Balance starts at zero. A card for ${(parseInt(initialBalance) || 0).toLocaleString('en-IN')} coins is raised — it needs a second person and an owner signature.`
                : 'Balance starts at zero. No coins are credited by this form.'}
            </p>
          </div>
          <button onClick={handleSubmit} disabled={submitting}
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors disabled:opacity-60 text-sm">
            {submitting
              ? <><Loader2 size={15} className="animate-spin" />Creating…</>
              : 'Create Seller'}
          </button>
        </div>
      </div>
    </div>
  )
}
