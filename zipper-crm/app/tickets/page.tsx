'use client'

/**
 * /tickets — retired (audit C-5). Redirects to /feedback.
 *
 * This screen read `supportTickets`, a collection NOTHING in the app writes
 * (zipper-app ChatRepository.kt:29), so support staff saw a permanently empty
 * queue; its reply also wrote a `users/{uid}/notifications` row the rules
 * refuse and the app never read. The feedback and support the app actually
 * files lives in `feedbackTickets` and is worked on /feedback (and
 * /operations/feedback for Ops), through the API's `feedback` ticket kind,
 * which tells the person in the top-level `notifications` collection the app
 * reads. The route is kept so an old bookmark lands somewhere useful.
 */

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { MessageSquare } from 'lucide-react'

export default function TicketsRetired() {
  const router = useRouter()
  useEffect(() => {
    const t = setTimeout(() => router.replace('/feedback'), 1200)
    return () => clearTimeout(t)
  }, [router])

  return (
    <div className="max-w-xl mx-auto bg-slate-900 border border-slate-800 rounded-xl p-6">
      <div className="flex items-start gap-3">
        <MessageSquare size={20} className="text-slate-400 mt-0.5 shrink-0" />
        <div>
          <h1 className="text-white font-semibold">App tickets moved</h1>
          <p className="text-slate-400 text-sm mt-1 leading-relaxed">
            The app files feedback and support requests in one place, and that place is{' '}
            <Link href="/feedback" className="text-pink-400 hover:text-pink-300 underline underline-offset-2">
              Feedback &amp; support
            </Link>
            . This screen read a queue the app never wrote to. Taking you there…
          </p>
        </div>
      </div>
    </div>
  )
}
