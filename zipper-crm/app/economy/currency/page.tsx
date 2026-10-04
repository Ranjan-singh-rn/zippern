'use client'

/**
 * Beans, diamonds and seller credit.
 *
 * This screen used to move money. It called `applyCurrencyTransaction`, which
 * did `updateDoc(users/{id}, { diamonds: increment(...) })` straight from the
 * browser, and `lendDiamondsToSeller`, which did the same to a seller's
 * `coinBalance` — with no due date — and a "mark repaid" button that cleared a
 * debt in one click. That made the whole approval chain optional: an operator
 * who opened this page instead of the user page skipped verification and
 * signature entirely. `firestore.rules` now refuses those writes outright, so
 * that code was not merely unsafe, it was broken.
 *
 * Every mutation here now raises a **card** on the money board and moves
 * nothing:
 *
 *   Balance change  → api.users.requestBalanceChange
 *   Lend to seller  → api.partnerOps.requestLending      (due date REQUIRED)
 *   Repayment       → api.partnerOps.requestRepayment
 *   Recovery        → api.partnerOps.requestRecovery
 *
 * The panel says so in those words, before the button is pressed and again
 * after, because "it worked" and "the money moved" are different claims and
 * confusing them is the failure this flow exists to prevent.
 *
 * Reading is still Firestore, and that is fine: the picker, the search and the
 * history list below are reads. Nothing on this page writes to Firestore.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  collection, getDocs, query, where, limit, orderBy,
  type DocumentData, type Timestamp,
} from 'firebase/firestore'
import {
  AlertTriangle, ArrowRight, Check, Coins, HandCoins, Loader2, RotateCcw,
  Search, ShieldAlert, ShoppingBag, Users, X, type LucideIcon,
} from 'lucide-react'

import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'
import { db } from '@/lib/firebase'
import api, { ApiError, type Card, type UserCurrency } from '@/lib/api'
import { getSellerLendingLedger, type DiamondLendingRecord } from '@/lib/economyConfig'
import {
  getUserBeanTransactions, getUserDiamondTransactions, type Transaction,
} from '@/lib/firestore'

const CURRENCY_PAGE_ROLES = ['superadmin', 'finance_admin', 'finance_member'] as const
const PAGE_SIZE = 20
const MIN_REASON = 3

const inputCls =
  'w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2.5 text-white text-sm placeholder-slate-600 focus:outline-none focus:border-pink-500'
const labelCls = 'block text-slate-400 text-xs font-medium mb-1.5'

type Mode = 'user' | 'seller'

/** Every mutation this screen can make. All four raise a card. */
type ActionKey = 'balance' | 'lend' | 'repayment' | 'recovery'

interface FoundUser {
  uid: string
  displayName: string
  email: string
  beans: number
  diamonds: number
  isHost: boolean
}

interface FoundSeller {
  id: string
  displayName: string
  email: string
  coinBalance: number
}

interface ActionSpec {
  key: ActionKey
  label: string
  icon: LucideIcon
  tone: 'blue' | 'purple' | 'green' | 'amber'
  title: string
  /** What pressing confirm actually does, said plainly. */
  effect: string
  confirmLabel: string
  reasonHint: string
}

const ACTIONS: Record<ActionKey, ActionSpec> = {
  balance: {
    key: 'balance',
    label: 'Request balance change',
    icon: Coins,
    tone: 'blue',
    title: 'Request a balance change',
    effect:
      'This creates a request. Nothing moves when you press confirm — the card goes to the money board, a second person verifies it, and an owner signs before the balance changes.',
    confirmLabel: 'Raise the request',
    reasonHint: 'Why the balance should change, and what it is correcting.',
  },
  lend: {
    key: 'lend',
    label: 'Lend coins',
    icon: HandCoins,
    tone: 'purple',
    title: 'Lend coins to this seller',
    effect:
      'Lending is credit — company money going out on trust — so it raises a card and no coins move until an owner signs. A due date is required: without one nothing can ever be reported as overdue.',
    confirmLabel: 'Raise the lending card',
    reasonHint: 'Why this seller is being extended credit, and against what agreement.',
  },
  repayment: {
    key: 'repayment',
    label: 'Record repayment',
    icon: Check,
    tone: 'green',
    title: 'Record a repayment',
    effect:
      'For coins the seller has actually paid back. This raises a card — it does not clear the debt by itself. The outstanding balance changes only after verification and signature.',
    confirmLabel: 'Raise the repayment card',
    reasonHint: 'What was repaid and how it arrived. Put the bank reference in the field above too.',
  },
  recovery: {
    key: 'recovery',
    label: 'Recover coins',
    icon: RotateCcw,
    tone: 'amber',
    title: 'Recover coins from this seller',
    effect:
      'Pulling coins back off a seller — for overdue credit, or inventory taken back. A recovery is a card like anything else: it is verified and signed before anything moves.',
    confirmLabel: 'Raise the recovery card',
    reasonHint: 'Why coins are being recovered, and what the seller has been told.',
  },
}

