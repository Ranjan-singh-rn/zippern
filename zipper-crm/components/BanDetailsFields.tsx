'use client'

/**
 * The three things a ban records besides its reason (§5): what it reaches,
 * what kind of breach it was, and the evidence references behind it.
 *
 * Two screens ban an account — the account page (`app/users/[uid]`) and the
 * row action on /users — and they ask this the same way, from this one
 * component, for the same reason `SuspendDuration` exists: a second copy is
 * how the two screens drift apart. The rules (the scopes, the category list,
 * the ten-reference limit) are `lib/banDetails.ts`, which the spec runs.
 *
 * The caller owns the state, so a dialog resets it with its other fields and
 * checks it with `banDetailsProblem` before sending `banDetailsBody`.
 */

import {
  BAN_CATEGORIES, BAN_SCOPES, BAN_SCOPE_EFFECT, BAN_SCOPE_LABEL, MAX_BAN_EVIDENCE, MAX_CATEGORY_LENGTH,
  parseEvidence, type BanDetailsInput,
} from '@/lib/banDetails'

export function BanDetailsFields({
  value,
  onChange,
}: {
  value: BanDetailsInput
  onChange: (next: BanDetailsInput) => void
}) {
  const refs = parseEvidence(value.evidenceText)
  const over = refs.length > MAX_BAN_EVIDENCE
  return (
    <div className="space-y-4">
      <div>
        <p className="block text-slate-400 text-xs font-medium mb-1.5">What the ban reaches</p>
        <div className="grid sm:grid-cols-2 gap-2">
          {BAN_SCOPES.map((scope) => (
            <button
              key={scope}
              type="button"
              onClick={() => onChange({ ...value, scope })}
              aria-pressed={value.scope === scope}
              className={`rounded-lg border px-3 py-2 text-sm font-medium text-left transition-colors ${
                value.scope === scope
                  ? 'bg-pink-500 border-pink-400 text-white'
                  : 'bg-slate-800 border-slate-700 text-slate-300 hover:border-slate-600'
              }`}
            >
              {BAN_SCOPE_LABEL[scope]}
            </button>
          ))}
        </div>
        <p className="text-slate-500 text-xs mt-2 leading-relaxed">
          {BAN_SCOPE_EFFECT[(BAN_SCOPES as readonly string[]).includes(value.scope)
            ? (value.scope as (typeof BAN_SCOPES)[number])
            : BAN_SCOPES[0]]}
        </p>
      </div>

      <div>
        <label className="block text-slate-400 text-xs font-medium mb-1.5">Category</label>
        <select
          value={value.category}
          onChange={(e) => onChange({ ...value, category: e.target.value.slice(0, MAX_CATEGORY_LENGTH) })}
          className="w-full bg-slate-800 border border-slate-700 text-white rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:border-pink-500"
        >
          {BAN_CATEGORIES.map((c) => (
            <option key={c.value || 'none'} value={c.value}>{c.label}</option>
          ))}
        </select>
      </div>

      <div>
        <label className="block text-slate-400 text-xs font-medium mb-1.5">
          Evidence references <span className="text-slate-600">(optional, one per line, up to {MAX_BAN_EVIDENCE})</span>
        </label>
        <textarea
          value={value.evidenceText}
          onChange={(e) => onChange({ ...value, evidenceText: e.target.value })}
          rows={3}
          placeholder={'Report ids, storage paths or links — never files.\nrep-77\nappealEvidence/abc/1.jpg'}
          className={`w-full bg-slate-800 border text-white rounded-lg px-3 py-2.5 text-sm placeholder-slate-600 focus:outline-none resize-none font-mono ${
            over ? 'border-amber-500' : 'border-slate-700 focus:border-pink-500'
          }`}
        />
        <p className={`text-xs mt-1 ${over ? 'text-amber-300' : 'text-slate-600'}`}>
          {refs.length} of {MAX_BAN_EVIDENCE}. Recorded on the account and in the audit log, and shown to whoever
          reviews an appeal against this ban.
        </p>
      </div>
    </div>
  )
}
