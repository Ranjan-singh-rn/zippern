'use client'

import './globals.css'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { AuthProvider, useAuth } from '@/components/AuthProvider'
import { PartnerRoleSwitcher } from '@/components/PartnerRoleSwitcher'
import {
  crmSignOut, ROLE_LABELS, ROLE_COLORS, CrmRole, CrmUser,
  approvedPartnerRoles, isDualRolePartner, resolvePartnerRedirect,
} from '@/lib/auth'
import { countPendingApprovals } from '@/lib/approvals'
import api, { getSessionToken, type ApiUser } from '@/lib/api'
import { sessionGate } from '@/lib/sessionGate'
import {
  Home,
  Users,
  Star,
  DollarSign,
  Building2,
  Radio,
  ShoppingBag,
  MessageSquare,
  Megaphone,
  BarChart3,
  Shield,
  FileCheck,
  LogOut,
  BookOpen,
  UserCog, UserCircle,
  HelpCircle,
  ChevronRight,
  ChevronDown,
  AlertTriangle,
  ShieldOff,
  Gauge,
  Bug,
  Layers,
  CreditCard,
  TrendingUp,
  Receipt,
  ReceiptText,
  PiggyBank,
  Package,
  Wallet,
  Gift,
  Settings,
  Gem,
  AppWindow,
  KanbanSquare,
  Sparkles,
  Inbox,
  Landmark,
  History,
  Eye,
  Scale,
  HandCoins,
  Coins,
  ShieldAlert,
  Activity,
  FileSpreadsheet,
  ShoppingCart,
  UserPlus,
  ScrollText,
  Siren,
  AlarmClock,
  Mail,
  MailWarning,
  Dices,
  Settings2,
  HeartPulse,
  ScanFace,
  RotateCcw,
  ArrowRightLeft,
  Lock,
  MonitorSmartphone,
  ShieldCheck,
} from 'lucide-react'

// Every screen below reads an endpoint behind `_require_oversight` or
// `_require_business_financials`, both of which admit only `can_read_all`
// (owner, observer) or a team admin. A `*_member` listed here would get a page
// of 403s, which reads as the CRM being broken rather than as a boundary.
const OVERSIGHT_ROLES: CrmRole[] = [
  'superadmin',
  'finance_admin', 'app_admin', 'ops_admin',
  'tech_admin', 'support_admin', 'marketing_admin',
]

// ── Nav link definitions ─────────────────────────────────────────────────────

const STAFF_ROLES: CrmRole[] = [
  'superadmin',
  'app_admin', 'app_member',
  'ops_admin', 'ops_member',
  'finance_admin', 'finance_member',
  'tech_admin', 'tech_member',
  'support_admin', 'support_member',
  'marketing_admin', 'marketing_member',
]

interface NavLink { href: string; label: string; icon: React.ElementType; roles: CrmRole[]; strict?: boolean }
interface NavGroup { id: string; label: string; icon: React.ElementType; links: NavLink[] }

// Always visible, never collapsed — the things every staff member checks daily.
const topLevelLinks: NavLink[] = [
  { href: '/inbox',         label: 'Waiting on you', icon: Inbox,       roles: STAFF_ROLES },
  { href: '/board',         label: 'Money Board',    icon: Landmark,    roles: STAFF_ROLES },
  { href: '/',              label: 'Dashboard',    icon: Home,          roles: STAFF_ROLES },
  { href: '/analytics',     label: 'Analytics',    icon: BarChart3,     roles: ['superadmin', 'app_admin', 'app_member', 'finance_admin', 'finance_member', 'ops_admin', 'ops_member'] },
  // The self-refusing report cards only help someone the page lets in at all.
  // `app/reports/page.tsx:51` (REPORT_ROLES) admits no `*_member` except
  // finance_member, so app/ops/tech/support/marketing members were being sent
  // to a hard `<Denied what="reporting" />` — a link to a wall, which is the
  // thing this sidebar is not supposed to do.
  //
  // finance_member is dropped too, though the page would let them in: seven of
  // the hub's eight cards go through `_require_business_financials`
  // (backend/app/routers/reports.py:128, `can_read_all` or a team admin) and
  // the eighth, team throughput, has its own top-level link below. A page of
  // seven refusals is not "reporting", it is the boundary rendered eight times.
  //
  // Team admins keep it, and for them the original intent holds exactly: they
  // see every card they are entitled to and a clear "not yours" on the rest.
  { href: '/reports',       label: 'Reports',      icon: FileSpreadsheet, roles: OVERSIGHT_ROLES },
  { href: '/reports/weekly', label: 'Weekly Report', icon: ScrollText,    roles: OVERSIGHT_ROLES },
  { href: '/alerts',        label: 'Alerts',       icon: Siren,           roles: OVERSIGHT_ROLES },
  // '/tickets' (App Tickets) is retired — audit C-5: it read `supportTickets`,
  // which nothing in the app writes, so the queue was always empty. The route
  // redirects to /feedback (the `feedbackTickets` the app actually files).
  { href: '/tech/tickets',  label: 'Team Tickets',  icon: KanbanSquare, roles: STAFF_ROLES },
  { href: '/throughput',    label: 'Team Throughput', icon: Activity,   roles: STAFF_ROLES },
]

