/**
 * AN IN-MEMORY FIRESTORE, SO THE REAL HANDLERS CAN BE RUN.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
 *
 * Every other test file in this directory tests a PURE module — `quickLoginPolicy`,
 * `mobileSession`, `publicSeller` — or asserts on source text. Neither runs the
 * thing that actually ships: `quickLogin.ts`, where the policy is composed with
 * Firestore reads, challenge consumption, rotation, rate limiting and audit.
 *
 * A Firestore emulator would be the right tool. There is none in this
 * environment and `firebase-tools` cannot be installed, so the choice was
 * between testing the composed handlers against a fake and not testing them at
 * all. This is the fake.
 *
 * ── WHAT IS REAL AND WHAT IS NOT ─────────────────────────────────────────────
 *
 * REAL: the handler code under test, imported from `lib/` exactly as deployed.
 * REAL: `admin.firestore.Timestamp` and `FieldValue` — the SDK's own classes.
 * REAL: `crypto` — signatures are genuine EC P-256 over genuine challenges.
 *
 * FAKE: the datastore. Document storage, queries, transactions.
 *
 * ── WHAT THIS CANNOT TELL YOU ────────────────────────────────────────────────
 *
 * It does not evaluate `firestore.rules` — rules are not involved when the
 * Admin SDK writes, which is the whole point of the appeal path, but it also
 * means NOTHING here says anything about what a client may do. That still needs
 * an emulator.
 *
 * By DEFAULT it does not model real contention: `runTransaction` serialises
 * through a promise chain, so a transaction callback runs exactly once.
 *
 * `installFakeFirestore({ transactions: 'optimistic' })` (or
 * `fake.transactionMode = 'optimistic'`) switches on what Firestore actually
 * does under contention: every attempt records the version of each document it
 * read and buffers its writes; at commit, if any of those documents changed
 * since it was read, the attempt is ROLLED BACK (its writes discarded) and the
 * callback is RUN AGAIN, up to 5 attempts, then the transaction fails ABORTED.
 * Each read and the commit yield to the event loop, so transactions started
 * together really do overlap. That is the behaviour that exposed the quick-login
 * rotation race: state set inside a callback by an attempt that was later rolled
 * back survived into the retry. `failCommitsTouching(prefix, n)` forces the
 * next n commits that write under `prefix` to abort, to test the retry path.
 *
 * Query support is deliberately only what the handlers use: chained `where`
 * equality, `orderBy`, `limit`. An unsupported operator throws rather than
 * quietly returning everything, because a query that silently matched nothing
 * would make a test pass for the wrong reason.
 */

const admin = require('firebase-admin')

const { Timestamp, FieldValue } = admin.firestore

/** Is this value a FieldValue sentinel rather than data? */
function isServerTimestamp(v) {
  return v != null && typeof v === 'object' && v.constructor
    && v.constructor.name === 'ServerTimestampTransform'
}

/**
 * `FieldValue.delete()` — the SDK's own sentinel. FX-10: before this it was
 * stored as an object, so no test could assert that a field was REMOVED.
 */
function isDelete(v) {
  return v != null && typeof v === 'object' && v.constructor
    && v.constructor.name === 'DeleteTransform'
}

/** Drop the keys a write deletes, from the merged result. */
function withoutDeleted(merged, data) {
  const out = { ...merged }
  for (const [k, v] of Object.entries(data)) if (isDelete(v)) delete out[k]
  return out
}

/** `FieldValue.increment(n)` — the SDK's own transform class. */
function isIncrement(v) {
  return v != null && typeof v === 'object' && v.constructor
    && v.constructor.name === 'NumericIncrementTransform'
}

/**
 * Apply top-level `FieldValue.increment` against the stored value, as the
 * server would. Before this the transform object itself was stored, so no test
 * could assert a balance after a debit — which is exactly what the call-billing
 * tests (P0-6) need to do.
 */
function applyIncrements(prior, data) {
  const out = {}
  for (const [k, v] of Object.entries(data)) {
    out[k] = isIncrement(v) ? Number((prior && prior[k]) ?? 0) + Number(v.operand) : v
  }
  return out
}

