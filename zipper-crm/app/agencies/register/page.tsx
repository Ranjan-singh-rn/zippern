'use client'

/**
 * Register an agency.
 *
 * ── The order things happen in, and why it changed ───────────────────────────
 *
 * This screen used to `addDoc` the agency and THEN create the Firebase Auth
 * account, catching `auth/email-already-in-use` afterwards, saying "A CRM
 * account with this email already exists" and returning — leaving the agency
 * document behind with no login. The seller form had the identical bug and
 * produced three orphans in production.
 *
 * The order now is:
 *
 *   1. refuse outright if this address already holds an agency record;
 *   2. create the **login** — which writes nothing to Firestore, so its refusal
 *      costs nothing;
 *   3. write the agency document;
 *   4. write the `crmUsers` document and link `crmUid` back.
 *
 * Nothing before step 3 leaves anything behind. `agencies` delete is
 * `isSuperAdmin()` in `firestore.rules`, so this screen could clean up after
 * itself for a superadmin and could not for an `app_admin` — but a failure at
 * step 4 leaves a real application somebody has to decide about, so it is not
 * deleted on any path. It is reported in those words below and `/agencies`
 * badges it "no login attached".
 *
 * ── THE PASSWORD IS NOT STORED. ANYWHERE. ────────────────────────────────────
 *
 * A non-superadmin cannot create the agency record, so this screen files an
 * `approvalRequests` document instead. That request used to carry the field
 * `_password` — the plaintext CRM password the agency owner would sign in with
 * — under the comment "store password hash hint for superadmin to create
 * account on approval". It was not a hash and it was not a hint: it was the
 * credential, and `onApprovalApproved` copied the whole payload onto the new
 * `agencies` document, so it landed in a second collection too.
 * `approvalRequests` is readable by the superadmin AND by the requester
 * (firestore.rules), and `agencies` is readable by every admin. Nothing ever
 * read the field.
 *
 * `/sellers/register` had already answered this, and its answer is copied here
 * verbatim: **the login is created at registration time, from the value the
 * person just typed, before anything is written.** It was always the only
 * honest answer to "the password is needed later" — it is not needed later.
 * `createPartnerLogin` puts it into the Firebase Auth account while it is still
 * only in this browser's memory, and the account is the only place it ever
 * lives after that. The approval request then carries `crmUid` — a public
 * identifier, useless on its own — and `onApprovalApproved` writes the
 * `crmUsers` document against it when a superadmin approves.
 *
 * So the account IS created at a different point in the flow than the record
 * is: at submit, not at approval. That is the fix. There is no encryption step
 * here and there must never be one — a credential you can decrypt is a
 * credential you have stored.
 */

import { useState, useRef, useEffect } from 'react'
import { db, storage } from '@/lib/firebase'
import { addDoc, collection, serverTimestamp, doc, getDoc, updateDoc } from 'firebase/firestore'
import {
  createAgencyAccount, createPartnerLoginThen, generateCrmId, canAccess,
} from '@/lib/auth'
import { ref, uploadBytesResumable, getDownloadURL } from 'firebase/storage'
import {
  Upload,
  CheckCircle,
  ArrowRight,
  ArrowLeft,
  Building2,
  FileText,
  CreditCard,
  User,
  Phone,
  Mail,
  MapPin,
  Hash,
  Landmark,
  Wallet,
  GitBranch,
  Globe,
  Shield,
  Clock,
  KeyRound,
  UserX,
  XCircle,
} from 'lucide-react'
import { submitApproval } from '@/lib/approvals'
import { isRecordNotWritten, recordNotWrittenMessage } from '@/lib/loginThenRecord'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import {
  findPartnersByEmail, normaliseEmail, statusPhrase, loginPhrase,
  duplicateHeadline, type ExistingPartner,
} from '@/lib/partnerDuplicates'
import PhoneInput from '@/components/PhoneInput'
import { useRegisteredCheck } from '@/lib/useRegisteredCheck'

/**
 * What happened to the agency's login, kept separate from "the agency was
 * created". They are two outcomes and reporting the second without the first is
 * how an agency ends up in the queue with nobody able to sign in as it.
 */
type LoginOutcome =
  /** C-17: `resetEmailSent` — the partner was emailed a set-password link (false = tell them to use "Forgot password"). */
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

