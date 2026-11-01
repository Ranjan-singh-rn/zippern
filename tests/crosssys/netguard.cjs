/**
 * Loopback-only network guard for the cross-system runs (Node).
 *
 * Loaded with `node --require tests/crosssys/netguard.cjs …` BEFORE any test or
 * library code, so every TCP/TLS connection and every DNS lookup to anything
 * that is not 127.0.0.0/8, ::1 or `localhost` is refused inside the process
 * and never leaves the machine. The emulators listen on loopback, so the run
 * needs nothing else.
 *
 * Every attempt — allowed or refused — is appended to $CROSSSYS_NETLOG as one
 * tab-separated line, so a run can prove afterwards that it made zero
 * non-loopback attempts (the Mac runner counts the BLOCKED lines).
 *
 * Also switches off Google metadata-server detection: `google-gax` asks
 * `google-auth-library` for a "universe domain", which probes
 * 169.254.169.254 even when an emulator is in use.
 */

'use strict'

const net = require('node:net')
const dns = require('node:dns')
const fs = require('node:fs')

process.env.METADATA_SERVER_DETECTION = 'none'

const LOG = process.env.CROSSSYS_NETLOG || ''
function record(kind, target, verdict) {
  if (!LOG) return
  try { fs.appendFileSync(LOG, `${Date.now()}\t${process.pid}\t${kind}\t${target}\t${verdict}\n`) } catch (_) { /* ignore */ }
}

function isLocal(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h) || h === '::ffff:127.0.0.1'
}

/** The host a `Socket#connect(...)` call is aimed at; null for a unix-domain path. */
function hostOf(args) {
  let a = args[0]
  if (Array.isArray(a)) a = a[0]                       // net.connect() passes normalized args
  if (a && typeof a === 'object') return a.path ? null : String(a.host || 'localhost')
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) {
    return typeof args[1] === 'string' ? args[1] : 'localhost'
  }
  return null                                          // a unix-domain path
}

const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function guardedConnect(...args) {
  const host = hostOf(args)
  if (host !== null) {
    const ok = isLocal(host)
    record('connect', host, ok ? 'allowed' : 'BLOCKED')
    if (!ok) {
      const err = Object.assign(new Error(`crosssys netguard: refused non-loopback connection to ${host}`),
        { code: 'ECONNREFUSED' })
      process.nextTick(() => this.destroy(err))
      return this
    }
  }
  return originalConnect.apply(this, args)
}

const originalLookup = dns.lookup
dns.lookup = function guardedLookup(hostname, ...rest) {
  if (!isLocal(hostname)) {
    record('dns', hostname, 'BLOCKED')
    const cb = rest[rest.length - 1]
    const err = Object.assign(new Error(`crosssys netguard: refused DNS lookup of ${hostname}`), { code: 'ENOTFOUND' })
    if (typeof cb === 'function') { process.nextTick(cb, err); return undefined }
    throw err
  }
  return originalLookup.call(this, hostname, ...rest)
}

record('guard', String(process.pid), 'netguard active')