const TONES: Record<ActionSpec['tone'], string> = {
  blue: 'bg-blue-500/10 hover:bg-blue-500/20 border-blue-500/30 text-blue-300',
  purple: 'bg-purple-500/10 hover:bg-purple-500/20 border-purple-500/30 text-purple-300',
  green: 'bg-green-500/10 hover:bg-green-500/20 border-green-500/30 text-green-300',
  amber: 'bg-amber-500/10 hover:bg-amber-500/20 border-amber-500/30 text-amber-300',
}

// ── Firestore → view model (typed; no `any` anywhere on this page) ────────────

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function toUser(id: string, d: DocumentData): FoundUser {
  return {
    uid: id,
    displayName: str(d.displayName) || str(d.name) || str(d.username) || id,
    email: str(d.email),
    beans: num(d.beans),
    diamonds: num(d.diamonds),
    isHost: d.isHost === true,
  }
}

function toSeller(id: string, d: DocumentData): FoundSeller {
  return {
    id,
    displayName: str(d.displayName) || str(d.name) || id,
    email: str(d.email),
    coinBalance: num(d.coinBalance),
  }
}

function shortId(id: string): string {
  return id.slice(0, 8).toUpperCase()
}

function whenOf(ts: Timestamp | null | undefined): string {
  if (!ts?.toDate) return '—'
  return ts.toDate().toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
  })
}

/**
 * `<input type="date">` gives 'YYYY-MM-DD'. The API wants a datetime, and "due
 * on the 9th" means end of the 9th, not the first second of it — sending
 * midnight would make a loan overdue a full day early.
 */
