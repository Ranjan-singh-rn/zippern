'use client'

import { ShoppingBag } from 'lucide-react'
import { PartnerWaitingRoom } from '@/components/PartnerWaitingRoom'

/**
 * A coin seller login whose application is under review — or approved and
 * waiting for BOTH contacts to be verified (Decision 15). The words for each
 * state are in `lib/waitingRoom.ts` (QA #25).
 */
export default function SellerPendingPage() {
  return (
    <PartnerWaitingRoom
      kind="seller"
      dashboardIcon={<ShoppingBag size={15} className="text-pink-400 mt-0.5 shrink-0" />}
    />
  )
}
