// B4 — `users.agencyId` is the agency a HOST works under; the person's own
// agency lives in `ownAgencyId`. Pinned at the source of syncMyRoles, which is
// an onCall and cannot be invoked here without the emulator.
const { test, describe } = require('node:test')
const { expect } = require('./expect')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const src = readFileSync(join(__dirname, '..', 'src', 'social.ts'), 'utf8')
const body = src.slice(src.indexOf('export const syncMyRoles'))

describe('syncMyRoles never overloads users.agencyId (B4)', () => {
  test('writes the own agency into ownAgencyId', () => {
    expect(body.includes('next.ownAgencyId = ownAgency')).toBe(true)
  })
  test('never assigns the own agency into agencyId', () => {
    expect(/next\.agencyId\s*=\s*(?!\s|del\b)/.test(body)).toBe(false)
  })
  test('the only agencyId write is the cleanup of a non-Host leftover', () => {
    expect(body.includes("userSnap.get('isHost') !== true")).toBe(true)
  })
  test('an ownAgencyId change alone is a real change (no silent skip)', () => {
    expect(body.includes('ownChanged ||')).toBe(true)
  })
})
