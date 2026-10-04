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
 * It does not model real contention. `runTransaction` below serialises through a
 * promise chain, which is enough to prove single-use semantics for two
 * overlapping redemptions but is not Firestore's optimistic retry.
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
  async get() { return new Snapshot(this.id, this._store._docs.get(this.path), this) }
  async set(data, opts) {
    const prior = this._store._docs.get(this.path)
    const next = materialise(data)
    this._store._docs.set(
      this.path,
      opts && opts.merge && prior ? { ...prior, ...next } : next,
    )
    this._store.writes++
  }
  async update(data) {
    const prior = this._store._docs.get(this.path)
    if (!prior) throw new Error(`update on missing document ${this.path}`)
    this._store._docs.set(this.path, { ...prior, ...materialise(data) })
    this._store.writes++
  }
  async delete() {
    this._store._docs.delete(this.path)
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
    if (op !== '==' && op !== '<=') {
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
      .filter(([p]) => p.startsWith(prefix))
      .map(([p, d]) => ({ id: p.slice(prefix.length), data: d, path: p }))

    for (const f of this._filters) {
      rows = rows.filter((r) => {
        const v = r.data[f.field]
        if (f.op === '==') return v === f.value
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
  }
  collection(name) { return new CollectionRef(this, name) }

  /**
   * Serialised, not optimistic.
   *
   * Firestore retries a transaction whose read set changed. This queues them
   * instead, which is enough to prove that two overlapping redemptions cannot
   * both claim one challenge — and is honestly weaker than the real thing.
   */
  runTransaction(fn) {
    const run = this._txChain.then(() => fn({
      get: (ref) => ref.get(),
      set: (ref, data, opts) => { void ref.set(data, opts) },
      update: (ref, data) => { void ref.update(data) },
      delete: (ref) => { void ref.delete() },
    }))
    this._txChain = run.catch(() => undefined)
    return run
  }

  // ── helpers for tests ─────────────────────────────────────────────────────
  seed(path, data) { this._docs.set(path, materialise(data)); return this }
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
function installFakeFirestore() {
  const fake = new FakeFirestore()
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
