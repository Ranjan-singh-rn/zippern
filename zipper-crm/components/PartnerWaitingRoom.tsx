'use client'

/**
 * The partner waiting room — /agency-pending and /seller-pending.
 *
 * Two states, each with its own words (QA #25, `lib/waitingRoom.ts`):
 *   * under review — the application has not been decided yet;
 *   * approved, verify to start (Decision 15) — the Owner approved the role and
 *     it starts once BOTH contacts on this login are verified. The verification
 *     steps are on this page, and the dashboard opens here when they are done.
 */

import { useEffect, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useAuth } from '@/components/AuthProvider'
import { crmSignOut } from '@/lib/auth'
import { partnerRoleStatus } from '@/lib/partnerRouting'
import { SUPPORT_EMAIL, mailtoHref } from '@/lib/contacts'
import { waitingRoomCopy, waitingRoomExit, type WaitingRoomIcon, type WaitingRoomKind } from '@/lib/waitingRoom'
import ContactVerificationPanel from '@/components/ContactVerificationPanel'
import { CheckCircle2, Clock, LogOut, Mail, Phone } from 'lucide-react'

const BUSINESS_DAYS = '1-2 business days'

/** The intro, with the review time in bold where it appears (as before). */
function Intro({ text }: { text: string }) {
  const at = text.indexOf(BUSINESS_DAYS)
  if (at < 0) return <>{text}</>
  return (
    <>
      {text.slice(0, at)}
      <strong className="text-white">{BUSINESS_DAYS}</strong>
      {text.slice(at + BUSINESS_DAYS.length)}
    </>
  )
}

export function PartnerWaitingRoom({ kind, dashboardIcon }: { kind: WaitingRoomKind; dashboardIcon: ReactNode }) {
  const { crmUser } = useAuth()
  const router = useRouter()
  const status = partnerRoleStatus(crmUser, kind)
  const waiting = status === 'awaiting_verification'
  const copy = waitingRoomCopy(kind, waiting, crmUser?.email)
  // A started role is passed on to its dashboard (E2E re-run, 3 Nov 2026) —
  // never shown the under-review words meant for an undecided application.
  const exit = waitingRoomExit(kind, status)
  useEffect(() => {
    if (exit) router.replace(exit)
  }, [exit, router])

  if (exit) {
    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
        <p className="text-slate-300 text-sm">
          Your role has started. Opening your dashboard…{' '}
          <a href={exit} className="text-pink-400 hover:text-pink-300">Open it now</a>
        </p>
      </div>
    )
  }

  const icon = (name: WaitingRoomIcon): ReactNode => ({
    check: <CheckCircle2 size={15} className="text-green-400 mt-0.5 shrink-0" />,
    mail: <Mail size={15} className="text-blue-400 mt-0.5 shrink-0" />,
    phone: <Phone size={15} className="text-blue-400 mt-0.5 shrink-0" />,
    dashboard: dashboardIcon,
  }[name])

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">

        <div className="text-center mb-8">
          <span className="text-3xl font-black text-pink-500 tracking-tight">Zipper</span>
          <span className="text-3xl font-black text-white tracking-tight"> CRM</span>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">

          <div className={`bg-gradient-to-r ${waiting ? 'from-green-500/15 to-emerald-500/15 border-green-500/20' : 'from-yellow-500/20 to-orange-500/20 border-yellow-500/20'} border-b p-6 text-center`}>
            <div className={`w-14 h-14 rounded-full ${waiting ? 'bg-green-500/20 border-green-500/30' : 'bg-yellow-500/20 border-yellow-500/30'} border flex items-center justify-center mx-auto mb-3`}>
              {waiting
                ? <CheckCircle2 size={28} className="text-green-400" />
                : <Clock size={28} className="text-yellow-400" />}
            </div>
            <h1 className="text-white text-xl font-bold">{copy.title}</h1>
            <p className={`${waiting ? 'text-green-300/80' : 'text-yellow-300/70'} text-sm mt-1`}>{copy.subtitle}</p>
          </div>

          <div className="p-6 space-y-5">
            <p className="text-slate-300 text-sm leading-relaxed text-center">
              <Intro text={copy.intro} />
            </p>

            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">What happens next</p>
              {copy.steps.map((step) => (
                <div key={step.text} className="flex items-start gap-3">
                  {icon(step.icon)}
                  <p className="text-slate-300 text-sm leading-relaxed">{step.text}</p>
                </div>
              ))}
            </div>

            {waiting && <ContactVerificationPanel />}

            {crmUser && (
              <div className="flex items-center gap-3 p-3 bg-slate-800 border border-slate-700 rounded-lg">
                <div className="w-9 h-9 rounded-full bg-pink-500/20 border border-pink-500/30 flex items-center justify-center shrink-0">
                  <span className="text-pink-300 text-sm font-bold">{crmUser.name?.[0]?.toUpperCase() ?? '?'}</span>
                </div>
                <div className="min-w-0">
                  <p className="text-white text-sm font-medium truncate">{crmUser.name}</p>
                  <p className="text-slate-400 text-xs truncate">{crmUser.email}</p>
                </div>
              </div>
            )}

            <button
              onClick={() => crmSignOut()}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors"
            >
              <LogOut size={15} />
              Sign Out
            </button>

            <p className="text-center text-slate-500 text-xs">
              Need help?{' '}
              <a href={mailtoHref(SUPPORT_EMAIL)} className="text-pink-400 hover:text-pink-300 transition-colors">
                {SUPPORT_EMAIL}
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
