#!/usr/bin/env node
/**
 * P0-9 — build `guestUidBindings` for every guest binding made before Phase 1A,
 * and quarantine any guest uid that is bound on more than one device.
 *
 *   # LOCAL: against the Firestore emulator (demo project). Dry run.
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
 *     node scripts/migrate-guest-bindings.mjs --project demo-zipper
 *
 *   # PRODUCTION: dry run. Needs an explicit key for that project and the
 *   # production confirmation. Reads only.
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/outside/the/repo/key.json \
 *   ZIPPER_ALLOW_PRODUCTION_ACCESS=<project-id> \
 *     node scripts/migrate-guest-bindings.mjs --project <project-id>
 *
 *   # PRODUCTION: apply. The same, plus --apply and a typed confirmation.
 *   ... ZIPPER_CONFIRM_APPLY=migrate-guest-bindings:<project-id> \
 *     node scripts/migrate-guest-bindings.mjs --project <project-id> --apply
 *
 * Every refusal happens BEFORE Firebase is initialised. It prints counts only —
 * never a uid or a device id. It only ever ADDS or merges `guestUidBindings`
 * documents; nothing is deleted. Re-running it is a no-op once applied.
 * Requires `npm run build` (it reads ../lib/guestBindingMigration.js).
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
const NAME = 'migrate-guest-bindings'

function refuse(msg, code = 2) {
  process.stderr.write(`${NAME}: refusing — ${msg}\n`)
  process.exit(code)
}

const args = process.argv.slice(2)
const projectIdx = args.indexOf('--project')
const project = projectIdx >= 0 ? String(args[projectIdx + 1] ?? '').trim() : ''
const apply = args.includes('--apply')
if (!project || project.startsWith('--')) {
  process.stderr.write(`usage: node scripts/${NAME}.mjs --project <id> [--apply]\n`)
  process.exit(1)
}

const isLoopback = (hostPort) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|::1)(:\d+)?$/.test(hostPort.trim())
const emulator = String(process.env.FIRESTORE_EMULATOR_HOST ?? '').trim()

if (project.startsWith('demo-')) {
  if (!emulator || !isLoopback(emulator)) {
    refuse('a demo- project runs only against the Firestore emulator on this machine: set FIRESTORE_EMULATOR_HOST=127.0.0.1:8080')
  }
} else {
  if (emulator) refuse('FIRESTORE_EMULATOR_HOST is set but the project is not a demo- project; unset one of them')
  if (String(process.env.ZIPPER_ALLOW_PRODUCTION_ACCESS ?? '') !== project) {
    refuse(`a real project needs ZIPPER_ALLOW_PRODUCTION_ACCESS=${project} for this one command`)
  }
  if (apply && String(process.env.ZIPPER_CONFIRM_APPLY ?? '') !== `${NAME}:${project}`) {
    refuse(`--apply on a real project needs ZIPPER_CONFIRM_APPLY=${NAME}:${project}`)
  }
  const keyPath = String(process.env.GOOGLE_APPLICATION_CREDENTIALS ?? '').trim()
  if (!keyPath) refuse('set GOOGLE_APPLICATION_CREDENTIALS to a key for this project, kept outside the repository')
  let keyProject = ''
  try {
    keyProject = String(JSON.parse(readFileSync(keyPath, 'utf8')).project_id ?? '')
  } catch {
    refuse('GOOGLE_APPLICATION_CREDENTIALS does not name a readable service-account key')
  }
  if (keyProject !== project) refuse('the key in GOOGLE_APPLICATION_CREDENTIALS belongs to a different project')
}

let MIG
try {
  MIG = require('../lib/guestBindingMigration.js')
} catch {
  refuse('../lib/guestBindingMigration.js not found — run `npm run build` first')
}
const admin = require('firebase-admin')
admin.initializeApp({ projectId: project })

const mode = apply ? 'APPLY' : 'DRY RUN (nothing is written)'
process.stdout.write(`${NAME}: ${mode} — target ${emulator ? 'Firestore EMULATOR' : 'the named project'}\n`)
const r = await MIG.runGuestBindingMigration(admin.firestore(), { apply })
const s = r.stats
process.stdout.write([
  `  bindings read            ${s.bindings}`,
  `  distinct guest uids      ${s.uids}`,
  `  index entries to create  ${s.created}`,
  `  stale entries to repoint ${s.repointed}`,
  `  uids to quarantine       ${s.quarantined}   (bound on more than one device)`,
  `  already indexed          ${s.unchanged}`,
  `  already quarantined      ${s.alreadyQuarantined}`,
  `  bindings with no uid     ${s.skippedEmptyUid}`,
  `  documents written        ${r.writes}${r.applied ? '' : '   (dry run)'}`,
].join('\n') + '\n')
process.exit(0)
