package com.zipper.app.data.repository

import android.content.Context
import com.google.firebase.functions.FirebaseFunctions
import com.google.firebase.functions.FirebaseFunctionsException
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.tasks.await
import com.zipper.app.util.AppBuild
import com.zipper.app.util.ServerRefusals
import com.zipper.app.util.SessionManager
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The app's single door to server-side money movement.
 *
 * Every balance change now happens in a Cloud Function. The app says what the
 * user wants; the server decides the price, whether it is allowed, and what to
 * record. Nothing here sends an amount — `settleGift` takes a gift id, not a
 * cost, and `tickCall` takes a call id, not a duration.
 *
 * ── Idempotency is the caller's job ──────────────────────────────────────────
 *
 * Each call carries a key that is stable across retries of the SAME user
 * action. Generate it once when the user taps, and reuse it for every retry of
 * that tap. A fresh key per retry defeats the entire mechanism — the server
 * would see two different requests and charge twice.
 *
 * [newIdempotencyKey] exists to make that explicit at the call site.
 */
@Singleton
class MoneyFunctions @Inject constructor(
    private val functions: FirebaseFunctions,
    /**
     * Phase 1A (SESSION-001): the one active mobile session's id, sent on every
     * callable so the server can refuse a displaced device on protected
     * operations (`assertActiveSession`). Read at call time, never cached.
     */
    private val sessionManager: SessionManager,
    /** D18: only to read the installed versionCode for the sign-in gate. */
    @ApplicationContext private val appContext: Context,
) {

    /** D18: the installed build, read once per process (an update restarts the process). */
    private val appVersionCode: Int by lazy { AppBuild.installedVersionCode(appContext) }

    sealed interface Result<out T> {
        data class Ok<T>(val value: T) : Result<T>
        /**
         * [userMessage] comes from the server and is written to be shown as-is —
         * "This costs 900, you have 420" rather than a code the app has to
         * translate and will translate wrongly.
         *
         * [detail] is the server's OWN name for the refusal, out of the
         * `details` payload of the `HttpsError` — `expired`, `revoked`,
         * `device_banned`, `rate_limited` and so on. [code] is only the gRPC
         * status the SDK mapped it to, and `permission-denied` is where half the
         * quick-login refusals land, so it cannot tell them apart. Empty for
         * every call that does not send one, which is most of them.
         */
        data class Failed(
            val code: String,
            val userMessage: String,
            val detail: String = "",
        ) : Result<Nothing>
    }

    /** One key per user action. Reuse it for retries of that same action. */
    fun newIdempotencyKey(): String = UUID.randomUUID().toString()

    // ── Gifts ────────────────────────────────────────────────────────────────

    /**
     * The server's roll on a lucky gift (spec §11). Shown, never computed
     * here: `reward = multiplier × unit`, drawn server-side from the CRM's odds
     * table inside the same transaction as the charge.
     */
    data class LuckyOutcome(
        val combo: Int,
        /** One gift's catalogue price. */
        val unit: Long,
        /** 5–100. */
        val multiplier: Int,
        /** Diamonds credited back to the sender: `multiplier × unit`. */
        val reward: Long,
        /** `appConfig/luckyGifts.version` the roll ran on, for a dispute. */
        val configVersion: Long,
    )

    data class GiftOutcome(
        val transactionId: String,
        val totalCost: Long,
        val beansCredited: Long,
        val receiverPct: Int,
        /** True when the server recognised a replay and charged nothing. */
        val replayed: Boolean,
        /** Non-null for a lucky gift. */
        val lucky: LuckyOutcome? = null,
    )

    /**
     * Send a gift.
     *
     * [combo] is the lucky shape, [quantity] the normal one, and the server
     * refuses the wrong one for the gift: a lucky gift without a combo, a
     * normal gift with one. Exactly one of the two is sent.
     */
    suspend fun settleGift(
        giftId: String,
        receiverUid: String,
        quantity: Int,
        context: String,
        roomId: String? = null,
        idempotencyKey: String,
        combo: Int? = null,
    ): Result<GiftOutcome> = call("settleGift", buildMap {
        put("giftId", giftId)
        put("receiverUid", receiverUid)
        if (combo != null) put("combo", combo) else put("quantity", quantity)
        put("context", context)
        put("idempotencyKey", idempotencyKey)
        roomId?.let { put("roomId", it) }
    }) { m ->
        @Suppress("UNCHECKED_CAST")
        val lucky = (m["lucky"] as? Map<String, Any?>)?.let { l ->
            LuckyOutcome(
                combo         = (l["combo"] as? Number)?.toInt() ?: (combo ?: 0),
                unit          = (l["unit"] as? Number)?.toLong() ?: 0L,
                multiplier    = (l["multiplier"] as? Number)?.toInt() ?: 0,
                reward        = (l["reward"] as? Number)?.toLong() ?: 0L,
                configVersion = (l["configVersion"] as? Number)?.toLong() ?: 0L,
            )
        }
        GiftOutcome(
            transactionId = m["transactionId"] as? String ?: "",
            totalCost     = (m["totalCost"] as? Number)?.toLong() ?: 0L,
            beansCredited = (m["beansCredited"] as? Number)?.toLong() ?: 0L,
            receiverPct   = (m["receiverPct"] as? Number)?.toInt() ?: 0,
            replayed      = m["replayed"] as? Boolean ?: false,
            lucky         = lucky,
        )
    }

    // ── Calls ────────────────────────────────────────────────────────────────

    data class CallStart(val callId: String, val perMinRateDiamonds: Long, val receiverPct: Int)

    suspend fun startCall(peerUid: String, idempotencyKey: String): Result<CallStart> =
        call("startCall", mapOf("peerUid" to peerUid, "idempotencyKey" to idempotencyKey)) { m ->
            CallStart(
                callId = m["callId"] as? String ?: "",
                perMinRateDiamonds = (m["perMinRateDiamonds"] as? Number)?.toLong() ?: 0L,
                receiverPct = (m["receiverPct"] as? Number)?.toInt() ?: 0,
            )
        }

    data class CallAccept(
        val callId: String,
        val status: String,
        val alreadyConnected: Boolean,
        // ── Per-minute billing (APK 20 / calls.ts) ──────────────────────────
        /** The server's clock at connection; the only thing elapsed time is measured from. */
        val startedAtMs: Long? = null,
        /** 1 on a fresh accept: the first full minute is charged on connect. */
        val minutesBilled: Long = 0L,
        /** `startedAtMs + minutesBilled × 60 000` — when the next minute is charged. */
        val billedThroughMs: Long? = null,
        val perMinRateDiamonds: Long = 0L,
        /** Diamonds taken for the first minute (0 on a replayed accept). */
        val charged: Long = 0L,
        /** Beans credited to the earner for it. */
        val beans: Long = 0L,
    )

    /**
     * The receiver picks up. The server stamps `startedAt` with its own clock —
     * the client must never set it, because that timestamp is the only thing
     * the charge is measured against — and charges the FIRST FULL MINUTE in
     * the same transaction.
     */
    suspend fun acceptCall(callId: String): Result<CallAccept> =
        call("acceptCall", mapOf("callId" to callId)) { m ->
            CallAccept(
                callId = m["callId"] as? String ?: callId,
                status = m["status"] as? String ?: "",
                alreadyConnected = m["alreadyConnected"] as? Boolean ?: false,
                startedAtMs = (m["startedAtMs"] as? Number)?.toLong(),
                minutesBilled = (m["minutesBilled"] as? Number)?.toLong() ?: 0L,
                billedThroughMs = (m["billedThroughMs"] as? Number)?.toLong(),
                perMinRateDiamonds = (m["perMinRateDiamonds"] as? Number)?.toLong() ?: 0L,
                charged = (m["charged"] as? Number)?.toLong() ?: 0L,
                beans = (m["beans"] as? Number)?.toLong() ?: 0L,
            )
        }

    /** Decline, cancel before pickup, or record a missed call. Moves no money. */
    suspend fun declineCall(callId: String, reason: String = "declined"): Result<Unit> =
        call("declineCall", mapOf("callId" to callId, "reason" to reason)) { }

    data class CallTick(
        /** Diamonds charged BY THIS TICK (whole minutes that fell due); 0 on most ticks. */
        val charged: Long,
        val beans: Long,
        /** The server has decided this call must stop — see [endReason]. */
        val endNow: Boolean,
        val status: String,
        // ── Per-minute billing (APK 20 / calls.ts) ──────────────────────────
        /** Whole minutes charged so far on this call. */
        val minutesBilled: Long = 0L,
        /** When the next whole minute is charged (`startedAtMs + minutesBilled × 60 000`). */
        val billedThroughMs: Long? = null,
        val nextChargeAtMs: Long? = null,
        val perMinRateDiamonds: Long = 0L,
        /** The server's clock at connection. */
        val startedAtMs: Long? = null,
        /** Seconds elapsed BY THE SERVER'S CLOCK when it answered. */
        val elapsedSeconds: Long = 0L,
        /** Further whole minutes the payer can afford; null on a free call, for the earner, or when unknown. */
        val affordableMinutes: Long? = null,
        /** `payer` or `earner` — which side this device is, as the server sees it. */
        val role: String = "",
        /** `insufficient_diamonds`, `party_restricted`, `session_displaced` when [endNow]. */
        val endReason: String? = null,
    )

    /**
     * Liveness ping — and the one source of truth for the figures on screen.
     *
     * No duration is sent. The server computes elapsed from the call's own
     * `startedAt` and charges WHOLE MINUTES from its own clock, so a device
     * with a moved clock, or one that stops calling this, changes nothing
     * about what is owed. Both devices call it every ten seconds; a tick from
     * the earner's device charges nothing and only refreshes the watchdog.
     */
    suspend fun tickCall(callId: String): Result<CallTick> =
        call("tickCall", mapOf("callId" to callId)) { m ->
            CallTick(
                charged = (m["charged"] as? Number)?.toLong() ?: 0L,
                beans   = (m["beans"] as? Number)?.toLong() ?: 0L,
                endNow  = m["endNow"] as? Boolean ?: false,
                status  = m["status"] as? String ?: "",
                minutesBilled = (m["minutesBilled"] as? Number)?.toLong()
                    ?: (m["tickIndex"] as? Number)?.toLong() ?: 0L,
                billedThroughMs = (m["billedThroughMs"] as? Number)?.toLong(),
                nextChargeAtMs = (m["nextChargeAtMs"] as? Number)?.toLong(),
                perMinRateDiamonds = (m["perMinRateDiamonds"] as? Number)?.toLong() ?: 0L,
                startedAtMs = (m["startedAtMs"] as? Number)?.toLong(),
                elapsedSeconds = (m["elapsedSeconds"] as? Number)?.toLong() ?: 0L,
                affordableMinutes = (m["affordableMinutes"] as? Number)?.toLong(),
                role = m["role"] as? String ?: "",
                endReason = m["endReason"] as? String,
            )
        }

    data class CallEnd(
        val durationSeconds: Long,
        val diamondsCharged: Long,
        val beansCredited: Long,
        /** Whole minutes billed in total, including the one in progress at the end. */
        val minutesBilled: Long = 0L,
        val billedThroughMs: Long? = null,
        /** The server's reason, which stands over whatever the client sent. */
        val endReason: String? = null,
        val alreadyEnded: Boolean = false,
    )

    suspend fun endCall(callId: String, reason: String = "user_ended"): Result<CallEnd> =
        call("endCall", mapOf("callId" to callId, "reason" to reason)) { m ->
            CallEnd(
                durationSeconds = (m["durationSeconds"] as? Number)?.toLong() ?: 0L,
                diamondsCharged = (m["diamondsCharged"] as? Number)?.toLong() ?: 0L,
                beansCredited   = (m["beansCredited"] as? Number)?.toLong() ?: 0L,
                minutesBilled   = (m["minutesBilled"] as? Number)?.toLong() ?: 0L,
                billedThroughMs = (m["billedThroughMs"] as? Number)?.toLong(),
                endReason       = m["endReason"] as? String,
                alreadyEnded    = m["alreadyEnded"] as? Boolean ?: false,
            )
        }

    // ── Wallet ───────────────────────────────────────────────────────────────

    data class Conversion(val beansSpent: Long, val diamondsGained: Long, val rate: Double)

    suspend fun convertBeans(beansAmount: Long, idempotencyKey: String): Result<Conversion> =
        call("convertBeans", mapOf("beansAmount" to beansAmount, "idempotencyKey" to idempotencyKey)) { m ->
            Conversion(
                beansSpent     = (m["beansSpent"] as? Number)?.toLong() ?: 0L,
                diamondsGained = (m["diamondsGained"] as? Number)?.toLong() ?: 0L,
                rate           = (m["rate"] as? Number)?.toDouble() ?: 0.0,
            )
        }

    data class DailyReward(val day: Int, val diamonds: Long, val videoCards: Int)

    suspend fun claimDailyReward(): Result<DailyReward> =
        call("claimDailyReward", emptyMap()) { m ->
            DailyReward(
                day        = (m["day"] as? Number)?.toInt() ?: 0,
                diamonds   = (m["diamonds"] as? Number)?.toLong() ?: 0L,
                videoCards = (m["videoCards"] as? Number)?.toInt() ?: 0,
            )
        }

    data class BagPurchase(
        val itemId: String,
        val pricePaid: Long,
        val durationDays: Int,
        val expiresAtMs: Long?,
        /** True when this renewal added days to an item that had not expired. */
        val extended: Boolean,
    )

    suspend fun purchaseBagItem(
        itemId: String,
        durationDays: Int? = null,
        idempotencyKey: String,
    ): Result<BagPurchase> = call("purchaseBagItem", buildMap {
        put("itemId", itemId)
        put("idempotencyKey", idempotencyKey)
        durationDays?.let { put("durationDays", it) }
    }) { m ->
        BagPurchase(
            itemId       = m["itemId"] as? String ?: itemId,
            pricePaid    = (m["pricePaid"] as? Number)?.toLong() ?: 0L,
            durationDays = (m["durationDays"] as? Number)?.toInt() ?: 0,
            expiresAtMs  = (m["expiresAt"] as? Number)?.toLong(),
            extended     = m["extended"] as? Boolean ?: false,
        )
    }

    data class EquipResult(
        /** The item now worn in this slot, or "" when the slot was cleared. */
        val equipped: String,
        val category: String,
    )

    /**
     * Wear a cosmetic, or pass an empty [itemId] to take one off.
     *
     * Server-side because the pointer fields on the user document are protected
     * now: the check is "do you own this, and has it expired", which needs a
     * lookup in `ownedItems` plus a clock — neither of which a security rule can
     * do. See `equipBagItem` in functions/src/wallet.ts.
     */
    suspend fun equipBagItem(itemId: String, category: String): Result<EquipResult> =
        call("equipBagItem", mapOf("itemId" to itemId, "category" to category)) { m ->
            EquipResult(
                equipped = m["equipped"] as? String ?: itemId,
                category = m["category"] as? String ?: category,
            )
        }

    // ── Identity ─────────────────────────────────────────────────────────────

    data class QuickLoginChallenge(
        val challengeId: String,
        /** The bytes to sign. Never stored, never logged. */
        val challenge: String,
        val expiresInMs: Long,
    )

    /**
     * Ask for something to sign.
     *
     * Step one of three. Unauthenticated — the caller has no session yet, which
     * is what it is asking for — and it discloses nothing: the response is
     * random bytes, and asking reveals no account and no device.
     *
     * Single-use and short-lived server-side. That is what stops a captured
     * signature being spent twice.
     */
    suspend fun quickLoginChallenge(): Result<QuickLoginChallenge> =
        call("quickLoginChallenge", emptyMap()) { m ->
            QuickLoginChallenge(
                challengeId = m["challengeId"] as? String ?: "",
                challenge   = m["challenge"] as? String ?: "",
                expiresInMs = (m["expiresInMs"] as? Number)?.toLong() ?: 0L,
            )
        }

    data class QuickLoginMint(
        val token: String,
        val displayName: String,
        val photoUrl: String,
        val expiresAtMs: Long,
    )

    /**
     * Ask for a quick-login credential for this device.
     *
     * The server keeps only `sha256(token)`, so what comes back here is the only
     * copy of the secret that will ever exist — and the secret is no longer
     * sufficient by itself. [publicKey] is this handset's Keystore public half,
     * and the server will demand a signature from the matching private key at
     * redemption. Without a key the server refuses to mint rather than quietly
     * issuing the old unbound kind.
     *
     * See [com.zipper.app.util.DeviceKey] and
     * [com.zipper.app.util.QuickLoginStore].
     */
    suspend fun mintQuickLoginToken(deviceId: String, publicKey: String): Result<QuickLoginMint> =
        call(
            "mintQuickLoginToken",
            mapOf("deviceId" to deviceId, "publicKey" to publicKey),
        ) { m ->
            QuickLoginMint(
                token       = m["token"] as? String ?: "",
                displayName = m["displayName"] as? String ?: "",
                photoUrl    = m["photoUrl"] as? String ?: "",
                expiresAtMs = (m["expiresAtMs"] as? Number)?.toLong() ?: 0L,
            )
        }

    data class QuickLoginRedemption(
        /**
         * `allow` — [customToken] is a session, and [token] is the ROTATED
         *           replacement that must be saved before anything else.
         * `banned` / `suspended` — the credential and the device both checked
         *           out, and the account is restricted. No session and no custom
         *           token, and the credential is deliberately KEPT, because it
         *           is the only thing left that can prove who is appealing.
         *
         * Every other outcome arrives as a [Result.Failed] with the server's
         * name for it in [Result.Failed.detail].
         */
        val outcome: String,
        val customToken: String,
        /** The replacement credential. Empty unless [outcome] is `allow`. */
        val token: String,
        val uid: String,
        val displayName: String,
        val photoUrl: String,
        val isProfileComplete: Boolean,
        val expiresAtMs: Long,
        /** Suspension only. */
        val reason: String,
        val suspendedUntilMs: Long?,
        val message: String,
    )

    /**
     * Spend the saved credential.
     *
     * Step three of three, and unauthenticated by nature. What makes it safe is
     * not the secret: it is [signature], which only the handset that minted the
     * credential can produce, over a [challengeId] the server issued and will
     * consume. A secret lifted out of a backup onto another phone arrives
     * without the Keystore key and authenticates nothing.
     *
     * On success the server has already destroyed the credential just spent and
     * issued a new one in [QuickLoginRedemption.token]. Save it immediately —
     * the old one no longer works, so dropping the new one costs the feature
     * until the next sign-out.
     */
    suspend fun redeemQuickLogin(
        token: String,
        challengeId: String,
        signature: String,
        deviceId: String,
    ): Result<QuickLoginRedemption> =
        call(
            "redeemQuickLogin",
            mapOf(
                "token" to token,
                "challengeId" to challengeId,
                "signature" to signature,
                "deviceId" to deviceId,
            ),
        ) { m ->
            QuickLoginRedemption(
                outcome           = m["outcome"] as? String ?: "",
                customToken       = m["customToken"] as? String ?: "",
                token             = m["token"] as? String ?: "",
                uid               = m["uid"] as? String ?: "",
                displayName       = m["displayName"] as? String ?: "",
                photoUrl          = m["photoUrl"] as? String ?: "",
                isProfileComplete = m["isProfileComplete"] as? Boolean ?: false,
                expiresAtMs       = (m["expiresAtMs"] as? Number)?.toLong() ?: 0L,
                reason            = m["reason"] as? String ?: "",
                suspendedUntilMs  = (m["suspendedUntilMs"] as? Number)?.toLong(),
                message           = m["message"] as? String ?: "",
            )
        }

    /**
     * QA #55 — what `quickLoginRestriction` said about the account this device
     * holds a quick-login key for. [outcome] is `banned`, `suspended`,
     * `device_banned`, `other_account` (the key is another account's — nothing
     * else is said) or `not_restricted`.
     */
    data class RestrictionNotice(
        val outcome: String,
        val uid: String,
        val reason: String,
        val message: String,
        val suspendedUntilMs: Long?,
    )

    /**
     * QA #55: Firebase refused a sign-in because the login is disabled (a ban).
     * Ask, with this handset's key, what happened to the account just tried —
     * [phone] / [email] are what the person signed in with. No session, no
     * token: an answer only when the key's account IS that sign-in.
     */
    suspend fun quickLoginRestriction(
        token: String,
        challengeId: String,
        signature: String,
        deviceId: String,
        phone: String,
        email: String,
    ): Result<RestrictionNotice> =
        call(
            "quickLoginRestriction",
            mapOf(
                "token" to token,
                "challengeId" to challengeId,
                "signature" to signature,
                "deviceId" to deviceId,
                "phone" to phone,
                "email" to email,
            ),
        ) { m ->
            RestrictionNotice(
                outcome = m["outcome"] as? String ?: "",
                uid = m["uid"] as? String ?: "",
                reason = m["reason"] as? String ?: "",
                message = m["message"] as? String ?: "",
                suspendedUntilMs = (m["suspendedUntilMs"] as? Number)?.toLong(),
            )
        }

    data class AppealSubmission(
        /** `submitted`, or `already_pending` when one is with a reviewer. */
        val status: String,
        val appealId: String,
    )

    /**
     * File an appeal with no session at all.
     *
     * ── WHY THIS EXISTS ──────────────────────────────────────────────────────
     *
     * A ban disables the Firebase login and revokes its tokens, so the person
     * who most needs to be heard — the one banned by mistake — has no session,
     * and the ordinary appeal is an authenticated Firestore write.
     *
     * The proof here is the same one redemption uses, and it is stronger than a
     * session would be: a signature over a server-issued challenge, from a key
     * that lives in this handset's Keystore. A session says somebody holds a
     * token; this says somebody is holding the phone the account was last signed
     * out from.
     *
     * No evidence files on this path. Cloud Storage rules need a signed-in
     * caller and there is none, so the statement is all that travels — which is
     * the part a reviewer reads.
     */
    suspend fun submitAccountAppeal(
        token: String,
        challengeId: String,
        signature: String,
        deviceId: String,
        statement: String,
    ): Result<AppealSubmission> =
        call(
            "submitAccountAppeal",
            mapOf(
                "token" to token,
                "challengeId" to challengeId,
                "signature" to signature,
                "deviceId" to deviceId,
                "statement" to statement,
            ),
        ) { m ->
            AppealSubmission(
                status   = m["status"] as? String ?: "",
                appealId = m["appealId"] as? String ?: "",
            )
        }

    /**
     * Retire a credential.
     *
     * [allDevices] is "sign out everywhere": it drops every credential the
     * account holds, on handsets this one cannot reach. Without it, only the
     * credential whose secret is supplied, and only if it belongs to the caller.
     */
    suspend fun revokeQuickLogin(token: String, allDevices: Boolean = false): Result<Int> =
        call(
            "revokeQuickLogin",
            buildMap<String, Any> {
                put("token", token)
                if (allDevices) put("allDevices", true)
            },
        ) { m ->
            (m["revoked"] as? Number)?.toInt() ?: 0
        }

    /**
     * B10 — "Remove this account from this device", on the server too.
     *
     * Needs no session, because the account being removed is usually not the one signed in: the proof is the one
     * redemption takes — the secret plus a signature from this handset's key over a fresh challenge — and all it
     * can do is delete that one credential. True when the server had it.
     */
    suspend fun forgetQuickLogin(
        token: String,
        challengeId: String,
        signature: String,
        deviceId: String,
    ): Result<Boolean> =
        call(
            "forgetQuickLogin",
            mapOf(
                "token" to token,
                "challengeId" to challengeId,
                "signature" to signature,
                "deviceId" to deviceId,
            ),
        ) { m ->
            m["removed"] == true
        }

    data class GuestClaim(
        /**
         * "no_guest"       — never had one here; the caller may create one.
         * "existing_guest" — [customToken] signs into [uid], or the caller is
         *                    already signed in as it.
         * "bound"          — the uid the caller sent is now this device's guest.
         * "unrecoverable"  — a guest is bound and this install cannot prove it
         *                    owns it. No token, and deliberately no replacement.
         * "conflict"       — the caller's account and the bound one both hold
         *                    data. Neither is chosen.
         * "upgraded"       — the bound account has its own credentials now.
         * "not_a_guest"    — the uid the caller offered is not a guest, so it is
         *                    not a candidate for the slot. Nothing written.
         * "device_banned"  — barred handset; no guest will be created.
         */
        val status: String,
        val uid: String,
        /** Present only for `existing_guest`. Signs into [uid]. */
        val customToken: String,
        val reason: String,
    )

    /**
     * Which guest account belongs to this device.
     *
     * Unauthenticated, like `redeemQuickLogin`, because the caller has no
     * session yet — that is what it is asking for.
     *
     * Asked TWICE on a first run, and the two calls mean different things. With
     * no `uid` it is a question: what does this device already own? With a `uid`
     * it is a request to bind the anonymous account the client has just created,
     * which the server grants only if nothing is bound yet. The client must never
     * create an account before the first answer comes back as `no_guest` — that
     * ordering is the entire point, and `signInAnonymously()` run first is the
     * duplicate-guest bug regardless of what is done with the result.
     *
     * @param deviceSecret proof of ownership. The device id alone selects an
     *   account but must never release one; see [com.zipper.app.util.DeviceSecretStore].
     */
    suspend fun claimGuestIdentity(
        deviceId: String,
        deviceSecret: String,
        uid: String = "",
    ): Result<GuestClaim> =
        call("claimGuestIdentity", buildMap {
            put("deviceId", deviceId)
            put("deviceSecret", deviceSecret)
            if (uid.isNotBlank()) put("uid", uid)
        }) { m ->
            GuestClaim(
                status      = m["status"] as? String ?: "",
                uid         = m["uid"] as? String ?: "",
                customToken = m["customToken"] as? String ?: "",
                reason      = m["reason"] as? String ?: "",
            )
        }

    /** Accounts that already exist for a phone or an email. Empty when there are none. */
    @Suppress("UNCHECKED_CAST")
    suspend fun findExistingAccount(phone: String, email: String): Result<List<ExistingAccount>> =
        call("findExistingAccount", buildMap {
            if (phone.isNotBlank()) put("phone", phone)
            if (email.isNotBlank()) put("email", email)
        }) { m ->
            (m["accounts"] as? List<*>).orEmpty().mapNotNull { row ->
                val r = row as? Map<String, Any?> ?: return@mapNotNull null
                ExistingAccount(
                    uid      = r["uid"] as? String ?: return@mapNotNull null,
                    name     = r["name"] as? String ?: "",
                    photoUrl = r["photoUrl"] as? String ?: "",
                    via      = r["via"] as? String ?: "",
                )
            }
        }

    /**
     * What the server says to do with the person who just authenticated.
     *
     * One call, asked once per sign-in, before any document is created. See
     * `resolveIdentity` in functions/src/identity.ts for why every one of these
     * is a server question rather than six client checks.
     */
    data class Identity(
        /**
         * "allow" | "observer_denied" | "deleted_recoverable" |
         * "deleted_permanent" | "suspended" | "banned" | "device_banned"
         */
        val decision: String,
        val uid: String,
        val exists: Boolean,
        val isProfileComplete: Boolean,
        val displayName: String,
        val photoUrl: String,
        /** The exact existing CRM role — `ops_admin`, `finance_member`, `agency` — or "". */
        val crmRole: String,
        val isHost: Boolean,
        /**
         * Still a guest — an anonymous account with no provider attached.
         *
         * Comes from the server because the client cannot answer it.
         * `FirebaseUser.isAnonymous` is FALSE after a quick sign-in: that path
         * redeems a custom token, which is the only way an anonymous account
         * can be recovered at all. So the one flag the app had reported "not a
         * guest" for exactly the returning guests who most needed to be told
         * their account lives on this handset alone.
         */
        val isGuest: Boolean,
        /** Ask for a phone ONLY when this is true. Ordinary users are never asked. */
        val requiresPhone: Boolean,
        /** Ask for an email ONLY when this is true. */
        val requiresEmail: Boolean,
        val deletionDueAtMs: Long,
        /** Why the refusal, for the suspended/banned/device-banned decisions. */
        val reason: String = "",
        /** When a suspension ends. 0 for indefinite. */
        val suspendedUntilMs: Long = 0L,
    ) {
        val isObserver: Boolean get() = decision == "observer_denied"
        val isRecoverable: Boolean get() = decision == "deleted_recoverable"
        val wasPermanentlyDeleted: Boolean get() = decision == "deleted_permanent"
    }

    /**
     * @param deviceId the handset asking. NOT optional in practice.
     *
     * This used to send `emptyMap()`, and the server reads `data.deviceId` to
     * answer two of its seven decisions. With nothing sent it saw `''` every
     * time, so `device_banned` was unreachable and `barDevice()` — the call
     * that spreads an account ban onto the handset that carried it — never
     * ran on a sign-in. The whole device-ban half of the ban feature was dead
     * from this one argument, and it failed silently, because a server that
     * is never told about a device cannot report one missing.
     */
    suspend fun resolveIdentity(deviceId: String = ""): Result<Identity> =
        // D18: the installed build rides along, so the server can count how
        // many accounts run a build that pins appeal ids. 0 is not sent.
        call(
            "resolveIdentity",
            buildMap {
                put("deviceId", deviceId)
                if (appVersionCode > 0) put("appVersionCode", appVersionCode)
            },
        ) { m ->
            Identity(
                decision          = m["decision"] as? String ?: "allow",
                uid               = m["uid"] as? String ?: "",
                exists            = m["exists"] as? Boolean ?: false,
                isProfileComplete = m["isProfileComplete"] as? Boolean ?: false,
                displayName       = m["displayName"] as? String ?: "",
                photoUrl          = m["photoUrl"] as? String ?: "",
                crmRole           = m["crmRole"] as? String ?: "",
                isHost            = m["isHost"] as? Boolean ?: false,
                isGuest           = m["isGuest"] as? Boolean ?: false,
                requiresPhone     = m["requiresPhone"] as? Boolean ?: false,
                requiresEmail     = m["requiresEmail"] as? Boolean ?: false,
                deletionDueAtMs   = (m["deletionDueAtMs"] as? Number)?.toLong() ?: 0L,
                reason            = m["reason"] as? String ?: "",
                suspendedUntilMs  = (m["suspendedUntilMs"] as? Number)?.toLong() ?: 0L,
            )
        }

    data class MobileSession(val sessionId: String, val replacedDeviceName: String)

    /**
     * Claim this device as the account's one active mobile session.
     *
     * Server-minted. The old form was a random string the CLIENT wrote, which
     * made the one-device rule a request rather than a rule — a patched app
     * could decline to write it and keep two phones alive for ever.
     */
    suspend fun startMobileSession(
        deviceId: String,
        platform: String = "android",
        deviceName: String = "",
    ): Result<MobileSession> = call("startMobileSession", mapOf(
        "deviceId" to deviceId,
        "platform" to platform,
        "deviceName" to deviceName,
    )) { m ->
        MobileSession(
            sessionId          = m["sessionId"] as? String ?: "",
            replacedDeviceName = m["replacedDeviceName"] as? String ?: "",
        )
    }

    /** Give up this device's claim. Only clears it if the session is still ours. */
    suspend fun endMobileSession(sessionId: String): Result<Boolean> =
        call("endMobileSession", mapOf("sessionId" to sessionId)) { m ->
            m["ended"] as? Boolean ?: false
        }

    /** Schedule deletion. Server sets the deadline — a device clock must not. */
    suspend fun requestAccountDeletion(): Result<Long> =
        call("requestAccountDeletion", emptyMap()) { m ->
            (m["dueAtMs"] as? Number)?.toLong() ?: 0L
        }

    /** Bind a phone or email the caller has just verified. See the three cases in identity.ts. */
    /**
     * What a bind answered. [customToken] is set only when this session began
     * ANONYMOUSLY: a token for the SAME uid, so the session stops reading as a
     * guest to checks that look at how it began (UGP D21 — see
     * `AuthRepository.adoptSameUidSession`).
     */
    data class Bound(val releasedFrom: List<String>, val customToken: String)

    suspend fun bindVerifiedIdentity(phone: String, email: String): Result<Bound> =
        call("bindVerifiedIdentity", buildMap {
            if (phone.isNotBlank()) put("phone", phone)
            if (email.isNotBlank()) put("email", email)
        }) { m ->
            Bound(
                releasedFrom = (m["releasedFrom"] as? List<*>).orEmpty().mapNotNull { it as? String },
                customToken = m["customToken"] as? String ?: "",
            )
        }

    // ── Email by one-time code (UGP-C; functions/src/emailOtp.ts) ───────────

    data class EmailCodeSent(
        /** "sent", or "already_bound" when this verified address is already on the account. */
        val status: String,
        /** Masked by the server ("s****@g****.com") — the app never echoes more. */
        val maskedEmail: String,
        val resendInSec: Int,
        val expiresInSec: Int,
        /**
         * With "already_bound" on a session that began anonymously: a token for
         * the SAME uid, exactly as a fresh bind would have returned (UGP-D21).
         */
        val customToken: String = "",
    )

    suspend fun requestEmailBindCode(email: String): Result<EmailCodeSent> =
        call("requestEmailBindCode", mapOf("email" to email)) { m ->
            EmailCodeSent(
                status = m["status"] as? String ?: "",
                maskedEmail = m["email"] as? String ?: "",
                resendInSec = (m["resendInSec"] as? Number)?.toInt() ?: 60,
                expiresInSec = (m["expiresInSec"] as? Number)?.toInt() ?: 600,
                customToken = m["customToken"] as? String ?: "",
            )
        }

    suspend fun verifyEmailBindCode(email: String, code: String): Result<Bound> =
        call("verifyEmailBindCode", mapOf("email" to email, "code" to code)) { m ->
            Bound(
                releasedFrom = (m["releasedFrom"] as? List<*>).orEmpty().mapNotNull { it as? String },
                customToken = m["customToken"] as? String ?: "",
            )
        }


    data class EmailAdoption(
        /** "adopted" — [customToken] signs into [uid]; "none" — keep the new account. */
        val status: String,
        val uid: String,
        val customToken: String,
        /** With `none`: why (`no_holder`, `caller_not_fresh`, …). See [GoogleAdoption.next]. */
        val reason: String = "",
    )

    /**
     * After a Google sign-in that CREATED a uid: does this verified email already
     * belong to exactly one other account (e.g. a guest that bound it)? If so the
     * server removes the new empty uid, links Google onto that account and returns
     * a token for it. See functions/src/emailAdoption.ts.
     */
    suspend fun adoptEmailAccount(): Result<EmailAdoption> =
        call("adoptEmailAccount", emptyMap()) { m ->
            EmailAdoption(
                status      = m["status"] as? String ?: "",
                uid         = m["uid"] as? String ?: "",
                customToken = m["customToken"] as? String ?: "",
                reason      = m["reason"] as? String ?: "",
            )
        }

    // ── Payout ───────────────────────────────────────────────────────────────

    data class PayoutStatus(
        val beans: Long,
        val beansAvailable: Long,
        val beansPending: Long,
        val nextReleaseAtMs: Long,
        val isVerifiedHost: Boolean,
        val payoutHold: Boolean,
    )

    suspend fun getPayoutStatus(): Result<PayoutStatus> =
        call("getPayoutStatus", emptyMap()) { m ->
            PayoutStatus(
                beans           = (m["beans"] as? Number)?.toLong() ?: 0L,
                beansAvailable  = (m["beansAvailable"] as? Number)?.toLong() ?: 0L,
                beansPending    = (m["beansPending"] as? Number)?.toLong() ?: 0L,
                nextReleaseAtMs = (m["nextReleaseAt"] as? Number)?.toLong() ?: 0L,
                isVerifiedHost  = m["isVerifiedHost"] as? Boolean ?: false,
                payoutHold      = m["payoutHold"] as? Boolean ?: false,
            )
        }

    // ── Host figures ─────────────────────────────────────────────────────────

    /**
     * Everything Host Home shows, in one round trip.
     *
     * Five reads collapsed into one call: today, the week, lifetime, the level
     * ladder position, and the payout position. The alternative was four
     * loading states on one screen.
     */
    suspend fun getHostHome(): Result<HostStatsRepository.HostHome> =
        call("getHostHome", emptyMap()) { m ->
            fun map(key: String): Map<String, Any?> {
                @Suppress("UNCHECKED_CAST")
                return (m[key] as? Map<String, Any?>) ?: emptyMap()
            }
            fun Map<String, Any?>.long(k: String) = (this[k] as? Number)?.toLong() ?: 0L
            fun Map<String, Any?>.int(k: String) = (this[k] as? Number)?.toInt() ?: 0
            fun Map<String, Any?>.str(k: String) = this[k] as? String ?: ""

            val today = map("today")
            val week = map("week")
            val lifetime = map("lifetime")
            val level = map("level")
            val payout = map("payout")

            HostStatsRepository.HostHome(
                today = HostStatsRepository.Today(
                    dayKey        = today.str("dayKey"),
                    beans         = today.long("beans"),
                    giftBeans     = today.long("giftBeans"),
                    callBeans     = today.long("callBeans"),
                    callSeconds   = today.long("callSeconds"),
                    calls         = today.int("calls"),
                    giftsReceived = today.int("giftsReceived"),
                ),
                week = HostStatsRepository.Week(
                    weekKey   = week.str("weekKey"),
                    beans     = week.long("beans"),
                    giftBeans = week.long("giftBeans"),
                    callBeans = week.long("callBeans"),
                ),
                lifetimeBeans     = lifetime.long("beans"),
                lifetimeCallBeans = lifetime.long("callBeans"),
                lifetimeGiftBeans = lifetime.long("giftBeans"),
                level = HostStatsRepository.Level(
                    level            = level.int("level"),
                    maxCallRateBeans = level.long("maxCallRateBeans"),
                    callRateBeans    = level.long("callRateBeans"),
                    nextLevel        = (level["nextLevel"] as? Number)?.toInt(),
                    beansToNextLevel = level.long("beansToNextLevel"),
                    nextLevelAt      = (level["nextLevelAt"] as? Number)?.toLong(),
                ),
                payout = HostStatsRepository.Payout(
                    beans          = payout.long("beans"),
                    beansAvailable = payout.long("beansAvailable"),
                    isVerifiedHost = payout["isVerifiedHost"] as? Boolean ?: false,
                    payoutHold     = payout["payoutHold"] as? Boolean ?: false,
                ),
            )
        }

    // ── Plumbing ─────────────────────────────────────────────────────────────

    @Suppress("UNCHECKED_CAST")
    private suspend fun <T> call(
        name: String,
        payload: Map<String, Any>,
        parse: (Map<String, Any?>) -> T,
    ): Result<T> = try {
        val res = functions.getHttpsCallable(name).call(sessionManager.withSession(payload)).await()
        val map = res.data as? Map<String, Any?>
            ?: return Result.Failed("internal", "Unexpected response from the server.")
        Result.Ok(parse(map))
    } catch (e: FirebaseFunctionsException) {
        // P0-1: a session refusal also signs this device out (SessionViewModel).
        ServerRefusals.report(e)
        // The server writes these messages for a person to read. Passing them
        // through beats inventing a generic one that hides the actual reason —
        // "you need 900 diamonds, you have 420" is the whole answer.
        Result.Failed(e.code.name, e.message ?: "Something went wrong.", detailCode(e))
    } catch (e: Exception) {
        Result.Failed("unavailable", "Could not reach the server. Check your connection.")
    }

    /**
     * The server's own name for a refusal, from `HttpsError`'s third argument.
     *
     * Quick login needs it: `expired`, `revoked`, `device_mismatch` and
     * `rate_limited` all arrive as `PERMISSION_DENIED`, and the client has to
     * treat them differently — one forgets the credential, one does not, one
     * says "wait a few minutes". Reading the message text to guess which is a
     * string comparison against a sentence somebody will reword.
     *
     * Returns "" rather than throwing on anything unexpected. A missing detail
     * must degrade to the generic path, never to a crash on a failure path.
     */
    @Suppress("UNCHECKED_CAST")
    private fun detailCode(e: FirebaseFunctionsException): String = try {
        ((e.details as? Map<String, Any?>)?.get("code") as? String).orEmpty()
    } catch (_: Exception) {
        ""
    }
}
