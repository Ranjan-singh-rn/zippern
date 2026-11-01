package com.zipper.app.ui

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * The partner entry point, pinned at the source.
 *
 *  1. There is no manual "agency code" route into becoming a partner. A Host
 *     joins by applying and choosing an agency or sub-agency; the old
 *     JoinAgency screen and its hub button are gone.
 *  2. ZIPPER staff (Owner, Observer, department roles) are never offered a
 *     partner role: the profile card is hidden on the server-stamped
 *     `crmRole`, and the hub renders no choices when the API says the caller
 *     is internal. The API's refusal is the rule; these are the UI halves.
 *
 * Source-level on purpose: these are Compose screens with Hilt view models,
 * and what matters is that the strings and the routes no longer exist.
 */
class PartnerEntryTest {

    private val root = File("src/main/java/com/zipper/app")

    private fun src(path: String): String = File(root, path).readText()

    private fun allKotlin(): Sequence<File> =
        root.walkTopDown().filter { it.isFile && it.extension == "kt" }

    @Test
    fun `no agency-code entry anywhere in the partner flow`() {
        val hub = src("ui/screens/partner/PartnerHubScreen.kt")
        assertFalse(hub.contains("Enter an agency code"))
        assertFalse(hub.contains("Invited by an agency"))
        assertFalse(hub.contains("onEnterReferralCode"))
    }

    @Test
    fun `the JoinAgency screen and route are gone`() {
        assertFalse(File(root, "ui/screens/host/JoinAgencyScreen.kt").exists())
        assertFalse(File(root, "ui/screens/host/JoinAgencyViewModel.kt").exists())
        val offenders = allKotlin().filter { it.readText().contains("JoinAgency") }.map { it.name }.toList()
        assertTrue("still references JoinAgency: $offenders", offenders.isEmpty())
    }

    @Test
    fun `staff never see the Become a partner card, and a guest without a verified contact is told what comes first`() {
        val profile = src("ui/screens/profile/MyProfileScreen.kt")
        // UGP-A: one rule, shared with the unit test — staff (crmRole) are
        // excluded. Approved contact rule: an account without a verified
        // phone/email now sees the card, saying verification comes first,
        // instead of seeing nothing at all.
        assertTrue(profile.contains("com.zipper.app.util.ContactRules.partnerEntryVisible("))
        assertTrue(profile.contains("com.zipper.app.util.ContactRules.partnerEntryNeedsContact("))
        assertTrue(profile.contains("\"Verify a phone number or email first — we'll show you how.\""))
        assertTrue(profile.contains("crmRole = user.crmRole"))
        assertTrue(profile.contains("authEmailVerified = authUser?.isEmailVerified == true"))
        // The old staff-only condition is gone, and it is not the display badge.
        assertFalse(profile.contains("if (user.crmRole.isBlank()) Row("))
        assertFalse(profile.contains("if (!user.isOfficial) Row("))
    }

    @Test
    fun `the hub shows no choices to an internal caller`() {
        val hub = src("ui/screens/partner/PartnerHubScreen.kt")
        val guard = hub.indexOf("if (elig.isInternal)")
        val choices = hub.indexOf("ROLES.forEach")
        assertTrue("internal guard missing", guard >= 0)
        assertTrue("internal guard must come before the role choices", guard < choices)
        assertTrue(src("data/repository/PartnerFunctions.kt").contains("isInternal = held[\"internal\"]"))
    }

    @Test
    fun `the agency dashboard reads the OWN agency, not the host agency (B4)`() {
        val dash = src("ui/screens/agency/AgencyDashboardScreen.kt")
        assertTrue(dash.contains("currentUser?.ownAgencyId"))
        // The host-agency fallback is only for a non-Host.
        assertTrue(dash.contains("takeIf { !it.isHost }?.agencyId"))
        assertTrue(src("data/model/User.kt").contains("ownAgencyId = doc.getString(\"ownAgencyId\")"))
    }

    @Test
    fun `profile setup phone has a country code picker, not a fixed +91`() {
        val setup = src("ui/screens/auth/ProfileSetupScreen.kt")
        assertFalse(setup.contains("\"+91\$extraPhone\""))
        assertTrue(setup.contains("CountryPickerSheet("))
        assertTrue(setup.contains("\${phoneCountry.dialCode}\$extraPhone"))
    }

