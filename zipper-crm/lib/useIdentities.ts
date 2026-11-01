'use client'

/**
 * Resolve the people and partners a screen is about to show, in batches (B1).
 *
 * Give it the ids the screen already has; it answers with one map per kind of
 * lookup and a state. The fetch is keyed on the SET of ids, so a re-render with
 * the same rows does not read again, and a read that fails leaves those ids
 * out of the maps — the screen then says "Name unavailable" next to the
 * labelled id rather than inventing anything.
 */
import { useEffect, useState } from 'react'
import { getPartners, getPeople, getPublicPeople } from '@/lib/identityLookup'
import { uniqueIds, type IdentityFacts, type LookupState } from '@/lib/identity'
import type { ReadFailure } from '@/lib/readState'

export interface IdentityRequest {
  /** Firebase uids to resolve from `users` (staff screens). */
  people?: Iterable<unknown>
  /** Firebase uids to resolve from `publicProfiles` (partner-facing screens: names only). */
  publicPeople?: Iterable<unknown>
  /** Partner record ids (agencies or sellers). */
  partners?: Iterable<unknown>
  /** False while the screen is not allowed to read at all (e.g. not signed in yet). */
  enabled?: boolean
}

export interface Identities {
  people: Map<string, IdentityFacts>
  publicPeople: Map<string, IdentityFacts>
  partners: Map<string, IdentityFacts>
  partnerKinds: Map<string, 'agency' | 'seller'>
  state: LookupState
  failure: ReadFailure | null
}

const EMPTY = new Map<string, IdentityFacts>()

export function useIdentities(req: IdentityRequest): Identities {
  const enabled = req.enabled !== false
  const peopleKey = uniqueIds(req.people ?? []).sort().join('|')
  const publicKey = uniqueIds(req.publicPeople ?? []).sort().join('|')
  const partnerKey = uniqueIds(req.partners ?? []).sort().join('|')

  const [result, setResult] = useState<Identities>({
    people: EMPTY, publicPeople: EMPTY, partners: EMPTY, partnerKinds: new Map(),
    state: 'loading', failure: null,
  })

  useEffect(() => {
    if (!enabled) return
    let live = true
    const peopleIds = peopleKey ? peopleKey.split('|') : []
    const publicIds = publicKey ? publicKey.split('|') : []
    const partnerIds = partnerKey ? partnerKey.split('|') : []
    if (peopleIds.length + publicIds.length + partnerIds.length === 0) {
      setResult({ people: EMPTY, publicPeople: EMPTY, partners: EMPTY, partnerKinds: new Map(), state: 'done', failure: null })
      return
    }
    setResult((prev) => ({ ...prev, state: 'loading' }))
    void Promise.all([getPeople(peopleIds), getPublicPeople(publicIds), getPartners(partnerIds)]).then(
      ([people, pub, partners]) => {
        if (!live) return
        const failure = people.failure ?? pub.failure ?? partners.failure
        setResult({
          people: people.facts,
          publicPeople: pub.facts,
          partners: partners.facts,
          partnerKinds: partners.kinds,
          state: failure ? 'failed' : 'done',
          failure,
        })
      },
    )
    return () => { live = false }
  }, [enabled, peopleKey, publicKey, partnerKey])

  return result
}