/** Replace sentinels with what the server would have written. */
function materialise(data) {
  if (Array.isArray(data)) return data.map(materialise)
  if (data == null || typeof data !== 'object') return data
  if (data instanceof Timestamp) return data
  if (isServerTimestamp(data)) return Timestamp.now()
  const out = {}
  for (const [k, v] of Object.entries(data)) out[k] = materialise(v)
  return out
}

let autoId = 0
const nextId = () => `auto_${++autoId}`

class Snapshot {
  constructor(id, data, ref) {
    this.id = id
    this.ref = ref
    this._data = data
  }
  get exists() { return this._data !== undefined }
  data() { return this._data === undefined ? undefined : { ...this._data } }
  get(field) { return this._data === undefined ? undefined : this._data[field] }
}

class DocRef {
  constructor(store, path, id) {
    this._store = store
    this.path = path
    this.id = id
  }
  get ref() { return this }
  // Subcollections: stored flat under the full path, e.g. 'agencies/A/agencyHosts'.
  collection(name) { return new CollectionRef(this._store, `${this.path}/${name}`) }
  async get() { return new Snapshot(this.id, this._store._docs.get(this.path), this) }
  async set(data, opts) {
    const merge = !!(opts && opts.merge)
    if (!merge && Object.values(data).some(isDelete)) {
      // What the SDK says: delete() is for update() and set(..., {merge}).
      throw new Error('FieldValue.delete() cannot be used with set() unless you pass {merge: true}')
    }
    const prior = this._store._docs.get(this.path)
    const next = materialise(applyIncrements(merge ? prior : undefined, data))
    this._store._docs.set(
      this.path,
      withoutDeleted(merge && prior ? { ...prior, ...next } : next, data),
    )
    this._store._bump(this.path)
    this._store.writes++
  }
  async update(data) {
    const prior = this._store._docs.get(this.path)
    if (!prior) throw new Error(`update on missing document ${this.path}`)
    this._store._docs.set(
      this.path,
      withoutDeleted({ ...prior, ...materialise(applyIncrements(prior, data)) }, data),
    )
    this._store._bump(this.path)
    this._store.writes++
  }
  async delete() {
    this._store._docs.delete(this.path)
    this._store._bump(this.path)
    this._store.deletes++
  }
}

class Query {
  constructor(store, collection, filters = [], order = null, limit = null) {
    this._store = store
    this._collection = collection
    this._filters = filters
    this._order = order
    this._limit = limit
  }
  where(field, op, value) {
    // `array-contains` added deliberately (RC invitation clean-up): an array
    // field holding `value` (strict equality), exactly Firestore's semantics
    // for a scalar operand. Anything that is not an array never matches.
    if (op !== '==' && op !== '<=' && op !== 'array-contains') {
      throw new Error(`fakeFirestore: unsupported operator "${op}" — add it deliberately`)
    }
    return new Query(this._store, this._collection,
      [...this._filters, { field, op, value }], this._order, this._limit)
  }
  orderBy(field, dir = 'asc') {
    return new Query(this._store, this._collection, this._filters, { field, dir }, this._limit)
  }
  limit(n) {
    return new Query(this._store, this._collection, this._filters, this._order, n)
  }
  async get() {
    const prefix = `${this._collection}/`
    let rows = [...this._store._docs.entries()]
      // Direct children only — a subcollection doc is not a member of its parent's collection.
      .filter(([p]) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/'))
      .map(([p, d]) => ({ id: p.slice(prefix.length), data: d, path: p }))

    for (const f of this._filters) {
      rows = rows.filter((r) => {
        const v = r.data[f.field]
        if (f.op === '==') return v === f.value
        if (f.op === 'array-contains') return Array.isArray(v) && v.includes(f.value)
        const a = v && typeof v.toMillis === 'function' ? v.toMillis() : v
        const b = f.value && typeof f.value.toMillis === 'function'
          ? f.value.toMillis() : f.value
        return a != null && a <= b
      })
    }
    if (this._order) {
      const { field, dir } = this._order
      rows.sort((x, y) => {
        const a = x.data[field], b = y.data[field]
        const av = a && typeof a.toMillis === 'function' ? a.toMillis() : (a ?? 0)
        const bv = b && typeof b.toMillis === 'function' ? b.toMillis() : (b ?? 0)
        return dir === 'desc' ? bv - av : av - bv
      })
    }
    if (this._limit != null) rows = rows.slice(0, this._limit)

    const docs = rows.map((r) =>
      new Snapshot(r.id, r.data, new DocRef(this._store, r.path, r.id)))
    return { docs, size: docs.length, empty: docs.length === 0,
      forEach: (fn) => docs.forEach(fn) }
  }
}

class CollectionRef extends Query {
  constructor(store, name) {
    super(store, name)
    this._name = name
  }
  doc(id) {
    const key = id || nextId()
    return new DocRef(this._store, `${this._name}/${key}`, key)
  }
  async add(data) {
    const ref = this.doc()
    await ref.set(data)
    return ref
  }
}

class FakeFirestore {
  constructor() {
    this._docs = new Map()
    this.writes = 0
    this.deletes = 0
    this._txChain = Promise.resolve()
    /** Per-document write counter — what an optimistic commit validates its reads against. */
    this._versions = new Map()
    /** 'serial' (default: one run per callback) or 'optimistic' (see the header). */
    this.transactionMode = 'serial'
    /** Optimistic mode only: callback runs, and attempts rolled back. */
    this.transactionAttempts = 0
    this.transactionAborts = 0
    this._forced = []          // [{ prefix, remaining }]
  }
  collection(name) { return new CollectionRef(this, name) }

