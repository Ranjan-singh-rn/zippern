/**
 * The local test copy's mailbox: inside the Functions emulator running a `demo-`
 * project, with LOCAL_MAILBOX_DIR set, mail is written to that folder instead of
 * being sent (mail.ts `localMailboxDir`). What is pinned:
 *
 *   * it is OFF unless all three hold — FUNCTIONS_EMULATOR=true, a `demo-`
 *     project, LOCAL_MAILBOX_DIR set — so production never writes a file;
 *   * a code (`sendTransactionalMail`) and a notification (`sendNotificationMail`)
 *     each become one 0600 JSON file holding to / identity / subject / text /
 *     html, named without the address or the code, and the provider is not used;
 *   * with the mailbox off, the configured transport is used exactly as before.
 *
 * Run:  node --test test/localMailbox.test.js
 */

const { test, describe, beforeEach, afterEach } = require('node:test')
const { expect } = require('./expect')
const fs = require('fs')
const os = require('os')
const path = require('path')

const MAIL = require('../lib/mail')

const KEYS = ['FUNCTIONS_EMULATOR', 'GCLOUD_PROJECT', 'GCP_PROJECT', 'LOCAL_MAILBOX_DIR', 'EMAIL_PROVIDER', 'ZIPPER_SENDGRID_API_KEY']
let saved
let box
let sent

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  box = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'zipper-mailbox-')), 'mailbox')
  sent = []
  MAIL.setMailTransportForTests(async (m) => { sent.push(m) })
})

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  MAIL.setMailTransportForTests(null)
})

function localCopy() {
  process.env.FUNCTIONS_EMULATOR = 'true'
  process.env.GCLOUD_PROJECT = 'demo-zipper'
  process.env.LOCAL_MAILBOX_DIR = box
}

describe('localMailboxDir', () => {
  test('off outside the emulator, even with the folder set and a demo project', () => {
    process.env.GCLOUD_PROJECT = 'demo-zipper'
    process.env.LOCAL_MAILBOX_DIR = box
    expect(MAIL.localMailboxDir()).toBeNull()
  })
  test('off in the emulator for a project that is not demo-', () => {
    process.env.FUNCTIONS_EMULATOR = 'true'
    process.env.GCLOUD_PROJECT = 'zipper-live'
    process.env.LOCAL_MAILBOX_DIR = box
    expect(MAIL.localMailboxDir()).toBeNull()
  })
  test('off when the folder is not set', () => {
    process.env.FUNCTIONS_EMULATOR = 'true'
    process.env.GCLOUD_PROJECT = 'demo-zipper'
    expect(MAIL.localMailboxDir()).toBeNull()
  })
  test('on in the emulator, demo project, folder set', () => {
    localCopy()
    expect(MAIL.localMailboxDir()).toBe(box)
  })
})

describe('writing to the local mailbox', () => {
  test('a code becomes one private JSON file; the provider is not used', async () => {
    localCopy()
    await MAIL.sendTransactionalMail({ to: 'qa.user1@zipper.test', subject: 'Your code', html: '<p>Code <b>482913</b></p>', text: '' })
    const files = fs.readdirSync(box)
    expect(files.length).toBe(1)
    expect(files[0].endsWith('-functions-auth.json')).toBe(true)
    expect(files[0].includes('zipper.test') || files[0].includes('482913')).toBe(false)
    expect(fs.statSync(path.join(box, files[0])).mode & 0o777).toBe(0o600)
    const body = JSON.parse(fs.readFileSync(path.join(box, files[0]), 'utf8'))
    expect(body.to).toBe('qa.user1@zipper.test')
    expect(body.identity).toBe('auth')
    expect(body.subject).toBe('Your code')
    expect(body.text.includes('482913')).toBe(true)
    expect(sent.length).toBe(0)
  })
  test('a notification is written and reported as sent with no key and EMAIL_PROVIDER=none', async () => {
    localCopy()
    process.env.EMAIL_PROVIDER = 'none'
    const r = await MAIL.sendNotificationMail('partner@zipper.test', 'Approved', '<p>Set your password</p>')
    expect(r).toBe('sent')
    const files = fs.readdirSync(box)
    expect(files.length).toBe(1)
    expect(files[0].endsWith('-functions-transactional.json')).toBe(true)
    expect(sent.length).toBe(0)
  })
  test('with the mailbox off, the transport is used as before and no file is written', async () => {
    process.env.LOCAL_MAILBOX_DIR = box
    process.env.GCLOUD_PROJECT = 'demo-zipper'
    await MAIL.sendTransactionalMail({ to: 'qa.user1@zipper.test', subject: 'Your code', html: '<p>1</p>', text: '' })
    expect(sent.length).toBe(1)
    expect(fs.existsSync(box)).toBe(false)
  })
})
