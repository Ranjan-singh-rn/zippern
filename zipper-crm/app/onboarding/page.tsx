'use client'

/**
 * How partners join.
 *
 * There are four ways into this business and, until this page existed, three of
 * them were undiscoverable. `/agencies/register` and `/sellers/register` at
 * least had a button on their list pages. `/agency-signup` and `/seller-signup`
 * — the public forms, the ones you actually send to a prospective partner —
 * were linked from nowhere at all, and sub-agency creation lives inside a modal
 * on `/agency-dashboard` that no staff member can reach.
 *
 * So this page does two things. It hands over the two public URLs in full,
 * copyable form, because the point of them is to be sent to someone. And it
 * says what happens after each form is submitted, read out of the code rather
 * than assumed — including the one place where the described flow and the real
 * one disagree.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { collection, getDocs, limit as fsLimit, query, where } from 'firebase/firestore'
import {
  AlertTriangle, ArrowRight, Building2, Check, ClipboardCopy, CornerDownRight,
  ExternalLink, Lock, RefreshCw, ShoppingBag, UserPlus,
} from 'lucide-react'
import { Denied, ErrorState, Loading } from '@/components/ui/States'
import { useAuth } from '@/components/AuthProvider'
import { canAccess, type CrmRole } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { ApiError } from '@/lib/api'
import { partnerOps, type Partner } from '@/lib/apiPartners'

// Every internal role. The public signup URL is the thing marketing and support
// need most and can do least harm with, so the page itself is not narrowed —
// each individual destination below is gated against what it genuinely needs.
const PAGE_ROLES: CrmRole[] = [
  'superadmin',
  'app_admin', 'app_member',
  'ops_admin', 'ops_member',
  'finance_admin', 'finance_member',
  'tech_admin', 'tech_member',
  'support_admin', 'support_member',
  'marketing_admin', 'marketing_member',
]

// Taken from the destination pages, not guessed.
//   app/agencies/register/page.tsx:49  and :1031
const AGENCY_REGISTER_ROLES: CrmRole[] = ['superadmin', 'app_admin']
//   app/sellers/register/page.tsx:111
const SELLER_REGISTER_ROLES: CrmRole[] = ['superadmin', 'app_admin', 'ops_admin', 'ops_member']
//   app/kyc/page.tsx:48
const KYC_ROLES: CrmRole[] = ['superadmin', 'app_admin', 'ops_admin']

const PARTNER_LIMIT = 500
const FS_LIMIT = 200

type Async<T> =
  | { state: 'loading' }
  | { state: 'ready'; data: T }
  | { state: 'error'; message: string }

/** Pending applications as the CRM's own queues count them. */
interface Queue {
  agency: number
  subAgency: number
  seller: number
  /** Every partner id the API knows about, whatever its status. */
  knownIds: string[]
  capped: boolean
}

/** Pending signup documents in Firestore, which is where a form writes first. */
interface Signups {
  agencies: string[]
  sellers: string[]
  capped: boolean
}

// ── The public host ───────────────────────────────────────────────────────────
// Not hardcoded. In a static export the CRM is served from the same Firebase
// Hosting site as the two public forms, so the origin the staff member is
// looking at *is* the origin to send. `NEXT_PUBLIC_PUBLIC_SITE_URL` overrides it
// for the case where the CRM is opened on localhost but the link to hand out is
// the deployed one.
function resolveOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_PUBLIC_SITE_URL
  if (configured && configured.trim()) return configured.trim().replace(/\/+$/, '')
  if (typeof window !== 'undefined' && window.location.origin) return window.location.origin
  return ''
}

