/**
 * P0-10 (OPS-A, OPS-C) — the Node scripts that load the repository-root
 * service-account key refuse to run unless the target is named and, for a
 * write, typed; `deleteUsers.js` runs only against the Auth emulator.
 *
 * SAFE TO RUN ANYWHERE. Each script is copied into a temporary tree next to a
 * FAKE key (a project id and nothing else — `credential.cert` cannot use it),
 * and every child process gets a bare environment whose Firebase hosts are
 * closed loopback ports and which has no credentials. Even a broken guard
 * could not reach a real project from here.
 *
 * Run:  node --test test/destructiveScriptsP0.test.js
 */

const { test, describe, before } = require('node:test')
const { expect } = require('./expect')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO = path.join(__dirname, '..', '..')
const FAKE_PROJECT = 'fake-project-p0-10'

/** [repo-relative path, writes-by-default] */
const KEY_SCRIPTS = [
  ['migrate-entrances.mjs', true],
  ['functions/delete-bag-item.mjs', true],
  ['functions/migrate-entrances.mjs', true],
  ['functions/upload-entry-thumbnails.mjs', true],
  ['functions/reupload-entrances.mjs', true],
  ['functions/restore-entrance-urls.mjs', true],
  ['functions/upload-entry-animations.mjs', true],
  ['functions/upload-entry-video.mjs', true],
  ['functions/scripts/purge-app-users.mjs', false],          // writes only with --confirm
  ['functions/scripts/backfill-public-sellers.mjs', false],  // writes only with --apply
  ['functions/scripts/seed-host-levels.mjs', true],          // read-only with --dry
  ['functions/scripts/backfill-public-profiles.mjs', true],  // read-only with --dry
  ['functions/scripts/preflight.mjs', false],
  ['functions/scripts/diagnose-referral.mjs', false],
]

let T
before(() => {
  T = fs.mkdtempSync(path.join(os.tmpdir(), 'p0-10-'))
  fs.mkdirSync(path.join(T, 'functions', 'scripts'), { recursive: true })
  fs.writeFileSync(path.join(T, 'serviceAccountKey.json'), JSON.stringify({ project_id: FAKE_PROJECT }))
  const nm = path.join(REPO, 'functions', 'node_modules')
  fs.symlinkSync(nm, path.join(T, 'functions', 'node_modules'))
  fs.symlinkSync(nm, path.join(T, 'node_modules'))
  fs.copyFileSync(path.join(REPO, 'functions', 'scripts', '_keyScriptGuard.mjs'),
    path.join(T, 'functions', 'scripts', '_keyScriptGuard.mjs'))
  for (const [rel] of KEY_SCRIPTS) fs.copyFileSync(path.join(REPO, rel), path.join(T, rel))
  fs.copyFileSync(path.join(REPO, 'deleteUsers.js'), path.join(T, 'deleteUsers.js'))
})

const SAFE_ENV = {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:9',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9',
  STORAGE_EMULATOR_HOST: 'http://127.0.0.1:9',
  GOOGLE_APPLICATION_CREDENTIALS: '/nonexistent/none.json',
}
function run(rel, args = [], env = {}) {
  return spawnSync(process.execPath, [path.join(T, rel), ...args], {
    cwd: path.dirname(path.join(T, rel)),
    env: { PATH: process.env.PATH, ...SAFE_ENV, ...env },
    encoding: 'utf8', timeout: 20000, input: '',
  })
}

describe('every script that loads the root key refuses without an acknowledgement', () => {
  for (const [rel] of KEY_SCRIPTS) {
    test(`${rel}: no ZIPPER_ALLOW_PRODUCTION_ACCESS → refused (exit 2)`, () => {
      const r = run(rel)
      expect(r.status).toBe(2)
      expect(/ZIPPER_ALLOW_PRODUCTION_ACCESS/.test(r.stderr)).toBe(true)
    })
    test(`${rel}: an acknowledgement naming ANOTHER project → refused`, () => {
      const r = run(rel, [], { ZIPPER_ALLOW_PRODUCTION_ACCESS: 'some-other-project' })
      expect(r.status).toBe(2)
    })
  }
})

