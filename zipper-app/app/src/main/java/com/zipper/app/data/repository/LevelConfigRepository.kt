package com.zipper.app.data.repository

import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.util.LevelEngine
import kotlinx.coroutines.tasks.await
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Reads user and host level configs from Firestore.
 *
 * Firestore paths (managed via CRM → App Config → Levels):
 *   levelConfig/user/levels/{0..20}  →  UserLevelConfig
 *   levelConfig/host/levels/{0..10}  →  HostLevelConfig
 *
 * Falls back to hardcoded defaults in LevelEngine if Firestore is empty or unreachable.
 */
@Singleton
class LevelConfigRepository @Inject constructor(
    private val firestore: FirebaseFirestore,
) {

    // ── Data models ───────────────────────────────────────────────────────────

    /**
     * Shared surface for the two level tables.
     *
     * LevelScreen picks one list or the other into a single `val levels`, which
     * without a common supertype infers as `List<Any>` — so `it.level` stopped
     * resolving and the whole module failed to compile. The screen genuinely
     * needs to treat both uniformly, so the type system should let it.
     */
    interface LevelConfig {
        val level: Int
        val frameName: String
        val entranceName: String
        val entranceAsset: String
    }

    data class UserLevelConfig(
        override val level: Int = 0,
        val xpRequired: Long    = 0L,
        override val frameName: String    = "",
        override val entranceName: String = "",
        override val entranceAsset: String = "",
        val profileCard: String = "",
        val bonusDiamonds: Long = 0L,
    ) : LevelConfig

    data class HostLevelConfig(
        override val level: Int  = 0,
        val beansRequired: Long  = 0L,
        override val frameName: String    = "",
        override val entranceName: String = "",
        override val entranceAsset: String = "",
        val bonusBeans: Long     = 0L,
        val bonusDiamonds: Long  = 0L,
        /**
         * Ceiling on the host income (beans/min) a host at this level may set.
         *
         * The table was hardcoded in EditProfileScreen (700 / 2,000 / 5,000 /
         * 12,000). Reading it from `levelConfig/host/levels/{n}.maxCallRateBeans`
         * makes progression tunable from the CRM instead of via a Play release.
         * Zero means "fall back to the shipped ladder".
         */
        val maxCallRateBeans: Long = 0L,
    ) : LevelConfig

    // ── Fetch methods ─────────────────────────────────────────────────────────

    /**
     * Returns all user level configs (0–20), sorted by level.
     * Falls back to LevelEngine defaults if Firestore returns nothing.
     */
    suspend fun getUserLevels(): List<UserLevelConfig> {
        return try {
            val snap = firestore
                .collection("levelConfig").document("user")
                .collection("levels")
                .get().await()

            if (snap.isEmpty) return defaultUserLevels()

            snap.documents.mapNotNull { doc ->
                val level = doc.getLong("level")?.toInt() ?: return@mapNotNull null
                UserLevelConfig(
                    level         = level,
                    xpRequired    = doc.getLong("xpRequired") ?: LevelEngine.USER_THRESHOLDS.getOrElse(level) { 0L },
                    frameName     = doc.getString("frameName") ?: "",
                    entranceName  = doc.getString("entranceName") ?: "",
                    entranceAsset = doc.getString("entranceAsset") ?: "",
                    profileCard   = doc.getString("profileCard") ?: "",
                    bonusDiamonds = doc.getLong("bonusDiamonds") ?: 0L,
                )
            }.sortedBy { it.level }
        } catch (_: Exception) {
            defaultUserLevels()
        }
    }

    /**
     * Returns all host level configs (0–10), sorted by level.
     * Falls back to LevelEngine defaults if Firestore returns nothing.
     */
    suspend fun getHostLevels(): List<HostLevelConfig> {
        return try {
            val snap = firestore
                .collection("levelConfig").document("host")
                .collection("levels")
                .get().await()

            if (snap.isEmpty) return defaultHostLevels()

            snap.documents.mapNotNull { doc ->
                val level = doc.getLong("level")?.toInt() ?: return@mapNotNull null
                HostLevelConfig(
                    level         = level,
                    beansRequired = doc.getLong("beansRequired") ?: LevelEngine.HOST_THRESHOLDS.getOrElse(level) { 0L },
                    frameName     = doc.getString("frameName") ?: "",
                    entranceName  = doc.getString("entranceName") ?: "",
                    entranceAsset = doc.getString("entranceAsset") ?: "",
                    bonusBeans    = doc.getLong("bonusBeans") ?: 0L,
                    bonusDiamonds = doc.getLong("bonusDiamonds") ?: 0L,
                    maxCallRateBeans = doc.getLong("maxCallRateBeans") ?: 0L,
                )
            }.sortedBy { it.level }
        } catch (_: Exception) {
            defaultHostLevels()
        }
    }

    // ── Hardcoded fallbacks (mirrors LevelEngine thresholds + LevelScreen data) ─

    private fun defaultUserLevels(): List<UserLevelConfig> = listOf(
        UserLevelConfig(0,  0L),
        UserLevelConfig(1,  100_000L,          frameName = "Basic Frame"),
        UserLevelConfig(2,  200_000L,          frameName = "Silver Ring",        profileCard = "Basic Card"),
        UserLevelConfig(3,  400_000L,          frameName = "Bronze Crown",       profileCard = "Bronze Card"),
        UserLevelConfig(4,  600_000L,          frameName = "Silver Crown",       entranceName = "Tiger Rush",    entranceAsset = "entries/entry_tiger.json"),
        UserLevelConfig(5,  900_000L,          frameName = "Gold Crown",         entranceName = "King's Entry",  entranceAsset = "entries/entry_king.json",    profileCard = "Gold Card"),
        UserLevelConfig(6,  1_800_000L,        frameName = "War Crown",          entranceName = "Horse Rider",   entranceAsset = "entries/entry_horse.json",   profileCard = "Warlord Card",  bonusDiamonds = 100L),
        UserLevelConfig(7,  5_000_000L,        frameName = "Diamond Crown",      entranceName = "Royal Ship",    entranceAsset = "entries/entry_ship.json",    profileCard = "Diamond Card",  bonusDiamonds = 500L),
        UserLevelConfig(8,  25_000_000L,       frameName = "Master Crown",       entranceName = "Rocket Launch", entranceAsset = "entries/entry_rocket.json",  profileCard = "Master Card",   bonusDiamonds = 1_000L),
        UserLevelConfig(9,  50_000_000L,       frameName = "Legend Crown",       entranceName = "Fighter Jet",   entranceAsset = "entries/entry_jet.json",     profileCard = "Legend Card",   bonusDiamonds = 2_000L),
        UserLevelConfig(10, 100_000_000L,      frameName = "Elite Crown",        entranceName = "VIP Plane",     entranceAsset = "entries/entry_vip_plane.json",profileCard = "Elite Card",   bonusDiamonds = 5_000L),
        UserLevelConfig(11, 200_000_000L,      frameName = "Mythic Crown",       bonusDiamonds = 10_000L),
        UserLevelConfig(12, 500_000_000L,      frameName = "Mythic Crown+",      bonusDiamonds = 20_000L),
        UserLevelConfig(13, 1_000_000_000L,    frameName = "Ancient Crown",      bonusDiamonds = 50_000L),
        UserLevelConfig(14, 2_000_000_000L,    frameName = "Ancient Crown+",     bonusDiamonds = 100_000L),
        UserLevelConfig(15, 6_000_000_000L,    frameName = "Eternal Crown",      bonusDiamonds = 200_000L),
        UserLevelConfig(16, 9_000_000_000L,    frameName = "Eternal Crown+",     bonusDiamonds = 500_000L),
        UserLevelConfig(17, 18_000_000_000L,   frameName = "Galaxy Crown",       bonusDiamonds = 1_000_000L),
        UserLevelConfig(18, 54_000_000_000L,   frameName = "Galaxy Crown+",      bonusDiamonds = 2_000_000L),
        UserLevelConfig(19, 158_000_000_000L,  frameName = "Cosmic Crown",       bonusDiamonds = 5_000_000L),
        UserLevelConfig(20, 550_000_000_000L,  frameName = "Zipper God Crown",   entranceName = "Yamraj Special", entranceAsset = "entries/entry_yamraj.json", profileCard = "God's Card", bonusDiamonds = 10_000_000L),
    )

    private fun defaultHostLevels(): List<HostLevelConfig> = listOf(
        HostLevelConfig(0,  0L),
        HostLevelConfig(1,  10_000L,      frameName = "Host Starter Frame"),
        HostLevelConfig(2,  100_000L,     frameName = "Bronze Host Frame",   bonusBeans = 30_000L),
        HostLevelConfig(3,  300_000L,     frameName = "Silver Host Frame",   bonusBeans = 50_000L),
        HostLevelConfig(4,  600_000L,     frameName = "Gold Host Frame",     bonusBeans = 100_000L,  bonusDiamonds = 500L),
        HostLevelConfig(5,  1_000_000L,   frameName = "Platinum Host Frame", bonusBeans = 200_000L,  bonusDiamonds = 1_000L),
        HostLevelConfig(6,  2_000_000L,   frameName = "Diamond Host Frame",  entranceName = "Biker Entry",  entranceAsset = "entries/entry_bike.json",  bonusBeans = 300_000L, bonusDiamonds = 2_000L),
        HostLevelConfig(7,  4_000_000L,   frameName = "Master Host Frame",   bonusBeans = 500_000L,  bonusDiamonds = 3_000L),
        HostLevelConfig(8,  8_000_000L,   frameName = "Legend Host Frame",   entranceName = "Royal Entry",  entranceAsset = "entries/entry_lv8.json",   bonusBeans = 800_000L, bonusDiamonds = 5_000L),
        HostLevelConfig(9,  16_000_000L,  frameName = "Elite Host Frame",    bonusBeans = 1_200_000L, bonusDiamonds = 10_000L),
        HostLevelConfig(10, 32_000_000L,  frameName = "Mythic Host Crown",   entranceName = "Lambo Entry",  entranceAsset = "entries/entry_lambo.json",  bonusBeans = 2_000_000L, bonusDiamonds = 20_000L),
    )
}
