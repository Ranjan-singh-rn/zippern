'use client'

/**
 * The switch between an agency view and a coin-seller view, on one login.
 *
 * Rendered ONLY for a partner that holds both capabilities. A partner with one
 * capability sees nothing from this file — not a disabled control, not a hint,
 * nothing — because a switch with one position is not a switch, it is clutter
 * on the screen of someone it does not apply to.
 *
 * It navigates. It does not change any state, store any preference or call any
 * API: the two dashboards read two different partner records, and which one is
 * on screen is simply which URL you are on. That also means it cannot get out
 * of step with where you actually are.
 *
 * A capability that is still under review gets a row too, marked, linking to its
 * waiting room — the alternative is a person who applied for something being
 * shown no evidence that they did.
 */

import Link from 'next/link'
import { Building2, ShoppingBag, Clock, UserCircle } from 'lucide-react'
import {
  PARTNER_HOME,
  PARTNER_PENDING,
  PARTNER_ROLE_LABEL,
  isDualRolePartner,
  partnerRoleStatus,
  partnerRolesOf,
  type CrmUser,
  type PartnerRole,
} from '@/lib/auth'

const ICON: Record<PartnerRole, React.ElementType> = {
  agency: Building2,
  seller: ShoppingBag,
}

const BLURB: Record<PartnerRole, string> = {
  agency: 'Hosts, salary and commission',
  seller: 'Coin inventory and recharges',
}

export function PartnerRoleSwitcher({
  crmUser,
  pathname,
}: {
  crmUser: CrmUser | null
  pathname: string
}) {
  const roles = partnerRolesOf(crmUser)

  // Nothing at all for staff — they have the full sidebar.
  if (roles.length === 0) return null

  const dual = isDualRolePartner(crmUser)
  const profileActive = pathname === '/profile' || pathname.startsWith('/profile/')

  return (
    <div className="pb-2 mb-2 border-b border-slate-800">
      {/*
        `My Profile` is here, and it is here because a partner could not reach
        it any other way.
        The page itself has supported agencies and coin sellers since it was
        built, and `PARTNER_SHARED_PATHS` lets them onto it — but the only nav
        entry for it sits in the staff `admin` group behind `STAFF_ROLES`, and
        no partner is in that list. A partner's sidebar renders this component
        and nothing else. So the one screen where they can correct their own
        phone number or their business name existed, was reachable by URL, and
        was linked from nowhere.

        Rendered for a partner holding ONE capability too. The switcher above it
        is hidden in that case — a switch with one position is clutter — but the
        profile link is not a switch and applies to every partner.
      */}
      <Link
        href="/profile"
        aria-current={profileActive ? 'page' : undefined}
        className={`flex items-center gap-3 px-3 py-2 mb-2 rounded-lg text-sm font-medium transition-colors ${
          profileActive
            ? 'bg-pink-500 text-white'
            : 'text-slate-400 hover:bg-slate-800 hover:text-white'
        }`}
      >
        <UserCircle size={17} className="flex-shrink-0" />
        <span className="flex-1 min-w-0">
          <span className="block truncate">My Profile</span>
          <span
            className={`block text-[11px] truncate ${
              profileActive ? 'text-pink-100' : 'text-slate-600'
            }`}
          >
            Your details and business name
          </span>
        </span>
      </Link>

      {!dual ? null : (
        <>
      <p className="px-3 pb-1.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">
        Your businesses
      </p>
      <div className="space-y-0.5">
        {roles.map((role) => {
          const status = partnerRoleStatus(crmUser, role)
          const approved = status === 'approved'
          const href = approved ? PARTNER_HOME[role] : PARTNER_PENDING[role]
          const isActive = pathname.startsWith(href)
          const Icon = ICON[role]

          return (
            <Link
              key={role}
              href={href}
              aria-current={isActive ? 'page' : undefined}
              className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                isActive
                  ? 'bg-pink-500 text-white'
                  : 'text-slate-400 hover:bg-slate-800 hover:text-white'
              }`}
            >
              <Icon size={17} className="flex-shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block truncate">{PARTNER_ROLE_LABEL[role]}</span>
                <span
                  className={`block text-[11px] truncate ${
                    isActive ? 'text-pink-100' : 'text-slate-600'
                  }`}
                >
                  {approved
                    ? BLURB[role]
                    : status === 'rejected'
                      ? 'Application not approved'
                      : 'Application under review'}
                </span>
              </span>
              {!approved && (
                <Clock size={13} className="text-yellow-400 flex-shrink-0" />
              )}
            </Link>
          )
        })}
      </div>
        </>
      )}
    </div>
  )
}

export default PartnerRoleSwitcher
