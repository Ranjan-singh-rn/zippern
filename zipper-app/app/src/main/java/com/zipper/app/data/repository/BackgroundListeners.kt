package com.zipper.app.data.repository

import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * O10 (5 Nov 2026), speed: where the busy Firestore listeners run their callbacks.
 *
 * `addSnapshotListener { … }` without an executor calls back on the MAIN thread, so parsing a live room's viewers,
 * summing its gifts or sorting the live list competed with drawing the screen — in a busy room, on every heartbeat.
 * These listeners pass this executor instead and hand only the finished list to the flow. One thread, so a listener's
 * snapshots are still delivered in order.
 */
object BackgroundListeners {
    val executor: Executor = Executors.newSingleThreadExecutor { r ->
        Thread(r, "firestore-listeners").apply { isDaemon = true; priority = Thread.NORM_PRIORITY - 1 }
    }
}