export default function RegisterAgencyPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const parentId = searchParams.get('parentId') ?? ''
  const { crmUser, loading: authLoading } = useAuth()
  const [parentAgencyName, setParentAgencyName] = useState('')

  useEffect(() => {
    if (!authLoading && !crmUser) {
      router.replace('/login')
    }
  }, [authLoading, crmUser, router])

  // If parentId is provided, fetch parent agency name for display
  useEffect(() => {
    if (!parentId) return
    if (!crmUser || !canAccess(crmUser, ['superadmin', 'app_admin'])) return
    getDoc(doc(db, 'agencies', parentId)).then((snap) => {
      if (snap.exists()) setParentAgencyName(snap.data().agencyName ?? parentId)
    }).catch(() => setParentAgencyName(parentId))
  }, [parentId, crmUser])

  const [step, setStep] = useState(1)
  const [submitting, setSubmitting] = useState(false)
  const [agencyId, setAgencyId] = useState('')
  const [createdReferralCode, setCreatedReferralCode] = useState('')
  const [submittedForApproval, setSubmittedForApproval] = useState(false)
  const [login, setLogin] = useState<LoginOutcome | null>(null)
  // Existing agency records filed under this address. Non-null means the form
  // refused, and the block in step 3 names every one of them.
  const [duplicates, setDuplicates] = useState<ExistingPartner[] | null>(null)
  const [form, setForm] = useState({
    agencyName:           '',
    ownerName:            '',
    ownerPhone:           '',
    ownerEmail:           '',
    address:              '',
    paymentType:          'india' as 'india' | 'foreign',
    country:              '',
    binanceUid:           '',
    accountName:          '',
    accountNumber:        '',
    confirmAccountNumber: '',
    ifsc:                 '',
    bankName:             '',
    branch:               '',
    upiId:                '',
  })
  // Flags an already-registered email / phone while it is being typed.
  const registered = useRegisteredCheck(form.ownerEmail, form.ownerPhone)
  const [aadhaarUrl, setAadhaarUrl] = useState('')
  const [panUrl, setPanUrl] = useState('')
  const [passbookUrl, setPassbookUrl] = useState('')
  const [aadhaarProgress, setAadhaarProgress] = useState(0)
  const [panProgress, setPanProgress] = useState(0)
  const [passbookProgress, setPassbookProgress] = useState(0)
  const [aadhaarFile, setAadhaarFile] = useState<File | null>(null)
  const [panFile, setPanFile] = useState<File | null>(null)
  const [passbookFile, setPassbookFile] = useState<File | null>(null)
  const [error, setError] = useState('')

  const aadhaarRef = useRef<HTMLInputElement>(null)
  const panRef = useRef<HTMLInputElement>(null)
  const passbookRef = useRef<HTMLInputElement>(null)

  const handleFormChange = (field: string, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }))
  }

  const handleFileUpload = (
    file: File,
    path: string,
    setProgress: (n: number) => void,
    setUrl: (s: string) => void,
    setFile: (f: File) => void
  ) => {
    setFile(file)
    setProgress(0)
    const storageRef = ref(storage, path)
    const uploadTask = uploadBytesResumable(storageRef, file)
    uploadTask.on(
      'state_changed',
      (snapshot) => {
        setProgress(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100))
      },
      (err) => {
        console.error('Upload error:', err)
        setProgress(0)
        setFile(null as unknown as File)
        setError('Upload failed: ' + (err.message ?? 'Please try again.'))
      },
      async () => {
        try {
          const url = await getDownloadURL(uploadTask.snapshot.ref)
          setUrl(url)
        } catch (err: unknown) {
          console.error('getDownloadURL error:', err)
          setProgress(0)
          setFile(null as unknown as File)
          setError('Could not get file URL after upload. Please try again.')
        }
      }
    )
  }

  const inputClass =
    'bg-slate-700 border border-slate-600 rounded-lg px-4 py-2.5 text-white w-full focus:outline-none focus:border-pink-500 focus:ring-1 focus:ring-pink-500 placeholder:text-slate-400 transition-colors'

  const labelClass = 'block text-sm font-medium text-slate-300 mb-1.5'

  // Step indicator
  const StepIndicator = () => {
    const steps = [
      { num: 1, label: 'Basic Info', icon: Building2 },
      { num: 2, label: 'KYC Docs',  icon: FileText   },
      { num: 3, label: 'Payment',   icon: CreditCard  },
      { num: 4, label: 'Done',      icon: CheckCircle },
    ]

    return (
      <div className="flex items-center justify-between mb-10">
        {steps.map((s, idx) => {
          const isCompleted = step > s.num
          const isActive = step === s.num
          const isFuture = step < s.num

          return (
            <div key={s.num} className="flex items-center flex-1">
              <div className="flex flex-col items-center">
                <div
                  className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm transition-all duration-300 ${
                    isCompleted
                      ? 'bg-green-500 text-white'
                      : isActive
                      ? 'bg-pink-500 text-white ring-4 ring-pink-500/30'
                      : 'bg-slate-700 text-slate-400'
                  }`}
                >
                  {isCompleted ? <CheckCircle className="w-5 h-5" /> : s.num}
                </div>
                <span
                  className={`text-xs mt-2 font-medium ${
                    isActive ? 'text-pink-400' : isCompleted ? 'text-green-400' : 'text-slate-500'
                  }`}
                >
                  {s.label}
                </span>
              </div>
              {idx < steps.length - 1 && (
                <div
                  className={`flex-1 h-0.5 mx-3 mb-5 transition-all duration-300 ${
                    step > s.num ? 'bg-green-500' : 'bg-slate-700'
                  }`}
                />
              )}
            </div>
          )
        })}
      </div>
    )
  }

  // Step 1: Basic Info
  const Step1 = () => {
    const handleNext = () => {
      setError('')
      if (
        !form.agencyName.trim() ||
        !form.ownerName.trim() ||
        !form.ownerPhone.trim() ||
        !form.ownerEmail.trim() ||
        !form.address.trim()
      ) {
        setError('Please fill in all required fields.')
        return
      }
      setStep(2)
    }

    return (
      <div>
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-white mb-1">Agency Information</h2>
          <p className="text-slate-400 text-sm">Enter the basic details about the agency.</p>
        </div>

        <div className="space-y-5">
          <div>
            <label className={labelClass}>
              <span className="flex items-center gap-1.5">
                <Building2 className="w-4 h-4 text-pink-400" />
                Agency Name *
              </span>
            </label>
            <input
              type="text"
              className={inputClass}
              placeholder="e.g. Sharma Travel Agency"
              value={form.agencyName}
              onChange={(e) => handleFormChange('agencyName', e.target.value)}
            />
          </div>

          <div>
            <label className={labelClass}>
              <span className="flex items-center gap-1.5">
                <User className="w-4 h-4 text-pink-400" />
                Owner Full Name *
              </span>
            </label>
            <input
              type="text"
              className={inputClass}
              placeholder="e.g. Rajesh Sharma"
              value={form.ownerName}
              onChange={(e) => handleFormChange('ownerName', e.target.value)}
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <div>
              <label className={labelClass}>
                <span className="flex items-center gap-1.5">
                  <Phone className="w-4 h-4 text-pink-400" />
                  Owner Phone *
                </span>
              </label>
              <PhoneInput
                className={inputClass}
                placeholder="Mobile number"
                value={form.ownerPhone}
                onChange={(v) => handleFormChange('ownerPhone', v)}
              />
              {registered.phone && <p className="text-xs text-red-400 mt-1">{registered.phone}</p>}
            </div>

            <div>
              <label className={labelClass}>
                <span className="flex items-center gap-1.5">
                  <Mail className="w-4 h-4 text-pink-400" />
                  Owner Email *
                </span>
              </label>
              <input
                type="email"
                className={inputClass}
                placeholder="e.g. rajesh@agency.com"
                value={form.ownerEmail}
                onChange={(e) => handleFormChange('ownerEmail', e.target.value)}
              />
              {registered.email && <p className="text-xs text-red-400 mt-1">{registered.email}</p>}
            </div>
          </div>

          <div>
            <label className={labelClass}>
              <span className="flex items-center gap-1.5">
                <MapPin className="w-4 h-4 text-pink-400" />
                Address *
              </span>
            </label>
            <textarea
              rows={3}
              className={inputClass + ' resize-none'}
              placeholder="Enter full agency address..."
              value={form.address}
              onChange={(e) => handleFormChange('address', e.target.value)}
            />
          </div>

          <div>
            <label className={labelClass}>
              <span className="flex items-center gap-1.5">
                <Globe className="w-4 h-4 text-pink-400" />
                Region *
              </span>
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button type="button"
                onClick={() => handleFormChange('paymentType', 'india')}
                className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 font-semibold transition-colors text-sm ${
                  form.paymentType === 'india'
                    ? 'border-pink-500 bg-pink-500/10 text-pink-300'
                    : 'border-slate-600 bg-slate-700 text-slate-400 hover:border-slate-500'
                }`}>
                🇮🇳 India
              </button>
              <button type="button"
                onClick={() => handleFormChange('paymentType', 'foreign')}
                className={`flex items-center justify-center gap-2 px-4 py-3 rounded-lg border-2 font-semibold transition-colors text-sm ${
                  form.paymentType === 'foreign'
                    ? 'border-pink-500 bg-pink-500/10 text-pink-300'
                    : 'border-slate-600 bg-slate-700 text-slate-400 hover:border-slate-500'
                }`}>
                🌍 International
              </button>
            </div>
            <p className="text-xs text-slate-500 mt-1.5">
              {form.paymentType === 'india'
                ? 'Indian agencies receive payouts via bank transfer (₹1000 per 1 lakh beans).'
                : 'International agencies receive payouts via Binance ($10 per 1 lakh beans).'}
            </p>
          </div>

          {/* Audit C-17 / CRM-FLOW 2.1.3: staff never type the partner's
              password. The login is created with a random one nobody sees and
              the owner is emailed a link to set their own. */}
          <div className="flex items-start gap-2 bg-slate-800/60 border border-slate-700 rounded-lg px-4 py-3">
            <Shield className="w-4 h-4 text-pink-400 mt-0.5 shrink-0" />
            <p className="text-xs text-slate-400 leading-relaxed">
              <span className="text-slate-200 font-medium">No password is typed here.</span> The CRM login is
              created with a random password nobody sees, and a set-password email goes to the owner&rsquo;s
              address above. They choose their own; you never know it.
            </p>
          </div>
        </div>

        {error && (
          <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="mt-8 flex justify-end">
          <button
            onClick={handleNext}
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors"
          >
            Next: KYC Documents
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    )
  }

  // Step 2: KYC Documents
  const Step2 = () => {
    const handleNext = () => {
      setError('')
      if (!aadhaarUrl || !panUrl || !passbookUrl) {
        setError('Please upload all three documents before proceeding.')
        return
      }
      setStep(3)
    }

    const UploadArea = ({
      label,
      description,
      file,
      url,
      progress,
      inputRef,
      onFileChange,
      icon: Icon,
    }: {
      label: string
      description: string
      file: File | null
      url: string
      progress: number
      inputRef: React.RefObject<HTMLInputElement>
      onFileChange: (file: File) => void
      icon: React.ElementType
    }) => {
      const isUploading = file && !url && progress > 0
      const isComplete = !!url
      const isImage = file?.type.startsWith('image/')

      return (
        <div
          className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition-colors ${
            isComplete
              ? 'border-green-500 bg-green-500/5'
              : isUploading
              ? 'border-pink-500/50 bg-pink-500/5'
              : 'border-slate-600 hover:border-pink-500'
          }`}
          onClick={() => !isComplete && inputRef.current?.click()}
        >
          <input
            type="file"
            accept="image/*,application/pdf"
            className="hidden"
            ref={inputRef}
            onChange={(e) => {
              const f = e.target.files?.[0]
              if (f) onFileChange(f)
            }}
          />

          {isComplete ? (
            <div className="space-y-3">
              {isImage ? (
                <img src={url} alt={label} className="max-h-24 mx-auto rounded object-cover" />
              ) : (
                <div className="flex items-center justify-center gap-2 text-slate-300">
                  <FileText className="w-8 h-8 text-slate-400" />
                  <span className="text-sm truncate max-w-[150px]">{file?.name}</span>
                </div>
              )}
              <div className="flex items-center justify-center gap-1.5 text-green-400 text-sm font-medium">
                <CheckCircle className="w-4 h-4" />
                Uploaded successfully
              </div>
            </div>
          ) : isUploading ? (
            <div className="space-y-3">
              <Icon className="w-8 h-8 text-pink-400 mx-auto" />
              <p className="text-sm text-slate-300 font-medium">Uploading...</p>
              <div className="w-full bg-slate-600 rounded-full h-2">
                <div
                  className="bg-pink-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: progress + '%' }}
                />
              </div>
              <p className="text-xs text-pink-400">{progress}%</p>
            </div>
          ) : (
            <div className="space-y-3">
              <Icon className="w-8 h-8 text-slate-400 mx-auto" />
              <div>
                <p className="text-sm font-medium text-slate-300">Click to upload</p>
                <p className="text-xs text-slate-500 mt-1">{description}</p>
              </div>
              <Upload className="w-4 h-4 text-slate-500 mx-auto" />
            </div>
          )}

          <p className="text-xs font-semibold text-slate-400 mt-3 uppercase tracking-wider">{label}</p>
        </div>
      )
    }

    return (
      <div>
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-white mb-1">KYC Documents</h2>
          <p className="text-slate-400 text-sm">Upload Aadhaar, PAN, and bank passbook for verification.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <UploadArea
            label={form.paymentType === 'foreign' ? 'Passport' : 'Aadhaar Card'}
            description={form.paymentType === 'foreign' ? 'Valid passport photo page (JPG, PNG or PDF)' : 'Front side of Aadhaar card (JPG, PNG or PDF)'}
            file={aadhaarFile}
            url={aadhaarUrl}
            progress={aadhaarProgress}
            inputRef={aadhaarRef}
            icon={FileText}
            onFileChange={(file) =>
              handleFileUpload(
                file,
                `kyc/agencies/temp/doc1_${Date.now()}`,
                setAadhaarProgress,
                setAadhaarUrl,
                setAadhaarFile
              )
            }
          />

          <UploadArea
            label={form.paymentType === 'foreign' ? 'Government / National ID' : 'PAN Card'}
            description={form.paymentType === 'foreign' ? "National ID, driver's license or equivalent (JPG, PNG or PDF)" : 'Clear photo of PAN card (JPG, PNG or PDF)'}
            file={panFile}
            url={panUrl}
            progress={panProgress}
            inputRef={panRef}
            icon={CreditCard}
            onFileChange={(file) =>
              handleFileUpload(
                file,
                `kyc/agencies/temp/doc2_${Date.now()}`,
                setPanProgress,
                setPanUrl,
                setPanFile
              )
            }
          />

          <UploadArea
            label={form.paymentType === 'foreign' ? 'Proof of Address' : 'Bank Passbook'}
            description={form.paymentType === 'foreign' ? 'Recent utility bill or bank statement (JPG, PNG or PDF)' : 'First page of bank passbook (JPG, PNG or PDF)'}
            file={passbookFile}
            url={passbookUrl}
            progress={passbookProgress}
            inputRef={passbookRef}
            icon={Landmark}
            onFileChange={(file) =>
              handleFileUpload(
                file,
                `kyc/agencies/temp/doc3_${Date.now()}`,
                setPassbookProgress,
                setPassbookUrl,
                setPassbookFile
              )
            }
          />
        </div>

        <div className="mt-4 bg-slate-800 border border-slate-700 rounded-lg px-4 py-3">
          <p className="text-xs text-slate-400">
            <span className="text-yellow-400 font-semibold">Note:</span> All documents are encrypted and stored
            securely. They will only be accessed by our verification team.
          </p>
        </div>

        {error && (
          <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="mt-8 flex justify-between">
          <button
            onClick={() => { setError(''); setStep(1) }}
            className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
          <button
            onClick={handleNext}
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors"
          >
            Next: Payment Details
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    )
  }

  // Step 3: Payment Details
  const Step3 = () => {
    const isForeign = form.paymentType === 'foreign'

    const handleSubmit = async () => {
      setError('')
      setDuplicates(null)

      if (isForeign) {
        if (!form.country.trim())    { setError('Please enter the agency country.'); return }
        if (!form.binanceUid.trim()) { setError('Please enter the Binance UID.'); return }
      } else {
        if (!form.accountName.trim()) { setError('Please enter the account holder name.'); return }
        if (!form.accountNumber.trim()) { setError('Please enter the account number.'); return }
        if (form.accountNumber !== form.confirmAccountNumber) { setError('Account numbers do not match. Please re-enter.'); return }
        if (!form.ifsc.trim()) { setError('Please enter the IFSC code.'); return }
        if (!form.bankName.trim()) { setError('Please enter the bank name.'); return }
        if (!form.branch.trim()) { setError('Please enter the branch name.'); return }
      }

      try {
        setSubmitting(true)

        const emailLower = normaliseEmail(form.ownerEmail)

        // ── Refuse a duplicate before the first write ────────────────────────
        //
        // `agencies` read is `isAdmin() || …`, and this page is already gated to
        // superadmin and app_admin, both of which satisfy `isAdmin()` — so this
        // query always runs here. It looks only at `agencies`: a coin seller at
        // this address applying to also run an agency is not a duplicate, and
        // that application does not come through this form anyway (see
        // lib/partnerRoles.ts).
        //
        // A refusal or a dropped connection stops the submit rather than being
        // read as "clean". Nothing has been written at this point either way.
        const existing = await findPartnersByEmail('agency', emailLower)
        if (!existing.checked) {
          setError(
            'The check for an existing agency under this address could not be run, '
            + `so nothing was created: ${existing.reason}`,
          )
          return
        }
        if (existing.matches.length > 0) {
          setDuplicates(existing.matches)
          return
        }

        // Shared payload (same whether direct create or approval)
        const nameSlug = form.agencyName.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 4) || 'AGN'
        const referralCode = nameSlug + Math.random().toString(36).toUpperCase().slice(2, 6)

        const agencyPayload: Record<string, unknown> = {
          crmId:            generateCrmId(),
          agencyName:       form.agencyName,
          ownerName:        form.ownerName,
          ownerPhone:       form.ownerPhone,
          // Lower-cased deliberately. `firestore.rules` binds the agency's own
          // `crmUsers` create and its `crmUid` back-link to
          // `ownerEmail == request.auth.token.email`, and Firebase stores that
          // token address lower-cased. An address typed with a capital letter
          // used to make both of those writes undeniable-by-rule.
          ownerEmail:       emailLower,
          address:          form.address,
          type:             parentId ? 'sub' : 'main',
          parentAgencyId:   parentId || null,
          referralCode,
          status:           'pending',
          kycStatus:        'pending',
          kycDocUrls:       [aadhaarUrl, panUrl, passbookUrl],
          paymentType:      form.paymentType,
          currency:         isForeign ? 'USD' : 'INR',
          isActive:         false,
          source:           'crm',
          totalHosts:       0,
          totalSubAgencies: 0,
          // NOTE: the password is deliberately NOT in this payload. It used to
          // be, as `_password`, and this payload is filed onto an
          // `approvalRequests` document that the requester can read back and
          // then copied wholesale onto the `agencies` document by
          // `onApprovalApproved` — a plaintext CRM credential at rest in two
          // collections, which nothing ever read. The Firebase Auth account is
          // created from the in-memory form value below, on both paths, before
          // this payload is written or filed at all. See the header comment.
          ...(isForeign ? {
            country:    form.country,
            binanceUid: form.binanceUid,
          } : {
            accountHolderName: form.accountName,
            accountNumber:     form.accountNumber,
            ifscCode:          form.ifsc,
            bankName:          form.bankName,
            branch:            form.branch,
            upiId:             form.upiId,
          }),
        }

        const isSuperAdmin = crmUser?.role === 'superadmin'

        // ── The login, FIRST, on BOTH paths, before anything is written ─────
        //
        // This writes no Firestore document, so a refusal here costs nothing.
        // It is also the authoritative uniqueness test on the address: the
        // duplicate check above cannot see a login that has no agency record
        // behind it, and this can.
        //
        // And it is where the password goes. The approval path used to skip
        // this and file the plaintext password on the request instead, for a
        // superadmin who was supposed to make the account later. Doing it here
        // means the credential is consumed at the moment it is typed: from
        // here on the flow carries `crmUid`, which identifies the login and
        // unlocks nothing. `adminMode: true` runs it on a throwaway secondary
        // Firebase app so the staff member's own session survives.
        //
        // RC: the record is written INSIDE the login's step (`createPartnerLoginThen`),
        // so when it fails the login made a moment ago is removed again rather
        // than left in Auth holding the address with nothing behind it — the
        // retry this page invites would otherwise be refused on the address.
        let crmUid: string
        let createdAgencyId = ''
        let resetEmailSent = false
        try {
          const created = await createPartnerLoginThen(
            { email: emailLower, kind: 'agency' },
            async (uid) => {
              if (isSuperAdmin) {
                // ── Superadmin: create directly ─────────────────────────────
                //
                // Written WITHOUT `crmUid`. If the two writes below fail, the
                // record is left with no login attached — which is exactly what
                // `/agencies` badges, so the state is visible rather than
                // invisible.
                const docRef = await addDoc(collection(db, 'agencies'), {
                  ...agencyPayload,
                  createdAt:      serverTimestamp(),
                  kycSubmittedAt: serverTimestamp(),
                })
                return docRef.id
              }
              // ── Admin / other: submit for superadmin approval ─────────────
              //
              // `crmUid` — not a password — is what travels through the queue.
              // It names the Firebase Auth account created moments ago, and it
              // is a public identifier: holding it grants nothing, and nobody,
              // superadmin included, can read the password back out of it.
              //
              // `onApprovalApproved` in functions/src/index.ts writes the
              // `crmUsers` document against that uid when the request is
              // approved, and does it BEFORE it creates the agency, so a
              // failure there leaves no agency behind rather than one nobody
              // can sign in as.
              await submitApproval({
                type:             'create_agency',
                description:      `New agency registration: ${form.agencyName} (${form.ownerName})`,
                targetLabel:      `Agency: ${form.agencyName}`,
                targetCollection: 'agencies',
                targetDocId:      '',   // will be created on approval
                operation:        'create',
                payload:          { ...agencyPayload, crmUid: uid },
                requestedBy: {
                  uid:  crmUser!.uid,
                  name: crmUser!.name,
                  role: crmUser!.role,
                },
              })
              return ''
            },
          )
          crmUid = created.uid
          createdAgencyId = created.result
          resetEmailSent = created.resetEmailSent
        } catch (authErr: unknown) {
          if (isRecordNotWritten(authErr)) {
            console.error('Agency record could not be written:', authErr.reason)
            setError(recordNotWrittenMessage(authErr, emailLower, 'agency'))
            return
          }
          setError(
            errorCode(authErr) === 'auth/email-already-in-use'
              ? `A login already exists for ${emailLower}, so nothing was created. `
                + 'If they are already a partner, grant the agency capability from '
                + 'their own record instead of registering them again. If this is a '
                + 'stale login from a failed registration, it has to be removed in '
                + 'the Firebase console before this address can be used.'
              : `The login could not be created, so nothing was created: ${errorMessage(authErr)}`,
          )
          return
        }

        if (isSuperAdmin) {
          setAgencyId(createdAgencyId)

          try {
            await createAgencyAccount({
              email:     emailLower,
              name:      form.ownerName,
              phone:     form.ownerPhone,
              agencyId:  createdAgencyId,
              adminMode: true,
              uid:       crmUid,
            })
            await updateDoc(doc(db, 'agencies', createdAgencyId), { crmUid })
            setLogin({ kind: 'attached', email: emailLower, resetEmailSent })
          } catch (linkErr: unknown) {
            // The agency record is committed and is a real application, so it
            // is NOT deleted — somebody has to decide about it. But it has no
            // login, and saying otherwise is the failure this rewrite exists to
            // stop.
            console.error('Agency CRM account could not be attached:', linkErr)
            setLogin({
              kind:    'failed',
              email:   emailLower,
              message: errorMessage(linkErr),
            })
          }

          setCreatedReferralCode(referralCode)
          setSubmittedForApproval(false)
        } else {
          setLogin({ kind: 'attached', email: emailLower, resetEmailSent })
          setCreatedReferralCode(referralCode)
          setSubmittedForApproval(true)
        }

        setStep(4)
      } catch (err) {
        console.error(err)
        setError('Something went wrong while submitting. Please try again.')
      } finally {
        setSubmitting(false)
      }
    }

    return (
      <div>
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-white mb-1">
            {isForeign ? 'Payment Details (International)' : 'Bank Details (India)'}
          </h2>
          <p className="text-slate-400 text-sm">
            {isForeign
              ? 'Payouts will be sent in USD ($10 per 1 lakh beans) to the agency\'s Binance account.'
              : 'Payouts will be sent in INR (₹1000 per 1 lakh beans) to the agency\'s bank account.'}
          </p>
        </div>

        {/* Region indicator */}
        <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg mb-5 text-sm font-medium border ${
          isForeign
            ? 'bg-blue-500/10 border-blue-500/30 text-blue-300'
            : 'bg-green-500/10 border-green-500/30 text-green-300'
        }`}>
          <Globe className="w-4 h-4" />
          {isForeign ? '🌍 International Agency — Binance payout ($10 / 1L beans)' : '🇮🇳 Indian Agency — Bank transfer payout (₹1000 / 1L beans)'}
        </div>

        {isForeign ? (
          /* ── Foreign: Country + Binance UID ─────────────────────── */
          <div className="space-y-5">
            <div>
              <label className={labelClass}>
                <span className="flex items-center gap-1.5">
                  <Globe className="w-4 h-4 text-pink-400" />
                  Country *
                </span>
              </label>
              <input
                type="text"
                className={inputClass}
                placeholder="e.g. United States, United Kingdom, UAE"
                value={form.country}
                onChange={(e) => handleFormChange('country', e.target.value)}
              />
            </div>

            <div>
              <label className={labelClass}>
                <span className="flex items-center gap-1.5">
                  <Hash className="w-4 h-4 text-pink-400" />
                  Binance UID *
                </span>
              </label>
              <input
                type="text"
                className={inputClass}
                placeholder="Agency owner's Binance UID (numbers only)"
                value={form.binanceUid}
                onChange={(e) => handleFormChange('binanceUid', e.target.value)}
              />
              <p className="text-xs text-slate-500 mt-1">
                Found in Binance App → Profile → UID. Payouts will be sent to this Binance account.
              </p>
            </div>

            <div className="bg-slate-800 border border-slate-700 rounded-lg px-4 py-3 flex items-start gap-2">
              <Shield className="w-4 h-4 text-blue-400 mt-0.5 shrink-0" />
              <p className="text-xs text-slate-400">
                Zippern sends international payouts via Binance P2P. A ~2% fee applies on Binance's side.
              </p>
            </div>
          </div>
        ) : (
          /* ── India: Bank account fields ──────────────────────────── */
          <div className="space-y-5">
            <div>
              <label className={labelClass}>
                <span className="flex items-center gap-1.5">
                  <User className="w-4 h-4 text-pink-400" />
                  Account Holder Name *
                </span>
              </label>
              <input
                type="text"
                className={inputClass}
                placeholder="As printed on the bank account"
                value={form.accountName}
                onChange={(e) => handleFormChange('accountName', e.target.value)}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label className={labelClass}>
                  <span className="flex items-center gap-1.5">
                    <Hash className="w-4 h-4 text-pink-400" />
                    Account Number *
                  </span>
                </label>
                <input
                  type="text"
                  className={inputClass}
                  placeholder="Enter account number"
                  value={form.accountNumber}
                  onChange={(e) => handleFormChange('accountNumber', e.target.value)}
                />
              </div>

              <div>
                <label className={labelClass}>
                  <span className="flex items-center gap-1.5">
                    <Hash className="w-4 h-4 text-pink-400" />
                    Confirm Account Number *
                  </span>
                </label>
                <input
                  type="text"
                  className={`${inputClass} ${
                    form.confirmAccountNumber && form.accountNumber !== form.confirmAccountNumber
                      ? 'border-red-500 focus:border-red-500 focus:ring-red-500'
                      : form.confirmAccountNumber && form.accountNumber === form.confirmAccountNumber
                      ? 'border-green-500 focus:border-green-500 focus:ring-green-500'
                      : ''
                  }`}
                  placeholder="Re-enter account number"
                  value={form.confirmAccountNumber}
                  onChange={(e) => handleFormChange('confirmAccountNumber', e.target.value)}
                />
                {form.confirmAccountNumber && form.accountNumber !== form.confirmAccountNumber && (
                  <p className="text-xs text-red-400 mt-1">Account numbers do not match</p>
                )}
                {form.confirmAccountNumber && form.accountNumber === form.confirmAccountNumber && (
                  <p className="text-xs text-green-400 mt-1 flex items-center gap-1">
                    <CheckCircle className="w-3 h-3" /> Numbers match
                  </p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label className={labelClass}>
                  <span className="flex items-center gap-1.5">
                    <Hash className="w-4 h-4 text-pink-400" />
                    IFSC Code *
                  </span>
                </label>
                <input
                  type="text"
                  className={inputClass}
                  placeholder="e.g. SBIN0001234"
                  value={form.ifsc}
                  onChange={(e) => handleFormChange('ifsc', e.target.value.toUpperCase())}
                />
              </div>

              <div>
                <label className={labelClass}>
                  <span className="flex items-center gap-1.5">
                    <Landmark className="w-4 h-4 text-pink-400" />
                    Bank Name *
                  </span>
                </label>
                <input
                  type="text"
                  className={inputClass}
                  placeholder="e.g. State Bank of India"
                  value={form.bankName}
                  onChange={(e) => handleFormChange('bankName', e.target.value)}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
              <div>
                <label className={labelClass}>
                  <span className="flex items-center gap-1.5">
                    <MapPin className="w-4 h-4 text-pink-400" />
                    Branch *
                  </span>
                </label>
                <input
                  type="text"
                  className={inputClass}
                  placeholder="e.g. Connaught Place, New Delhi"
                  value={form.branch}
                  onChange={(e) => handleFormChange('branch', e.target.value)}
                />
              </div>

              <div>
                <label className={labelClass}>
                  <span className="flex items-center gap-1.5">
                    <Wallet className="w-4 h-4 text-pink-400" />
                    UPI ID{' '}
                    <span className="text-slate-500 font-normal">(optional)</span>
                  </span>
                </label>
                <input
                  type="text"
                  className={inputClass}
                  placeholder="e.g. rajesh@upi"
                  value={form.upiId}
                  onChange={(e) => handleFormChange('upiId', e.target.value)}
                />
              </div>
            </div>
          </div>
        )}

        {duplicates && duplicates.length > 0 && (
          <div className="mt-4 bg-red-500/10 border border-red-500/40 rounded-xl px-5 py-4">
            <p className="text-red-200 text-sm font-semibold flex items-center gap-2">
              <XCircle className="w-4 h-4 flex-shrink-0" />
              {duplicateHeadline('agency', duplicates)}
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
                  <p className="text-red-100/85 text-sm mt-0.5">It is {statusPhrase(m)}.</p>
                  {loginPhrase(m) && (
                    <p className="text-amber-200/90 text-sm mt-0.5">{loginPhrase(m)}</p>
                  )}
                  {m.isSecondRole && (
                    <p className="text-indigo-200/90 text-sm mt-0.5">
                      It was filed as a second capability beside an existing coin seller.
                    </p>
                  )}
                </li>
              ))}
            </ul>
            <p className="text-red-100/75 text-sm mt-3">
              Reopen the record above rather than filing another. A sub-agency
              belongs under its parent — register it from that agency's page — and
              a genuinely separate agency needs its own email address.
            </p>
            <p className="text-red-100/60 text-sm mt-2">
              An existing <span className="font-semibold">coin seller</span> at this
              address is a different matter and is not blocked here: grant them the
              agency capability from their own record, which keeps the two
              businesses on one login with separate balances.
            </p>
          </div>
        )}

        {error && (
          <div className="mt-4 bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-red-400 text-sm">
            {error}
          </div>
        )}

        <div className="mt-8 flex justify-between">
          <button
            onClick={() => { setError(''); setStep(2) }}
            disabled={submitting}
            className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ArrowLeft className="w-4 h-4" />
            Back
          </button>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <>
                <svg className="animate-spin w-4 h-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Submitting...
              </>
            ) : (
              <>
                Submit Registration
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </div>
      </div>
    )
  }

  // Step 4: Done
  const Step4 = () => (
    <div className="text-center py-16">
      <div className="flex justify-center mb-6">
        <div className={`w-24 h-24 rounded-full flex items-center justify-center ${submittedForApproval ? 'bg-yellow-500/10' : 'bg-green-500/10'}`}>
          {submittedForApproval
            ? <Clock className="text-yellow-400 w-14 h-14" />
            : <CheckCircle className="text-green-500 w-14 h-14" />}
        </div>
      </div>
      <h2 className="text-3xl font-bold text-white mb-3">
        {submittedForApproval
          ? 'Submitted for Approval'
          : login?.kind === 'failed'
          ? 'Agency Registered — but it has no login'
          : 'Agency Registered!'}
      </h2>
      <p className="text-slate-400 mb-2">
        {submittedForApproval
          ? 'The agency registration has been sent to the superadmin for review. It will be created once approved.'
          : 'The agency has been successfully created.'}
      </p>

      {/* The approval path. The login exists NOW even though the agency does
          not — that is the whole point, and it has to be said, because the
          person filling this in has just been asked for a password and needs
          to know where it went and that nobody can look it up for them. */}
      {submittedForApproval && login?.kind === 'attached' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 mt-4 mb-2 max-w-md mx-auto text-left">
          <p className="text-white text-sm font-semibold flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-slate-500" />
            A login for {login.email} exists already.
          </p>
          <p className="text-slate-400 text-sm mt-1">
            It was created just now with a random password that{' '}
            <span className="text-white font-semibold">nobody knows</span> — not you, not the
            superadmin, and it is stored nowhere.{' '}
            {login.resetEmailSent
              ? <>A set-password email has been sent to the owner; they choose their own password from the link in it.</>
              : <>The set-password email could <span className="text-yellow-400 font-semibold">not</span> be sent just now — tell the owner to use &ldquo;Forgot password&rdquo; on the sign-in page, which sends the same link.</>}
          </p>
          <p className="text-slate-400 text-sm mt-2">
            The login opens nothing yet. Approving this request is what creates
            the agency and writes the CRM account against this login, and the
            account is still <span className="text-yellow-400 font-semibold">pending</span> after
            that until the agency itself is approved.
          </p>
          <p className="text-slate-500 text-sm mt-2">
            If the request is rejected, that login stays behind holding nothing.
            Remove it in the Firebase console, or this address cannot be
            registered again.
          </p>
        </div>
      )}

      {/* The login, said plainly. "A CRM account with this email already exists"
          while silently leaving a half-made agency is the failure this screen
          was rewritten to stop. */}
      {!submittedForApproval && login?.kind === 'attached' && (
        <div className="bg-slate-900 border border-slate-800 rounded-xl px-5 py-4 mt-4 mb-2 max-w-md mx-auto text-left">
          <p className="text-white text-sm font-semibold flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-slate-500" />
            A login was created for {login.email}.
          </p>
          <p className="text-slate-400 text-sm mt-1">
            It is <span className="text-yellow-400 font-semibold">pending</span> and
            opens nothing until this agency is approved.
          </p>
          <p className="text-slate-400 text-sm mt-1">
            {login.resetEmailSent
              ? <>A set-password email has been sent to the owner; they choose their own password from it. Nobody here knows it.</>
              : <>The set-password email could <span className="text-yellow-400 font-semibold">not</span> be sent just now — tell the owner to use &ldquo;Forgot password&rdquo; on the sign-in page.</>}
          </p>
        </div>
      )}

      {!submittedForApproval && login?.kind === 'failed' && (
        <div className="bg-red-500/10 border border-red-500/40 rounded-xl px-5 py-4 mt-4 mb-2 max-w-md mx-auto text-left">
          <p className="text-red-200 text-sm font-semibold flex items-center gap-2">
            <UserX className="w-4 h-4" /> This agency has NO login. Nobody can sign in as it.
          </p>
          <p className="text-red-100/85 text-sm mt-1">
            The agency record was created, but the CRM account for{' '}
            <span className="font-mono">{login.email}</span> could not be written:{' '}
            {login.message}
          </p>
          <p className="text-red-100/75 text-sm mt-2">
            A Firebase login for that address <strong>does</strong> now exist and is
            not attached to anything, so re-registering this agency will be refused.
            The record has deliberately not been deleted — it is a real application,
            and it shows on{' '}
            <Link href="/agencies" className="text-red-200 underline underline-offset-2 hover:text-white">
              /agencies
            </Link>{' '}
            badged <span className="font-semibold">no login attached</span>. Reject
            it there if it is not wanted; the reason goes on the record.
          </p>
        </div>
      )}

      {/* Referral Code — shown prominently */}
      {createdReferralCode && (
        <div className="inline-block bg-purple-500/10 border border-purple-500/30 rounded-xl px-6 py-4 mt-4 mb-3 text-left">
          <p className="text-xs text-purple-400 uppercase tracking-wider font-semibold mb-1">Agency Referral Code</p>
          <p className="text-purple-300 font-mono font-bold text-2xl tracking-widest">{createdReferralCode}</p>
          <p className="text-slate-500 text-xs mt-1">Hosts use this code to join this agency in the app</p>
        </div>
      )}

      {/* Internal Agency ID — only shown when directly created */}
      {!submittedForApproval && agencyId && (
        <div className="inline-block bg-slate-800 border border-slate-700 rounded-xl px-6 py-4 mb-6 text-left">
          <p className="text-xs text-slate-500 uppercase tracking-wider font-semibold mb-1">Internal Agency ID</p>
          <p className="text-slate-400 font-mono text-sm">{agencyId}</p>
          <p className="text-slate-600 text-xs mt-1">Used internally — not shared with the agency</p>
        </div>
      )}

      <div className={`border rounded-xl px-6 py-4 mb-8 max-w-md mx-auto ${
        submittedForApproval
          ? 'bg-yellow-500/10 border-yellow-500/30'
          : 'bg-yellow-500/10 border-yellow-500/30'
      }`}>
        <p className="text-yellow-400 text-sm font-semibold mb-1">
          {submittedForApproval ? 'Pending Superadmin Approval' : 'KYC Pending Review'}
        </p>
        <p className="text-slate-400 text-sm">
          {submittedForApproval
            ? 'The superadmin will review and approve this agency registration. Check the Approvals queue.'
            : 'Our team will verify the documents within 1–2 business days.'}
        </p>
      </div>

      <div className="flex justify-center gap-4">
        <Link
          href="/agencies"
          className="flex items-center gap-2 bg-pink-500 hover:bg-pink-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to Agencies
        </Link>
        <button
          onClick={() => {
            setStep(1)
            setForm({
              agencyName: '', ownerName: '', ownerPhone: '', ownerEmail: '', address: '',
              paymentType: 'india', country: '', binanceUid: '',
              accountName: '', accountNumber: '', confirmAccountNumber: '', ifsc: '',
              bankName: '', branch: '', upiId: '',
            })
            setAadhaarUrl('')
            setPanUrl('')
            setPassbookUrl('')
            setAadhaarFile(null)
            setPanFile(null)
            setPassbookFile(null)
            setAadhaarProgress(0)
            setPanProgress(0)
            setPassbookProgress(0)
            setAgencyId('')
            setError('')
            setLogin(null)
            setDuplicates(null)
          }}
          className="flex items-center gap-2 bg-slate-700 hover:bg-slate-600 text-white font-semibold px-6 py-2.5 rounded-lg transition-colors"
        >
          Register Another
        </button>
      </div>
    </div>
  )

  if (!authLoading && (!crmUser || !canAccess(crmUser, ['superadmin', 'app_admin']))) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center gap-4">
        <Shield size={48} className="text-slate-600" />
        <h1 className="text-white text-2xl font-bold">Access Denied</h1>
        <p className="text-slate-400 text-sm">You do not have permission to view this page.</p>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-950 p-6">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <Link
              href="/agencies"
              className="text-slate-400 hover:text-white transition-colors text-sm flex items-center gap-1"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Agencies
            </Link>
            {parentId && (
              <>
                <span className="text-slate-600">/</span>
                <Link href={`/agencies/${parentId}`} className="text-slate-400 hover:text-white text-sm transition-colors">
                  {parentAgencyName || parentId}
                </Link>
              </>
            )}
            <span className="text-slate-600">/</span>
            <span className="text-slate-300 text-sm">
              {parentId ? 'Register Sub-Agency' : 'Register New Agency'}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <h1 className="text-3xl font-bold text-white">
              {parentId ? 'Register Sub-Agency' : 'Register New Agency'}
            </h1>
            {parentId && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-purple-500/20 text-purple-300 border border-purple-500/30">
                <GitBranch className="w-3 h-3" />
                Under {parentAgencyName || 'Main Agency'}
              </span>
            )}
          </div>
        </div>

        {/* Card */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-xl">
          {/* Step Indicator */}
          {StepIndicator()}

          {/* Step Content */}
          {step === 1 && Step1()}
          {step === 2 && Step2()}
          {step === 3 && Step3()}
          {step === 4 && Step4()}
        </div>

        {/* Footer note */}
        {step !== 4 && (
          <p className="text-center text-slate-600 text-xs mt-6">
            All data is encrypted and stored securely. For support, contact{' '}
            <a href="mailto:314zipper@gmail.com" className="text-pink-500 hover:underline">
              314zipper@gmail.com
            </a>
          </p>
        )}
      </div>
    </div>
  )
}
