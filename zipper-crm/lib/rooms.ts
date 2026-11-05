/**
 * Live and party rooms as the monitoring screens read them (O12, 5 Nov 2026).
 *
 * `/party` reads open party rooms straight from Firestore (rooms are real-time app state; any signed-in account may
 * read them). An agency's "live now" comes from the server — `myMonitorRooms` — which works out the agency's own
 * hosts and its sub-agencies' hosts with its own access and returns only rooms the caller may open. Opening one goes
 * through `monitorRoomToken` (components/LiveWatch.tsx).
 */

import { collection, getDocs, limit, query, where, type Timestamp } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { crmFunctions, db } from '@/lib/firebase'

const PARTY_ROOM_LIMIT = 200

export interface PartyRoomRow {
  roomId: string
  hostUid: string
  hostName: string
  title: string
  visibility: 'public' | 'private'
  listenerCount: number
  occupantCount: number
  createdAt: Timestamp | null
}

/** Every open party room, the busiest first. */
export async function getActivePartyRooms(): Promise<PartyRoomRow[]> {
  const snap = await getDocs(query(collection(db, 'partyRooms'), where('isActive', '==', true), limit(PARTY_ROOM_LIMIT)))
  return snap.docs
    .map((d) => {
      const x = d.data()
      return {
        roomId: d.id,
        hostUid: String(x.hostUid ?? ''),
        hostName: String(x.hostName ?? ''),
        title: String(x.title ?? x.roomName ?? ''),
        visibility: x.visibility === 'private' ? 'private' as const : 'public' as const,
        listenerCount: Number(x.listenerCount ?? 0) || 0,
        occupantCount: Number(x.occupantCount ?? 0) || 0,
        createdAt: (x.createdAt ?? null) as Timestamp | null,
      }
    })
    .sort((a, b) => (b.listenerCount + b.occupantCount) - (a.listenerCount + a.occupantCount))
}

/** One room the caller may monitor (the server's `MonitorRoom`). */
export interface MonitorRoom {
  kind: 'live' | 'party'
  roomId: string
  hostUid: string
  hostName: string
  title: string
  /** Viewers (live) or listeners + people on seats (party). */
  audience: number
  /** A PIN-locked party room — a monitor opens it without the PIN. */
  private: boolean
}

export interface MonitorRooms {
  as: 'staff' | 'agency' | 'sub_agency'
  rooms: MonitorRoom[]
}

/** The rooms open right now that the caller may monitor — the server decides the scope. */
export async function myMonitorRooms(): Promise<MonitorRooms> {
  const call = httpsCallable<Record<string, never>, MonitorRooms>(crmFunctions(), 'myMonitorRooms')
  return (await call({})).data
}