    @Test
    fun `every account can add the contact it lacks, by code, and email is not a sign-in`() {
        val settings = src("ui/screens/settings/SettingsScreen.kt")
        assertTrue(settings.contains("if (!hasPhone) SettingRow("))
        assertTrue(settings.contains("if (!hasEmail) SettingRow("))
        assertFalse(settings.contains("if (isGuest) {\n                Column"))
        // UGP-1.7: the rows follow the BOUND state, not the Auth record alone.
        val nav = src("navigation/ZipperNavGraph.kt")
        assertTrue(nav.contains("com.zipper.app.util.ContactRules.phoneBound("))
        assertTrue(nav.contains("com.zipper.app.util.ContactRules.emailBound("))

        // UGP-E1: no "Continue with Email" on Login, and no email-link sign-in.
        val login = src("ui/screens/auth/LoginScreen.kt")
        assertFalse(login.contains("ZipperButton(\"Continue with Email\""))
        assertFalse(login.contains("onContinueWithEmail:"))
        val repo = src("data/repository/AuthRepository.kt")
        assertFalse(repo.contains("auth.signInWithEmailLink("))
        assertFalse(repo.contains("sendSignInLinkToEmail("))
        assertFalse(repo.contains("EmailAuthProvider.getCredentialWithLink("))

        // UGP-C: email is bound by a six-digit code, server-verified.
        val vm = src("ui/screens/auth/SecureEmailViewModel.kt")
        assertTrue(vm.contains("repo.requestEmailCode("))
        assertTrue(vm.contains("repo.verifyEmailCode("))
        assertTrue(src("data/repository/MoneyFunctions.kt").contains("call(\"verifyEmailBindCode\""))
    }

