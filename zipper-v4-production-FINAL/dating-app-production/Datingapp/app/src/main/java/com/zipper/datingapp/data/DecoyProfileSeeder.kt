package com.zipper.datingapp.data

import com.google.firebase.firestore.FirebaseFirestore
import kotlinx.coroutines.tasks.await

/**
 * Seeds decoy/dummy profiles into Firestore.
 *
 * Decoy profiles appear in the discovery feed for new users to create social proof.
 * They are NOT real accounts — they cannot receive calls, messages, or gifts.
 *
 * Schema:
 *   isDecoy: true
 *   linkedRealHostId: String? — if set, interactions redirect to this real host
 *   decoyOrder: Int           — ordering in feed (lower = shown first)
 *
 * Call seedDecoyProfiles() from admin panel / Cloud Function only.
 * These profiles should NEVER be seeded from the client in production.
 */
object DecoyProfileSeeder {

    private val DECOY_PROFILES = listOf(

        // ── decoy_001 ────────────────────────────────────────────────────────
        mapOf(
            "uid"               to "decoy_001",
            "displayName"       to "Priya",
            "age"               to 23,
            "gender"            to "FEMALE",
            "city"              to "Mumbai",
            "bio"               to "Love music and dance 🎵",
            "photoUrl"          to "https://randomuser.me/api/portraits/women/1.jpg",
            "isOnline"          to true,
            "role"              to "HOST",
            "isDecoy"           to true,
            "decoyOrder"        to 1,
            "linkedRealHostId"  to null,
            "totalBeansEarned"  to 250000L,
            "currentLevel"      to 3,
            "hobbies"           to listOf("Music", "Dance", "Travel"),
            "isVerified"        to true,
            "createdAt"         to System.currentTimeMillis(),
        ),

        // ── decoy_002 ────────────────────────────────────────────────────────
        mapOf(
            "uid"               to "decoy_002",
            "displayName"       to "Anjali",
            "age"               to 25,
            "gender"            to "FEMALE",
            "city"              to "Delhi",
            "bio"               to "Artist by heart ❤️",
            "photoUrl"          to "https://randomuser.me/api/portraits/women/2.jpg",
            "isOnline"          to true,
            "role"              to "HOST",
            "isDecoy"           to true,
            "decoyOrder"        to 2,
            "linkedRealHostId"  to null,
            "totalBeansEarned"  to 180000L,
            "currentLevel"      to 2,
            "hobbies"           to listOf("Art", "Cooking", "Yoga"),
            "isVerified"        to true,
            "createdAt"         to System.currentTimeMillis(),
        ),

        // ── decoy_003 ────────────────────────────────────────────────────────
        mapOf(
            "uid"               to "decoy_003",
            "displayName"       to "Kavya",
            "age"               to 22,
            "gender"            to "FEMALE",
            "city"              to "Bangalore",
            "bio"               to "Coffee lover & bookworm ☕📚",
            "photoUrl"          to "https://randomuser.me/api/portraits/women/3.jpg",
            "isOnline"          to true,
            "role"              to "HOST",
            "isDecoy"           to true,
            "decoyOrder"        to 3,
            "linkedRealHostId"  to null,
            "totalBeansEarned"  to 135000L,
            "currentLevel"      to 2,
            "hobbies"           to listOf("Reading", "Coffee", "Photography"),
            "isVerified"        to true,
            "createdAt"         to System.currentTimeMillis(),
        ),

        // ── decoy_004 ────────────────────────────────────────────────────────
        mapOf(
            "uid"               to "decoy_004",
            "displayName"       to "Meera",
            "age"               to 24,
            "gender"            to "FEMALE",
            "city"              to "Chennai",
            "bio"               to "Classical dancer | Foodie 🌶️",
            "photoUrl"          to "https://randomuser.me/api/portraits/women/4.jpg",
            "isOnline"          to false,
            "role"              to "HOST",
            "isDecoy"           to true,
            "decoyOrder"        to 4,
            "linkedRealHostId"  to null,
            "totalBeansEarned"  to 92000L,
            "currentLevel"      to 2,
            "hobbies"           to listOf("Classical Dance", "Cooking", "Music"),
            "isVerified"        to true,
            "createdAt"         to System.currentTimeMillis(),
        ),

        // ── decoy_005 ────────────────────────────────────────────────────────
        mapOf(
            "uid"               to "decoy_005",
            "displayName"       to "Shreya",
            "age"               to 21,
            "gender"            to "FEMALE",
            "city"              to "Hyderabad",
            "bio"               to "Dreamer. Singer. Wanderer 🌙✨",
            "photoUrl"          to "https://randomuser.me/api/portraits/women/5.jpg",
            "isOnline"          to true,
            "role"              to "HOST",
            "isDecoy"           to true,
            "decoyOrder"        to 5,
            "linkedRealHostId"  to null,
            "totalBeansEarned"  to 210000L,
            "currentLevel"      to 3,
            "hobbies"           to listOf("Singing", "Travel", "Fitness"),
            "isVerified"        to true,
            "createdAt"         to System.currentTimeMillis(),
        ),

        // ── decoy_006 ────────────────────────────────────────────────────────
        mapOf(
            "uid"               to "decoy_006",
            "displayName"       to "Riya",
            "age"               to 26,
            "gender"            to "FEMALE",
            "city"              to "Kolkata",
            "bio"               to "Bengali at heart, foodie by nature 🍛",
            "photoUrl"          to "https://randomuser.me/api/portraits/women/6.jpg",
            "isOnline"          to true,
            "role"              to "HOST",
            "isDecoy"           to true,
            "decoyOrder"        to 6,
            "linkedRealHostId"  to null,
            "totalBeansEarned"  to 78000L,
            "currentLevel"      to 1,
            "hobbies"           to listOf("Cooking", "Poetry", "Painting"),
            "isVerified"        to true,
            "createdAt"         to System.currentTimeMillis(),
        ),

        // ── decoy_007 ────────────────────────────────────────────────────────
        mapOf(
            "uid"               to "decoy_007",
            "displayName"       to "Pooja",
            "age"               to 28,
            "gender"            to "FEMALE",
            "city"              to "Pune",
            "bio"               to "Yoga instructor & nature lover 🌿🧘",
            "photoUrl"          to "https://randomuser.me/api/portraits/women/7.jpg",
            "isOnline"          to false,
            "role"              to "HOST",
            "isDecoy"           to true,
            "decoyOrder"        to 7,
            "linkedRealHostId"  to null,
            "totalBeansEarned"  to 165000L,
            "currentLevel"      to 2,
            "hobbies"           to listOf("Yoga", "Hiking", "Meditation"),
            "isVerified"        to true,
            "createdAt"         to System.currentTimeMillis(),
        ),

        // ── decoy_008 ────────────────────────────────────────────────────────
        mapOf(
            "uid"               to "decoy_008",
            "displayName"       to "Neha",
            "age"               to 20,
            "gender"            to "FEMALE",
            "city"              to "Jaipur",
            "bio"               to "Fashion obsessed 👗 | Rajasthan ki Rani 👸",
            "photoUrl"          to "https://randomuser.me/api/portraits/women/8.jpg",
            "isOnline"          to true,
            "role"              to "HOST",
            "isDecoy"           to true,
            "decoyOrder"        to 8,
            "linkedRealHostId"  to null,
            "totalBeansEarned"  to 310000L,
            "currentLevel"      to 4,
            "hobbies"           to listOf("Fashion", "Dance", "Shopping"),
            "isVerified"        to true,
            "createdAt"         to System.currentTimeMillis(),
        ),

        // ── decoy_009 ────────────────────────────────────────────────────────
        mapOf(
            "uid"               to "decoy_009",
            "displayName"       to "Divya",
            "age"               to 27,
            "gender"            to "FEMALE",
            "city"              to "Bangalore",
            "bio"               to "Tech girl by day, dancer by night 💃💻",
            "photoUrl"          to "https://randomuser.me/api/portraits/women/9.jpg",
            "isOnline"          to true,
            "role"              to "HOST",
            "isDecoy"           to true,
            "decoyOrder"        to 9,
            "linkedRealHostId"  to null,
            "totalBeansEarned"  to 195000L,
            "currentLevel"      to 3,
            "hobbies"           to listOf("Dance", "Gaming", "Fitness"),
            "isVerified"        to true,
            "createdAt"         to System.currentTimeMillis(),
        ),

        // ── decoy_010 ────────────────────────────────────────────────────────
        mapOf(
            "uid"               to "decoy_010",
            "displayName"       to "Simran",
            "age"               to 23,
            "gender"            to "FEMALE",
            "city"              to "Hyderabad",
            "bio"               to "Chai > Coffee ☕ | Music is my therapy 🎧",
            "photoUrl"          to "https://randomuser.me/api/portraits/women/10.jpg",
            "isOnline"          to false,
            "role"              to "HOST",
            "isDecoy"           to true,
            "decoyOrder"        to 10,
            "linkedRealHostId"  to null,
            "totalBeansEarned"  to 125000L,
            "currentLevel"      to 2,
            "hobbies"           to listOf("Music", "Travel", "Baking"),
            "isVerified"        to true,
            "createdAt"         to System.currentTimeMillis(),
        ),
    )

    // ─────────────────────────────────────────────────────────────────────────
    // PUBLIC API
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Seeds all decoy profiles to Firestore.
     * Safe to call multiple times — uses document ID so won't duplicate.
     */
    suspend fun seedDecoyProfiles(db: FirebaseFirestore = FirebaseFirestore.getInstance()) {
        val batch = db.batch()
        DECOY_PROFILES.forEach { profile ->
            val uid = profile["uid"] as String
            val ref = db.collection("users").document(uid)
            @Suppress("UNCHECKED_CAST")
            batch.set(ref, profile as Map<String, Any?>)
        }
        batch.commit().await()
    }

    /**
     * Returns IDs of all decoy profiles.
     */
    fun decoyIds(): List<String> = DECOY_PROFILES.map { it["uid"] as String }

    /**
     * Whether a given uid belongs to a decoy profile.
     * Fast path: checks the "decoy_" prefix without hitting Firestore.
     */
    fun isDecoyId(uid: String): Boolean = uid.startsWith("decoy_")

    /**
     * Returns the decoyOrder for a given uid, or null if not a known decoy.
     */
    fun decoyOrderFor(uid: String): Int? =
        DECOY_PROFILES.firstOrNull { it["uid"] == uid }?.get("decoyOrder") as? Int
}
