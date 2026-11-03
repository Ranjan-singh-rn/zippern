package com.zipper.app.data.repository

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * C7 (B01, B02), B11, B12, B13, B15 — where a sign-in lands, when a sign-out may
 * finish, what a failed Google adoption does, and the order of an abandon.
 *
 * The decisions are pure objects and are tested directly. The wiring that
 * makes every sign-in path use them is pinned at the source as an extra guard,
 * the same way `ServerRefusalsTest` pins `generateSession`.
 */
class SignInRoutingTest {

    // ── C7: the route ────────────────────────────────────────────────────────

    @Test fun `a complete profile that owes a phone goes Main`() {
        assertEquals(
            SignInRouting.Route.Main,
            SignInRouting.decide(isProfileComplete = true, requiresPhone = true, requiresEmail = false),
        )
    }

    @Test fun `a complete profile that owes an email, or both, goes Main`() {
        assertEquals(SignInRouting.Route.Main, SignInRouting.decide(true, false, true))
        assertEquals(SignInRouting.Route.Main, SignInRouting.decide(true, true, true))
        assertEquals(SignInRouting.Route.Main, SignInRouting.decide(true, false, false))
    }

    @Test fun `an incomplete profile goes to setup, whatever it owes`() {
        for (phone in listOf(false, true)) for (email in listOf(false, true)) {
            assertEquals(SignInRouting.Route.ProfileSetup, SignInRouting.decide(false, phone, email))
        }
    }

    @Test fun `a complete profile is never sent to setup`() {
        for (phone in listOf(false, true)) for (email in listOf(false, true)) {
            val route = SignInRouting.decide(isProfileComplete = true, requiresPhone = phone, requiresEmail = email)
            assertTrue("phone=$phone email=$email went to setup", route != SignInRouting.Route.ProfileSetup)
        }
    }

    @Test fun `the route becomes the result the view model navigates on`() {
        assertEquals(AuthResult.Success, SignInRouting.toResult(SignInRouting.Route.Main))
        assertEquals(AuthResult.ProfileIncomplete, SignInRouting.toResult(SignInRouting.Route.ProfileSetup))
    }

    // ── B12: which results open the account ─────────────────────────────────

    @Test fun `every result that enters the account takes the guest binding check`() {
        assertTrue(SignInRouting.entersAccount(AuthResult.Success))
        assertTrue(SignInRouting.entersAccount(AuthResult.ProfileIncomplete))
        assertTrue(SignInRouting.entersAccount(AuthResult.DeletedRecoverable("Asha", "", 0L)))
    }

    @Test fun `refusals and errors open nothing`() {
        assertFalse(SignInRouting.entersAccount(AuthResult.Banned("spam")))
        assertFalse(SignInRouting.entersAccount(AuthResult.Banned("spam", RestrictionKind.Suspension, 5L)))
        assertFalse(SignInRouting.entersAccount(AuthResult.Error("offline")))
        assertFalse(SignInRouting.entersAccount(AuthResult.ObserverDenied))
        assertFalse(SignInRouting.entersAccount(AuthResult.IdentityTaken("taken")))
        assertFalse(SignInRouting.entersAccount(AuthResult.AccountDeleted("gone")))
        assertFalse(SignInRouting.entersAccount(AuthResult.CodeSent("v")))
    }

    // ── B11: a sign-out finishes only what it started ───────────────────────

    @Test fun `an undisturbed sign-out finishes`() {
        assertTrue(SignOutGuard.mayFinish("u1", "u1", startedSerial = 4, currentSerial = 4))
        assertTrue(SignOutGuard.mayFinish(null, null, 0, 0))
    }

    @Test fun `a sign-in started since — even into the same account — is never wiped`() {
        assertFalse(SignOutGuard.mayFinish("u1", "u1", startedSerial = 4, currentSerial = 5))
    }

    @Test fun `another account signed in since is never wiped`() {
        assertFalse(SignOutGuard.mayFinish("u1", "u2", startedSerial = 4, currentSerial = 4))
        assertFalse(SignOutGuard.mayFinish(null, "u2", startedSerial = 4, currentSerial = 4))
    }

    // ── B13: a failed adoption call is not "no match" ────────────────────────

