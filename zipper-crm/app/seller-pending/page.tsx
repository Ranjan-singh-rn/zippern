'use client'

import { useAuth } from '@/components/AuthProvider'
import { crmSignOut } from '@/lib/auth'
import { Clock, ShoppingBag, Mail, LogOut, CheckCircle2 } from 'lucide-react'

export default function SellerPendingPage() {
  const { crmUser } = useAuth()

  return (
    <div className="min-h-screen bg-slate-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md">

        <div className="text-center mb-8">
          <span className="text-3xl font-black text-pink-500 tracking-tight">Zipper</span>
          <span className="text-3xl font-black text-white tracking-tight"> CRM</span>
        </div>

        <div className="bg-slate-900 border border-slate-800 rounded-2xl overflow-hidden shadow-2xl">

          <div className="bg-gradient-to-r from-yellow-500/20 to-orange-500/20 border-b border-yellow-500/20 p-6 text-center">
            <div className="w-14 h-14 rounded-full bg-yellow-500/20 border border-yellow-500/30 flex items-center justify-center mx-auto mb-3">
              <Clock size={28} className="text-yellow-400" />
            </div>
            <h1 className="text-white text-xl font-bold">Application Under Review</h1>
            <p className="text-yellow-300/70 text-sm mt-1">We have received your coin seller application</p>
          </div>

          <div className="p-6 space-y-5">
            <p className="text-slate-300 text-sm leading-relaxed text-center">
              Your coin seller application is being reviewed by our team. This usually takes{' '}
              <strong className="text-white">1-2 business days</strong>.
            </p>

            <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-3">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">What happens next</p>
              <div className="flex items-start gap-3">
                <CheckCircle2 size={15} className="text-green-400 mt-0.5 shrink-0" />
                <p className="text-slate-300 text-sm leading-relaxed">Our team reviews your application and account details</p>
              </div>
              <div className="flex items-start gap-3">
                <Mail size={15} className="text-blue-400 mt-0.5 shrink-0" />
                <p className="text-slate-300 text-sm leading-relaxed">
                  You will receive an email at{' '}
                  <span className="text-white font-medium">{crmUser?.email ?? 'your email'}</span>{' '}
                  once approved
                </p>
              </div>
              <div className="flex items-start gap-3">
                <ShoppingBag size={15} className="text-pink-400 mt-0.5 shrink-0" />
                <p className="text-slate-300 text-sm leading-relaxed">After approval, log back in to access your seller dashboard</p>
              </div>
            </div>

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
              <a href="mailto:314zipper@gmail.com" className="text-pink-400 hover:text-pink-300 transition-colors">
                Contact us
              </a>
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