// Everything else, grouped by department — collapsible so the sidebar doesn't
// overwhelm superadmins who can see every section at once.
const navGroups: NavGroup[] = [
  {
    id: 'users', label: 'Users & Hosts', icon: Users,
    links: [
      { href: '/users', label: 'Users', icon: Users, roles: ['superadmin', 'app_admin', 'app_member', 'ops_admin', 'finance_admin', 'support_admin', 'support_member', 'tech_admin'] },
      { href: '/hosts', label: 'Hosts', icon: Star,  roles: ['superadmin', 'app_admin', 'app_member', 'ops_admin', 'ops_member'] },
      // Directly under Hosts because it is the gate in front of them: until a
      // host is verified `releaseBeansForWeek` releases nothing and
      // functions/src/calls.ts prices them at the base rate, so a queue nobody
      // works is a queue of hosts who cannot be paid and cannot earn their own
      // rate. The API has had the endpoints all along and no screen called them.
      { href: '/hosts/verification', label: 'Host Verification', icon: ScanFace, roles: ['superadmin', 'app_admin', 'app_member', 'ops_admin', 'ops_member'] },
    ],
  },
  {
    id: 'sellers', label: 'Sellers & Agencies', icon: ShoppingBag,
    links: [
      // First, because it is the "how does anyone get in here" entry. The four
      // registration routes existed and were effectively invisible — the two
      // PUBLIC ones, which are the links you send to a prospective agency, were
      // reachable from nowhere at all.
      { href: '/onboarding',     label: 'How partners join', icon: UserPlus,  roles: STAFF_ROLES },
      { href: '/partners',       label: 'Statements',      icon: Building2,   roles: STAFF_ROLES },
      { href: '/sellers',        label: 'Coin Sellers',    icon: ShoppingBag, roles: ['superadmin', 'app_admin', 'ops_admin', 'ops_member'] },
      { href: '/coin-purchases', label: 'Coin Purchases',  icon: Package,     roles: ['superadmin', 'finance_admin', 'finance_member'] },
      // Filing and approving a sale is the only thing that brings a seller's
      // inventory down. The endpoints existed for a while with no screen, so in
      // the running CRM inventory never decremented at all.
      { href: '/sales',          label: 'Seller Sales',    icon: ShoppingCart, roles: ['superadmin', 'ops_admin', 'ops_member', 'finance_admin', 'finance_member'] },
      // Buyer-filed recharges through a Coin Seller: staff verify the payment
      // here; the API credits through the ledger, once. There is no gateway.
      { href: '/recharges',      label: 'Recharges',       icon: Coins,        roles: ['superadmin', 'ops_admin', 'ops_member', 'finance_admin', 'finance_member'] },
      /*
       * `ops_admin` is here because they are the only non-owner role that holds
       * `can_approve_kyc` and `can_approve_seller` — and they had no link to
       * either screen. The one role the approval queues exist for could not
       * reach them except by typing the URL, while four roles that cannot
       * approve anything were being shown live Approve buttons on pages they
       * could open. Both halves of that are now the other way round.
       *
       * This grants nothing. The permission was already theirs; only the door
       * was missing, and the page and the API both check it independently.
       */
      { href: '/agencies',       label: 'Agencies',        icon: Building2,   roles: ['superadmin', 'app_admin', 'ops_admin'] },
      { href: '/kyc',            label: 'KYC',             icon: FileCheck,   roles: ['superadmin', 'app_admin', 'ops_admin'] },
      // GOV C2 / C3: the two queues where reviewers RECOMMEND and the Owner
      // DECIDES — a revoked role asked back, and a Host or Sub-agency moved to
      // another agency. Beside KYC because the same people work them: the
      // server admits `can_approve_kyc` / `can_approve_seller` holders and the
      // Owner, which in the role table is ops_admin and the Owner alone.
      { href: '/role-appeals',   label: 'Reinstatement requests', icon: RotateCcw,      roles: ['superadmin', 'ops_admin'] },
      { href: '/transfers',      label: 'Transfer requests',      icon: ArrowRightLeft, roles: ['superadmin', 'ops_admin'] },
      // RC (confirmed, CRM-FLOW 9.48): money behind a suspension, ban or
      // revocation waits here for the Owner. Owner only, like the API.
      { href: '/frozen-money',   label: 'Frozen money',           icon: Lock,           roles: ['superadmin'] },
    ],
  },
  {
    id: 'finance', label: 'Finance', icon: DollarSign,
    links: [
      // Business-wide money is admin-and-above, deliberately. The API's
      // `_require_business_financials` admits only `can_read_all` (owner,
      // observer) or a team admin — its own docstring says "a member sees their
      // own work and their team's queues, not the company's cash position".
      // Listing finance_member here put them on screens where every figure came
      // back 403, which reads as the CRM being broken rather than as a boundary.
      { href: '/finance',             label: 'Overview',      icon: DollarSign, roles: ['superadmin', 'finance_admin'] },
      { href: '/finance/cash',        label: 'Cash Position', icon: Landmark,   roles: ['superadmin', 'finance_admin'] },
      { href: '/finance/liabilities', label: 'Liabilities',   icon: Scale,      roles: ['superadmin', 'finance_admin'] },
      { href: '/finance/payouts',     label: 'Payouts',       icon: Receipt,    roles: ['superadmin', 'finance_admin'] },
      { href: '/finance/withdrawals', label: 'Withdrawals',   icon: Wallet,     roles: ['superadmin', 'finance_admin'] },
      { href: '/finance/profit',      label: 'Profit',        icon: TrendingUp, roles: ['superadmin', 'finance_admin'] },
      // Costs sits directly under Profit on purpose. Until every running cost
      // is entered here, the figure above it is an upper bound and says so —
      // and for the whole life of the CRM until now there was no screen to
      // enter one at all, so it always said so.
      { href: '/finance/costs',       label: 'Costs',         icon: ReceiptText, roles: ['superadmin', 'finance_admin'] },
      // The owners' own money in and out. Cash, never trading — see
      // `backend/app/services/capital.py` for why it is kept apart from both.
      { href: '/finance/capital',     label: 'Owner Capital', icon: PiggyBank,  roles: ['superadmin', 'finance_admin'] },
      // Credit Book is per-partner operational work, not a business-wide
      // financial report, so a finance member keeps it.
      { href: '/lending',             label: 'Credit Book',   icon: HandCoins,  roles: ['superadmin', 'finance_admin', 'finance_member', 'ops_admin'] },
      { href: '/finance/reports',     label: 'Weekly Reports', icon: BarChart3, roles: ['superadmin', 'finance_admin'] },
      // B1: held items of a revoked partner, replica drift and (Owner) the
      // money notices not yet delivered. `can_process_payout` on the server —
      // the Owner, Finance admin and Finance member; the page offers each
      // section by the server's own gate (lib/moneyIntegrity).
      { href: '/finance/integrity',   label: 'Money integrity', icon: ShieldCheck, roles: ['superadmin', 'finance_admin', 'finance_member'] },
    ],
  },
  {
    id: 'tech', label: 'Tech', icon: Bug,
    links: [
      { href: '/tech',          label: 'Overview', icon: Bug,        roles: ['superadmin', 'tech_admin', 'tech_member'] },
      { href: '/tech/content',  label: 'Content',  icon: Layers,     roles: ['superadmin', 'tech_admin', 'tech_member'] },
      { href: '/tech/payments', label: 'Payments', icon: CreditCard, roles: ['superadmin', 'tech_admin', 'tech_member'] },
      // These two sit in the Tech group but belong to every team admin, unlike
      // the links above. A job that has never run and a payout receipt that
      // bounced are everyone's problem, not the tech team's.
      { href: '/tech/jobs',     label: 'Scheduled Jobs', icon: AlarmClock,  roles: OVERSIGHT_ROLES },
      { href: '/tech/email',    label: 'Email Delivery', icon: MailWarning, roles: OVERSIGHT_ROLES },
    ],
  },
  {
    id: 'economy', label: 'Economy', icon: Gift,
    links: [
      { href: '/gifts',            label: 'Gift Economy',  icon: Gift,     roles: ['superadmin', 'app_admin', 'ops_admin'] },
      { href: '/economy',          label: 'Overview',      icon: BookOpen, roles: ['superadmin', 'finance_admin', 'finance_member', 'ops_admin'] },
      { href: '/economy/config',   label: 'Config',        icon: Settings, roles: ['superadmin', 'finance_admin'] },
      { href: '/economy/currency', label: 'Beans/Diamonds', icon: Gem,     roles: ['superadmin', 'finance_admin', 'finance_member'] },
    ],
  },
  {
    // Lucky gifts and games. Every screen here reads a `require_internal`
    // endpoint, so the read roles are the whole internal set — but the actions
    // inside them are narrower and the pages gate themselves: a team admin
    // raises a configuration card, only an owner signs it or resumes a
    // suspended mechanic, only Ops or an owner freezes a player, and only
    // Finance and owners see the margin (8B.5.6).
    id: 'chance', label: 'Chance', icon: Dices,
    links: [
      { href: '/chance',            label: 'Mechanics',         icon: Dices,      roles: STAFF_ROLES },
      { href: '/chance/configure',  label: 'Configuration',     icon: Settings2,  roles: STAFF_ROLES },
      { href: '/chance/exposure',   label: 'Exposure & Safety', icon: Wallet,     roles: STAFF_ROLES },
      { href: '/chance/monitoring', label: 'Monitoring',        icon: Activity,   roles: STAFF_ROLES },
      { href: '/chance/protection', label: 'Player Protection', icon: HeartPulse, roles: STAFF_ROLES },
      // Narrower on purpose — the reports behind it are business-wide money.
      { href: '/chance/money',      label: 'The Money',         icon: Gauge,      roles: ['superadmin', 'finance_admin'] },
    ],
  },
  {
    id: 'live', label: 'Live & Comms', icon: Radio,
    links: [
      { href: '/live',       label: 'Live Monitor', icon: Radio,      roles: ['superadmin', 'app_admin', 'app_member', 'ops_admin', 'ops_member', 'tech_admin', 'tech_member', 'support_admin'] },
      // `app_member` is NOT here, though the page's own PAGE_ROLES still lists
      // them. Feedback is Firestore `feedbackTickets`, read-gated on
      // `isOps() || isAdmin() || isSupport()` (firestore.rules:920). `isApp()`
      // is not on that clause, so an app_member gets permission-denied on the
      // list and an empty screen with no reason. app_admin passes via
      // `isAdmin()`, which matches every `*_admin` (firestore.rules:77).
      { href: '/feedback',   label: 'Feedback',     icon: HelpCircle, roles: ['superadmin', 'app_admin', 'support_admin', 'support_member', 'tech_admin', 'ops_admin'] },
    ],
  },
  {
    id: 'marketing', label: 'Marketing', icon: Sparkles,
    links: [
      { href: '/broadcasts', label: 'Broadcasts', icon: Megaphone, roles: ['superadmin', 'marketing_admin', 'marketing_member'] },
      // The email composer (8A.7.2). A wider list than the in-app broadcast
      // above, because what it can reach is graded by audience inside the API
      // rather than by who can open the page: a support or ops admin may write
      // to one named customer (customer care), a marketing admin to every
      // agency or seller, and only an owner to every app user. The page reads
      // that table from `GET /api/broadcasts/audiences` and greys out what the
      // person cannot do, with the API's own reason on each — so this list only
      // has to decide who sees the link at all.
      { href: '/broadcasts/email', label: 'Email Composer', icon: Mail, roles: ['superadmin', 'marketing_admin', 'marketing_member', 'support_admin', 'ops_admin', 'app_admin', 'finance_admin', 'tech_admin'] },
    ],
  },
  {
    id: 'operations', label: 'Operations', icon: Gauge,
    links: [
      { href: '/operations',          label: 'Overview',     icon: Gauge,         roles: ['superadmin', 'ops_admin', 'ops_member'] },
      { href: '/moderation',          label: 'Moderation',   icon: ShieldAlert,   roles: ['superadmin', 'ops_admin', 'ops_member', 'app_admin', 'support_admin'] },
      { href: '/operations/reports',  label: 'Reports',      icon: AlertTriangle, roles: ['superadmin', 'ops_admin', 'ops_member'] },
      { href: '/operations/bans',     label: 'Device Bans',  icon: ShieldOff,     roles: ['superadmin', 'ops_admin', 'ops_member'] },
      { href: '/operations/feedback', label: 'App Feedback', icon: MessageSquare, roles: ['superadmin', 'ops_admin', 'ops_member', 'support_admin', 'support_member'] },
    ],
  },
  {
    id: 'appconfig', label: 'App Config', icon: AppWindow,
    links: [
      { href: '/app-config',                 label: 'Overview',       icon: AppWindow,   roles: ['superadmin'] },
      { href: '/app-config/bag-items',       label: 'Bag Items',      icon: Package,     roles: ['superadmin'] },
      { href: '/app-config/packages',        label: 'Packages',       icon: ShoppingBag, roles: ['superadmin'] },
      { href: '/app-config/daily-rewards',   label: 'Daily Rewards',  icon: Gift,        roles: ['superadmin'] },
      { href: '/app-config/profile-options', label: 'Profile Options', icon: UserCog,    roles: ['superadmin'] },
      { href: '/app-config/levels',          label: 'Levels',         icon: BarChart3,   roles: ['superadmin'] },
      { href: '/app-config/payment-creds',   label: 'Payment Creds',  icon: CreditCard,  roles: ['superadmin'] },
      // Owner and Tech: what firestore.rules allows on appConfig/* (not paymentCredentials).
      { href: '/app-config/lucky-gifts',     label: 'Lucky Gifts',    icon: Sparkles,    roles: ['superadmin', 'tech_admin', 'tech_member'] },
    ],
  },
  {
    id: 'admin', label: 'Admin', icon: Shield,
    links: [
      { href: '/approvals', label: 'Approvals', icon: Shield,   roles: ['superadmin'] },
      // Everybody has one, including partners — it is their own record, and
      // keeping your own phone number current should not need a request.
      { href: '/profile',     label: 'My Profile',  icon: UserCircle, roles: STAFF_ROLES },
      // B3 / §13: this login's live sessions and "Sign out everywhere else".
      // Self-scoped on the server, so every staff role has it; partners reach
      // it from their switcher and the Observer from their own sidebar.
      { href: '/sessions', label: 'Signed-in devices', icon: MonitorSmartphone, roles: STAFF_ROLES },
      { href: '/audit',       label: 'Audit Log',   icon: History, roles: STAFF_ROLES },
      { href: '/team-access', label: 'Team Access', icon: UserCog, roles: STAFF_ROLES },
      { href: '/policies',  label: 'Policies',  icon: BookOpen, roles: ['superadmin', 'app_admin'] },
      // /team used to be superadmin-only, because it did all of its work
      // through Firestore `createCrmUser` / `updateCrmUser` and `crmUsers`
      // create and update are `isSuperAdmin()` (firestore.rules:279 and :290) —
      // a department admin could open it and have every button refused by the
      // database.
      //
      // It now goes through the API, exactly as /team-access does: `GET /staff`
      // is `current_user`, `POST /staff` is `require_team_admin`, and the list
      // of roles the invite form offers is computed server-side, so a team
      // admin is offered their own team and nothing else. Every staff role can
      // therefore use it, and no button on it can be refused by Firestore
      // because it no longer writes there.
      //
      // Both entries are kept deliberately: the two screens now do the same
      // job, and which one survives is the owner's call, not a nav edit.
      { href: '/team',      label: 'Team',      icon: UserCog,  roles: STAFF_ROLES },
    ],
  },
]

