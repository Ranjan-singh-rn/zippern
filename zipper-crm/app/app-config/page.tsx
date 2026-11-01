'use client'

import Link from 'next/link'
import { AppWindow, Package, ShoppingCart, Gift, User, BarChart3, ChevronRight, Sparkles } from 'lucide-react'
import { useAuth } from '@/components/AuthProvider'
import { canAccess } from '@/lib/auth'

const sections = [
  {
    href: '/app-config/bag-items',
    icon: <Package size={22} className="text-pink-400" />,
    title: 'Bag Items',
    description: 'Set minimum user and host level to unlock each cosmetic item (frames, chat bubbles, profile cards, ID frames, entrances).',
    tag: 'bagItems',
  },
  {
    href: '/app-config/packages',
    icon: <ShoppingCart size={22} className="text-yellow-400" />,
    title: 'Packages',
    description: 'Manage user recharge packages (Diamond Shop), seller wholesale diamond packs, and seller coin purchase packages.',
    tag: 'rechargePackages · diamondPacks · coinPackages',
  },
  {
    href: '/app-config/daily-rewards',
    icon: <Gift size={22} className="text-green-400" />,
    title: 'Daily Rewards',
    description: '7-day login streak rewards — diamonds and video call cards given to users for consecutive daily logins.',
    tag: 'appConfig/dailyRewards',
  },
  {
    href: '/app-config/profile-options',
    icon: <User size={22} className="text-blue-400" />,
    title: 'Profile Options',
    description: 'Hobbies, likes, live categories, support categories, and max languages shown to users in profile setup.',
    tag: 'appConfig/profileOptions',
  },
  {
    href: '/app-config/levels',
    icon: <BarChart3 size={22} className="text-purple-400" />,
    title: 'Level Config',
    description: 'XP and bean thresholds for user levels (0–20) and host levels (0–10), including unlocked frames, entrances, and bonus rewards.',
    tag: 'levelConfig/user · levelConfig/host',
  },
  {
    href: '/app-config/lucky-gifts',
    icon: <Sparkles size={22} className="text-pink-400" />,
    title: 'Lucky Gifts',
    description: 'Combos, the receiver share and the odds table the server rolls over — saved only after the same payout guard the server runs.',
    tag: 'appConfig/luckyGifts',
  },
  {
    href: '/app-config/payment-creds',
    icon: <span className="text-xl">🏦</span>,
    title: 'Payment Credentials',
    description: 'Bank account and Binance UID shown to sellers when purchasing coins. Previously hardcoded in APK — now managed here.',
    tag: 'appConfig/paymentCredentials',
  },
]

export default function AppConfigPage() {
  const { crmUser } = useAuth()

  if (!crmUser || !canAccess(crmUser, ['superadmin'])) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <p className="text-slate-400">Access denied.</p>
      </div>
    )
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <AppWindow size={26} className="text-pink-500" />
        <div>
          <h1 className="text-2xl font-bold text-white">App Config</h1>
          <p className="text-slate-400 text-sm mt-0.5">All hardcoded app data migrated to Firestore — manage here without shipping a new APK.</p>
        </div>
      </div>

      <div className="space-y-3">
        {sections.map(s => (
          <Link key={s.href} href={s.href}
            className="flex items-center gap-4 bg-slate-800 border border-slate-700 hover:border-pink-500/40 rounded-xl p-5 transition-colors group">
            <div className="w-12 h-12 bg-slate-700 rounded-xl flex items-center justify-center shrink-0 group-hover:bg-slate-600 transition-colors">
              {s.icon}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-white font-semibold">{s.title}</p>
              <p className="text-slate-400 text-sm mt-0.5">{s.description}</p>
              <p className="text-slate-600 text-xs mt-1 font-mono">{s.tag}</p>
            </div>
            <ChevronRight size={18} className="text-slate-600 group-hover:text-pink-400 shrink-0 transition-colors" />
          </Link>
        ))}
      </div>
    </div>
  )
}
