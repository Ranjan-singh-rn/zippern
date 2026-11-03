package com.zipper.app.data.repository

import android.net.Uri
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.DocumentReference
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.FirebaseFirestoreException
import com.google.firebase.firestore.Query
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageMetadata
import com.zipper.app.util.AppealIds
import com.zipper.app.util.DeviceKey
import com.zipper.app.util.QuickLoginStore
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Appealing a ban or a suspension.
 *
 * ── TWO ROUTES, BECAUSE THE SESSION IS NO LONGER THERE ───────────────────────
 *
 * This file used to open by saying that `isBanned` gates the PRODUCT and not the
 * session, so a banned person is still signed in — "which is what makes this
 * possible at all". That was true, and it stopped being true.
 *
 * Banning now calls `set_user_disabled(uid, True)` on the server, which disables
 * the Firebase login AND revokes its refresh tokens. The session is gone within
 * the second. So the authenticated write below — the one `firestore.rules`
 * permits because `raisedByUid == request.auth.uid` — became a write nobody
 * banned could make, and the person a reviewer most needs to hear from had no
 * way to say anything.
 *
 *   SIGNED IN     the direct Firestore write, with evidence uploads. Still the
 *                 path for a SUSPENDED account reached through normal sign-in,
 *                 and for an agency filing on a host's behalf.
 *
 *   NO SESSION    `submitAccountAppeal`, proved by a signature from this
 *                 handset's Keystore key over a server-issued challenge. No
 *                 evidence files — Cloud Storage needs a signed-in caller — so
 *                 the statement is all that travels.
 *
 * The second is a stronger claim than the first, not a weaker one. A session
 * says somebody holds a token for this account. A device signature says somebody
 * is holding the physical phone the account was last signed out from, and the
 * private half of that key cannot be copied off it.
 *
 * ── WHAT NEITHER ROUTE CAN DO ────────────────────────────────────────────────
 *
 * Decide anything. Both write `status: 'pending'`, the rules refuse every update
 * from a browser or a phone, and the verdict comes from
 * `POST /users/appeals/{id}/decide` on the server, where it is audited and where
 * a four-eyes check stops the person who made the original decision from also
 * deciding the appeal against it.
 */
