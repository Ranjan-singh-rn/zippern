/**
 * P0-10 (OPS-C) — the gate every script that loads the repository-root
 * service-account key passes before it touches Firebase.
 *
 * That key is a production credential. A script holding it reaches the real
 * project the moment it runs, from any shell, with no prompt — which is how
 * maintenance scripts written for one afternoon end up running against live
 * data months later. So, before `admin.initializeApp`:
 *
 *   1. the key must be readable and name its project;
 *   2. `ZIPPER_ALLOW_PRODUCTION_ACCESS` must equal THAT project id, for this
 *      one command (the same acknowledgement the backend requires — Phase 0);
 *   3. a run that WRITES must also carry
 *      `ZIPPER_CONFIRM_DESTRUCTIVE=<script>:<project-id>`, typed for that run.
 *
 * Every refusal exits 2 before Firebase is initialised. The target is printed.
 * Nothing here prints a key, a token or a uid.
 */
import { readFileSync } from 'node:fs'

/**
 * @param {string} name     the script's short name, used in the confirmation
 * @param {{ keyPath: string | URL, writes: boolean }} opts
 * @returns {string} the project id the key belongs to
 */
export function guardKeyScript(name, { keyPath, writes }) {
  const refuse = (msg) => {
    process.stderr.write(`${name}: refusing — ${msg}\n`)
    process.exit(2)
  }
  let project = ''
  try {
    project = String(JSON.parse(readFileSync(keyPath, 'utf8')).project_id ?? '').trim()
  } catch {
    refuse('the service-account key could not be read.')
  }
  if (!project) refuse('the service-account key names no project.')
  if (String(process.env.ZIPPER_ALLOW_PRODUCTION_ACCESS ?? '').trim() !== project) {
    refuse(
      'this script reaches the REAL Firebase project the key belongs to. Set ' +
      'ZIPPER_ALLOW_PRODUCTION_ACCESS=<that project id> for this one command.',
    )
  }
  if (writes && String(process.env.ZIPPER_CONFIRM_DESTRUCTIVE ?? '').trim() !== `${name}:${project}`) {
    refuse(
      `a run that writes needs ZIPPER_CONFIRM_DESTRUCTIVE=${name}:<project-id> ` +
      'typed for this one command. Run it without that to see the refusal, not the effect.',
    )
  }
  process.stdout.write(`${name}: target PROJECT ${project} (${writes ? 'writes — confirmed' : 'read-only'})\n`)
  return project
}

/**
 * A data canary for the most destructive scripts: `opsCanary/target` in the
 * project's own Firestore must name the same project. Nothing creates it; a
 * person provisions it deliberately for an environment where a wipe is
 * acceptable. Call after `initializeApp`, before the first write.
 */
export async function requireDataCanary(name, db, project) {
  let snap
  try {
    snap = await db.collection('opsCanary').doc('target').get()
  } catch {
    process.stderr.write(`${name}: refusing — the data canary could not be read.\n`)
    process.exit(2)
  }
  if (!snap.exists || String(snap.get('projectId') ?? '').trim() !== project) {
    process.stderr.write(
      `${name}: refusing — this project has no data canary (opsCanary/target naming it). ` +
      'A destructive run needs one, provisioned deliberately by a person.\n',
    )
    process.exit(2)
  }
}