export default function Onboarding() {
  const { crmUser } = useAuth()
  const allowed = !!crmUser && canAccess(crmUser, PAGE_ROLES)

  // Resolved after mount: `output: 'export'` prerenders this file at build
  // time, when there is no host to read.
  const [origin, setOrigin] = useState<string | null>(null)
  useEffect(() => { setOrigin(resolveOrigin()) }, [])

  const [queue, setQueue] = useState<Async<Queue>>({ state: 'loading' })
  const [signups, setSignups] = useState<Async<Signups>>({ state: 'loading' })

  const load = useCallback(async () => {
    setQueue({ state: 'loading' })
    setSignups({ state: 'loading' })

    // Two independent reads against two different stores. One failing must not
    // turn the other into a zero — a zero that might mean "could not read" is
    // worse than no number at all.
    const readQueue = (async () => {
      const [agencies, subs, sellers] = await Promise.all([
        partnerOps.list({ kind: 'agency', limit: PARTNER_LIMIT }),
        partnerOps.list({ kind: 'sub_agency', limit: PARTNER_LIMIT }),
        partnerOps.list({ kind: 'seller', limit: PARTNER_LIMIT }),
      ])
      const all: Partner[] = [...agencies, ...subs, ...sellers]
      const pending = (list: Partner[]) => list.filter((p) => p.status === 'pending').length
      setQueue({
        state: 'ready',
        data: {
          agency: pending(agencies),
          subAgency: pending(subs),
          seller: pending(sellers),
          knownIds: all.map((p) => p.id),
          capped:
            agencies.length >= PARTNER_LIMIT ||
            subs.length >= PARTNER_LIMIT ||
            sellers.length >= PARTNER_LIMIT,
        },
      })
    })().catch((err: unknown) => {
      setQueue({
        state: 'error',
        message:
          err instanceof ApiError
            ? err.message
            : 'The review queue could not be read, so these counts are unknown.',
      })
    })

    const readSignups = (async () => {
      const [agencyDocs, sellerDocs] = await Promise.all([
        getDocs(query(collection(db, 'agencies'), where('status', '==', 'pending'), fsLimit(FS_LIMIT))),
        getDocs(query(collection(db, 'sellers'), where('status', '==', 'pending'), fsLimit(FS_LIMIT))),
      ])
      setSignups({
        state: 'ready',
        data: {
          agencies: agencyDocs.docs.map((d) => d.id),
          sellers: sellerDocs.docs.map((d) => d.id),
          capped: agencyDocs.size >= FS_LIMIT || sellerDocs.size >= FS_LIMIT,
        },
      })
    })().catch((err: unknown) => {
      setSignups({
        state: 'error',
        message:
          err instanceof Error
            ? err.message
            : 'The submitted signup forms could not be read from Firestore.',
      })
    })

    await Promise.all([readQueue, readSignups])
  }, [])

  useEffect(() => { if (allowed) load() }, [allowed, load])

  /**
   * Applications that exist as a submitted form but have no business record, so
   * they are in none of the CRM's queues. Only computable when both reads
   * succeeded — otherwise it is silence, not zero.
   */
  const stranded = useMemo<{ agencies: number; sellers: number } | null>(() => {
    if (queue.state !== 'ready' || signups.state !== 'ready') return null
    const known = new Set(queue.data.knownIds)
    return {
      agencies: signups.data.agencies.filter((id) => !known.has(id)).length,
      sellers: signups.data.sellers.filter((id) => !known.has(id)).length,
    }
  }, [queue, signups])

  if (!allowed) return <Denied what="partner onboarding" />

  const canAgencyRegister = !!crmUser && canAccess(crmUser, AGENCY_REGISTER_ROLES)
  const canSellerRegister = !!crmUser && canAccess(crmUser, SELLER_REGISTER_ROLES)
  const canReview = !!crmUser && canAccess(crmUser, KYC_ROLES)

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-white flex items-center gap-2">
            <UserPlus size={26} className="text-pink-500" />
            How partners join
          </h1>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Four ways into the business — two forms a partner fills in themselves,
            two a staff member fills in for them. The links to send are below,
            in full.
          </p>
        </div>
        <button
          onClick={load}
          className="flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2.5 text-sm transition-colors"
        >
          <RefreshCw size={14} /> Refresh
        </button>
      </div>

      {/* ── 1 & 2. The public forms ───────────────────────────────────────── */}

      <SectionHeading
        n="1"
        title="They apply themselves"
        blurb="Send one of these two links. Neither needs a CRM account, and neither is reachable from anywhere else in the CRM."
      />

      <div className="grid gap-4 lg:grid-cols-2 mb-8">
        <PublicRoute
          icon={<Building2 size={18} className="text-purple-300" />}
          title="An agency applies"
          path="/agency-signup"
          origin={origin}
          who="The agency owner fills this in. Three steps: their details, payout details (Indian bank or a Binance UID), and three KYC documents — Aadhaar, PAN and a bank passbook."
          next={[
            'The application is written as an agency record with status “pending”, KYC “pending” and the account switched off.',
            'A CRM login is created for them at the same time, also pending. They can sign in immediately — and land on a holding page, not a dashboard.',
            'A “registration received” email goes out automatically when the record is created.',
            'On approval they get a second email and an in-app notification, and the account becomes active.',
          ]}
        />
        <PublicRoute
          icon={<ShoppingBag size={18} className="text-amber-300" />}
          title="A coin seller applies"
          path="/seller-signup"
          origin={origin}
          who="The seller fills this in themselves. Their details, then one government photo ID."
          next={[
            'Written as a seller record with status “pending”, not approved, not active — and a coin balance of exactly zero.',
            'A pending CRM login is created. Same as an agency: they can sign in, and they wait on a holding page.',
            'A “registration received” email goes out automatically on submission.',
            'On approval they get a second email — but they still hold nothing. Inventory only ever arrives through a signed coin-purchase card.',
          ]}
          footnote="A seller starts with zero coins. There is no opening balance on the public form and none is created on approval; the first load is raised as a card on /coin-purchases and moves nothing until an owner signs it on the Money Board."
        />
      </div>

      {/* ── 3. Staff register on their behalf ─────────────────────────────── */}

      <SectionHeading
        n="2"
        title="You register them"
        blurb="For a partner who is sitting with you, or who will not get through a form on their own. Same records, filled in by staff."
      />

      <div className="grid gap-4 lg:grid-cols-2 mb-8">
        <StaffRoute
          icon={<Building2 size={18} className="text-purple-300" />}
          title="Register an agency"
          href="/agencies/register"
          allowed={canAgencyRegister}
          rolesLabel="Owner and App admin"
          next={[
            'As an owner: the agency and its CRM login are created straight away, still pending approval.',
            'As anyone else: nothing is created. It goes to /approvals as a request an owner has to action, and the agency exists only once they do.',
            'Either way the “registration received” email fires on creation, exactly as it does for a self-signup.',
          ]}
        />
        <StaffRoute
          icon={<ShoppingBag size={18} className="text-amber-300" />}
          title="Register a coin seller"
          href="/sellers/register"
          allowed={canSellerRegister}
          rolesLabel="Owner, App admin, Ops admin, Ops member"
          next={[
            'As an owner: the seller is created holding nothing. If you enter an opening balance it is raised as a coin-purchase card — the coins do not exist until an owner signs it.',
            'As anyone else: nothing is created. It goes to /approvals for an owner to action.',
            'This form does not send a registration email — only the public seller form does. If they need one, tell them yourself.',
          ]}
        />
      </div>

      {/* ── 4. Sub-agency ─────────────────────────────────────────────────── */}

      <SectionHeading
        n="3"
        title="A sub-agency"
        blurb="Not yours to create. Only the parent agency can, from inside their own portal."
      />

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-8">
        <div className="flex items-start gap-3">
          <CornerDownRight size={18} className="text-slate-400 mt-0.5 shrink-0" />
          <div className="min-w-0">
            <h3 className="text-white font-semibold">The parent agency creates it</h3>
            <p className="text-slate-400 text-sm mt-1.5 leading-relaxed">
              There is no staff screen for this and no public form. The parent
              signs into their own agency portal, opens <span className="text-slate-300">My Agency</span>,
              and uses <span className="text-slate-300">Add Sub-Agency</span>. You
              cannot do it for them, and you cannot see the form — so if they are
              stuck, walk them through it rather than looking for a link.
            </p>

            <p className="text-slate-300 text-sm font-medium mt-4">
              What the parent needs to have in front of them before starting
            </p>
            <ul className="mt-2 space-y-1.5">
              {[
                'Sub-agency name, and the owner’s name, phone and email.',
                'A password of at least 6 characters — this becomes the sub-agency owner’s CRM login, so it has to be handed over.',
                'Payout details: account holder name, account number (typed twice), IFSC, bank and branch for India — or a Binance UID for an international sub-agency.',
                'Three KYC documents, uploaded. All three are required; the form will not submit with two.',
              ].map((line) => (
                <li key={line} className="flex items-start gap-2 text-slate-400 text-sm">
                  <span className="text-slate-600 mt-1.5 shrink-0">•</span>
                  <span>{line}</span>
                </li>
              ))}
            </ul>

            <p className="text-slate-300 text-sm font-medium mt-4">What happens next</p>
            <ul className="mt-2 space-y-1.5">
              {[
                'It is created pending and inactive, with its KYC marked submitted and the parent recorded on it.',
                'It goes through the same review as any agency, and nothing about it works until it is approved.',
                'Money reaches a sub-agency through its parent and never directly — a payout is made to the parent, who then confirms they passed it on.',
              ].map((line) => (
                <li key={line} className="flex items-start gap-2 text-slate-400 text-sm">
                  <ArrowRight size={12} className="text-slate-600 mt-1 shrink-0" />
                  <span>{line}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* ── Review ────────────────────────────────────────────────────────── */}

      <SectionHeading
        n="4"
        title="Where it lands, and who decides"
        blurb="Every one of the four routes ends in the same place."
      />

      <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 mb-4">
        <ul className="space-y-2">
          {[
            'Applications are reviewed on /kyc, which is where the documents are shown alongside the record. Agencies and sellers can also be approved from their own list pages.',
            'Nothing works until it is approved. The account is created switched off: the applicant can sign in and see a holding page, and no money can move on them.',
            'A rejection has to carry a reason. It is stored on the record and shown to the applicant, so they are told why instead of silently reapplying.',
            'Approving and rejecting move no money and need no owner signature. Anything that moves money is a separate card an owner signs on the Money Board.',
          ].map((line) => (
            <li key={line} className="flex items-start gap-2 text-slate-400 text-sm">
              <ArrowRight size={12} className="text-slate-600 mt-1 shrink-0" />
              <span>{line}</span>
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-slate-800">
          {canReview ? (
            <Link
              href="/kyc"
              className="inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-3 py-2 text-sm transition-colors"
            >
              Open KYC review <ArrowRight size={13} />
            </Link>
          ) : (
            <span className="inline-flex items-center gap-2 text-slate-500 text-sm">
              <Lock size={13} /> KYC review is open to Owner, App admin and Ops admin.
            </span>
          )}
        </div>
      </div>

      {/* ── Counts ────────────────────────────────────────────────────────── */}

      <h2 className="text-white font-semibold text-lg mt-8 mb-1">Waiting for a decision right now</h2>
      <p className="text-slate-500 text-sm mb-4">
        Live, from the review queue. Nothing here is cached.
      </p>

      {queue.state === 'loading' && <Loading label="Counting applications…" />}

      {queue.state === 'error' && (
        <ErrorState message={queue.message} onRetry={load} />
      )}

      {queue.state === 'ready' && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <QueueStat
              label="Agencies"
              count={queue.data.agency}
              href="/kyc"
              linkable={canReview}
            />
            <QueueStat
              label="Sub-agencies"
              count={queue.data.subAgency}
              href="/kyc"
              linkable={canReview}
            />
            <QueueStat
              label="Coin sellers"
              count={queue.data.seller}
              href="/kyc"
              linkable={canReview}
            />
          </div>

          {queue.data.agency + queue.data.subAgency + queue.data.seller === 0 && (
            <p className="text-slate-500 text-sm mt-3">
              No applications are waiting. That is a real answer — the queue was
              read successfully and it is empty.
            </p>
          )}

          {queue.data.capped && (
            <p className="text-amber-300/80 text-xs mt-3">
              The queue was read {PARTNER_LIMIT} records at a time and came back
              full, so these counts may be short. Open KYC review for the
              authoritative list.
            </p>
          )}
        </>
      )}

      {/* ── The gap between a submitted form and the queue ────────────────── */}

      <div className="mt-6">
        {signups.state === 'loading' && (
          <p className="text-slate-500 text-sm">Checking submitted forms…</p>
        )}

        {signups.state === 'error' && (
          <div className="flex items-start gap-2 bg-slate-900 border border-slate-800 rounded-xl px-4 py-3">
            <AlertTriangle size={15} className="text-amber-400 mt-0.5 shrink-0" />
            <p className="text-slate-400 text-sm">
              The submitted signup forms could not be read, so we cannot tell you
              whether any are sitting outside the queue.{' '}
              <span className="text-slate-500">{signups.message}</span>
            </p>
          </div>
        )}

        {signups.state === 'ready' && stranded === null && (
          <p className="text-slate-500 text-sm">
            {signups.data.agencies.length + signups.data.sellers.length} submitted
            form{signups.data.agencies.length + signups.data.sellers.length === 1 ? '' : 's'} found,
            but the queue could not be read, so we cannot tell which of them have
            reached it.
          </p>
        )}

        {signups.state === 'ready' && stranded !== null && stranded.agencies + stranded.sellers > 0 && (
          <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/40 rounded-xl px-4 py-3.5">
            <AlertTriangle size={16} className="text-red-400 mt-0.5 shrink-0" />
            <div className="min-w-0">
              <p className="text-red-200 text-sm font-semibold">
                {stranded.agencies + stranded.sellers} submitted application
                {stranded.agencies + stranded.sellers === 1 ? '' : 's'} did not reach
                the review queue
                {stranded.agencies > 0 && stranded.sellers > 0
                  ? ` — ${stranded.agencies} agenc${stranded.agencies === 1 ? 'y' : 'ies'} and ${stranded.sellers} seller${stranded.sellers === 1 ? '' : 's'}.`
                  : '.'}
              </p>
              <p className="text-red-200/75 text-sm mt-1 leading-relaxed">
                A form submitted in the browser writes the application, but not the
                business record every queue is built from — so these people are
                waiting and nobody can see them on /kyc, /agencies or /sellers.
                The fix is on the server, not in here:{' '}
                <span className="font-mono text-red-100">
                  python -m scripts.backfill_partners --confirm
                </span>{' '}
                creates the missing records, pending and holding nothing. Ask
                whoever runs the API to do it.
              </p>
              {signups.data.capped && (
                <p className="text-red-200/60 text-xs mt-2">
                  Only the first {FS_LIMIT} pending forms of each kind were checked,
                  so the real number may be higher.
                </p>
              )}
            </div>
          </div>
        )}

        {signups.state === 'ready' && stranded !== null && stranded.agencies + stranded.sellers === 0 && (
          <p className="text-slate-500 text-sm">
            Every submitted form has reached the review queue. Checked{' '}
            {signups.data.agencies.length + signups.data.sellers.length} pending
            form{signups.data.agencies.length + signups.data.sellers.length === 1 ? '' : 's'}.
          </p>
        )}
      </div>
    </div>
  )
}

// ── Bits ──────────────────────────────────────────────────────────────────────

function SectionHeading({ n, title, blurb }: { n: string; title: string; blurb: string }) {
  return (
    <div className="mb-3">
      <h2 className="text-white font-semibold text-lg flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-slate-800 text-slate-400 text-xs font-bold flex items-center justify-center shrink-0">
          {n}
        </span>
        {title}
      </h2>
      <p className="text-slate-500 text-sm mt-1 ml-8">{blurb}</p>
    </div>
  )
}

/**
 * One of the two public forms, with its absolute URL front and centre. The URL
 * is the product here — the link is secondary.
 */
function PublicRoute({
  icon,
  title,
  path,
  origin,
  who,
  next,
  footnote,
}: {
  icon: React.ReactNode
  title: string
  path: string
  origin: string | null
  who: string
  next: string[]
  footnote?: string
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-white font-semibold">{title}</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/15 text-green-300 ml-auto">
          public
        </span>
      </div>

      <p className="text-slate-400 text-sm mt-2 leading-relaxed">{who}</p>

      <CopyableUrl origin={origin} path={path} />

      <p className="text-slate-300 text-sm font-medium mt-4">What happens next</p>
      <ul className="mt-2 space-y-1.5">
        {next.map((line) => (
          <li key={line} className="flex items-start gap-2 text-slate-400 text-sm">
            <ArrowRight size={12} className="text-slate-600 mt-1 shrink-0" />
            <span>{line}</span>
          </li>
        ))}
      </ul>

      {footnote && (
        <p className="flex items-start gap-2 text-amber-200/80 text-xs mt-4 bg-amber-500/10 border border-amber-500/25 rounded-lg px-3 py-2.5">
          <AlertTriangle size={13} className="mt-0.5 shrink-0 text-amber-400" />
          <span>{footnote}</span>
        </p>
      )}
    </div>
  )
}

function StaffRoute({
  icon,
  title,
  href,
  allowed,
  rolesLabel,
  next,
}: {
  icon: React.ReactNode
  title: string
  href: string
  allowed: boolean
  rolesLabel: string
  next: string[]
}) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 flex flex-col">
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-white font-semibold">{title}</h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-700 text-slate-300 ml-auto">
          staff
        </span>
      </div>

      <p className="text-slate-500 text-xs mt-2">Open to: {rolesLabel}</p>

      {allowed ? (
        <Link
          href={href}
          className="inline-flex items-center gap-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg px-3 py-2 text-sm transition-colors mt-3 self-start"
        >
          <UserPlus size={13} /> {href}
        </Link>
      ) : (
        <p className="inline-flex items-start gap-2 text-slate-500 text-sm mt-3">
          <Lock size={13} className="mt-0.5 shrink-0" />
          <span>
            Your role cannot open <span className="font-mono text-slate-400">{href}</span>.
            Ask an owner if it should.
          </span>
        </p>
      )}

      <p className="text-slate-300 text-sm font-medium mt-4">What happens next</p>
      <ul className="mt-2 space-y-1.5">
        {next.map((line) => (
          <li key={line} className="flex items-start gap-2 text-slate-400 text-sm">
            <ArrowRight size={12} className="text-slate-600 mt-1 shrink-0" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/**
 * The absolute URL, selectable, with a copy button.
 *
 * `navigator.clipboard` is undefined on an http origin, which is exactly where
 * this CRM runs in development — so there are three tiers: the clipboard API,
 * the old `execCommand` path, and finally selecting the text and saying so.
 */
function CopyableUrl({ origin, path }: { origin: string | null; path: string }) {
  const [copied, setCopied] = useState(false)
  const [manual, setManual] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 2500)
    return () => clearTimeout(t)
  }, [copied])

  if (origin === null) {
    return (
      <div className="mt-3 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2.5">
        <p className="text-slate-500 text-xs">Working out this site’s address…</p>
      </div>
    )
  }

  if (origin === '') {
    return (
      <div className="mt-3 bg-slate-950 border border-amber-500/30 rounded-lg px-3 py-2.5">
        <p className="text-amber-200/90 text-xs">
          This site’s address could not be determined, so the full link cannot be
          shown. The path is <span className="font-mono text-white">{path}</span> —
          put it after whatever address you use to reach this CRM.
        </p>
      </div>
    )
  }

  const url = `${origin}${path}`

  async function copy() {
    setManual(false)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url)
        setCopied(true)
        return
      }
    } catch {
      // Fall through — a refused clipboard is not an error worth showing when
      // there is still a way to get the text across.
    }

    const el = inputRef.current
    if (el) {
      el.focus()
      el.select()
      try {
        if (document.execCommand('copy')) {
          setCopied(true)
          return
        }
      } catch {
        // Same again — the selection below is the answer either way.
      }
    }
    setManual(true)
  }

  return (
    <div className="mt-3">
      <div className="flex items-stretch gap-2">
        <input
          ref={inputRef}
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          aria-label="Public signup link"
          className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white text-xs font-mono focus:outline-none focus:border-pink-500"
        />
        <button
          type="button"
          onClick={copy}
          className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors ${
            copied
              ? 'bg-green-600/90 text-white'
              : 'bg-slate-800 hover:bg-slate-700 text-slate-200'
          }`}
        >
          {copied ? <><Check size={12} /> Copied</> : <><ClipboardCopy size={12} /> Copy</>}
        </button>
        <Link
          href={path}
          className="inline-flex items-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg px-3 py-2 text-xs transition-colors whitespace-nowrap"
        >
          <ExternalLink size={12} /> Open
        </Link>
      </div>
      {manual && (
        <p className="text-amber-300/90 text-xs mt-1.5">
          This browser would not let the page write to the clipboard. The link is
          selected above — press Ctrl+C, or ⌘C on a Mac.
        </p>
      )}
      {copied && !manual && (
        <p className="text-green-400/90 text-xs mt-1.5">
          Copied. Paste it into WhatsApp or an email and send it as it is.
        </p>
      )}
    </div>
  )
}

function QueueStat({
  label,
  count,
  href,
  linkable,
}: {
  label: string
  count: number
  href: string
  linkable: boolean
}) {
  const body = (
    <>
      <p className="text-slate-400 text-xs font-medium uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${count > 0 ? 'text-amber-300' : 'text-slate-600'}`}>
        {count.toLocaleString('en-IN')}
      </p>
      <p className="text-slate-600 text-xs mt-0.5">
        {count === 0 ? 'none waiting' : 'waiting for a decision'}
      </p>
    </>
  )

  if (!linkable) {
    return <div className="bg-slate-900 border border-slate-800 rounded-xl p-4">{body}</div>
  }

  return (
    <Link
      href={href}
      className="bg-slate-900 border border-slate-800 hover:border-slate-700 rounded-xl p-4 block transition-colors"
    >
      {body}
      <span className="inline-flex items-center gap-1 text-pink-400 text-xs mt-2">
        Review <ArrowRight size={11} />
      </span>
    </Link>
  )
}
