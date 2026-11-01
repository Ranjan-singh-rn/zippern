'use client'

import { createContext, useCallback, useContext, useEffect, useRef, useState, ReactNode } from 'react'
import { onCrmAuthChange, crmSignOut, normalizeCrmRole, CrmUser, hasPermission, canAccess, Permission, CrmRole } from '@/lib/auth'
import { db } from '@/lib/firebase'
import { doc, onSnapshot } from 'firebase/firestore'
import type { User } from 'firebase/auth'
import api, {
  ApiError, endSession, getSessionToken, sessionNeedsRenewal, setSessionToken,
  API_UNAUTHORIZED_EVENT, type ApiUnauthorizedEvent, type ApiUser,
} from '@/lib/api'

interface AuthContextValue {
  firebaseUser: User | null
  crmUser: CrmUser | null
  loading: boolean
  hasPermission: (perm: Permission) => boolean
  canAccess: (roles: CrmRole[]) => boolean
  isSuperAdmin: boolean
  /** True once the API session exists — money and audit calls need it. */
  apiReady: boolean
  apiError: string
  /**
   * The identity the API recognises. For the observer this is the *only*
   * identity — they have no Firestore crmUsers record on purpose, because the
   * old role vocabulary has no read-only tier.
   */
  apiUser: ApiUser | null
  /**
   * Re-read the API identity from the session token that is in storage now.
   *
   * The observer's sign-in creates a session *after* this provider has mounted,
   * and the navigation that follows is client-side — nothing remounts. Without
   * this they would sit here authenticated with `apiUser: null` and be treated
   * as signed out.
   */
  refreshApiUser: () => Promise<ApiUser | null>
  /**
   * True once renewal has been refused and the only way forward is a password.
   *
   * Distinct from `!apiReady`, which is also true while a session is merely
   * being established. This one means the server has made a decision about the
   * account — deactivated, demoted, revoked, or away too long.
   */
  mustSignInAgain: boolean
  /**
   * The `crmUsers/{uid}` read failed, so this session's CRM profile is
   * **unknown** rather than absent.
   *
   * `crmUser` is null either way, and the two facts mean opposite things: an
   * absent record means no staff access and belongs at /login, an unread one
   * means we could not find out and must not evict anybody. Routing reads this
   * before it decides.
   */
  crmProfileUnread: boolean
}

const AuthContext = createContext<AuthContextValue>({
  firebaseUser: null,
  crmUser: null,
  loading: true,
  hasPermission: () => false,
  canAccess: () => false,
  isSuperAdmin: false,
  apiReady: false,
  apiError: '',
  apiUser: null,
  refreshApiUser: async () => null,
  mustSignInAgain: false,
  crmProfileUnread: false,
})

// ── How long a session lives, and how it stays alive ─────────────────────────
//
// The owner's complaint, verbatim: "when checking seller or try to view seller
// or agency details or refresh it comes back to login page ask to login again
// which is not correct. token at least go for a week then expire."
//
// The token is a week now (`session_ttl_minutes` in the API's config), but the
// length was never the whole story. What was missing is everything below: an
// active session is replaced before it dies, a refused call renews before it
// complains, and a password is asked for only when the *server* says the
// account can no longer hold a session.
//
// Three things start a renewal, and all three go through `renewNow`, which
// holds a single in-flight promise so a screen firing eight calls at once
// produces one renewal and not eight:
//
//   1. **Due.** The API says on every session response when to come back
//      (`renew_at`, a day before expiry). Checked when the tab becomes visible,
//      when the window takes focus, and on a slow interval for a tab that is
//      simply left open.
//   2. **Refused.** A 401 from any of the three API clients. Renewal is the
//      first response to one; the sign-out prompt is the second, and only if
//      renewal is refused.
//   3. **On load**, if the stored session is already past due.

/** How often a tab that is just sitting there checks whether renewal is due. */
const RENEWAL_POLL_MS = 5 * 60 * 1000

/**
 * How long after a *successful* renewal a 401 is treated as a straggler.
 *
 * Renewal rotates: the moment a new token is issued the old one is revoked. So
 * a request that was already in flight when the renewal landed comes back 401
 * on a session that is perfectly healthy — and it would be a bad joke to
 * answer that by asking for a password, since it is the very symptom being
 * fixed. Inside this window the 401 is checked rather than believed: one call
 * on the *current* token settles whether the session is actually gone.
 */