  _bump(path) { this._versions.set(path, (this._versions.get(path) || 0) + 1) }
  _version(path) { return this._versions.get(path) || 0 }

  /** Optimistic mode: abort the next `n` commits that write under `prefix` (as contention would). */
  failCommitsTouching(prefix, n = 1) { this._forced.push({ prefix, remaining: n }); return this }

  /**
   * Serialised by default; optimistic with retries when `transactionMode` is
   * 'optimistic' (see the header).
   */
  runTransaction(fn) {
    if (this.transactionMode === 'optimistic') return this._runOptimistic(fn)
    const run = this._txChain.then(() => fn({
      get: (ref) => ref.get(),
      set: (ref, data, opts) => { void ref.set(data, opts) },
      update: (ref, data) => { void ref.update(data) },
      delete: (ref) => { void ref.delete() },
    }))
    this._txChain = run.catch(() => undefined)
    return run
  }

  async _runOptimistic(fn, maxAttempts = 5) {
    const yieldTurn = () => new Promise((resolve) => setImmediate(resolve))
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      this.transactionAttempts += 1
      const reads = new Map()            // path → version when this attempt read it
      const ops = []                     // buffered: applied only if this attempt commits
      const tx = {
        get: async (ref) => {
          if (ops.length) {
            throw new Error('Firestore transactions require all reads to be executed before all writes.')
          }
          reads.set(ref.path, this._version(ref.path))
          const data = this._docs.get(ref.path)
          const snap = new Snapshot(ref.id, data === undefined ? undefined : { ...data }, ref)
          await yieldTurn()                // let the competing transactions read too
          return snap
        },
        set: (ref, data, opts) => { ops.push({ path: ref.path, run: () => ref.set(data, opts) }) },
        update: (ref, data) => { ops.push({ path: ref.path, check: true, run: () => ref.update(data) }) },
        delete: (ref) => { ops.push({ path: ref.path, run: () => ref.delete() }) },
      }
      const value = await fn(tx)          // a throw from the callback fails the transaction, as in the SDK
      await yieldTurn()                   // a commit is a round trip: others may commit first
      // ── commit: validate and apply in ONE synchronous block, so it is atomic ──
      const stale = [...reads].some(([path, version]) => this._version(path) !== version)
      const forced = this._forced.find((f) => f.remaining > 0 && ops.some((o) => o.path.startsWith(f.prefix)))
      if (stale || forced) {
        if (forced) forced.remaining -= 1
        this.transactionAborts += 1
        continue                          // rolled back: nothing applied; run the callback again
      }
      for (const op of ops) {
        if (op.check && !this._docs.has(op.path)) throw new Error(`update on missing document ${op.path}`)
      }
      // DocRef writes have synchronous bodies, so `map` applies every one of them
      // before any other turn runs; awaiting afterwards only surfaces errors.
      await Promise.all(ops.map((op) => op.run()))
      return value
    }
    const err = new Error('10 ABORTED: Too much contention on these documents. Please try again.')
    err.code = 10
    throw err
  }

