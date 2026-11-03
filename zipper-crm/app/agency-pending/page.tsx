'use client'

import { Building2 } from 'lucide-react'
import { PartnerWaitingRoom } from '@/components/PartnerWaitingRoom'

/**
 * An agency login whose application is under review — or approved and waiting
 * for BOTH contacts to be verified (Decision 15). The words for each state are
 * in `lib/waitingRoom.ts` (QA #25).
 */
export default function AgencyPendingPage() {
  return (
    <PartnerWaitingRoom
      kind="agency"
      dashboardIcon={<Building2 size={15} className="text-pink-400 mt-0.5 shrink-0" />}
    />
  )
}