const RENEWAL_QUIET_MS = 30 * 1000

/**
 * The hard stop: this many renewals inside `RENEWAL_WINDOW_MS` and the CRM
 * stops trying and asks for a password.
 *
 * Nothing legitimate comes close — a renewal is due once a day. This exists so
 * that a server which keeps refusing freshly minted tokens produces three
 * calls and a login screen rather than an endless quiet loop nobody can see.
 */
const MAX_RENEWALS_PER_WINDOW = 3
const RENEWAL_WINDOW_MS = 10 * 60 * 1000

export function AuthProvider({ children }: { children: ReactNode }) {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null)
  const [crmUser, setCrmUser] = useState<CrmUser | null>(null)
  const [loading, setLoading] = useState(true)
  const [apiReady, setApiReady] = useState(() => !!getSessionToken())
  const [apiError, setApiError] = useState('')
  const [apiUser, setApiUser] = useState<ApiUser | null>(null)
  const [mustSignInAgain, setMustSignInAgain] = useState(false)

  //: True when the `crmUsers/{uid}` listener ERRORED, as opposed to reporting
  //: that no such document exists. `crmUser` is null in both cases and they
  //: mean opposite things: "you have no staff access" versus "we could not find
  //: out". Only the first should ever send somebody to /login.
  const [crmProfileUnread, setCrmProfileUnread] = useState(false)

  //: The Firebase user, readable from a callback without re-creating it. The
  //: state above is for rendering; this is for deciding — `requireSignIn` runs
  //: from a `useCallback` with no dependencies and must not close over a stale
  //: copy, because whether it signs Firebase out is the difference between
  //: showing a login form and showing a dead CRM.
  const firebaseUserRef = useRef<User | null>(null)

  // ── Renewal state ───────────────────────────────────────────────────────────
  //: The renewal currently in flight. Every trigger awaits this one rather than
  //: starting a second — eight screens 401-ing at once must renew once.
  const renewing = useRef<Promise<ApiUser | null> | null>(null)
  //: When the last renewal succeeded, for the straggler check.
  const renewedAt = useRef(0)
  //: When each recent renewal happened, for the hard stop.
  const renewals = useRef<number[]>([])
  //: A recovery from a 401 in progress. Set synchronously, because the call it
  //: makes can itself 401 and re-enter this listener before any await resolves.
  const recovering = useRef<Promise<void> | null>(null)
  //: Set when renewal has been refused. Nothing retries after this — the only
  //: thing that clears it is a fresh sign-in.
  const giveUp = useRef(false)

  /** A session we now hold. The one place `apiReady` becomes true. */
  const accept = useCallback((u: ApiUser): ApiUser => {
    giveUp.current = false
    setApiUser(u)
    setApiReady(true)
    setApiError('')
    setMustSignInAgain(false)
    return u
  }, [])

  /**
   * Renewal was refused. Ask for a password — and mean it.
   *
   * This is the *second* response to a lost session, never the first. By the
   * time it runs the API has been asked to renew and has declined, which it
   * only does for a reason about the account: deactivated, role changed,
   * session revoked, the observer's one-code-at-a-time rule, or an absence
   * longer than the grace window.
   *
   * Signing the Firebase user out is what actually produces the login screen —
   * the shell routes on `crmUser`, which is the Firestore identity, and that
   * only clears when Firebase does. It is deliberately NOT done for a bare
   * 401: a Firebase session can be perfectly valid while an API session is not,
   * and throwing it away on every transient refusal is how a person ends up
   * retyping a password because a Cloud Run instance was cold.
   */
  const requireSignIn = useCallback((message: string) => {
    giveUp.current = true
    endSession()
    setApiUser(null)
    setApiReady(false)
    setMustSignInAgain(true)
    setApiError(message)
    if (firebaseUserRef.current) crmSignOut().catch(console.error)
  }, [])

  /**
   * Renew now. Silent when it works, a password prompt when the server refuses.
   *
   * Returns the renewed identity, or null when nothing could be decided —
   * which is the network case, and is deliberately not a refusal: an offline
   * laptop must not cost anybody their session.
   */
  const renewNow = useCallback(async (): Promise<ApiUser | null> => {
    if (giveUp.current) return null
    if (renewing.current) return renewing.current
    if (!getSessionToken()) return null

    // The hard stop. Three renewals inside ten minutes is not a session ageing
    // out — it is something refusing tokens as fast as they are minted, and
    // the honest answer to that is a login screen rather than a fourth token.
    const now = Date.now()
    renewals.current = renewals.current.filter((t) => now - t < RENEWAL_WINDOW_MS)
    if (renewals.current.length >= MAX_RENEWALS_PER_WINDOW) {
      requireSignIn('Your session could not be kept alive. Sign in again to continue.')
      return null
    }
    renewals.current.push(now)

    const run = (async (): Promise<ApiUser | null> => {
      try {
        const u = await api.auth.refresh()
        renewedAt.current = Date.now()
        return accept(u)
      } catch (err) {
        // Could not reach the server. The session is not the problem and it is
        // not touched; the next trigger will try again.
        if (err instanceof ApiError && err.status === 0) {
          console.warn('Session renewal could not reach the API; keeping the session.')
          return null
        }
        // The server declined, and it says why. That message is the person's,
        // not a paraphrase — it is the difference between "your account has
        // been deactivated" and "it has been a while since you last used it".
        const message =
          err instanceof Error && err.message
            ? err.message
            : 'Your session could not be renewed.'
        requireSignIn(message)
        return null
      } finally {
        renewing.current = null
      }
    })()

    renewing.current = run
    return run
  }, [accept, requireSignIn])

  // Resolve whoever the API thinks we are, from a session token that already
  // exists. The observer signs in at /observer with a one-time code and never
  // touches Firebase, so this is the only way their identity is ever discovered.
  //
  // Unchanged on purpose: a plain read of the session in storage, no renewal.
  // The observer calls this immediately after exchanging their code, when the
  // session is seconds old, and `renew_session` refuses an observer by design.
  const refreshApiUser = useCallback(async (): Promise<ApiUser | null> => {
    if (!getSessionToken()) {
      setApiUser(null)
      setApiReady(false)
      return null
    }
    try {
      return accept(await api.auth.me())
    } catch {
      setSessionToken(null)
      setApiUser(null)
      setApiReady(false)
      return null
    }
  }, [accept])

  /**
   * Establish an identity from whatever is already in storage, on load.
   *
   * Renew rather than read when the stored session is past due, so the very
   * first thing a returning person's browser does is the thing that keeps them
   * signed in. A session that is not due is simply read — including one
   * carried over from the build before this, which has no schedule stored and
   * is left alone until it 401s and is renewed on that path instead.
   */
  const resolveStoredSession = useCallback(async (): Promise<ApiUser | null> => {
    if (!getSessionToken()) {
      setApiUser(null)
      setApiReady(false)
      return null
    }
    if (sessionNeedsRenewal()) return renewNow()
    try {
      return accept(await api.auth.me())
    } catch (err) {
      // The token looked live and was refused anyway — revoked, or a clock
      // that disagrees. `reportUnauthorized` no longer throws the token away,
      // so there is still something to renew with. One attempt, then a
      // password; `renewNow` decides which.
      if (err instanceof ApiError && err.status === 0) return null
      return renewNow()
    }
  }, [accept, renewNow])

  // ── Deciding when identity is actually "resolved" ───────────────────────────
  //
  // Two independent sources answer at different speeds, and `loading` must not
  // go false until BOTH have spoken — otherwise `resolveRedirect` reads a
  // half-answer and sends a signed-in person to /login.
  //
  //   API session   — a token in localStorage, shared by every tab.
  //   Firebase      — a session in IndexedDB, also shared by every tab.
  //
  // Both failure modes are real and were both live:
  //   · Observer signs in: no Firebase user ever, identity comes only from the
  //     token. Clearing `loading` on Firebase's instant "nobody" declared them
  //     signed out.
  //   · Staff opens a second tab: when the token lived in sessionStorage there
  //     was none in the new tab, so the API side answered "nothing" on a
  //     microtask — long before Firebase had read the user back out of
  //     IndexedDB. Clearing `loading` on that bounced a perfectly signed-in
  //     owner to /login, and /login's own restore-session effect had already
  //     run, so the form just sat there. The storage change means the second
  //     tab now *has* the token; this gate stays because the observer case does
  //     not, and because a first sign-in on a fresh machine still has neither.
  //
  // Hence: either source producing a real identity settles it immediately; an
  // empty answer only settles it once the other has also finished. Order does
  // not matter, which is the point — neither of these races is reproducible on
  // demand.
  const apiSettled = useRef(false)
  const firebaseSettled = useRef(false)

  const settleIfBothAnswered = useCallback(() => {
    if (apiSettled.current && firebaseSettled.current) setLoading(false)
  }, [])

  useEffect(() => {
    resolveStoredSession()
      .then((u) => {
        apiSettled.current = true
        // ONLY the observer may settle on the API answer alone, because the
        // observer is the only identity with no Firebase session to wait for.
        //
        // This used to read `if (u) setLoading(false)`, which fired for every
        // role — and that is what threw a signed-in owner to /login on every
        // refresh. The owner holds a 7-day API session in localStorage, so
        // `resolveStoredSession` returns an identity in milliseconds, while
        // Firebase is still reading its own session out of IndexedDB. Clearing
        // `loading` on the API answer meant `resolveRedirect` ran with
        // `crmUser: null` and `apiUser: {role:'owner'}` — which is neither the
        // observer case nor the both-absent case its two guards cover, so it
        // fell through to `if (!crmUser) return '/login'`.
        //
        // The bounce then looked like two different bugs. Landing on /login
        // with a live Firebase session, the login page recognises the user and
        // shows the superadmin security gate — so the same race presented as
        // "it sends me to the login page" and "it sends me to the verification
        // page" depending on which resolved first.
        if (u?.role === 'observer') setLoading(false)
        else settleIfBothAnswered()
      })
      .catch(() => {
        apiSettled.current = true
        settleIfBothAnswered()
      })
  }, [resolveStoredSession, settleIfBothAnswered])

  /**
   * A call carrying this session was refused. Work out what that means.
   *
   * Three answers, in the order they are cheapest to be sure of:
   *
   *   1. **A straggler.** A request that was already in flight when a renewal
   *      landed carries the token the renewal replaced, and rotation kills that
   *      token instantly — so its 401 says nothing about the live session. One
   *      call on the *current* token settles it. This case is common and
   *      answering it with a password prompt would reproduce the exact bug
   *      being fixed, one renewal later.
   *   2. **The session is simply old.** Renew it. Silent when it works.
   *   3. **The server has decided.** `renewNow` turns that into `requireSignIn`.
   *
   * `recovering` is set synchronously and before anything is awaited, because
   * the calls made here can themselves 401 and re-enter this function through
   * the very event that called it. Without it, step 1's own refusal would call
   * step 1 again, forever.
   */
  const recoverFromUnauthorized = useCallback((): void => {
    if (giveUp.current || recovering.current) return

    recovering.current = (async () => {
      try {
        const sinceRenewal = Date.now() - renewedAt.current
        if (renewedAt.current && sinceRenewal < RENEWAL_QUIET_MS) {
          try {
            accept(await api.auth.me())
            return // the session is fine — that 401 belonged to a dead token
          } catch (err) {
            if (err instanceof ApiError && err.status === 0) return
            requireSignIn(
              err instanceof Error && err.message
                ? err.message
                : 'Your session has ended. Sign in again to continue.',
            )
            return
          }
        }

        // Not "signed out" — "not usable this second". The money and audit
        // screens already gate on `apiReady`, so they show their waiting state
        // while this runs rather than an error nobody can act on.
        setApiReady(false)
        await renewNow()
      } finally {
        recovering.current = null
      }
    })()
  }, [accept, renewNow, requireSignIn])

  // ── A 401 mid-session: renew first, ask for a password second ───────────────
  //
  // All three API clients announce a 401 through this event. What the listener
  // used to do was set `apiError` and stop — which is the visible half of the
  // owner's complaint: the CRM said "your API session has ended, sign in again"
  // and nothing whatsoever tried to get it back.
  //
  // Now the announcement starts a recovery, and there are three separate bounds
  // on it. Between them there is no path that renews more than three times in
  // ten minutes, and none at all once the server has said no:
  //
  //   · `recovering` — one recovery at a time, so a seller detail page firing
  //     four calls that all 401 produces one, not four.
  //   · `MAX_RENEWALS_PER_WINDOW` — the hard stop, in `renewNow`.
  //   · `giveUp` — once renewal has been *refused*, nothing tries again. Only
  //     a fresh sign-in clears it.
  //
  // Note what is still deliberately absent: this does not sign the Firebase
  // user out and does not redirect. `requireSignIn` does both, and it only runs
  // when the API has actually declined.
  useEffect(() => {
    function onUnauthorized(event: Event) {
      const { detail } = event as ApiUnauthorizedEvent
      console.warn('API session rejected:', detail?.path, detail?.message)
      recoverFromUnauthorized()
    }
    window.addEventListener(API_UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(API_UNAUTHORIZED_EVENT, onUnauthorized)
  }, [recoverFromUnauthorized])

  // ── Renewing before it is needed ────────────────────────────────────────────
  //
  // The 401 path above is the safety net. This is the thing that means nobody
  // ever reaches it: a session past its `renew_at` is replaced the next time
  // the tab is looked at. A person who opens the CRM every day never sees an
  // expired session at all, which is the whole of "shouldn't show crm user it
  // expired if they are regularly visiting".
  //
  // `visibilitychange` is the important one — a laptop closed on Friday and
  // opened on Monday fires it, and the renewal is done before the first screen
  // has finished asking for data.
  useEffect(() => {
    const renewIfDue = () => {
      if (giveUp.current) return
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      if (sessionNeedsRenewal()) void renewNow()
    }

    const timer = window.setInterval(renewIfDue, RENEWAL_POLL_MS)
    window.addEventListener('focus', renewIfDue)
    document.addEventListener('visibilitychange', renewIfDue)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', renewIfDue)
      document.removeEventListener('visibilitychange', renewIfDue)
    }
  }, [renewNow])

  // ── Two identities that must be the same person ─────────────────────────────
  //
  // The API token now lives in localStorage, which every tab shares and which
  // outlives the tab that wrote it. That is the point — it is what makes a new
  // tab and a browser restart free — but it means the token in storage is no
  // longer guaranteed to have been minted for the Firebase user this page has.
  // `crmSignIn` signs a failed applicant out of Firebase without touching the
  // API token, so the two can be left pointing at different people.
  //
  // Checked here rather than in the auth-change handler because the two answers
  // do not arrive together and either can be first. Once both are known, they
  // must name the same uid or the stored session is not ours: exchange, which
  // mints one for the Firebase user we actually have.
  //
  // The observer is why this returns early on a missing `firebaseUser` rather
  // than treating it as a mismatch — they hold an API identity and no Firebase
  // session at all, on purpose.
  useEffect(() => {
    if (!firebaseUser || !apiUser) return
    if (apiUser.uid === firebaseUser.uid) return
    console.warn('The stored API session belongs to another account; re-exchanging.')
    giveUp.current = false
    api.auth
      .signInWithFirebase()
      .then(accept)
      .catch((err) => {
        setApiReady(false)
        setApiError(err?.message ?? 'Could not establish an API session.')
      })
  }, [firebaseUser, apiUser, accept])

  // Holds the unsubscribe fn for the current user-doc listener
  const userDocUnsubRef = useRef<(() => void) | null>(null)

  // NOTE: there is no superadmin bootstrap on this path any more, deliberately.
  // Accounts with authority are created by backend/scripts/seed_accounts.py
  // through the Admin SDK. Nothing in the browser can mint a role.

  useEffect(() => {
    const unsubAuth = onCrmAuthChange((user) => {
      // Tear down any previous user-doc listener
      if (userDocUnsubRef.current) {
        userDocUnsubRef.current()
        userDocUnsubRef.current = null
      }

      setFirebaseUser(user)
      firebaseUserRef.current = user

      // ── Exchanging a Firebase session for an API session ─────────────────
      //
      // Everything that touches money or the audit log goes through the API,
      // and the API does not accept a Firebase token on every call — it issues
      // its own session. Without this, those screens all 401.
      //
      // **The condition is the fix.** This used to run unconditionally, and it
      // raced the effect above that resolves the session already in storage.
      // Both fired on every load; neither knew about the other. With a token
      // that had aged past the old twelve-hour limit the two produced exactly
      // the reported symptom:
      //
      //   1. the stored-session effect sends the stale token to `/auth/me`;
      //   2. this exchange succeeds and writes a **new, valid** token;
      //   3. the 401 from step 1 lands *afterwards*, and the old
      //      `reportUnauthorized` answered it by clearing the token — deleting
      //      the good one that had just arrived — and announcing a dead
      //      session. Nothing retried. Every later call threw "Not signed in"
      //      and the screen said to sign in again.
      //
      // Two changes close it and either would have been enough; both are here
      // because they are correct for different reasons. `reportUnauthorized`
      // no longer destroys a token it did not issue, and the exchange no longer
      // runs when a session already exists — that session is the stored-session
      // effect's business, and it will renew it if it is due.
      //
      // A stored token that belongs to somebody *else* is handled separately,
      // by the reconciliation effect below — it needs both identities resolved
      // and they do not arrive together.
      if (user) {
        if (!getSessionToken()) {
          // A sign-in is the one thing that earns back a refused renewal.
          giveUp.current = false
          setMustSignInAgain(false)
          api.auth
            .signInWithFirebase()
            .then(accept)
            .catch((err) => {
              setApiReady(false)
              setApiError(
                err?.message ??
                  'Could not reach the business API. Money and audit screens will not load.',
              )
              console.error('API session exchange failed:', err)
            })
        }
      } else if (!getSessionToken()) {
        // No Firebase user and no API session — genuinely signed out.
        //
        // `giveUp` and the message are NOT cleared here. This branch also runs
        // for the sign-out `requireSignIn` performs itself, and clearing them
        // there would erase the reason a moment after setting it. They are
        // cleared where they should be: when somebody signs in again.
        setApiUser(null)
        setApiReady(false)
        if (!giveUp.current) setApiError('')
      }

      if (user) {
        // Real-time listener on crmUsers/{uid}
        // When isActive becomes false, auto sign-out immediately
        const userRef = doc(db, 'crmUsers', user.uid)
        const unsubUser = onSnapshot(
          userRef,
          (snap) => {
            if (!snap.exists()) {
              // A real answer: this Firebase account has no staff record, so it
              // has no CRM access. /login says exactly that.
              setCrmUser(null)
              setCrmProfileUnread(false)
              firebaseSettled.current = true
              settleIfBothAnswered()
              return
            }
            const raw  = snap.data() as Omit<CrmUser, 'uid'> & { role: string }
            const data = { ...raw, role: normalizeCrmRole(raw.role) } as Omit<CrmUser, 'uid'>
            // Deactivated — force sign-out without waiting for next login.
            // GOV C4: likewise a login whose app account is suspended or
            // banned; /login then gives the API's reason (`resolveCrmUser`).
            if (data.isActive === false || data.accountRestricted === true) {
              crmSignOut().catch(console.error)
              return
            }
            setCrmUser({ uid: snap.id, ...data } as CrmUser)
            setCrmProfileUnread(false)
            firebaseSettled.current = true
            setLoading(false)
          },
          (err) => {
            // The read FAILED. That is not the same fact as "this user has no
            // staff record", and treating the two alike is the second way a
            // signed-in owner got thrown to /login: one refused or dropped
            // listener — a rules evaluation racing token propagation, a moment
            // offline, a tab waking from sleep — left `crmUser` null, cleared
            // `loading`, and `resolveRedirect` read that as signed out.
            //
            // Record it as unknown instead. `resolveRedirect` holds position on
            // unknown, and the screens already render their own "could not be
            // read" state, which is the honest thing to show.
            console.error('crmUsers listener error:', err)
            setCrmProfileUnread(true)
            firebaseSettled.current = true
            settleIfBothAnswered()
          }
        )
        userDocUnsubRef.current = unsubUser
      } else {
        setCrmUser(null)
        // Firebase reporting "nobody" is an answer, not a verdict — the
        // observer never has a Firebase session at all. Record that this source
        // has spoken and let the API side decide with it.
        setCrmProfileUnread(false)
        firebaseSettled.current = true
        settleIfBothAnswered()
      }
    })

    return () => {
      unsubAuth()
      if (userDocUnsubRef.current) {
        userDocUnsubRef.current()
        userDocUnsubRef.current = null
      }
    }
    // `settleIfBothAnswered` and `accept` are useCallbacks with no dependencies,
    // so they are stable and this effect still runs exactly once. Listed so a
    // future edit that gives one a dependency cannot leave a stale closure
    // behind — this effect owns the Firebase subscription, and re-running it is
    // cheap while running it against a stale `accept` would not be.
  }, [accept, settleIfBothAnswered])

  const value: AuthContextValue = {
    firebaseUser,
    crmUser,
    loading,
    hasPermission: (perm) => hasPermission(crmUser, perm),
    canAccess: (roles) => canAccess(crmUser, roles),
    isSuperAdmin: crmUser?.role === 'superadmin',
    apiReady,
    apiError,
    apiUser,
    refreshApiUser,
    mustSignInAgain,
    crmProfileUnread,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
