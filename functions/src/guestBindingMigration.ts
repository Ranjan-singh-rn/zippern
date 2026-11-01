/**
 * P0-9 (AUTH-001-R) — index every guest binding made before Phase 1A.
 *
 * Phase 1A added `guestUidBindings/{uid}` → the ONE device a guest uid belongs
 * to, written whenever a binding is created or proven. Bindings from before it
 * have no entry, so nothing stopped one uid being bound on two devices — the
 * shape of a takeover made with a harvested uid. This plans and (only when
 * asked) writes the entries:
 *
 *   uid on ONE device, no entry          → create the entry;
 *   uid on ONE device, entry elsewhere   → repoint (the other device no longer
 *                                          points at this uid, so the entry is stale);
 *   uid on ONE device, entry here        → unchanged;
 *   uid on TWO OR MORE devices           → quarantine: no token is issued for it
 *                                          (`claimGuestIdentity`) until a person
 *                                          decides which device keeps it;
 *   entry already quarantined            → left alone, for that person.
 *
 * Pure planning plus a thin runner, so the decision can be tested without
 * Firestore and the run can be tested against the fake. DRY RUN IS THE DEFAULT:
 * `runGuestBindingMigration(db, { apply: false })` reads and reports, and writes
 * nothing. Only additive writes exist in this module; nothing is deleted.
 *
 * Run through `functions/scripts/migrate-guest-bindings.mjs`, never directly.
 */

import * as admin from 'firebase-admin'

export const GUEST_DEVICE_BINDINGS = 'guestDeviceBindings'
export const GUEST_UID_BINDINGS_COLLECTION = 'guestUidBindings'

export interface BindingRow { deviceId: string; uid: string; createdAtMs: number | null }
export interface ReverseRow { uid: string; deviceId: string; quarantined: boolean }

export interface MigrationStats {
  bindings: number
  uids: number
  created: number
  repointed: number
  quarantined: number
  unchanged: number
  alreadyQuarantined: number
  skippedEmptyUid: number
}

export interface MigrationPlan {
  create: { uid: string; deviceId: string }[]
  repoint: { uid: string; deviceId: string }[]
  quarantine: { uid: string; deviceIds: string[] }[]
  stats: MigrationStats
}

export function planGuestBindingMigration(bindings: BindingRow[], reverse: ReverseRow[]): MigrationPlan {
  const byUid = new Map<string, string[]>()
  let skippedEmptyUid = 0
  for (const b of bindings) {
    const uid = (b.uid || '').trim()
    if (uid === '') { skippedEmptyUid++; continue }
    const list = byUid.get(uid) ?? []
    list.push(b.deviceId)
    byUid.set(uid, list)
  }
  const rev = new Map(reverse.map((r) => [r.uid, r]))

  const plan: MigrationPlan = {
    create: [], repoint: [], quarantine: [],
    stats: {
      bindings: bindings.length, uids: byUid.size, created: 0, repointed: 0, quarantined: 0,
      unchanged: 0, alreadyQuarantined: 0, skippedEmptyUid,
    },
  }

  for (const uid of [...byUid.keys()].sort()) {
    const devices = [...(byUid.get(uid) ?? [])].sort()
    const entry = rev.get(uid)
    if (entry?.quarantined) { plan.stats.alreadyQuarantined++; continue }
    if (devices.length > 1) {
      plan.quarantine.push({ uid, deviceIds: devices })
      plan.stats.quarantined++
      continue
    }
    const deviceId = devices[0]
    if (!entry) {
      plan.create.push({ uid, deviceId })
      plan.stats.created++
    } else if (entry.deviceId !== deviceId) {
      plan.repoint.push({ uid, deviceId })
      plan.stats.repointed++
    } else {
      plan.stats.unchanged++
    }
  }
  return plan
}

function millisOf(v: unknown): number | null {
  const t = v as { toMillis?: () => number } | null | undefined
  return t && typeof t.toMillis === 'function' ? t.toMillis() : null
}

/**
 * Read both collections, plan, and — only with `apply: true` — write the plan.
 * Returns the plan, how many documents were written, and whether it applied.
 */
export async function runGuestBindingMigration(
  db: admin.firestore.Firestore,
  opts: { apply: boolean },
): Promise<MigrationPlan & { writes: number; applied: boolean }> {
  const [bindSnap, revSnap] = await Promise.all([
    db.collection(GUEST_DEVICE_BINDINGS).get(),
    db.collection(GUEST_UID_BINDINGS_COLLECTION).get(),
  ])
  const bindings: BindingRow[] = bindSnap.docs.map((d) => ({
    deviceId: d.id,
    uid: String(d.get('uid') ?? ''),
    createdAtMs: millisOf(d.get('createdAt')),
  }))
  const reverse: ReverseRow[] = revSnap.docs.map((d) => ({
    uid: d.id,
    deviceId: String(d.get('deviceId') ?? ''),
    quarantined: d.get('quarantined') === true,
  }))
  const plan = planGuestBindingMigration(bindings, reverse)
  if (!opts.apply) return { ...plan, writes: 0, applied: false }

  const stamp = admin.firestore.FieldValue.serverTimestamp()
  let writes = 0
  for (const { uid, deviceId } of [...plan.create, ...plan.repoint]) {
    await db.collection(GUEST_UID_BINDINGS_COLLECTION).doc(uid).set(
      { deviceId, createdAt: stamp, migratedAt: stamp }, { merge: true },
    )
    writes++
  }
  for (const { uid, deviceIds } of plan.quarantine) {
    await db.collection(GUEST_UID_BINDINGS_COLLECTION).doc(uid).set({
      quarantined: true,
      quarantineReason: 'bound_on_multiple_devices',
      quarantinedDeviceIds: deviceIds,
      quarantinedAt: stamp,
      migratedAt: stamp,
    }, { merge: true })
    writes++
  }
  return { ...plan, writes, applied: true }
}