// strict: only show to a partner who actually holds that capability — the
// superadmin bypass does NOT apply here.
//
// The match used to be `roles.includes(crmUser.role)`, i.e. exact equality with
// the single role string. It is now "does this login hold this capability, and
// has it been approved", which is the same answer for every account that holds
// one. A partner holding BOTH sees neither of these: they get
// `PartnerRoleSwitcher` instead, which shows both businesses together with
// which one is on screen, and a dual-role partner offered two ordinary nav
// links would have no way to tell.
const strictLinks: NavLink[] = [
  { href: '/agency-dashboard', label: 'My Agency', icon: Building2,   roles: ['agency'], strict: true },
  { href: '/seller-dashboard', label: 'My Sales',  icon: ShoppingBag, roles: ['seller'], strict: true },
]

// ── Sidebar ──────────────────────────────────────────────────────────────────

const NAV_STORAGE_KEY = 'zipperCrmOpenNavGroups'

function NavItem({
  href, label, icon: Icon, isActive, pendingCount, indent,
}: {
  href: string; label: string; icon: React.ElementType; isActive: boolean; pendingCount?: number; indent?: boolean
}) {
  return (
    <Link
      href={href}
      className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
        indent ? 'pl-9' : ''
      } ${
        isActive
          ? 'bg-pink-500 text-white'
          : 'text-slate-400 hover:bg-slate-800 hover:text-white'
      }`}
    >
      {!indent && <Icon size={17} />}
      <span className="flex-1">{label}</span>
      {!!pendingCount && (
        <span className="text-xs font-bold bg-yellow-500 text-slate-900 rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1">
          {pendingCount > 99 ? '99+' : pendingCount}
        </span>
      )}
    </Link>
  )
}

/** Non-interactive placeholder rows — shown in place of nav links while the
 *  user's role is still unknown. Deliberately not <Link>s: nothing navigable
 *  renders until we know what this user is allowed to see. */
function NavSkeleton() {
  return (
    <div className="space-y-1.5" aria-hidden="true">
      {[...Array(7)].map((_, i) => (
        <div key={i} className="h-9 rounded-lg bg-slate-800/70 animate-pulse" />
      ))}
    </div>
  )
}

function Sidebar() {
  const pathname = usePathname()
  const { crmUser, canAccess, loading } = useAuth()
  const [pendingCount, setPendingCount] = useState(0)
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})
  const [hydrated, setHydrated] = useState(false)

  async function handleSignOut() {
    // Revoke the API session first — it outlives the Firebase one otherwise,
    // and a revocable session is only useful if it actually gets revoked.
    await api.auth.signOut().catch(() => {})
    await crmSignOut()
  }

  useEffect(() => {
    if (crmUser?.role === 'superadmin') {
      countPendingApprovals().then(setPendingCount).catch(() => {})
    }
  }, [crmUser?.role])

  const isLinkActive = (href: string) => href === '/' ? pathname === '/' : pathname.startsWith(href)

  // Restore collapsed/expanded state from last session; default-expand whichever
  // group contains the current page so navigation never opens to a dead end.
  useEffect(() => {
    let saved: Record<string, boolean> = {}
    try {
      saved = JSON.parse(localStorage.getItem(NAV_STORAGE_KEY) ?? '{}')
    } catch { /* ignore */ }
    const activeGroup = navGroups.find((g) => g.links.some((l) => isLinkActive(l.href)))
    setOpenGroups({ ...saved, ...(activeGroup ? { [activeGroup.id]: true } : {}) })
    setHydrated(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function toggleGroup(id: string) {
    setOpenGroups((prev) => {
      const next = { ...prev, [id]: !prev[id] }
      try { localStorage.setItem(NAV_STORAGE_KEY, JSON.stringify(next)) } catch { /* ignore */ }
      return next
    })
  }

  // Fail closed: until the crmUsers doc has arrived we do not know the role, and
  // "unknown role" must mean "nothing privileged", never "everything".
  // canAccess(null, …) already returns false, but we gate explicitly as well so
  // a future change to canAccess can't silently open the sidebar up.
  const roleKnown = !loading && !!crmUser

  // strict links: capability match only — no superadmin bypass. A partner
  // holding both gets the switcher rather than two loose links, so these are
  // suppressed for them; a partner holding one sees exactly the link they saw
  // before, in the same place.
  const heldPartnerRoles = roleKnown ? approvedPartnerRoles(crmUser) : []
  const dualRole = roleKnown && isDualRolePartner(crmUser)
  const visibleTopLevel = roleKnown ? topLevelLinks.filter((link) => canAccess(link.roles)) : []
  const visibleStrict = dualRole
    ? []
    : strictLinks.filter((link) =>
        link.roles.some((r) => heldPartnerRoles.includes(r as 'agency' | 'seller')),
      )
  const visibleGroups = roleKnown
    ? navGroups
        .map((g) => ({ ...g, links: g.links.filter((link) => canAccess(link.roles)) }))
        .filter((g) => g.links.length > 0)
    : []

  const role = crmUser?.role as CrmRole | undefined
  const initial = crmUser?.name ? crmUser.name[0].toUpperCase() : '?'

  return (
    <aside className="w-64 h-screen bg-slate-900 border-r border-slate-800 fixed top-0 left-0 flex flex-col z-40 overflow-hidden">
      {/* Logo */}
      <div className="px-6 py-5 border-b border-slate-800 flex-shrink-0">
        <span className="text-2xl font-black text-pink-500 tracking-tight">Zipper</span>
        <span className="text-2xl font-black text-white tracking-tight"> CRM</span>
      </div>

      {/* Nav */}
      <nav className="flex-1 px-3 py-4 space-y-0.5 overflow-y-auto">
        {/* Role not yet known — placeholder rows only, never real links */}
        {!roleKnown && <NavSkeleton />}

        {/* One login, two businesses. Renders nothing at all for anyone who is
            not a dual-capability partner — including every account today. */}
        {roleKnown && <PartnerRoleSwitcher crmUser={crmUser} pathname={pathname} />}

        {/* Always-visible items */}
        {visibleTopLevel.map((link) => (
          <NavItem
            key={link.href}
            {...link}
            isActive={isLinkActive(link.href)}
            pendingCount={link.href === '/approvals' ? pendingCount : undefined}
          />
        ))}

        {/* Collapsible department groups */}
        {hydrated && visibleGroups.length > 0 && (
          <div className="pt-2 mt-2 border-t border-slate-800 space-y-0.5">
            {visibleGroups.map((group) => {
              const isOpen = !!openGroups[group.id]
              const GroupIcon = group.icon
              return (
                <div key={group.id}>
                  <button
                    onClick={() => toggleGroup(group.id)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                  >
                    <GroupIcon size={17} />
                    <span className="flex-1 text-left">{group.label}</span>
                    {isOpen ? <ChevronDown size={15} className="text-slate-500" /> : <ChevronRight size={15} className="text-slate-500" />}
                  </button>
                  {isOpen && (
                    <div className="space-y-0.5 mt-0.5 mb-1">
                      {group.links.map((link) => (
                        <NavItem
                          key={link.href}
                          {...link}
                          isActive={isLinkActive(link.href)}
                          pendingCount={link.href === '/approvals' ? pendingCount : undefined}
                          indent
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* Strict role-only items (agency / seller) */}
        {visibleStrict.map((link) => (
          <NavItem key={link.href} {...link} isActive={isLinkActive(link.href)} />
        ))}
      </nav>

      {/* Footer — user info + logout */}
      <div className="px-4 py-4 border-t border-slate-800 flex-shrink-0">
        <div className="flex items-center gap-3">
          {/* Avatar initial */}
          <div className="w-9 h-9 rounded-full bg-pink-500/20 border border-pink-500/40 flex items-center justify-center flex-shrink-0">
            <span className="text-pink-300 text-sm font-bold">{initial}</span>
          </div>

          {/* Name + role */}
          <div className="flex-1 min-w-0">
            {roleKnown ? (
              <>
                <p className="text-white text-sm font-medium truncate">{crmUser?.name ?? 'Unknown'}</p>
                {role && (
                  <span className={`inline-block text-xs font-medium px-1.5 py-0.5 rounded mt-0.5 ${ROLE_COLORS[role]}`}>
                    {ROLE_LABELS[role]}
                  </span>
                )}
              </>
            ) : (
              <div className="space-y-1.5" aria-hidden="true">
                <div className="h-3 w-24 rounded bg-slate-800 animate-pulse" />
                <div className="h-3 w-16 rounded bg-slate-800 animate-pulse" />
              </div>
            )}
          </div>

          {/* Logout — only meaningful once we know there is a session */}
          {roleKnown && (
            <button
              onClick={handleSignOut}
              title="Sign out"
              className="text-slate-500 hover:text-red-400 transition-colors flex-shrink-0"
            >
              <LogOut size={17} />
            </button>
          )}
        </div>
      </div>
    </aside>
  )
}

// ── AppShell — handles routing logic ─────────────────────────────────────────

/**
 * Where this user must be sent, or null if they may stay on `pathname`.
 * Pure mirror of the original redirect rules — only ever called with a resolved
 * auth state. Used both to drive router.push AND to decide whether it is safe to
 * mount page content, so a user who is about to be bounced never sees the page
 * they are being bounced away from.
 */
function resolveRedirect(
  crmUser: CrmUser | null,
  apiUser: ApiUser | null,
  pathname: string,
  crmProfileUnread = false,
): string | null {
  // Is there a session at all? One question, and the only thing that may send
  // anybody to /login.
  //
  // It lives in `lib/sessionGate.ts` — no React, no imports, no browser —
  // because it has been got wrong twice and both times the symptom was a
  // signed-in person being evicted: first the observer, who has no Firestore
  // record by design, then an owner refreshing, whose API session resolves out
  // of localStorage while Firebase is still reading IndexedDB. Landing on
  // /login with a live Firebase session, the login page recognised them and
  // showed the superadmin security gate — so one race was reported as two
  // separate bugs.
  //
  // `lib/sessionGate.spec.ts` runs the full cross-product of every fact and
  // asserts that exactly one combination out of all of them means "signed out".
  // Both live bugs were combinations nobody had thought to write a case for,
  // which is why the check is exhaustive rather than by example.
  if (sessionGate({
    hasCrmUser: !!crmUser,
    apiRole: apiUser?.role ?? null,
    hasSessionToken: !!getSessionToken(),
    crmProfileUnread,
  }) === 'login') return '/login'

  // Past the gate with no profile means a session the API vouches for whose
  // Firestore record has not arrived — the observer, or an owner mid-refresh.
  // Neither has partner routing to do.
  if (!crmUser) return null

  // Lock partner users — a pending capability sees its pending page, an approved
  // one sees its dashboard. That rule is unchanged; what changed is that a login
  // may now hold BOTH capabilities, so the two blocks that used to sit here
  // ('if role === agency' / 'if role === seller') became one table that is the
  // same for one capability and defined for two.
  //
  // The table lives in `lib/partnerRouting.ts` — no React, no imports, no
  // browser — because it is the thing that must be provably right rather than
  // merely readable. `lib/partnerRouting.spec.ts` runs every capability and
  // status combination against the exact predicate this file used to carry, and
  // re-runs the resolver on its own answer to prove no path can loop.
  //
  // Staff, the superadmin and anyone whose role is not 'agency' or 'seller' get
  // null from it, which is what the two blocks above them did.
  return resolvePartnerRedirect(crmUser, pathname)
}

/** Neutral placeholder for the main content area — no user data, no links. */
function ContentSkeleton() {
  return (
    <div className="space-y-8 animate-pulse" aria-hidden="true">
      <div className="flex items-end justify-between">
        <div className="space-y-2">
          <div className="h-3 w-28 rounded bg-slate-800" />
          <div className="h-8 w-52 rounded bg-slate-800" />
        </div>
        <div className="h-3 w-40 rounded bg-slate-800" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="bg-slate-800 rounded-xl p-5 border border-slate-700">
            <div className="h-3 bg-slate-700 rounded w-28 mb-4" />
            <div className="h-8 bg-slate-700 rounded w-20" />
          </div>
        ))}
      </div>
    </div>
  )
}

/** Full-screen branded loader — only used on the standalone pending pages,
 *  which have no shell to paint progressively. */
function BootSplash() {
  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center">
      <div className="flex flex-col items-center gap-4">
        <div className="w-10 h-10 border-2 border-pink-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-slate-400 text-sm font-medium">
          <span className="text-pink-500 font-bold">Zipper</span> CRM
        </p>
      </div>
    </div>
  )
}

// The observer has no Firestore crmUsers record on purpose — the old role
// vocabulary has no read-only tier, so mirroring them there would grant full
// write access. They authenticate against the API instead, and only the
// API-backed screens are available to them.
// `/reports` belongs here: the observer's whole point is seeing the business
// including the money, and `can_read_all` in the API grants them every report.
// Leaving it out would have hidden the money from the one role that exists to
// watch it.
// `startsWith`, so '/finance' covers the whole section — cash, liabilities,
// payouts, profit, reports, withdrawals. Those screens admit the observer and
// skip their Firestore reads for them, because an observer holds an API session
// and no Firebase session at all.
// Note '/tech/email' and '/tech/jobs' are listed individually and '/tech' is
// NOT. These match by prefix, so '/tech' would also open Content, Payments,
// App Control and Team Tickets — none of which are read-only API screens.
// '/sessions' is the Observer's own sessions (B3 / §13) — self-scoped on the
// server, so seeing and ending them writes nothing about the business.
const OBSERVER_ROUTES = [
  '/inbox', '/board', '/audit', '/team-access', '/partners', '/reports', '/finance',
  '/alerts', '/tech/email', '/tech/jobs', '/sessions',
]

function ObserverShell({ children, pathname }: { children: React.ReactNode; pathname: string }) {
  const allowed = OBSERVER_ROUTES.some((r) => pathname.startsWith(r))

  return (
    <>
      <aside className="w-64 h-screen bg-slate-900 border-r border-slate-800 fixed top-0 left-0 flex flex-col z-40">
        <div className="px-6 py-5 border-b border-slate-800">
          <span className="text-2xl font-black text-pink-500 tracking-tight">Zipper</span>
          <span className="text-2xl font-black text-white tracking-tight"> CRM</span>
        </div>
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          <NavItem href="/inbox"  label="Waiting on you" icon={Inbox}    isActive={pathname.startsWith('/inbox')} />
          <NavItem href="/board"  label="Money Board"    icon={Landmark} isActive={pathname.startsWith('/board')} />
          <NavItem href="/reports/weekly" label="Weekly Report" icon={ScrollText} isActive={pathname.startsWith('/reports/weekly')} />
          <NavItem href="/reports" label="Reports"      icon={FileSpreadsheet} isActive={pathname === '/reports' || pathname === '/reports/'} />
          <NavItem href="/finance" label="Finance"      icon={DollarSign} isActive={pathname.startsWith('/finance')} />
          <NavItem href="/alerts"  label="Alerts"       icon={Siren} isActive={pathname.startsWith('/alerts')} />
          <NavItem href="/tech/jobs"  label="Scheduled Jobs" icon={AlarmClock}  isActive={pathname.startsWith('/tech/jobs')} />
          <NavItem href="/tech/email" label="Email Delivery" icon={MailWarning} isActive={pathname.startsWith('/tech/email')} />
          <NavItem href="/audit"  label="Audit Log"      icon={History}  isActive={pathname.startsWith('/audit')} />
          <NavItem href="/partners" label="Statements"  icon={Building2} isActive={pathname.startsWith('/partners')} />
          <NavItem href="/team-access" label="Team Access" icon={UserCog} isActive={pathname.startsWith('/team-access')} />
          <NavItem href="/sessions" label="Signed-in devices" icon={MonitorSmartphone} isActive={pathname.startsWith('/sessions')} />
        </nav>
        <div className="px-4 py-4 border-t border-slate-800">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center">
              <Eye size={15} className="text-slate-300" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white text-sm font-medium truncate">Observer</p>
              <span className="inline-block text-xs px-1.5 py-0.5 rounded mt-0.5 bg-slate-700 text-slate-300">
                Read only
              </span>
            </div>
            <button
              onClick={async () => { await api.auth.signOut(); window.location.href = '/observer' }}
              title="Sign out"
              className="text-slate-500 hover:text-red-400 transition-colors"
            >
              <LogOut size={17} />
            </button>
          </div>
        </div>
      </aside>
      <main className="ml-64 min-h-screen p-8">
        {allowed ? children : (
          <div className="max-w-lg mx-auto text-center py-24">
            <Eye size={32} className="text-slate-700 mx-auto mb-4" />
            <h1 className="text-white text-xl font-bold">Not available to the observer</h1>
            <p className="text-slate-400 text-sm mt-2">
              This page reads and writes directly, so it is not part of the read-only view.
              Use Waiting on you, Money Board, Audit Log or Team Access.
            </p>
          </div>
        )}
      </main>
    </>
  )
}

function AppShell({ children }: { children: React.ReactNode }) {
  const { crmUser, loading, apiUser, crmProfileUnread } = useAuth()
  const pathname = usePathname()
  const router = useRouter()

  // Public pages — rendered standalone, no sidebar, no auth gate.
  // /observer is here deliberately: the observer signs in with a one-time code
  // rather than Firebase, so it must be reachable without a Firebase session.
  const isLoginPage = pathname === '/login'         || pathname === '/login/'
                   || pathname === '/observer'      || pathname === '/observer/'
                   || pathname === '/agency-signup'  || pathname === '/agency-signup/'
                   || pathname === '/seller-signup'  || pathname === '/seller-signup/'
                   // UGP-F: the public appeal — for people locked out of the app.
                   || pathname === '/appeal'         || pathname === '/appeal/'

  const isPendingPage = pathname.startsWith('/agency-pending')
                     || pathname.startsWith('/seller-pending')

  // Never redirect on an unresolved identity, and never redirect off a public page.
  const redirectTo = loading || isLoginPage
    ? null
    : resolveRedirect(crmUser, apiUser, pathname, crmProfileUnread)

  useEffect(() => {
    if (redirectTo) router.push(redirectTo)
  }, [redirectTo, router])

  // Public auth pages (login / agency-signup / seller-signup) — standalone, no
  // sidebar, and no auth gate at all: they need nothing from the network to be
  // usable, so they paint as soon as the JS bundle runs.
  if (isLoginPage) {
    return <>{children}</>
  }

  // Pending pages — standalone full-screen, but still require a known user.
  if (isPendingPage) {
    if (loading) return <BootSplash />
    if (redirectTo) return null          // redirect in flight — render nothing
    return <>{children}</>
  }

  // Observer — an API session with no Firestore identity. Handled before the
  // signed-out check below, which would otherwise bounce them to /login even
  // though they are properly authenticated.
  if (!loading && !crmUser && apiUser?.role === 'observer') {
    return <ObserverShell pathname={pathname}>{children}</ObserverShell>
  }

  // Not logged in — redirect to /login in progress, render nothing.
  // (Kept identical to the previous behaviour: no CRM chrome for signed-out users.)
  if (!loading && !crmUser) {
    return null
  }

  // Static shell paints immediately — the frame does not depend on the network.
  // Children mount only once auth has resolved AND this user is allowed to stay
  // here; until then the content area shows a neutral skeleton. This keeps page
  // components from firing their data fetches (and flashing content) on behalf
  // of a user who is about to be redirected out.
  const contentReady = !loading && !!crmUser && !redirectTo

  return (
    <>
      <Sidebar />
      <main className="ml-64 min-h-screen p-8">
        {contentReady ? children : <ContentSkeleton />}
      </main>
    </>
  )
}

// ── Root layout ──────────────────────────────────────────────────────────────

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-slate-950 text-slate-100">
        <AuthProvider>
          <AppShell>{children}</AppShell>
        </AuthProvider>
      </body>
    </html>
  )
}