    @Test fun `a usable adoption adopts`() {
        assertEquals(GoogleAdoption.Step.Adopt, GoogleAdoption.next("adopted", hasToken = true, attempt = 1))
        assertEquals(GoogleAdoption.Step.Adopt, GoogleAdoption.next("adopted", hasToken = true, attempt = 2))
    }

    @Test fun `only the server's own none keeps the new account`() {
        assertEquals(GoogleAdoption.Step.KeepNew, GoogleAdoption.next("none", hasToken = false, attempt = 1))
        assertEquals(GoogleAdoption.Step.KeepNew, GoogleAdoption.next("none", hasToken = false, attempt = 2))
    }

    @Test fun `a failed call is retried once and then fails closed`() {
        assertEquals(GoogleAdoption.Step.Retry, GoogleAdoption.next(null, hasToken = false, attempt = 1))
        assertEquals(GoogleAdoption.Step.FailClosed, GoogleAdoption.next(null, hasToken = false, attempt = 2))
    }

    @Test fun `an adoption with no token, or an unknown status, is a failure too`() {
        assertEquals(GoogleAdoption.Step.Retry, GoogleAdoption.next("adopted", hasToken = false, attempt = 1))
        assertEquals(GoogleAdoption.Step.FailClosed, GoogleAdoption.next("adopted", hasToken = false, attempt = 2))
        assertEquals(GoogleAdoption.Step.FailClosed, GoogleAdoption.next("", hasToken = false, attempt = 2))
        assertEquals(GoogleAdoption.Step.FailClosed, GoogleAdoption.next("something_new", hasToken = true, attempt = 2))
    }

    @Test fun `a failure never keeps the new account`() {
        for (attempt in 1..GoogleAdoption.MAX_ATTEMPTS) {
            assertTrue(GoogleAdoption.next(null, false, attempt) != GoogleAdoption.Step.KeepNew)
        }
    }

    // ── FX-08: a late retry of a login with no document is not "no match" ──

    @Test fun `caller_not_fresh for a login with NO users document is retried, then fails closed`() {
        assertEquals(GoogleAdoption.Step.Retry,
            GoogleAdoption.next("none", false, 1, reason = "caller_not_fresh", callerHasDocument = false))
        assertEquals(GoogleAdoption.Step.FailClosed,
            GoogleAdoption.next("none", false, 2, reason = "caller_not_fresh", callerHasDocument = false))
        for (attempt in 1..GoogleAdoption.MAX_ATTEMPTS) {
            assertTrue("never keeps the duplicate", GoogleAdoption.next(
                "none", false, attempt, reason = "caller_not_fresh", callerHasDocument = false,
            ) != GoogleAdoption.Step.KeepNew)
        }
    }

    @Test fun `caller_not_fresh for a login with ANOTHER provider and no document keeps it, as before`() {
        // A CRM password with Google connected, or a login left by a failed
        // purge: the server never adopts it, so its caller_not_fresh means keep.
        assertEquals(GoogleAdoption.Step.KeepNew, GoogleAdoption.next(
            "none", false, 1, reason = "caller_not_fresh", callerHasDocument = false, callerGoogleOnly = false,
        ))
    }

    @Test fun `caller_not_fresh for a login that HAS a document still keeps it`() {
        assertEquals(GoogleAdoption.Step.KeepNew,
            GoogleAdoption.next("none", false, 1, reason = "caller_not_fresh", callerHasDocument = true))
    }

    @Test fun `a none answer for any other reason keeps the new account, as before`() {
        assertEquals(GoogleAdoption.Step.KeepNew,
            GoogleAdoption.next("none", false, 1, reason = "no_holder", callerHasDocument = false))
        assertEquals(GoogleAdoption.Step.KeepNew,
            GoogleAdoption.next("none", false, 1, reason = "ambiguous", callerHasDocument = false))
    }

    @Test fun `the Google path passes the reason and whether a document exists`() {
        val google = repo.substring(repo.indexOf("suspend fun signInWithGoogle("), repo.indexOf("// ── Guest"))
        assertTrue(google.contains("reason = adopted?.reason.orEmpty(),"))
        assertTrue(google.contains("callerHasDocument = callerHasDocument,"))
        assertTrue(google.contains("callerGoogleOnly = callerGoogleOnly,"))
        assertTrue(google.contains(".filter { it != \"firebase\" } == listOf(\"google.com\")"))
    }

    // ── FX-07: the document is written only after the gate ─────────────────

