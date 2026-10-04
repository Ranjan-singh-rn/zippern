package com.zipper.app.util

import com.google.firebase.Timestamp
import com.google.firebase.firestore.DocumentSnapshot

/**
 * Read a moment in time from Firestore as epoch millis, whatever it was stored as.
 *
 * ── The bug this exists to end ────────────────────────────────────────────────
 *
 * The Cloud Functions write `FieldValue.serverTimestamp()`, which lands as a
 * Firestore `Timestamp`. The app, written earlier, stored and read
 * `System.currentTimeMillis()` — a `Long`. Both are "a time", and the two halves
 * of the system disagreed about which:
 *
 *   - `doc.getLong("timestamp")` on a Timestamp THROWS. It is not the lenient read
 *     it looks like: `getLong` goes through `getTypedValue`, which tests
 *     `Long.class.isInstance(value)` and raises a RuntimeException the moment that
 *     fails. There is no null to fall back to — the field is populated, just not
 *     with the type being asked for. So a bean or diamond history row read that way
 *     does not quietly deserialise with timestamp 0 and sort into nonsense; it takes
 *     the snapshot callback down with it, and the list stays empty with nothing on
 *     screen to point at.
 *   - `toObject(ActiveCall::class.java)` with `startedAt: Long` against a Timestamp
 *     fails the same way one layer up, inside the mapper. Incoming calls never rang
 *     and the in-call screen never left "connecting", because the listener died on
 *     the first populated document.
 *
 * So there was never a forgiving half to this mismatch to leave alone — both sides
 * throw, and both throws land inside a listener where there is nobody to catch them.
 *
 * Neither side was wrong on its own. The server should write server time — a
 * device clock is not evidence of when a call started. And the app should hold
 * millis, because that is what Compose, `SimpleDateFormat` and every existing
 * screen expect. This is the seam between them.
 *
 * Accepts a `Timestamp`, a `Long`, a `Double`, or nothing, and returns millis
 * or [default]. Use it everywhere a time is read from a document; never
 * `getLong` on a time field again.
 */
fun DocumentSnapshot.millis(field: String, default: Long = 0L): Long =
    when (val v = get(field)) {
        is Timestamp -> v.toDate().time
        is Long -> v
        is Int -> v.toLong()
        is Double -> v.toLong()
        is java.util.Date -> v.time
        else -> default
    }

/** Same, for a value already pulled out of a map (e.g. a nested field). */
fun Any?.asMillis(default: Long = 0L): Long =
    when (this) {
        is Timestamp -> toDate().time
        is Long -> this
        is Int -> toLong()
        is Double -> toLong()
        is java.util.Date -> time
        else -> default
    }
