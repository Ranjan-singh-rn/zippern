/**
 * Batched, read-only identity lookups for the CRM (B1).
 *
 * Every read here is one the signed-in CRM session could already make — the
 * same Firestore rules the rest of the CRM reads under (`users` list is staff
 * only, `agencies` list is admins or the agency's own login, `sellers` list is
 * staff only, `publicProfiles` is any signed-in user). Nothing new is opened up:
 * a role that cannot read a collection gets a refusal, recorded as a failure,
 * and the screen shows "Name unavailable" with the labelled id instead.
 *
 * One `documentId() in [...]` query per 30 ids — never one read per row — and
 * nothing here ever throws: the same contract as `getAgencyNames`.
 */
import { collection, documentId, getDocs, query, where } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { fromSettled, type ReadFailure } from '@/lib/readState'
import {
  agencyFacts, chunks, foldBatch, mergePartner, personFacts, publicFacts, sellerFacts, uniqueIds,
  type IdentityFacts,
} from '@/lib/identity'

export interface IdentityLookup {
  facts: Map<string, IdentityFacts>
  failure: ReadFailure | null
}

type ToFacts = (doc: Record<string, unknown> | null | undefined) => IdentityFacts

async function lookup(collectionName: string, ids: Iterable<unknown>, toFacts: ToFacts): Promise<IdentityLookup> {
  const unique = uniqueIds(ids)
  const facts = new Map<string, IdentityFacts>()
  if (unique.length === 0) return { facts, failure: null }
  const batches = chunks(unique)
  const results = await Promise.allSettled(
    // `async`, so anything thrown while a query is being built is a rejection
    // that `allSettled` records rather than an exception out of here.
    batches.map(async (batch) => getDocs(query(collection(db, collectionName), where(documentId(), 'in', batch)))),
  )
  let failure: ReadFailure | null = null
  results.forEach((res, i) => {
    const read = fromSettled(res, `${collectionName}/identities#${i}`)
    if (!read.ok) {
      failure = failure ?? read
      return
    }
    foldBatch(
      facts,
      batches[i],
      read.value.docs.map((d) => ({ id: d.id, data: d.data() as Record<string, unknown> })),
      toFacts,
    )
  })
  return { facts, failure }
}

/** People by Firebase uid, from `users/{uid}` — staff screens only (the rules refuse anyone else). */
export function getPeople(uids: Iterable<unknown>): Promise<IdentityLookup> {
  return lookup('users', uids, personFacts)
}

/**
 * People by uid from the PUBLIC projection: a display name and a photo, never a
 * contact. For partner-facing screens, where the viewer may know a buyer's or a
 * host's name but has no right to their email or phone.
 */
export function getPublicPeople(uids: Iterable<unknown>): Promise<IdentityLookup> {
  return lookup('publicProfiles', uids, publicFacts)
}

/**
 * Partner records by id. An id may be an agency (incl. sub-agency) or a seller
 * record, so both collections are asked; `kinds` says which one answered.
 */
export async function getPartners(
  ids: Iterable<unknown>,
): Promise<IdentityLookup & { kinds: Map<string, 'agency' | 'seller'> }> {
  const unique = uniqueIds(ids)
  const [agencies, sellers] = await Promise.all([
    lookup('agencies', unique, agencyFacts),
    lookup('sellers', unique, sellerFacts),
  ])
  const facts = new Map<string, IdentityFacts>()
  const kinds = new Map<string, 'agency' | 'seller'>()
  for (const id of unique) {
    const a = agencies.facts.get(id)
    const s = sellers.facts.get(id)
    const merged = mergePartner(a, s)
    if (merged) facts.set(id, merged)
    if (a && a.found) kinds.set(id, 'agency')
    else if (s && s.found) kinds.set(id, 'seller')
  }
  return { facts, kinds, failure: agencies.failure ?? sellers.failure }
}
