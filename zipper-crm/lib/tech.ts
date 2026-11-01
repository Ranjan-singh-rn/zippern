import {
  collection,
  doc,
  getDocs,
  addDoc,
  updateDoc,
  setDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  Timestamp,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { Dept } from '@/lib/auth'
import { tickets as apiTickets } from '@/lib/api'

// ── Types ────────────────────────────────────────────────────────────────────

// Team Tickets — internal CRM tickets any department can file, assigned to any
// department (and optionally a specific person). Distinct from `supportTickets`
// (app-user support requests) — `source` tags where a ticket originated so
// teams/admins can tell the two apart at a glance.
export interface TechTicket {
  id: string
  title: string
  description: string
  category: 'bug' | 'feature' | 'content' | 'design' | 'testing' | 'support'
  priority: 'low' | 'medium' | 'high' | 'critical'
  status: 'open' | 'in_progress' | 'review' | 'done'
  source: 'app' | 'crm'           // 'app' = routed from an app-user support ticket, 'crm' = filed by CRM staff
  assignedTeam: Dept              // which department owns/works this ticket
  assignedTo?: string             // uid of a specific staff member (optional — can be team-only)
  assignedToName?: string
  reportedBy: string
  reportedByDept?: Dept           // which department filed it
  linkedSupportTicketId?: string  // set when created by Support routing an app-user ticket
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  labels: string[]
  attachmentUrls: string[]
}

// Gift type is the canonical Gift Economy type — same schema, same collection.
export type { Gift } from '@/lib/gifts'

export interface Level {
  id: string
  level: number
  xpRequired: number
  title: string
  badge: string           // emoji or text fallback shown in-app
  badgeImage?: string     // PNG/WebP badge image (preferred over text)
  rewards: { diamonds?: number; frames?: string[] }
  entryEffect?: string    // Lottie JSON URL for room-entry animation
  lottieUrl?: string      // Lottie JSON URL for level-up celebration screen
  isActive: boolean
}

export interface ProfileCard {
  id: string
  name: string
  imageUrl: string
  unlockLevel: number
  isActive: boolean
}

// BagItem — managed in Firestore `bagItems` collection.
// Android MyBagViewModel reads from this; falls back to hardcoded defaults if empty.
export interface BagItem {
  id: string
  name: string
  category: 'frame' | 'chat_bubble' | 'profile_card' | 'id_frame' | 'entrance'
  previewUrl: string
  unlockLevel: number      // min USER level (0–20) — Android reads this field name
  minHostLevel: number     // min HOST level (0–10) — 0 = no host-level requirement
  price: number
  source: 'level' | 'marketplace' | 'event'
  animationAsset: string   // Storage path, e.g. bag_items/entrances/en_bike.json
  animationUrl?: string    // Firebase Storage download URL (set by upload-bag-assets.mjs)
  targetGender:  'all' | 'male' | 'female'   // who can see/use this item
  targetRole:    'all' | 'user' | 'host'     // role restriction (Option A: strict exclusive)
  targetUserId?: string                       // if set, ONLY this account can have this item
  isActive: boolean
}

export interface PaymentMethod {
  type: 'offline' | 'stripe' | 'razorpay' | 'upi' | 'google_play'
  isActive: boolean
  config?: object
}

export interface PaymentConfig {
  id: string
  country: string
  methods: PaymentMethod[]
  updatedAt: Timestamp | null
}

// ── Tech Tickets ─────────────────────────────────────────────────────────────

export async function getTechTickets(status?: string): Promise<TechTicket[]> {
  const ref = collection(db, 'techTickets')
  // Avoid compound query (where + orderBy) — needs composite index.
  // Filter client-side when status is provided.
  const q = query(ref, orderBy('createdAt', 'desc'))
  const snap = await getDocs(q)
  const tickets = snap.docs.map((d) => ({ id: d.id, ...d.data() } as TechTicket))
  return status ? tickets.filter((t) => t.status === status) : tickets
}

/** All team tickets currently assigned to a given department */
export async function getTechTicketsByTeam(team: Dept): Promise<TechTicket[]> {
  const all = await getTechTickets()
  return all.filter((t) => t.assignedTeam === team)
}

/**
 * Drop keys whose value is `undefined`.
 *
 * Firestore refuses `undefined` outright — `addDoc()` throws
 * "Unsupported field value: undefined (found in field X)" and the whole write
 * fails. `null` it accepts; `undefined` it does not, and the distinction is
 * easy to miss because TypeScript treats an optional field and an explicitly
 * undefined one as the same type.
 *
 * That is exactly how filing a team ticket broke: a superadmin belongs to no
 * department, `getDeptFromRole('superadmin')` correctly returns `null`, the
 * form wrote `reportedByDept: myDept ?? undefined`, and every ticket a
 * superadmin filed was rejected. `assignedTo` and `assignedToName` are
 * undefined whenever a ticket is filed without an assignee, so the same write
 * had three ways to fail and only reported the first.
 *
 * Omitting the key is the right answer rather than writing `null`: the field is
 * optional on `TechTicket`, and "absent" is what "this ticket has no
 * department" means. A reader already has to handle the key not being there.
 */
function withoutUndefined<T extends Record<string, unknown>>(data: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined),
  ) as Partial<T>
}