    @Test fun `a new phone or Google login writes its document only after the gate`() {
        val phone = repo.substring(repo.indexOf("private suspend fun signInWithCredential("), repo.indexOf("suspend fun signInWithGoogle("))
        assertTrue(phone.indexOf("gateIdentity(deviceId)?.let { return it }") in 0 until phone.indexOf("createUserDocument("))
        val google = repo.substring(repo.indexOf("suspend fun signInWithGoogle("), repo.indexOf("// ── Guest"))
        assertTrue(google.indexOf("gateIdentity(deviceId)?.let { return it }") in 0 until google.indexOf("createUserDocument("))
    }

    // ── The wiring, pinned at the source (extra guard) ───────────────────────

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(rel: String) = File(main, "com/zipper/app/$rel").readText()
    private val repo by lazy { src("data/repository/AuthRepository.kt") }

    @Test fun `the gate records a contact requirement and no longer returns one`() {
        assertFalse(repo.contains("NeedsContactDetails("))
        val gate = repo.substring(repo.indexOf("private suspend fun gateIdentity("), repo.indexOf("private suspend fun routeSignIn("))
        val record = gate.indexOf("sessionManager.setContactRequirement(id.requiresPhone, id.requiresEmail)")
        assertTrue("the requirement must be stored", record >= 0)
        assertTrue("…on the carry-on path, before the guest flag", record < gate.indexOf("sessionManager.setGuest(id.isGuest)"))
    }

    @Test fun `every sign-in path routes through SignInRouting`() {
        assertFalse(repo.contains("AuthResult.Success else AuthResult.ProfileIncomplete"))
        // phone ×2, Google ×2, quick login, guest, recovery
        assertTrue(Regex("routeSignIn\\(").findAll(repo).count() >= 8)
        assertTrue(repo.contains("SignInRouting.decide("))
    }

    // ── FX-15: the guest button checks the binding BEFORE a session starts ──

    @Test fun `quick login asks its pre-session check before the gate, the document and the session`() {
        val fn = repo.substring(repo.indexOf("suspend fun signInWithQuickLogin("), repo.indexOf("private suspend fun refuseQuickLogin("))
        val token = fn.indexOf("auth.signInWithCustomToken(value.customToken).await()")
        val check = fn.indexOf("val refusal = beforeSession(uid)")
        assertTrue("the check needs the redeemed uid", token in 0 until check)
        assertTrue("…and runs before the gate", check < fn.indexOf("gateIdentity(deviceId)?.let { return it }"))
        assertTrue("…before the document", check < fn.indexOf("ensureUserDocument(uid)"))
        assertTrue("…and before the mobile session", check < fn.indexOf("generateSession(uid, deviceId)"))
    }

    @Test fun `the guest path runs the device binding check inside quick login`() {
        val guest = repo.substring(repo.indexOf("if (existing == null && savedQuickLogin() != null) {"))
        // B10: the call names the device's guest account when this device remembers it (several accounts may be
        // saved here); the binding check is still passed in, as the trailing lambda, exactly as before.
        val call = guest.indexOf("signInWithQuickLogin(deviceId, accountUid = if (guestSaved) guestUid else null) { recovered ->")
        assertTrue("the guest path must pass the check into quick login", call >= 0)
        assertTrue(guest.indexOf("confirmDeviceBinding(deviceId, secret, recovered)") in call until call + 400)
        // Not-a-guest no longer signs a STARTED session out — nothing was started.
        assertFalse(guest.substring(0, guest.indexOf("THE DEVICE'S OWN GUEST ACCOUNT"))
            .contains("BindingCheck.NotTheDevicesGuest -> signOut(deviceId)"))
    }

    @Test fun `the sign-out tail is guarded and its network steps are bounded`() {
        val fn = repo.substring(repo.indexOf("suspend fun signOut("), repo.indexOf("suspend fun abandonSignup("))
        assertTrue(fn.contains("SignOutGuard.mayFinish("))
        val tail = fn.substring(fn.lastIndexOf("if (stillOurs())"))
        assertTrue("auth.signOut() must sit behind the guard", tail.contains("auth.signOut()"))
        assertTrue(fn.contains("withTimeoutOrNull(SIGN_OUT_MINT_TIMEOUT_MS)"))
        assertTrue(fn.contains("withTimeoutOrNull(SIGN_OUT_STEP_TIMEOUT_MS)"))
        assertEquals(4, Regex("signInSerial\\.incrementAndGet\\(\\)").findAll(repo).count())
    }