    @Test
    fun `the email deep link is gone end to end`() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assertFalse(manifest.contains("android:pathPrefix=\"/__/auth/links\""))
        assertFalse(manifest.contains("android:pathPrefix=\"/secure-account\""))
        assertFalse(manifest.contains("android:autoVerify=\"true\""))
        val main = src("MainActivity.kt")
        assertFalse(main.contains("isSignInWithEmailLink("))
        assertFalse(main.contains("PendingNav.EmailLink"))
        val offenders = allKotlin().filter { it.readText().contains("EmailLinkReturn.") }.map { it.name }.toList()
        assertTrue("still hands an email link around: $offenders", offenders.isEmpty())
    }

    @Test
    fun `a finished binding lands on Settings`() {
        val nav = src("navigation/ZipperNavGraph.kt")
        assertTrue(nav.contains("onDone = { navController.backToSettings(Screen.SecureAccount.route) }"))
        assertTrue(nav.contains("onDone = { navController.backToSettings(Screen.SecureEmail.route) }"))
        assertTrue(nav.contains("internal fun NavHostController.backToSettings("))
    }

    // ── Approved contact rule: explain, route, and come back ──────────────

    @Test
    fun `the hub and the form explain a missing contact and open the verification flows`() {
        val card = src("ui/screens/partner/ContactRequiredCard.kt")
        assertTrue(card.contains("VerifyAction.PHONE -> onVerifyPhone()"))
        assertTrue(card.contains("VerifyAction.EMAIL -> onVerifyEmail()"))
        assertTrue(card.contains("Text(contact.explanation"))

        val hub = src("ui/screens/partner/PartnerHubScreen.kt")
        assertTrue(hub.contains("elig.contact?.takeIf { it.required }?.let { contact ->"))
        assertTrue(hub.contains("ContactRequiredCard(contact, onVerifyPhone = onVerifyPhone, onVerifyEmail = onVerifyEmail)"))
        assertTrue("the hub re-reads on return", hub.contains("if (event == Lifecycle.Event.ON_RESUME) viewModel.onResumed()"))

        val form = src("ui/screens/partner/PartnerApplyScreen.kt")
        assertTrue(form.contains("val contact = state.contactRequired"))
        assertTrue(form.contains("ContactRequiredCard(contact, onVerifyPhone = onVerifyPhone, onVerifyEmail = onVerifyEmail)"))
        assertTrue("the form re-reads on return", form.contains("if (event == Lifecycle.Event.ON_RESUME) viewModel.onResumed()"))

        // The refusal's details reach the form as a requirement, not a sentence.
        val fns = src("data/repository/PartnerFunctions.kt")
        assertTrue(fns.contains("ContactRequirement.fromRefusal(e.details, e.message)"))
        assertTrue(fns.contains("ContactRequirement.fromEligibility("))
    }

    @Test
    fun `a verification opened from the partner flow returns to it, not to Settings`() {
        val nav = src("navigation/ZipperNavGraph.kt")
        for (route in listOf("SecureAccountForPartner", "SecureEmailForPartner")) {
            val at = nav.indexOf("composable(Screen.$route.route) {")
            assertTrue("$route is registered", at >= 0)
            val body = nav.substring(at, nav.indexOf("}\n", nav.indexOf("onCancel", at)) + 1)
            assertTrue("$route returns to the opener", body.contains("onDone = { navController.popBackStack() }"))
            assertFalse("$route does not land on Settings", body.contains("backToSettings("))
        }
        val hub = nav.substring(nav.indexOf("composable(Screen.PartnerHub.route) {"))
        assertTrue(hub.contains("onVerifyPhone = { navController.navigate(Screen.SecureAccountForPartner.route) }"))
        assertTrue(hub.contains("onVerifyEmail = { navController.navigate(Screen.SecureEmailForPartner.route) }"))
        val apply = nav.substring(nav.indexOf("Screen.PartnerApply.route,"))
        assertTrue(apply.contains("onVerifyPhone = { navController.navigate(Screen.SecureAccountForPartner.route) }"))
        // The Settings entry points are unchanged.
        assertTrue(nav.contains("onDone = { navController.backToSettings(Screen.SecureAccount.route) }"))
    }

    // ── FX-07: a session with no users document restarts the sign-in ──────

    @Test
    fun `Splash restarts an unfinished sign-in instead of creating the profile document`() {
        val splash = src("ui/screens/auth/SplashScreen.kt")
        val missing = splash.substring(splash.indexOf("if (!snap.exists()) {"))
        val branch = missing.substring(0, missing.indexOf("return@LaunchedEffect"))
        assertTrue(branch.contains("ForcedSignOut.raise(ForcedSignOut.SIGN_IN_INCOMPLETE)"))
        assertTrue(branch.contains("sessionViewModel.tearDownSession()"))
        assertTrue(branch.contains("onNavigateToLogin()"))
        assertFalse("Profile Setup no longer creates a document for an unfinished sign-in",
            branch.contains("onNavigateToProfileSetup"))
    }

    @Test
    fun `sign out and forget this device is gone, log out and switch account stay`() {
        val settings = src("ui/screens/settings/SettingsScreen.kt")
        assertFalse(settings.contains("Sign out and forget this device"))
        assertFalse(settings.contains("onSignOutAndForget"))
        assertTrue(settings.contains("\"Log out\""))
        assertTrue(settings.contains("\"Switch account\""))
        assertFalse(src("data/repository/AuthRepository.kt").contains("suspend fun signOutAndForget("))
    }

    @Test
    fun `a new Google uid asks the server for the existing email account BEFORE creating a profile`() {
        val repo = src("data/repository/AuthRepository.kt")
        val google = repo.substring(repo.indexOf("suspend fun signInWithGoogle("))
        val adopt = google.indexOf("money.adoptEmailAccount()")
        val create = google.indexOf("createUserDocument(")
        assertTrue("Google sign-in must call adoptEmailAccount", adopt >= 0)
        assertTrue("adoptEmailAccount must run before any user document is written", adopt < create)
        assertTrue(google.contains("auth.signInWithCustomToken(adopted.customToken)"))
        assertTrue(src("data/repository/MoneyFunctions.kt").contains("call(\"adoptEmailAccount\""))
    }

    @Test
    fun `the guest button never hands back a Google, email or phone account when the binding check fails`() {
        val repo = src("data/repository/AuthRepository.kt")
        val fn = repo.substring(repo.indexOf("private suspend fun confirmDeviceBinding("))
        val failed = fn.substring(fn.indexOf("is MoneyFunctions.Result.Failed ->"), fn.indexOf("return when (claim.status)"))
        assertFalse("must not agree unconditionally on failure",
            failed.contains("is MoneyFunctions.Result.Failed -> return BindingCheck.Agrees"))
        assertTrue(failed.contains("providerId != \"firebase\""))
        assertTrue(failed.contains("BindingCheck.Refuse("))
    }
}
