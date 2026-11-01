'use client'

/**
 * The CRM's one way of showing who a record belongs to (B1).
 *
 *   IdentityBlock   name / email · phone / labelled id, on three lines
 *   IdentityInline  name followed by the labelled id, on one line
 *
 * Both take the facts a lookup returned (see lib/useIdentities) and decide
 * nothing themselves: the wording — including "Profile not found" and
 * "Name unavailable" — comes from `identityView` in lib/identity, so every
 * screen says the same thing in the same situation.
 *
 * `showContacts` is the CALLER's statement that the viewer may see this
 * person's email and phone on this screen. It defaults to false; a contact is
 * never shown just because a lookup happened to return one.
 */
import Link from 'next/link'
import { identityView, type IdentityFacts, type IdKind, type LookupState } from '@/lib/identity'

export interface IdentityProps {
  facts?: IdentityFacts
  id: string
  kind: IdKind
  state?: LookupState
  showContacts?: boolean
  /** Link the name (the labelled id stays plain text so it can be copied). */
  href?: string
  /** Further labelled ids for the same record, e.g. a request id. */
  refs?: ReadonlyArray<{ label: string; value: string }>
  className?: string
}

export function IdentityBlock({
  facts, id, kind, state = 'done', showContacts = false, href, refs = [], className = '',
}: IdentityProps) {
  const v = identityView(facts, id, kind, { showContacts, state })
  const nameClass = v.named ? 'text-white font-medium' : 'text-slate-400 italic'
  return (
    <div className={`min-w-0 ${className}`}>
      <p className={`${nameClass} truncate`}>
        {href ? <Link href={href} className="hover:text-pink-300">{v.primary}</Link> : v.primary}
      </p>
      {v.secondary && <p className="text-slate-400 text-xs truncate">{v.secondary}</p>}
      <p className="text-slate-500 text-xs font-mono break-all">
        {v.reference}
        {refs.map((r) => (
          <span key={r.label}>{' · '}{r.label}: {r.value || '—'}</span>
        ))}
      </p>
    </div>
  )
}

export function IdentityInline({
  facts, id, kind, state = 'done', showContacts = false, href, className = '',
}: Omit<IdentityProps, 'refs'>) {
  const v = identityView(facts, id, kind, { showContacts, state })
  const nameClass = v.named ? 'text-white' : 'text-slate-400 italic'
  return (
    <span className={`inline-flex flex-wrap items-baseline gap-x-1.5 min-w-0 ${className}`}>
      {href ? (
        <Link href={href} className={`${nameClass} hover:text-pink-300`}>{v.primary}</Link>
      ) : (
        <span className={nameClass}>{v.primary}</span>
      )}
      {v.secondary && <span className="text-slate-400 text-xs">{v.secondary}</span>}
      <span className="text-slate-500 text-xs font-mono break-all">{v.reference}</span>
    </span>
  )
}