function dueDateToIso(day: string): string {
  return new Date(`${day}T23:59:59`).toISOString()
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function CurrencyPage() {
  const { crmUser } = useAuth()
  const hasAccess = !!crmUser && canAccess(crmUser, [...CURRENCY_PAGE_ROLES])

  const [mode, setMode] = useState<Mode>('user')

  // Browse lists — Firestore reads.
  const [allUsers, setAllUsers] = useState<FoundUser[]>([])
  const [allSellers, setAllSellers] = useState<FoundSeller[]>([])
  const [listLoading, setListLoading] = useState(true)
  const [listError, setListError] = useState('')
  const [userPage, setUserPage] = useState(0)
  const [sellerPage, setSellerPage] = useState(0)
  const [listSearch, setListSearch] = useState('')

  // Selection.
  const [foundUser, setFoundUser] = useState<FoundUser | null>(null)
  const [foundSeller, setFoundSeller] = useState<FoundSeller | null>(null)

  // Exact-match search.
  const [searchTerm, setSearchTerm] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState('')

  // The card most recently raised, so the banner can point at the board.
  const [raised, setRaised] = useState<{ card: Card; text: string } | null>(null)

  // Modal.
  const [pending, setPending] = useState<ActionSpec | null>(null)

  const loadLists = useCallback(async () => {
    setListLoading(true)
    setListError('')
    try {
      const [usersSnap, sellersSnap] = await Promise.all([
        // `name`, not `displayName`: the app writes `name`, and Firestore drops
        // every document missing the orderBy field, so this returned zero users.
        getDocs(query(collection(db, 'users'), orderBy('name'), limit(500))),
        getDocs(query(collection(db, 'sellers'), orderBy('displayName'), limit(200))),
      ])
      setAllUsers(usersSnap.docs.map((d) => toUser(d.id, d.data())))
      setAllSellers(sellersSnap.docs.map((d) => toSeller(d.id, d.data())))
    } catch {
      // An empty list and a list that failed to load are not the same thing,
      // and the old code showed both as "No users found."
      setListError('Could not load the directory. Exact-match search below still works.')
    } finally {
      setListLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!hasAccess) return
    loadLists()
  }, [hasAccess, loadLists])

  const filteredUsers = useMemo(() => {
    const q = listSearch.trim().toLowerCase()
    if (!q) return allUsers
    return allUsers.filter(
      (u) =>
        u.displayName.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        u.uid.toLowerCase().includes(q),
    )
  }, [allUsers, listSearch])

  const filteredSellers = useMemo(() => {
    const q = listSearch.trim().toLowerCase()
    if (!q) return allSellers
    return allSellers.filter(
      (s) =>
        s.displayName.toLowerCase().includes(q) ||
        s.email.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q),
    )
  }, [allSellers, listSearch])

  const userPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE))
  const sellerPages = Math.max(1, Math.ceil(filteredSellers.length / PAGE_SIZE))
  const pagedUsers = filteredUsers.slice(userPage * PAGE_SIZE, (userPage + 1) * PAGE_SIZE)
  const pagedSellers = filteredSellers.slice(sellerPage * PAGE_SIZE, (sellerPage + 1) * PAGE_SIZE)

  function selectUser(u: FoundUser) {
    setFoundUser(u)
    setFoundSeller(null)
    setRaised(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function selectSeller(s: FoundSeller) {
    setFoundSeller(s)
    setFoundUser(null)
    setRaised(null)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  function clearSelection() {
    setFoundUser(null)
    setFoundSeller(null)
    setRaised(null)
  }

  function switchMode(m: Mode) {
    setMode(m)
    clearSelection()
    setSearchTerm('')
    setSearchErr('')
    setListSearch('')
    setUserPage(0)
    setSellerPage(0)
  }

  async function handleSearch() {
    const term = searchTerm.trim()
    if (!term) return
    setSearching(true)
    setSearchErr('')
    setFoundUser(null)
    setFoundSeller(null)
    try {
      if (mode === 'seller') {
        const snaps = await Promise.all([
          // Lower-cased, because `sellers.email` is. The registration forms
          // normalise it on the way in, and
          // `backend/scripts/normalise_partner_emails.py` normalised the
          // records that predate that — Firestore's `==` is case-sensitive, so
          // a staff member typing the address the way the seller writes it,
          // with a capital, would find nothing and be told no such seller
          // exists. The name query is deliberately left alone: `displayName` is
          // stored as typed and lower-casing it would find nothing at all.
          getDocs(query(collection(db, 'sellers'), where('email', '==', term.toLowerCase()), limit(1))),
          getDocs(query(collection(db, 'sellers'), where('displayName', '==', term), limit(1))),
        ])
        const found = [...snaps[0].docs, ...snaps[1].docs][0]
        if (found) setFoundSeller(toSeller(found.id, found.data()))
        else setSearchErr('No seller with that exact email or name. Try browsing the list below.')
      } else {
        const snaps = await Promise.all([
          getDocs(query(collection(db, 'users'), where('email', '==', term), limit(1))),
          // `username` is not a field the app writes. Search by the visible name.
          getDocs(query(collection(db, 'users'), where('name', '==', term), limit(1))),
        ])
        const found = [...snaps[0].docs, ...snaps[1].docs][0]
        if (found) setFoundUser(toUser(found.id, found.data()))
        else setSearchErr('No user with that exact email or username. Try browsing the list below.')
      }
    } catch {
      setSearchErr('Search failed. Check your connection and try again.')
    } finally {
      setSearching(false)
    }
  }

  const selected = foundUser ?? foundSeller
  const availableActions: ActionSpec[] = foundUser
    ? [ACTIONS.balance]
    : foundSeller
      ? [ACTIONS.lend, ACTIONS.repayment, ACTIONS.recovery]
      : []

  if (!hasAccess) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-slate-400">Access denied.</p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-white">Beans, diamonds &amp; seller credit</h1>
        <p className="text-slate-400 text-sm mt-1">
          Raise a request against a user or a seller. This screen does not move money.
        </p>
      </div>

      {/* Said before anything is pressed, not after. */}
      <div className="flex items-start gap-2 bg-blue-500/5 border border-blue-500/25 rounded-xl px-4 py-3">
        <Coins size={15} className="text-blue-300 mt-0.5 shrink-0" />
        <p className="text-blue-100/90 text-sm">
          Nothing here is a direct write. <strong>Every action raises a card. A second person
          verifies it and an owner signs it before any balance changes.</strong> You can follow
          anything you raise on the{' '}
          <Link href="/board" className="text-blue-300 underline underline-offset-2 hover:text-white">
            money board
          </Link>
          .
        </p>
      </div>

      {/* Mode switcher */}
      <div className="flex gap-1 p-1 bg-slate-900 border border-slate-800 rounded-xl">
        {([
          { key: 'user' as Mode, label: 'Users', icon: Users },
          { key: 'seller' as Mode, label: 'Coin sellers', icon: ShoppingBag },
        ]).map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            onClick={() => switchMode(key)}
            className={`flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium transition-colors ${
              mode === key ? 'bg-pink-500 text-white' : 'text-slate-400 hover:text-white'
            }`}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>

      {/* A raised card is deliberately not dressed up as a success: nothing has
          happened to the balance yet, and saying otherwise is the failure mode
          this whole flow exists to prevent. */}
      {raised && (
        <div className="flex items-start justify-between gap-3 bg-blue-500/10 border border-blue-500/30 rounded-xl px-4 py-3">
          <div className="flex items-start gap-2">
            <Coins size={15} className="text-blue-300 mt-0.5 shrink-0" />
            <div className="text-blue-50 text-sm">
              <p className="font-semibold">{raised.text}</p>
              <p className="mt-1 text-blue-100/90">
                <strong>No money has moved.</strong> The request is a card on the money board. It
                needs a second person to verify it and an owner to sign it before anything changes.
                If nobody does, nothing happens.
              </p>
              <p className="mt-1 text-blue-100/70 text-xs">
                Card {raised.card.id} · {raised.card.stage.replace(/_/g, ' ')}
              </p>
              <Link
                href="/board"
                className="inline-flex items-center gap-1.5 mt-2 text-blue-200 hover:text-white underline underline-offset-2 font-medium"
              >
                Open the money board <ArrowRight size={13} />
              </Link>
            </div>
          </div>
          <button onClick={() => setRaised(null)} className="text-blue-300/70 hover:text-blue-100">
            <X size={14} />
          </button>
        </div>
      )}

      {/* Selection + actions */}
      {selected ? (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div
                className={`w-10 h-10 rounded-full flex items-center justify-center font-bold shrink-0 ${
                  foundUser ? 'bg-pink-500/20 text-pink-300' : 'bg-blue-500/20 text-blue-300'
                }`}
              >
                {(foundUser?.displayName ?? foundSeller?.displayName ?? '?')[0]?.toUpperCase()}
              </div>
              <div>
                <p className="text-white font-medium">
                  {foundUser?.displayName ?? foundSeller?.displayName}
                </p>
                <p className="text-slate-400 text-xs">
                  {foundUser?.email || foundSeller?.email || '—'}
                </p>
                {foundUser && (
                  <p className="text-slate-500 text-xs mt-0.5">
                    🫘 {foundUser.beans.toLocaleString('en-IN')} &nbsp;·&nbsp; 💎{' '}
                    {foundUser.diamonds.toLocaleString('en-IN')}
                    {foundUser.isHost && <span className="ml-2 text-yellow-400">Host</span>}
                  </p>
                )}
                {foundSeller && (
                  <p className="text-slate-500 text-xs mt-0.5">
                    🪙 Coins on hand: {foundSeller.coinBalance.toLocaleString('en-IN')}
                  </p>
                )}
              </div>
            </div>
            <button onClick={clearSelection} className="text-slate-500 hover:text-white transition-colors">
              <X size={16} />
            </button>
          </div>

          <p className="text-slate-500 text-xs">
            Balances shown are the last values Firestore holds. They are read-only here — the
            authoritative figure after a card executes is on the statement.
          </p>

          <div className="flex flex-wrap gap-2">
            {availableActions.map((spec) => (
              <button
                key={spec.key}
                onClick={() => setPending(spec)}
                className={`flex items-center gap-2 border rounded-lg px-3 py-2 text-sm font-medium transition-colors ${TONES[spec.tone]}`}
              >
                <spec.icon size={14} /> {spec.label}
              </button>
            ))}
          </div>

          {foundSeller && (
            <div className="flex items-start gap-2 bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2.5">
              <ShieldAlert size={14} className="text-slate-400 mt-0.5 shrink-0" />
              <p className="text-slate-400 text-xs">
                There is no &ldquo;mark repaid&rdquo; button. Clearing a debt in one click, with no
                money arriving and nobody countersigning, is how an outstanding balance quietly
                disappears. Record a repayment or a recovery instead — both are cards.
              </p>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-slate-900 border border-slate-800 rounded-xl p-5 space-y-3">
          <p className="text-slate-400 text-sm">
            Quick search by exact {mode === 'seller' ? 'seller email or name' : 'email or username'}:
          </p>
          <div className="flex gap-2">
            <input
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
              placeholder={mode === 'seller' ? 'Seller email or name' : 'User email or username'}
              className={inputCls}
            />
            <button
              onClick={handleSearch}
              disabled={searching || !searchTerm.trim()}
              className="flex items-center gap-2 px-4 py-2 bg-pink-500 hover:bg-pink-400 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors shrink-0"
            >
              {searching ? <Loader2 size={14} className="animate-spin" /> : <Search size={14} />}
            </button>
          </div>
          {searchErr && (
            <p className="text-red-400 text-sm flex items-center gap-2">
              <AlertTriangle size={13} /> {searchErr}
            </p>
          )}
        </div>
      )}

      {/* History — Firestore reads, safe to keep */}
      {foundUser && <UserHistory uid={foundUser.uid} />}
      {foundSeller && <SellerLendingHistory sellerId={foundSeller.id} />}

      {/* Browse list */}
      <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
            <input
              value={listSearch}
              onChange={(e) => {
                setListSearch(e.target.value)
                setUserPage(0)
                setSellerPage(0)
              }}
              placeholder={`Search ${mode === 'seller' ? 'sellers' : 'users'} by name, email or ID…`}
              className="w-full pl-9 pr-3 py-2 bg-slate-800 border border-slate-700 rounded-lg text-sm text-white placeholder-slate-500 focus:outline-none focus:border-pink-500"
            />
          </div>
          {listLoading && <Loader2 size={16} className="text-slate-400 animate-spin shrink-0" />}
        </div>

        {listError && (
          <div className="flex items-center justify-between gap-3 px-5 py-3 bg-red-500/10 border-b border-red-500/25">
            <p className="text-red-300 text-sm flex items-center gap-2">
              <AlertTriangle size={14} /> {listError}
            </p>
            <button
              onClick={loadLists}
              className="text-red-200 hover:text-white text-xs underline underline-offset-2 shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {mode === 'user' ? (
          <>
            <div className="divide-y divide-slate-800">
              {listLoading ? (
                <p className="text-slate-500 text-sm text-center py-8">Loading users…</p>
              ) : pagedUsers.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-8">
                  {listSearch.trim() ? 'No users match that search.' : 'No users to show.'}
                </p>
              ) : (
                pagedUsers.map((u) => (
                  <button
                    key={u.uid}
                    onClick={() => selectUser(u)}
                    className={`w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-800/60 transition-colors text-left ${
                      foundUser?.uid === u.uid ? 'bg-pink-500/10' : ''
                    }`}
                  >
                    <div className="w-8 h-8 rounded-full bg-pink-500/20 flex items-center justify-center text-pink-300 text-xs font-bold shrink-0">
                      {u.displayName[0]?.toUpperCase() ?? '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">
                        {u.displayName}
                        {u.isHost && (
                          <span className="ml-2 text-xs text-yellow-400 font-normal">Host</span>
                        )}
                      </p>
                      <p className="text-slate-500 text-xs truncate">
                        {u.email || '—'} · <span className="font-mono">{shortId(u.uid)}</span>
                      </p>
                    </div>
                    <div className="text-right text-xs shrink-0">
                      <p className="text-slate-300">🫘 {u.beans.toLocaleString('en-IN')}</p>
                      <p className="text-slate-300">💎 {u.diamonds.toLocaleString('en-IN')}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
            <ListFooter
              page={userPage}
              pages={userPages}
              total={filteredUsers.length}
              noun="users"
              loading={listLoading}
              onPage={setUserPage}
            />
          </>
        ) : (
          <>
            <div className="divide-y divide-slate-800">
              {listLoading ? (
                <p className="text-slate-500 text-sm text-center py-8">Loading sellers…</p>
              ) : pagedSellers.length === 0 ? (
                <p className="text-slate-500 text-sm text-center py-8">
                  {listSearch.trim() ? 'No sellers match that search.' : 'No sellers to show.'}
                </p>
              ) : (
                pagedSellers.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => selectSeller(s)}
                    className={`w-full flex items-center gap-3 px-5 py-3 hover:bg-slate-800/60 transition-colors text-left ${
                      foundSeller?.id === s.id ? 'bg-pink-500/10' : ''
                    }`}
                  >
                    <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-300 text-xs font-bold shrink-0">
                      {s.displayName[0]?.toUpperCase() ?? '?'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white text-sm font-medium truncate">{s.displayName}</p>
                      <p className="text-slate-500 text-xs truncate">
                        {s.email || '—'} · <span className="font-mono">SLR-{shortId(s.id)}</span>
                      </p>
                    </div>
                    <div className="text-right text-xs shrink-0">
                      <p className="text-slate-300">🪙 {s.coinBalance.toLocaleString('en-IN')}</p>
                    </div>
                  </button>
                ))
              )}
            </div>
            <ListFooter
              page={sellerPage}
              pages={sellerPages}
              total={filteredSellers.length}
              noun="sellers"
              loading={listLoading}
              onPage={setSellerPage}
            />
          </>
        )}
      </div>

      {pending && (
        <ActionModal
          spec={pending}
          subjectName={foundUser?.displayName ?? foundSeller?.displayName ?? ''}
          userUid={foundUser?.uid ?? null}
          sellerId={foundSeller?.id ?? null}
          onClose={() => setPending(null)}
          onRaised={(card, text) => {
            setRaised({ card, text })
            setPending(null)
            window.scrollTo({ top: 0, behavior: 'smooth' })
          }}
        />
      )}
    </div>
  )
}

// ── List footer ───────────────────────────────────────────────────────────────

function ListFooter({
  page, pages, total, noun, loading, onPage,
}: {
  page: number
  pages: number
  total: number
  noun: string
  loading: boolean
  onPage: (updater: (p: number) => number) => void
}) {
  if (loading) return null
  if (pages <= 1) {
    return (
      <p className="px-5 py-2 text-slate-600 text-xs border-t border-slate-800">
        {total} {noun}
      </p>
    )
  }
  return (
    <div className="flex items-center justify-between px-5 py-3 border-t border-slate-800">
      <button
        onClick={() => onPage((p) => Math.max(0, p - 1))}
        disabled={page === 0}
        className="text-slate-400 hover:text-white disabled:opacity-30 text-sm transition-colors"
      >
        ← Prev
      </button>
      <span className="text-slate-500 text-xs">
        Page {page + 1} of {pages} · {total} {noun}
      </span>
      <button
        onClick={() => onPage((p) => Math.min(pages - 1, p + 1))}
        disabled={page >= pages - 1}
        className="text-slate-400 hover:text-white disabled:opacity-30 text-sm transition-colors"
      >
        Next →
      </button>
    </div>
  )
}

// ── History panels (reads only) ───────────────────────────────────────────────

function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className="bg-slate-900 border border-slate-800 rounded-xl overflow-hidden">
      <div className="px-5 py-3.5 border-b border-slate-800">
        <h2 className="text-white text-sm font-semibold">{title}</h2>
        <p className="text-slate-600 text-xs mt-0.5">{note}</p>
      </div>
      {children}
    </div>
  )
}

function HistoryState({ children }: { children: React.ReactNode }) {
  return <p className="text-slate-500 text-sm text-center py-8">{children}</p>
}

function UserHistory({ uid }: { uid: string }) {
  const [rows, setRows] = useState<(Transaction & { currency: 'beans' | 'diamonds' })[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    Promise.all([getUserBeanTransactions(uid), getUserDiamondTransactions(uid)])
      .then(([beans, diamonds]) => {
        if (!live) return
        const merged = [
          ...beans.map((t) => ({ ...t, currency: 'beans' as const })),
          ...diamonds.map((t) => ({ ...t, currency: 'diamonds' as const })),
        ].sort((a, b) => (b.timestamp?.toMillis() ?? 0) - (a.timestamp?.toMillis() ?? 0))
        setRows(merged.slice(0, 50))
      })
      .catch(() => {
        if (live) setError('Could not read this account’s transaction history.')
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [uid])

  return (
    <Panel title="Transaction history" note="Read from Firestore. Newest 50 across both currencies.">
      {loading ? (
        <HistoryState>
          <Loader2 size={16} className="animate-spin inline" />
        </HistoryState>
      ) : error ? (
        <HistoryState>
          <span className="text-red-400 inline-flex items-center gap-2">
            <AlertTriangle size={13} /> {error}
          </span>
        </HistoryState>
      ) : rows.length === 0 ? (
        <HistoryState>No transactions recorded against this account.</HistoryState>
      ) : (
        <div className="divide-y divide-slate-800 max-h-80 overflow-y-auto">
          {rows.map((t) => (
            <div key={`${t.currency}-${t.id}`} className="flex items-center gap-3 px-5 py-2.5">
              <span className="text-base shrink-0">{t.currency === 'beans' ? '🫘' : '💎'}</span>
              <div className="flex-1 min-w-0">
                <p className="text-slate-200 text-sm truncate">
                  {t.reasonLabel || t.reason || '—'}
                </p>
                <p className="text-slate-600 text-xs">
                  {whenOf(t.timestamp)}
                  {t.relatedUserName && ` · ${t.relatedUserName}`}
                </p>
              </div>
              <p
                className={`text-sm font-semibold shrink-0 ${
                  t.type === 'debit' ? 'text-red-300' : 'text-green-300'
                }`}
              >
                {t.type === 'debit' ? '−' : '+'}
                {t.amount.toLocaleString('en-IN')}
              </p>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

function SellerLendingHistory({ sellerId }: { sellerId: string }) {
  const [rows, setRows] = useState<DiamondLendingRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    setLoading(true)
    setError('')
    getSellerLendingLedger(sellerId)
      .then((r) => {
        if (live) setRows(r)
      })
      .catch(() => {
        if (live) setError('Could not read this seller’s lending ledger.')
      })
      .finally(() => {
        if (live) setLoading(false)
      })
    return () => {
      live = false
    }
  }, [sellerId])

  return (
    <Panel title="Lending history" note="Read from Firestore. Newest 50 entries.">
      {loading ? (
        <HistoryState>
          <Loader2 size={16} className="animate-spin inline" />
        </HistoryState>
      ) : error ? (
        <HistoryState>
          <span className="text-red-400 inline-flex items-center gap-2">
            <AlertTriangle size={13} /> {error}
          </span>
        </HistoryState>
      ) : rows.length === 0 ? (
        <HistoryState>Nothing has been lent to this seller.</HistoryState>
      ) : (
        <div className="divide-y divide-slate-800 max-h-80 overflow-y-auto">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-5 py-2.5">
              <div className="flex-1 min-w-0">
                <p className="text-slate-200 text-sm truncate">{r.notes || 'Lending'}</p>
                <p className="text-slate-600 text-xs">
                  {whenOf(r.lentAt)}
                  {r.lentBy && ` · ${r.lentBy}`}
                </p>
              </div>
              <span
                className={`px-2 py-0.5 rounded-full text-xs font-semibold shrink-0 ${
                  r.status === 'repaid'
                    ? 'bg-green-500/15 text-green-300'
                    : 'bg-amber-500/15 text-amber-200'
                }`}
              >
                {r.status === 'repaid' ? 'Repaid' : 'Outstanding'}
              </span>
              <p className="text-slate-200 text-sm font-semibold shrink-0 w-20 text-right">
                🪙 {(r.amount ?? 0).toLocaleString('en-IN')}
              </p>
            </div>
          ))}
        </div>
      )}
    </Panel>
  )
}

// ── Action modal ──────────────────────────────────────────────────────────────
//
// Every mutation captures its reason here. Never `window.prompt` — a prompt
// cannot be validated, cannot explain what the action does, and cannot say that
// no money is about to move.

interface Failure {
  message: string
  /** A business rule refused, as opposed to the request never arriving. */
  isRule: boolean
}

function ActionModal({
  spec, subjectName, userUid, sellerId, onClose, onRaised,
}: {
  spec: ActionSpec
  subjectName: string
  userUid: string | null
  sellerId: string | null
  onClose: () => void
  onRaised: (card: Card, text: string) => void
}) {
  const [reason, setReason] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<UserCurrency>('diamonds')
  const [dueDate, setDueDate] = useState('')
  const [terms, setTerms] = useState('')
  const [paymentRef, setPaymentRef] = useState('')
  const [penalty, setPenalty] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)

  async function raise(why: string): Promise<{ card: Card; text: string }> {
    const n = Number(amount)

    switch (spec.key) {
      case 'balance': {
        if (!userUid) throw new ApiError('No user selected.', 400)
        const card = await api.users.requestBalanceChange(userUid, currency, n, why)
        return {
          card,
          text: `Requested ${n > 0 ? '+' : ''}${n.toLocaleString('en-IN')} ${currency} for ${subjectName || userUid}.`,
        }
      }
      case 'lend': {
        if (!sellerId) throw new ApiError('No seller selected.', 400)
        const card = await api.partnerOps.requestLending(sellerId, {
          coins: n,
          due_at: dueDateToIso(dueDate),
          terms: terms.trim() || undefined,
          reason: why,
        })
        return {
          card,
          text: `Requested lending of ${n.toLocaleString('en-IN')} coins to ${subjectName || sellerId}, due ${dueDate}.`,
        }
      }
      case 'repayment': {
        if (!sellerId) throw new ApiError('No seller selected.', 400)
        const card = await api.partnerOps.requestRepayment(sellerId, {
          coins: n,
          payment_ref: paymentRef.trim() || undefined,
          reason: why,
        })
        return {
          card,
          text: `Requested a repayment of ${n.toLocaleString('en-IN')} coins from ${subjectName || sellerId}.`,
        }
      }
      case 'recovery': {
        if (!sellerId) throw new ApiError('No seller selected.', 400)
        const penaltyCoins = penalty.trim() ? Number(penalty) : undefined
        const card = await api.partnerOps.requestRecovery(sellerId, {
          coins: n,
          penalty_coins: penaltyCoins,
          reason: why,
        })
        return {
          card,
          text: `Requested recovery of ${n.toLocaleString('en-IN')} coins from ${subjectName || sellerId}${
            penaltyCoins ? ` plus a ${penaltyCoins.toLocaleString('en-IN')} coin penalty` : ''
          }.`,
        }
      }
    }
  }

  /** Everything the API would refuse, checked here so it is not sent to be refused. */
  function validate(why: string): string | null {
    if (why.length < MIN_REASON) {
      return `A reason of at least ${MIN_REASON} characters is required — it is what the audit log stores.`
    }

    const n = Number(amount)
    if (!amount.trim() || !Number.isInteger(n)) {
      return 'Enter the amount as a whole number.'
    }

    if (spec.key === 'balance') {
      if (n === 0) {
        return 'Enter a whole number. Positive credits the account, negative debits it. Zero has no meaning.'
      }
    } else if (n <= 0) {
      return 'Enter a positive number of coins.'
    }

    if (spec.key === 'lend') {
      if (!dueDate) {
        return 'A due date is required. Credit with no due date can never be reported as overdue, which is how it stops being chased.'
      }
      if (dueDate <= todayIso()) {
        return 'The due date has to be in the future.'
      }
    }

    if (spec.key === 'recovery' && penalty.trim()) {
      const p = Number(penalty)
      if (!Number.isInteger(p) || p < 0) return 'The penalty has to be a whole number of coins, or blank.'
    }

    return null
  }

  async function submit() {
    const why = reason.trim()
    const problem = validate(why)
    if (problem) {
      setFailure({ message: problem, isRule: true })
      return
    }

    setBusy(true)
    setFailure(null)
    try {
      const { card, text } = await raise(why)
      onRaised(card, text)
    } catch (err) {
      // ApiError.message is what the API actually said. Show it verbatim —
      // replacing it with something friendlier is how a refusal becomes a
      // mystery.
      if (err instanceof ApiError) setFailure({ message: err.message, isRule: err.isRule })
      else setFailure({ message: 'That did not work. Try again.', isRule: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={busy ? undefined : onClose} />
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-800 rounded-2xl shadow-2xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 px-6 py-4 border-b border-slate-800">
          <div>
            <h2 className="text-white font-semibold">{spec.title}</h2>
            <p className="text-slate-500 text-xs mt-0.5">{subjectName || '—'}</p>
          </div>
          <button onClick={onClose} disabled={busy} className="text-slate-500 hover:text-white disabled:opacity-40">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-5 space-y-4">
          <p className="text-slate-300 text-sm leading-relaxed">{spec.effect}</p>

          {spec.key === 'balance' ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls}>Currency</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as UserCurrency)}
                  className={inputCls}
                >
                  <option value="diamonds">Diamonds</option>
                  <option value="beans">Beans</option>
                </select>
              </div>
              <div>
                <label className={labelCls}>Amount (− to debit)</label>
                <input
                  type="number"
                  step={1}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="e.g. 500 or -500"
                  className={inputCls}
                />
              </div>
            </div>
          ) : (
            <div>
              <label className={labelCls}>Coins</label>
              <input
                type="number"
                min={1}
                step={1}
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="Whole number of coins"
                className={inputCls}
              />
            </div>
          )}

          {spec.key === 'lend' && (
            <>
              <div>
                <label className={labelCls}>
                  Due date <span className="text-pink-400">(required)</span>
                </label>
                <input
                  type="date"
                  value={dueDate}
                  min={todayIso()}
                  onChange={(e) => setDueDate(e.target.value)}
                  className={inputCls}
                />
                <p className="text-slate-600 text-xs mt-1">
                  Credit is due at the end of this day. Without it nothing can be reported overdue.
                </p>
              </div>
              <div>
                <label className={labelCls}>Terms (optional)</label>
                <input
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                  placeholder="Agreement reference, repayment schedule…"
                  className={inputCls}
                />
              </div>
            </>
          )}

          {spec.key === 'repayment' && (
            <div>
              <label className={labelCls}>Payment reference (optional)</label>
              <input
                value={paymentRef}
                onChange={(e) => setPaymentRef(e.target.value)}
                placeholder="UTR, Binance TxID…"
                className={inputCls}
              />
              <p className="text-slate-600 text-xs mt-1">
                Whoever verifies this card will look for the money against this reference.
              </p>
            </div>
          )}

          {spec.key === 'recovery' && (
            <div>
              <label className={labelCls}>Penalty coins (optional)</label>
              <input
                type="number"
                min={0}
                step={1}
                value={penalty}
                onChange={(e) => setPenalty(e.target.value)}
                placeholder="Leave blank for no penalty"
                className={inputCls}
              />
            </div>
          )}

          <div>
            <label className={labelCls}>
              Reason <span className="text-pink-400">(required)</span>
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              autoFocus
              placeholder={spec.reasonHint}
              className={`${inputCls} resize-none`}
            />
            <p className="text-slate-600 text-xs mt-1">
              At least {MIN_REASON} characters. This is stored on the card and in the audit log, and
              it is what the person verifying it reads first.
            </p>
          </div>

          {failure && (
            <div
              className={`flex items-start gap-2 rounded-lg px-4 py-3 border ${
                failure.isRule
                  ? 'bg-amber-500/10 border-amber-500/30'
                  : 'bg-red-500/10 border-red-500/30'
              }`}
            >
              <AlertTriangle
                size={15}
                className={`mt-0.5 shrink-0 ${failure.isRule ? 'text-amber-400' : 'text-red-400'}`}
              />
              <div className={failure.isRule ? 'text-amber-100 text-sm' : 'text-red-200 text-sm'}>
                <p className="font-medium">{failure.isRule ? 'Refused' : 'Could not complete that'}</p>
                <p className="mt-0.5">{failure.message}</p>
              </div>
            </div>
          )}
        </div>

        <div className="flex gap-3 px-6 py-4 border-t border-slate-800">
          <button
            onClick={onClose}
            disabled={busy}
            className="flex-1 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={busy}
            className="flex-1 flex items-center justify-center gap-2 bg-pink-500 hover:bg-pink-600 disabled:opacity-50 text-white rounded-lg px-4 py-2.5 text-sm font-semibold transition-colors"
          >
            {busy ? (
              <>
                <Loader2 size={15} className="animate-spin" /> Raising…
              </>
            ) : (
              <>
                <ArrowRight size={15} /> {spec.confirmLabel}
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
