package com.zipper.app.data.repository

import android.net.Uri
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.firestore.FieldValue
import com.google.firebase.firestore.FirebaseFirestore
import com.google.firebase.firestore.Query
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageMetadata
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
        data object Ok : Result
        /** Already has one waiting. Filing a second does not make it go faster. */
        data object AlreadyPending : Result
        data class Failed(val message: String) : Result
    }

    /** The statement has to actually say something. */
    private companion object {
        const val MIN_STATEMENT = 20
        const val MAX_EVIDENCE = 3
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
            !firestore.collection("appeals")
                .whereEqualTo("subjectUid", uid)
                .whereEqualTo("status", "pending")
                .limit(1)
                .get()
                .await()
                .isEmpty
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
        if (text.length < MIN_STATEMENT) {
            return Result.Failed(
                "Tell us what happened, in at least $MIN_STATEMENT characters. " +
                "This is what a person reads when they look at your account."
            )
        }

        // No session — the ordinary case for a ban now. Checked before anything
        // that needs one, because everything below needs one.
        val user = auth.currentUser ?: return appealWithoutSession(text)

        val uid = user.uid
        if (pendingAppeal()) return Result.AlreadyPending

        return try {
            val urls = mutableListOf<String>()
            evidence.take(MAX_EVIDENCE).forEachIndexed { i, uri ->
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
                    /* One unusable file must not cost them the appeal. */
                }
            }

            val name = try {
                firestore.collection("users").document(uid).get().await()
                    .getString("name").orEmpty()
            } catch (_: Exception) {
                ""
            }

            // The key set here must match `appealFields()` in firestore.rules
            // exactly — the rule uses `hasOnly`, so one extra key is a refusal
            // of the whole write.
            firestore.collection("appeals").add(
                mapOf(
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
            ).await()
            Result.Ok
        } catch (e: Exception) {
            Result.Failed(e.message ?: "Your appeal could not be sent. Try again.")
        }
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
    private suspend fun appealWithoutSession(text: String): Result {
        val saved = quickLogin.load()
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
                else Result.Ok

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
                .limit(5)
                .get()
                .await()
                .documents
                .map { it.data.orEmpty() }
        } catch (_: Exception) {
            emptyList()
        }
    }
}