/**
 * P1-D — Team Tickets are written by the API, not the browser. Firestore rules
 * refuse client writes to `techTickets`. The server sets the reporter (name,
 * uid, department) from the session and the assignee's name from their staff
 * record, so neither is sent from here.
 */
export interface NewTicket {
  title: string
  description?: string
  category: TechTicket['category']
  priority: TechTicket['priority']
  assignedTeam: Dept
  assignedTo?: string
}

export async function createTicket(data: NewTicket): Promise<void> {
  await apiTickets.createTeam(withoutUndefined({ ...data }) as NewTicket)
}

/** Fields the server accepts on a Team Ticket. */
export type TicketChange = Partial<Pick<TechTicket,
  'status' | 'priority' | 'assignedTeam' | 'assignedTo' | 'title' | 'description' | 'category' | 'labels'>>
  & { blockedBy?: string | null }

/**
 * Routing to another team, closing, reopening and changing a dependency need
 * a `reason`; the API refuses them without one and says so.
 */
export async function updateTicket(id: string, changes: TicketChange, reason = ''): Promise<void> {
  await apiTickets.update('team', id, withoutUndefined(changes as Record<string, unknown>), reason)
}

/** Does this change need a reason? Mirrors the server rule so the UI can ask first. */
export function ticketChangeNeedsReason(ticket: Pick<TechTicket, 'status' | 'assignedTeam'>, changes: TicketChange): string | null {
  if ('blockedBy' in changes) return 'change this ticket’s dependency'
  if (changes.assignedTeam && changes.assignedTeam !== ticket.assignedTeam) return 'route this ticket to another team'
  if (changes.status && changes.status !== ticket.status) {
    if (changes.status === 'done') return 'close this ticket'
    if (ticket.status === 'done') return 'reopen this ticket'
  }
  return null
}

// ── Gifts ────────────────────────────────────────────────────────────────────
// Re-exported from the canonical gifts lib so Content Management and Gift Economy
// both read/write the SAME `gifts` Firestore collection — one source of truth.
export { getGifts, createGift, updateGift } from '@/lib/gifts'
export { toggleGiftActive as toggleGift } from '@/lib/gifts'

// ── Levels ───────────────────────────────────────────────────────────────────

export async function getLevels(): Promise<Level[]> {
  const snap = await getDocs(collection(db, 'contentConfig', 'levels', 'items'))
  const levels = snap.docs.map((d) => ({ id: d.id, ...d.data() } as Level))
  return levels.sort((a, b) => a.level - b.level)
}

export async function upsertLevel(level: number, data: Omit<Level, 'id'>): Promise<void> {
  await setDoc(doc(db, 'contentConfig', 'levels', 'items', String(level)), data, { merge: true })
}

// ── Profile Cards ────────────────────────────────────────────────────────────

export async function getProfileCards(): Promise<ProfileCard[]> {
  const snap = await getDocs(collection(db, 'contentConfig', 'profileCards', 'items'))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as ProfileCard))
}

export async function upsertProfileCard(id: string, data: Omit<ProfileCard, 'id'>): Promise<void> {
  await setDoc(doc(db, 'contentConfig', 'profileCards', 'items', id), data, { merge: true })
}

// ── Bag Items ────────────────────────────────────────────────────────────────

export async function getBagItems(): Promise<BagItem[]> {
  const snap = await getDocs(collection(db, 'bagItems'))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as BagItem))
}

export async function upsertBagItem(id: string | null, data: Omit<BagItem, 'id'>): Promise<void> {
  if (id) {
    await updateDoc(doc(db, 'bagItems', id), { ...data })
  } else {
    await addDoc(collection(db, 'bagItems'), { ...data })
  }
}

export async function toggleBagItem(id: string, isActive: boolean): Promise<void> {
  await updateDoc(doc(db, 'bagItems', id), { isActive })
}

// ── Payment Config ───────────────────────────────────────────────────────────

export async function getPaymentConfigs(): Promise<PaymentConfig[]> {
  const snap = await getDocs(collection(db, 'paymentConfig'))
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as PaymentConfig))
}

export async function updatePaymentConfig(countryCode: string, methods: PaymentMethod[]): Promise<void> {
  await setDoc(
    doc(db, 'paymentConfig', countryCode),
    { methods, updatedAt: serverTimestamp() },
    { merge: true }
  )
}
