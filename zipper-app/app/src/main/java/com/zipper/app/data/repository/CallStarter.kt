package com.zipper.app.data.repository

import com.zipper.app.util.CallPrice
import javax.inject.Inject
import javax.inject.Singleton

/**
 * O5c (5 Nov 2026) — "in live, the viewer cannot call the broadcaster … same in party". Calling someone from inside a
 * room: the same price quote the profile shows (util/CallPrice) and the same server call (`startCall`, which decides
 * the price, the balance, blocks and the host's "calls off" switch for the room they are in). Shared by the live and
 * party rooms so neither invents its own version.
 */
@Singleton
class CallStarter @Inject constructor(
    private val callRepo: CallRepository,
    private val economyConfig: EconomyConfigRepository,
    private val discover: DiscoverRepository,
    private val profileRepo: ProfileRepository,
) {
    data class Quote(val perMinDiamonds: Long, val myDiamonds: Long)

    /** What a minute with [targetUid] would cost this person, and their balance; null when it cannot be worked out. */
    suspend fun quote(targetUid: String): Quote? = try {
        val cfg = economyConfig.get()
        val target = discover.findByUid(targetUid)
        val me = profileRepo.fetchCurrentUser()
        if (target == null || me == null) null else Quote(
            perMinDiamonds = CallPrice.callerPaysPerMin(
                cfg,
                me = CallPrice.Side(me.isHost, me.isVerifiedHost, me.callRateBeans.toLong(), me.gender),
                target = CallPrice.Side(target.isHost, target.isVerifiedHost, target.callRateBeans.toLong(), target.gender),
            ),
            myDiamonds = me.diamonds,
        )
    } catch (_: Exception) { null }

    suspend fun start(targetUid: String): CallRepository.CallStart = callRepo.createCall(targetUid)
}