    @Test fun `logout shows Login only after the sign-out, with the real device id`() {
        val nav = src("navigation/ZipperNavGraph.kt")
        val start = nav.indexOf("val signOutAndGoToLogin")
        val body = nav.substring(start, nav.indexOf("\n    }\n", start))
        assertTrue(body.contains("authVm.signOut(deviceId)"))
        assertFalse("must not navigate before the sign-out is done", body.contains("navigate("))
        assertTrue(nav.contains("LaunchedEffect(authState.navigateToLogin)"))
        val session = src("ui/screens/auth/SessionViewModel.kt")
        assertTrue(session.contains("suspend fun forceSignOut()"))
        assertTrue(session.contains("viewModelScope.launch { tearDownSession() }.join()"))
        val setup = src("ui/screens/auth/ProfileSetupScreen.kt")
        assertFalse(setup.contains("viewModel.signOut(); onNavigateToLogin()"))
    }

    @Test fun `a Google adoption failure fails closed instead of creating a document (B13)`() {
        val google = repo.substring(repo.indexOf("suspend fun signInWithGoogle("), repo.indexOf("// ── Guest"))
        val adopt = google.indexOf("money.adoptEmailAccount()")
        val failClosed = google.indexOf("GoogleAdoption.Step.FailClosed")
        val create = google.indexOf("createUserDocument(")
        assertTrue(adopt in 0 until create)
        assertTrue("the fail-closed return comes before any document is written", failClosed in adopt until create)
        assertTrue(google.contains("return AuthResult.Error(GoogleAdoption.COULD_NOT_CHECK)"))
    }

    @Test fun `abandon deletes the login only after the document is gone (B15)`() {
        val fn = repo.substring(repo.indexOf("suspend fun abandonSignup("))
        val docGone = fn.indexOf("if (!documentGone)")
        assertTrue(docGone >= 0)
        assertTrue(docGone < fn.indexOf("user.delete().await()"))
        assertTrue(docGone < fn.indexOf("deviceKey.clear()"))
        assertFalse(fn.contains("try { firestore.collection(\"users\").document(uid).delete().await() } catch (_: Exception) {}"))
    }

    // ── RF-27: the gate fails closed on an answer it does not know ───────────

    @Test fun `only an explicit allow lets a sign-in carry on`() {
        assertTrue(SignInRouting.gateLetsThrough("allow"))
        assertTrue(SignInRouting.gateLetsThrough(" allow "))
        for (other in listOf(null, "", "suspended", "banned", "device_banned", "deleted_recoverable",
            "deleted_permanent", "observer_denied", "restricted", "ALLOW")) {
            assertFalse("'$other' must not let a sign-in through", SignInRouting.gateLetsThrough(other))
        }
    }

    @Test fun `gateIdentity refuses an unknown answer after every known refusal and before the session`() {
        val fn = repo.substring(repo.indexOf("private suspend fun gateIdentity("))
        val known = fn.indexOf("if (com.zipper.app.util.DeletionWindow.endsAccount(id.decision))")
        val closed = fn.indexOf("if (!SignInRouting.gateLetsThrough(id.decision))")
        val carryOn = fn.indexOf("sessionManager.setContactRequirement(")
        assertTrue("the fail-closed check exists", closed > 0)
        assertTrue("…after the known refusals", known in 0 until closed)
        assertTrue("…before the sign-in carries on", closed < carryOn)
        assertTrue(fn.substring(closed, carryOn).contains("return AuthResult.Error(SignInRouting.UNKNOWN_GATE_ANSWER)"))
    }

    @Test fun `a restricted account at session start is not told to check its connection`() {
        val start = repo.indexOf("private suspend fun generateSession(")
        val fn = repo.substring(start, repo.indexOf("private suspend fun mintQuickLoginCredential(", start))
        val restricted = fn.indexOf("com.zipper.app.util.ServerRefusals.Kind.Restricted")
        val connection = fn.indexOf("Check your connection and try again.")
        assertTrue(restricted > 0 && restricted < connection)
        assertTrue(fn.substring(restricted, connection).contains("AuthResult.Error(res.userMessage)"))
    }
}