@Singleton
class AppealRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val firestore: FirebaseFirestore,
    private val storage: FirebaseStorage,
    private val money: MoneyFunctions,
    private val quickLogin: QuickLoginStore,
    private val deviceKey: DeviceKey,
) {

    sealed interface Result {
        /**
         * Filed. `evidenceDropped` counts screenshots that would not upload.
         *
         * The appeal is still sent — losing somebody's written account because
         * a photograph failed is the wrong trade — but it is NOT silent any
         * more. The upload catch below used to swallow the failure entirely,
         * so a user watched their thumbnail appear, submitted, and never
         * learned the reviewer would see nothing.
         */
        data class Ok(val evidenceDropped: Int = 0) : Result
        /** Already has one waiting. Filing a second does not make it go faster. */
        data object AlreadyPending : Result
        data class Failed(val message: String) : Result
    }

    // The statement rule — the minimum, the trimmed length, the message —
    // lives in `AppealStatement`, which imports nothing and is therefore
    // provable without a device. It used to be spelled out here AND on the
    // Send button AND beside the character count; see that file for what
    // three copies of one rule cost.

    /**
     * C9 (B26): which appeal this phone can actually send right now.
     *
     * Signed in → the ordinary form. Not signed in, but holding this device's
     * quick-login credential AND its Keystore key → the same form, sent by
     * [appealWithoutSession]. Neither → the web appeal. The screen used to ask
     * only "is anybody signed in", so the device-key route below was never
     * offered to the people it exists for: a quick-login ban or suspension
     * issues no session at all. The decision itself is the pure
     * [com.zipper.app.util.AppealRoute.decide].
     */
    suspend fun appealRoute(): com.zipper.app.util.AppealRoute.Route {
        if (auth.currentUser != null) {
            return com.zipper.app.util.AppealRoute.decide(
                signedIn = true, hasQuickLoginCredential = false, hasDeviceKey = false,
            )
        }
        // QA #55: a restriction found by a refused sign-in, whose account this
        // phone's key could not be shown to be, is appealed on the web — the
        // key would file the appeal for its own account, maybe another one.
        if (!com.zipper.app.util.PublicAppeal.deviceKeyAppealAllowed) {
            return com.zipper.app.util.AppealRoute.Route.Web
        }
        // B10: the credential that speaks for THE restricted account — never another one this device remembers.
        val credential = try { appealCredential() != null } catch (_: Exception) { false }
        val key = try { deviceKey.hasKey() } catch (_: Exception) { false }
        return com.zipper.app.util.AppealRoute.decide(
            signedIn = false, hasQuickLoginCredential = credential, hasDeviceKey = key,
        )
    }

    /**
     * Is there already an appeal waiting on a decision for this account?
     *
     * Checked before the form is shown, so somebody who appealed yesterday sees
     * "we have it, it is with a reviewer" rather than an empty box that invites
     * them to say the same thing again. A queue of duplicate appeals from one
     * person delays every other appeal in it.
     */
    suspend fun pendingAppeal(): Boolean {
        val uid = auth.currentUser?.uid ?: return false
        return try {
            firestore.collection("appeals")
                .whereEqualTo("subjectUid", uid)
                .whereEqualTo("status", "pending")
                // Room for public-web filings (filtered out below) not to
                // crowd out the owner's own.
                .limit(20)
                .get()
                .await()
                .documents
                // UGP review: an appeal filed on the PUBLIC web form proves
                // nothing about who filed it, so it does not stop the signed-in
                // owner from filing their own (the server's device-key path
                // applies the same rule).
                .any { it.getString("source") != PUBLIC_WEB_SOURCE }
        } catch (_: Exception) {
            // A read that failed is not a "no". Returning false here shows the
            // form, and a duplicate appeal is a far smaller problem than
            // telling somebody they have already appealed when they have not.
            false
        }
    }

    /**
     * File an appeal about my own account.
     *
     * Evidence is optional and capped. An upload that fails does not fail the
     * appeal — the statement is the part that matters, and losing somebody's
     * written account of what happened because a photograph would not upload
     * is the wrong trade.
     */
    suspend fun appealMyBan(statement: String, evidence: List<Uri>): Result {
        val text = statement.trim()
        if (!AppealStatement.isSendable(statement)) {
            return Result.Failed(AppealStatement.TOO_SHORT)
        }

        // No session — the ordinary case for a ban now. Checked before anything
        // that needs one, because everything below needs one.
        val user = auth.currentUser ?: return appealWithoutSession(text)

        val uid = user.uid
        if (pendingAppeal()) return Result.AlreadyPending

        return try {
            // FX-13 (RF-19): where this appeal goes — the restriction's
            // deterministic slot — found BEFORE any evidence is uploaded, so a
            // second filing for the same restriction stops here.
            val account = try {
                firestore.collection("users").document(uid).get().await()
            } catch (_: Exception) {
                null
            }
            val key = AppealIds.restrictionKey(
                isSuspended = account?.getBoolean("isSuspended") == true,
                isBanned = account?.getBoolean("isBanned") == true,
                accountState = account?.getString("accountState"),
                suspendedAtMs = account?.getTimestamp("suspendedAt")?.toDate()?.time,
                bannedAtMs = account?.getTimestamp("bannedAt")?.toDate()?.time,
            )
            val placement = freeAppealSlot(uid, key) ?: return Result.AlreadyPending
            val slot = placement.ref
            // RC (confirmed): "another appeal after a decision only with new
            // evidence or a valid reason". Repeating the decided statement with
            // no new evidence is refused here, before anything is uploaded —
            // the rules refuse it anyway (`reappealOk` in firestore.rules).
            if (placement.decidedStatement != null && evidence.isEmpty() &&
                AppealStatement.normalise(text) == AppealStatement.normalise(placement.decidedStatement)
            ) {
                return Result.Failed(AppealStatement.REAPPEAL_NEEDS_SOMETHING_NEW)
            }

            val urls = mutableListOf<String>()
            var dropped = 0
            evidence.take(AppealStatement.MAX_EVIDENCE).forEachIndexed { i, uri ->
                try {
                    val ref = storage.reference.child(
                        "appealEvidence/$uid/${System.currentTimeMillis()}_$i.jpg"
                    )
                    ref.putFile(
                        uri,
                        StorageMetadata.Builder().setContentType("image/jpeg").build(),
                    ).await()
                    urls += ref.downloadUrl.await().toString()
                } catch (_: Exception) {
                    // One unusable file must not cost them the appeal — but
                    // the count is carried back so the screen can say so.
                    // The common cause is the 5 MB cap in storage.rules
                    // against an un-resized gallery photograph.
                    dropped += 1
                }
            }

            val name = account?.getString("name").orEmpty()

            // The key set here must match `appealFields()` in firestore.rules
            // exactly — the rule uses `hasOnly`, so one extra key is a refusal
            // of the whole write.
            val appeal = mapOf(
                "subjectUid" to uid,
                "subjectName" to name,
                "raisedByUid" to uid,
                "raisedByName" to name,
                "raisedByRole" to "self",
                "agencyId" to "",
                "kind" to "ban",
                "reportId" to "",
                "statement" to text,
                "evidenceUrls" to urls,
                "status" to "pending",
                "createdAt" to FieldValue.serverTimestamp(),
                "originalDecidedBy" to "",
            )
            // CREATE semantics: the rules allow no update on `appeals`, so if
            // the other path (or another device) filed at this id in the
            // meantime, this write is refused — and that is "already pending".
            try {
                slot.set(appeal).await()
            } catch (e: FirebaseFirestoreException) {
                if (e.code == FirebaseFirestoreException.Code.PERMISSION_DENIED && slotTaken(slot)) {
                    return Result.AlreadyPending
                }
                throw e
            }
            Result.Ok(dropped)
        } catch (e: Exception) {
            Result.Failed(e.message ?: "Your appeal could not be sent. Try again.")
        }
    }

    /** The free slot, and the statement of the decided appeal just before it (null at slot 1). */
    private data class Placement(val ref: DocumentReference, val decidedStatement: String?)

    /**
     * FX-13: the first slot for this restriction that is free, stepping past
     * DECIDED appeals; null when one is still pending. Reading a slot that
     * does not exist is refused by the rules (nobody may read an appeal that
     * is not theirs, and an absent one is nobody's) — here that means "free".
     * RC: every slot decided → null too. The rules accept only the pinned ids,
     * so there is nowhere left to file (no automatic-id fallback any more).
     *
     * The walk itself is `AppealIds.chooseSlot` (pure, run by `AppealIdsTest`);
     * this only reads each slot for it.
     */
    private suspend fun freeAppealSlot(uid: String, key: String): Placement? {
        val col = firestore.collection("appeals")
        val choice = AppealIds.chooseSlot { n ->
            val snap = try {
                col.document(AppealIds.selfAppealId(uid, key, n)).get().await()
            } catch (e: FirebaseFirestoreException) {
                if (e.code == FirebaseFirestoreException.Code.PERMISSION_DENIED) null else throw e
            }
            if (snap == null || !snap.exists()) {
                AppealIds.SlotRead(exists = false)
            } else {
                AppealIds.SlotRead(exists = true, status = snap.getString("status"), statement = snap.getString("statement"))
            }
        }
        // Pending, or every slot decided: nothing is filed (an automatic id is refused).
        val free = choice as? AppealIds.SlotChoice.Free ?: return null
        return Placement(col.document(AppealIds.selfAppealId(uid, key, free.slot)), free.decidedStatement)
    }

    /** Is there now an appeal at this slot (filed by the other path meanwhile)? */
    private suspend fun slotTaken(ref: DocumentReference): Boolean = try {
        ref.get().await().exists()
    } catch (_: Exception) {
        false
    }

    /**
     * File an appeal with no session, proved by this handset's device key.
     *
     * ── THE THREE STEPS, AND WHY THEY ARE THE SAME THREE ─────────────────────
     *
     * Challenge, sign, submit — identical to quick-login redemption, because the
     * question is identical: is the caller holding the device this account was
     * last signed out from? Reusing the machinery means one verification path on
     * the server rather than two, and the second one is always the one that rots.
     *
     * ── WHEN THIS CANNOT WORK, AND WHAT IT SAYS INSTEAD ──────────────────────
     *
     * It needs the credential AND the key. A person who cleared Block Store, or
     * reinstalled after a ban (a reinstall mints a new Keystore key, so the old
     * credential's signature cannot be produced any more), has neither — and
     * there is nothing this can do about that. It says so, and points at support,
     * rather than failing with something that sounds like a bug they could retry
     * their way out of.
     */
    /**
     * B10: which saved credential files the appeal. This device may remember several accounts, and the server
     * files a session-less appeal for whichever account the credential belongs to — so it must be the restricted
     * account's own (the uid the refused sign-in proved, [com.zipper.app.util.PublicAppeal.lastRestrictedUid]).
     * With no uid known, only a device that remembers exactly one account can say whose it is.
     */
    private suspend fun appealCredential(): com.zipper.app.util.QuickLoginStore.Saved? {
        val all = quickLogin.loadAll().ifEmpty { listOfNotNull(quickLogin.load()) }
        return com.zipper.app.util.QuickLoginStore.credentialFor(all, com.zipper.app.util.PublicAppeal.lastRestrictedUid)
    }

    private suspend fun appealWithoutSession(text: String): Result {
        val saved = appealCredential()
        if (saved == null || !deviceKey.hasKey()) {
            return Result.Failed(
                "This device can no longer prove which account it belongs to, so " +
                "an appeal cannot be sent from here. Please contact support."
            )
        }

        val challenge = when (val res = money.quickLoginChallenge()) {
            is MoneyFunctions.Result.Ok -> res.value
            is MoneyFunctions.Result.Failed -> return Result.Failed(res.userMessage)
        }
        if (challenge.challenge.isBlank() || challenge.challengeId.isBlank()) {
            return Result.Failed("Your appeal could not be sent. Try again.")
        }

        val signature = deviceKey.sign(challenge.challenge)
            ?: return Result.Failed(
                "This device could not verify itself. Please contact support."
            )

        return when (
            val res = money.submitAccountAppeal(
                token = saved.token,
                challengeId = challenge.challengeId,
                signature = signature,
                // Empty on purpose. The server does not consult the device ban
                // for an appeal — a barred handset and a banned account are two
                // different facts, and somebody with both must still be able to
                // appeal the account one. The id is sent only for the audit
                // fingerprint, which this path does not need.
                deviceId = "",
                statement = text,
            )
        ) {
            is MoneyFunctions.Result.Ok ->
                // `already_pending` is not a failure. Filing a second does not
                // make the first go faster, and the screen says so.
                if (res.value.status == "already_pending") Result.AlreadyPending
                // The session-less path carries no evidence — the callable
                // takes a statement only — so nothing can have been dropped.
                else Result.Ok()

            is MoneyFunctions.Result.Failed -> Result.Failed(res.userMessage)
        }
    }

    /** My own appeals, newest first — so the screen can show what came of one. */
    suspend fun myAppeals(): List<Map<String, Any?>> {
        val uid = auth.currentUser?.uid ?: return emptyList()
        return try {
            firestore.collection("appeals")
                .whereEqualTo("subjectUid", uid)
                .orderBy("createdAt", Query.Direction.DESCENDING)
                .limit(20)
                .get()
                .await()
                .documents
                // Not a public-web appeal: anybody can file one naming this
                // account, and its outcome is not "your last appeal".
                .filter { it.getString("source") != PUBLIC_WEB_SOURCE }
                .map { it.data.orEmpty() }
        } catch (_: Exception) {
            emptyList()
        }
    }

    private companion object {
        /** `appeals.source` of one filed on the public web form (backend `public_appeals.SOURCE`). */
        const val PUBLIC_WEB_SOURCE = "public_web"
    }
}