  /**
   * A write batch: applied in order at `commit()`, all or nothing. An
   * `update` of a missing document fails the commit BEFORE anything is
   * applied, as the server does.
   */
  batch() {
    const ops = []
    return {
      set: (ref, data, opts) => { ops.push(() => ref.set(data, opts)) },
      update: (ref, data) => {
        ops.push({ check: ref, run: () => ref.update(data) })
      },
      delete: (ref) => { ops.push(() => ref.delete()) },
      commit: async () => {
        for (const op of ops) {
          if (op.check && !this._docs.has(op.check.path)) {
            throw new Error(`update on missing document ${op.check.path}`)
          }
        }
        for (const op of ops) await (op.run ? op.run() : op())
      },
    }
  }

  // ── helpers for tests ─────────────────────────────────────────────────────
  seed(path, data) { this._docs.set(path, materialise(data)); this._bump(path); return this }
  read(path) { const d = this._docs.get(path); return d ? { ...d } : undefined }
  has(path) { return this._docs.has(path) }
  count(collection) {
    const p = `${collection}/`
    return [...this._docs.keys()].filter((k) => k.startsWith(p)).length
  }
  all(collection) {
    const p = `${collection}/`
    return [...this._docs.entries()].filter(([k]) => k.startsWith(p))
      .map(([k, v]) => ({ id: k.slice(p.length), ...v }))
  }
}

/**
 * Install the fake and return it.
 *
 * Patches the `firebase-admin` module object in place, BEFORE the code under
 * test is required, so its `admin.firestore()` resolves here. `quickLogin.ts`
 * calls it lazily inside `store()`; `identity.ts` calls it at module scope — so
 * the order matters for that one and this must come first either way.
 *
 * `Timestamp` and `FieldValue` are left as the SDK's own, so the handlers
 * construct the same objects they would in production.
 */
function installFakeFirestore(options = {}) {
  const fake = new FakeFirestore()
  if (options.transactions === 'optimistic') fake.transactionMode = 'optimistic'
  const firestoreFn = () => fake
  firestoreFn.Timestamp = Timestamp
  firestoreFn.FieldValue = FieldValue

  const minted = []
  const authFn = () => ({
    createCustomToken: async (uid) => {
      minted.push(uid)
      return `custom-token-for-${uid}`
    },
    getUser: async (uid) => ({ uid, providerData: [] }),
    updateUser: async () => undefined,
    revokeRefreshTokens: async () => undefined,
  })
  fake.mintedTokens = minted

  /*
   * `defineProperty`, not assignment.
   *
   * `admin.firestore` and `admin.auth` are GETTER-ONLY accessors on
   * `FirebaseNamespace.prototype`. A plain `admin.firestore = fn` is a write to
   * an accessor with no setter, which in non-strict code fails SILENTLY — the
   * assignment appears to work, the getter still wins, and the handler goes to
   * the real SDK and throws `app/no-app`. That is exactly what happened on the
   * first run of this file, and it is worth the comment because the failure
   * mode is invisible rather than loud.
   *
   * Defining an own property on the instance shadows the prototype accessor.
   */
  Object.defineProperty(admin, 'firestore', {
    value: firestoreFn, configurable: true, writable: true,
  })
  Object.defineProperty(admin, 'auth', {
    value: authFn, configurable: true, writable: true,
  })
  return fake
}

module.exports = { installFakeFirestore, FakeFirestore, Timestamp, FieldValue }
