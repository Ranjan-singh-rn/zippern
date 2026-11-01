package com.zipper.app.util

import com.zipper.app.data.repository.RestrictionKind

/**
 * WHICH APPEAL A RESTRICTED PERSON CAN ACTUALLY SEND FROM THIS PHONE (C9).
 *
 * ── THE ROUTE THAT EXISTED AND COULD NOT BE REACHED (B26) ────────────────────
 *
 * There are three ways to appeal a ban or a suspension:
 *
 *   Session    the in-app form, an authenticated Firestore write with up to
 *              three screenshots. Needs somebody signed in.
 *   DeviceKey  the same form, sent through `submitAccountAppeal` with no session
 *              at all — proved by this handset's saved quick-login credential
 *              and a signature from its Keystore key over a server challenge.
 *              Statement only: Cloud Storage needs a signed-in caller.
 *   Web        the public appeal page, with the account ID to type in.
 *
 * `AppealRepository.appealWithoutSession` has implemented the second for a long
 * time, and the screen never offered it: `AppealPanel` showed the form only when
 * `FirebaseAuth.currentUser` was set, and a quick-login ban or suspension never
 * sets it — no custom token is issued for either. So exactly the people that
 * path was built for were sent to the web.
 *
 * The device-key form grants nothing but the appeal: no session, no read of the
 * account, one pending appeal for a person to review.
 *
 * ── AND WHICH SCREEN THE QUICK-LOGIN ANSWER BELONGS ON (B25) ─────────────────
 *
 * [kindOfOutcome] is the one place the server's quick-login outcome names are
 * turned into a restriction screen, so a suspension is never shown the ban
 * screen by a second, drifting copy of the comparison.
 */
object AppealRoute {

    enum class Route { Session, DeviceKey, Web }

    fun decide(signedIn: Boolean, hasQuickLoginCredential: Boolean, hasDeviceKey: Boolean): Route =
        when {
            signedIn -> Route.Session
            // Both halves, or neither: the credential alone is bytes, and the
            // key alone has nothing to sign for.
            hasQuickLoginCredential && hasDeviceKey -> Route.DeviceKey
            else -> Route.Web
        }

    /** Does this route show the in-app form at all? */
    fun showsForm(route: Route): Boolean = route != Route.Web

    /** May screenshots be attached? Only an authenticated write can upload them. */
    fun carriesEvidence(route: Route): Boolean = route == Route.Session

    /**
     * The restriction a quick-login outcome names, or null when it names none.
     * `suspended` is a suspension — temporary, the phone left alone — and must
     * never be read as a ban.
     */
    fun kindOfOutcome(outcome: String?): RestrictionKind? = when (outcome?.trim()) {
        "suspended" -> RestrictionKind.Suspension
        "banned" -> RestrictionKind.Account
        "device_banned" -> RestrictionKind.Device
        else -> null
    }
}