describe('a run that writes needs the typed confirmation', () => {
  const ack = { ZIPPER_ALLOW_PRODUCTION_ACCESS: FAKE_PROJECT }
  for (const [rel, writesByDefault] of KEY_SCRIPTS.filter(([, w]) => w)) {
    test(`${rel}: acknowledged but unconfirmed → refused`, () => {
      const r = run(rel, [], ack)
      expect(writesByDefault).toBe(true)
      expect(r.status).toBe(2)
      expect(/ZIPPER_CONFIRM_DESTRUCTIVE/.test(r.stderr)).toBe(true)
    })
  }
  test('purge-app-users --confirm: acknowledged but unconfirmed → refused', () => {
    const r = run('functions/scripts/purge-app-users.mjs', ['--confirm'], ack)
    expect(r.status).toBe(2)
    expect(/ZIPPER_CONFIRM_DESTRUCTIVE/.test(r.stderr)).toBe(true)
  })
  test('backfill-public-sellers --apply: acknowledged but unconfirmed → refused', () => {
    const r = run('functions/scripts/backfill-public-sellers.mjs', ['--apply'], ack)
    expect(r.status).toBe(2)
  })
  test('a confirmation typed for ANOTHER script → refused', () => {
    const r = run('functions/scripts/purge-app-users.mjs', ['--confirm'],
      { ...ack, ZIPPER_CONFIRM_DESTRUCTIVE: `seed-host-levels:${FAKE_PROJECT}` })
    expect(r.status).toBe(2)
  })
  test('a READ-ONLY run passes the guard once acknowledged (and names the target)', () => {
    const r = run('functions/scripts/purge-app-users.mjs', [], ack)
    expect(r.status !== 2).toBe(true)   // it then fails on the fake key, which cannot sign anything
    expect(r.stdout.includes(`target PROJECT ${FAKE_PROJECT} (read-only)`)).toBe(true)
  })
  test('a confirmed write passes the guard (and names the target)', () => {
    const r = run('functions/scripts/purge-app-users.mjs', ['--confirm'],
      { ...ack, ZIPPER_CONFIRM_DESTRUCTIVE: `purge-app-users:${FAKE_PROJECT}` })
    expect(r.stdout.includes(`target PROJECT ${FAKE_PROJECT} (writes — confirmed)`)).toBe(true)
  })
})

describe('deleteUsers.js runs only against the Auth emulator', () => {
  test('no --project → refused', () => {
    const r = run('deleteUsers.js')
    expect(r.status).toBe(2)
  })
  test('a real-looking project → refused', () => {
    const r = run('deleteUsers.js', ['--project', 'real-project-1'])
    expect(r.status).toBe(2)
  })
  test('a demo- project WITHOUT a loopback emulator → refused', () => {
    const r = run('deleteUsers.js', ['--project', 'demo-zipper'], { FIREBASE_AUTH_EMULATOR_HOST: 'auth.example.com:9099' })
    expect(r.status).toBe(2)
  })
  test('it no longer reads the root key at all', () => {
    const src = fs.readFileSync(path.join(REPO, 'deleteUsers.js'), 'utf8')
    expect(/require\(['"]\.\/serviceAccountKey\.json['"]\)/.test(src)).toBe(false)
  })
})

describe('setup-email-and-deploy.command is quarantined (static checks — never executed by tests)', () => {
  const src = fs.readFileSync(path.join(REPO, 'setup-email-and-deploy.command'), 'utf8')
  test('it refuses unless the target project is typed', () => {
    const guard = src.indexOf('ZIPPER_CONFIRM_DEPLOY:-')
    const firstDeploy = src.indexOf('firebase deploy')
    expect(guard > 0 && guard < firstDeploy).toBe(true)
  })
  test('functions are no longer force-deployed', () => {
    expect(/firebase deploy[^\n]*--force/.test(src)).toBe(false)
  })
  test('the API environment and secrets are merged, not replaced', () => {
    expect(/--set-env-vars|--set-secrets/.test(src)).toBe(false)
    expect(/--update-env-vars/.test(src) && /--update-secrets/.test(src)).toBe(true)
  })
})
