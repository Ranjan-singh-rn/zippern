package com.zipper.app.ui.screens.auth

import com.zipper.app.data.api.ApiError
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * APK 20 / spec §8 — the Owner two-step gate on the app login, as a pure
 * state machine. Every transition the view-model can take is driven here
 * with the answers `routers/auth.py` gives, and the wiring is pinned at the
 * source: no logging of codes or tokens, `client: "android"` on sign-in,
 * the custom token never reaching a screen.
 */
class OwnerMfaGateTest {

    private val me = MfaStep.Checking(MfaStep.Phase.Me)
    private val status = MfaStep.Checking(MfaStep.Phase.Status)
    private val enrolStart = MfaStep.Checking(MfaStep.Phase.EnrolStart)

    private fun failed(status: Int, message: String = "refused", kind: ApiError.Kind = ApiError.kindOf(status), code: String? = null) =
        MfaEvent.Failed(status, message, kind, code)

    // ── Who the gate applies to ─────────────────────────────────────────────

    @Test fun `applies to an owner in either spelling, nobody else`() {
        assertTrue(OwnerMfaGate.appliesTo("owner"))
        assertTrue(OwnerMfaGate.appliesTo(" SUPERADMIN "))
        for (r in listOf("", "observer", "agency", "seller", "ops_admin", "finance_member", "admin")) {
            assertFalse(r, OwnerMfaGate.appliesTo(r))
        }
        assertTrue(OwnerMfaGate.enforced("owner"))
    }

    @Test fun `me decides - owner pending goes to status, verified passes, others pass, the observer is refused`() {
        assertEquals(status, MfaMachine.next(me, MfaEvent.MeLoaded("owner", false)))
        assertEquals(status, MfaMachine.next(me, MfaEvent.MeLoaded("owner", null)))
        assertEquals(MfaStep.NotRequired, MfaMachine.next(me, MfaEvent.MeLoaded("owner", true)))
        assertEquals(MfaStep.NotRequired, MfaMachine.next(me, MfaEvent.MeLoaded("ops_admin", null)))
        assertEquals(MfaStep.NotRequired, MfaMachine.next(me, MfaEvent.MeLoaded("agency", null)))
        assertEquals(MfaStep.Blocked(OwnerMfaGate.OBSERVER_DENIED_MESSAGE), MfaMachine.next(me, MfaEvent.MeLoaded("observer", null)))
    }

    @Test fun `me failures - observer_denied refuses, no account passes, not configured blocks, network retries, 403 blocks`() {
        assertEquals(MfaStep.Blocked(OwnerMfaGate.OBSERVER_DENIED_MESSAGE),
            MfaMachine.next(me, failed(403, "This account cannot use the app.", code = "observer_denied")))
        assertEquals(MfaStep.NotRequired, MfaMachine.next(me, failed(401, "No account found", ApiError.Kind.NoAccount)))
        assertEquals(MfaStep.Blocked(OwnerMfaGate.NOT_CONFIGURED_MESSAGE),
            MfaMachine.next(me, MfaEvent.failed(ApiError.notConfigured())))
        assertEquals(MfaStep.Trouble(OwnerMfaGate.UNREACHABLE_MESSAGE), MfaMachine.next(me, MfaEvent.failed(ApiError.network("timeout"))))
        assertEquals(MfaStep.Trouble(OwnerMfaGate.UNREACHABLE_MESSAGE), MfaMachine.next(me, failed(503, "down", ApiError.Kind.Unavailable)))
        assertEquals(MfaStep.Blocked("This account has been deactivated."), MfaMachine.next(me, failed(403, "This account has been deactivated.")))
        // A plain 401 on /me (session refused) is not "no account": blocked with the sentence.
        assertEquals(MfaStep.Blocked("Sign-in required"), MfaMachine.next(me, failed(401, "Sign-in required")))
    }

    @Test fun `a refused step never passes, a transient one is never a bypass`() {
        for (step in listOf(MfaStep.Blocked("x"), MfaStep.Trouble("y"), me, status, enrolStart,
            MfaStep.Verify(3), MfaStep.Enrol("S", "otpauth://totp/x", null), MfaStep.RecoveryCodes(listOf("a"), MfaBinding.NOT_BOUND),
            // Notices are read before Main: no two-step routes; Owner screens still locked.
            MfaStep.Unavailable("n"), MfaStep.Done(MfaBinding("failed", "r")))) {
            assertFalse(step.toString(), MfaMachine.passes(step))
        }
        for (step in listOf(MfaStep.NotRequired, MfaStep.Done(MfaBinding("bound")), MfaStep.Done(MfaBinding("failed"), acknowledged = true))) {
            assertTrue(step.toString(), MfaMachine.passes(step))
        }
        // Blocked stays blocked whatever arrives; Trouble leaves only through Retry.
        assertEquals(MfaStep.Blocked("x"), MfaMachine.next(MfaStep.Blocked("x"), MfaEvent.Retry))
        assertEquals(MfaStep.Blocked("x"), MfaMachine.next(MfaStep.Blocked("x"), MfaEvent.MeLoaded("ops_admin", null)))
        assertEquals(MfaMachine.start, MfaMachine.next(MfaStep.Trouble("y"), MfaEvent.Retry))
        assertEquals(MfaStep.Trouble("y"), MfaMachine.next(MfaStep.Trouble("y"), MfaEvent.CodeAccepted(MfaBinding("bound"))))
    }

    // ── Status ──────────────────────────────────────────────────────────────

    @Test fun `status routes - verified passes, enrolled verifies, not enrolled enrols, unconfigured server blocks`() {
        val loaded = { enrolled: Boolean?, verified: Boolean, configured: Boolean?, locked: String?, left: Int ->
            MfaEvent.StatusLoaded(enrolled, verified, configured, locked, left)
        }
        assertEquals(MfaStep.NotRequired, MfaMachine.next(status, loaded(true, true, true, null, 8)))
        assertEquals(MfaStep.Verify(8, null), MfaMachine.next(status, loaded(true, false, true, null, 8)))
        assertEquals(MfaStep.Verify(2, "2026-11-01T10:15:00+00:00"), MfaMachine.next(status, loaded(true, false, true, "2026-11-01T10:15:00+00:00", 2)))
        assertEquals(enrolStart, MfaMachine.next(status, loaded(false, false, true, null, 0)))
        assertEquals(enrolStart, MfaMachine.next(status, loaded(null, false, null, null, 0)))
        assertEquals(MfaStep.Blocked(OwnerMfaGate.SERVER_NOT_READY_MESSAGE), MfaMachine.next(status, loaded(false, false, false, null, 0)))
        // An unconfigured server never lets a verified-by-status session through either: verified wins first.
        assertEquals(MfaStep.NotRequired, MfaMachine.next(status, loaded(true, true, false, null, 0)))
    }

    @Test fun `status failures - 404 degrades with the CRM's notice, network retries, anything else blocks`() {
        assertEquals(MfaStep.Unavailable(OwnerMfaGate.UNAVAILABLE_NOTICE), MfaMachine.next(status, failed(404, "Not Found")))
        assertEquals(MfaStep.Unavailable(OwnerMfaGate.UNAVAILABLE_NOTICE), MfaMachine.next(status, failed(405, "Method Not Allowed")))
        assertEquals(MfaStep.Trouble(OwnerMfaGate.UNREACHABLE_MESSAGE), MfaMachine.next(status, MfaEvent.failed(ApiError.network(null))))
        assertEquals(MfaStep.Trouble(OwnerMfaGate.UNREACHABLE_MESSAGE), MfaMachine.next(status, failed(500, "boom")))
        assertEquals(MfaStep.Blocked("Only Owner accounts use this sign-in step."), MfaMachine.next(status, failed(403, "Only Owner accounts use this sign-in step.")))
    }

    // ── Enrolment ───────────────────────────────────────────────────────────

    @Test fun `enrolment - key shown once, first code confirms, recovery codes shown once, then done`() {
        val enrol = MfaMachine.next(enrolStart, MfaEvent.EnrolStarted("JBSWY3DPEHPK3PXP", "otpauth://totp/Zipper:o@x?secret=JBSWY3DPEHPK3PXP&issuer=Zipper", "2026-11-01T10:30:00Z"))
        assertEquals(MfaStep.Enrol("JBSWY3DPEHPK3PXP", "otpauth://totp/Zipper:o@x?secret=JBSWY3DPEHPK3PXP&issuer=Zipper", "2026-11-01T10:30:00Z"), enrol)
        val codes = MfaMachine.next(enrol, MfaEvent.CodeAccepted(MfaBinding("bound"), listOf("AAAA-BBBB", "CCCC-DDDD")))
        assertEquals(MfaStep.RecoveryCodes(listOf("AAAA-BBBB", "CCCC-DDDD"), MfaBinding("bound")), codes)
        // The codes screen already said whether Owner screens unlocked: "saved" is the acknowledgement.
        assertEquals(MfaStep.Done(MfaBinding("bound"), acknowledged = true), MfaMachine.next(codes, MfaEvent.RecoveryCodesSaved))
        assertTrue(MfaMachine.passes(MfaMachine.next(MfaStep.RecoveryCodes(listOf("a"), MfaBinding("failed")), MfaEvent.RecoveryCodesSaved)))
        // Without codes in the answer the step is simply done.
        assertEquals(MfaStep.Done(MfaBinding("failed", "r")), MfaMachine.next(enrol, MfaEvent.CodeAccepted(MfaBinding("failed", "r"))))
    }

    @Test fun `enrolment failures - wrong code stays with the message, expiry restarts, already set up re-reads status, 503 blocks`() {
        val enrol = MfaStep.Enrol("S", "otpauth://totp/x?secret=S", null)
        assertEquals(enrol.copy(error = OwnerMfaGate.WRONG_CODE_MESSAGE), MfaMachine.next(enrol, failed(401, OwnerMfaGate.WRONG_CODE_MESSAGE)))
        assertEquals(enrol.copy(error = "Too many wrong codes. Sign-in is paused for a few minutes."),
            MfaMachine.next(enrol, failed(429, "Too many wrong codes. Sign-in is paused for a few minutes.")))
        assertEquals(enrolStart, MfaMachine.next(enrol, failed(410, "The set-up expired. Start again.")))
        assertEquals(status, MfaMachine.next(enrol, failed(409, "MFA was set up from another window. Sign in again.")))
        assertEquals(MfaStep.Trouble("boom"), MfaMachine.next(enrol, failed(500, "boom")))
        assertEquals(MfaStep.Blocked(OwnerMfaGate.SERVER_NOT_READY_MESSAGE), MfaMachine.next(enrolStart, failed(503, "not configured")))
        assertEquals(MfaStep.Verify(0), MfaMachine.next(enrolStart, failed(409, "MFA is already set up for this account.")))
        // A status refresh while enrolling carries the lock over, nothing else.
        assertEquals(enrol.copy(lockedUntil = "2026-11-01T10:15:00Z"),
            MfaMachine.next(enrol, MfaEvent.StatusLoaded(false, false, true, "2026-11-01T10:15:00Z", 0)))
    }

    // ── Verification ────────────────────────────────────────────────────────

    @Test fun `verification - code or recovery code, wrong stays, lockout keeps the sentence and the status fills until-when`() {
        val verify = MfaStep.Verify(5)
        assertEquals(MfaStep.Done(MfaBinding("bound")), MfaMachine.next(verify, MfaEvent.CodeAccepted(MfaBinding("bound"))))
        assertEquals(verify.copy(error = OwnerMfaGate.WRONG_CODE_MESSAGE), MfaMachine.next(verify, failed(401, OwnerMfaGate.WRONG_CODE_MESSAGE)))
        val locked = MfaMachine.next(verify, failed(429, "Too many wrong codes. Try again after 10:15 UTC."))
        assertEquals(verify.copy(error = "Too many wrong codes. Try again after 10:15 UTC."), locked)
        val withUntil = MfaMachine.next(locked, MfaEvent.StatusLoaded(true, false, true, "2026-11-01T10:15:00Z", 4))
        assertEquals(MfaStep.Verify(4, "2026-11-01T10:15:00Z", false, "Too many wrong codes. Try again after 10:15 UTC."), withUntil)
        // Recovery toggle keeps the lock and clears the error; 409 "not set up" re-reads status.
        assertEquals(MfaStep.Verify(4, "2026-11-01T10:15:00Z", true, null), MfaMachine.next(withUntil, MfaEvent.ToggleRecovery))
        assertEquals(status, MfaMachine.next(verify, failed(409, "MFA is not set up for this account yet.")))
        assertEquals(MfaStep.Trouble("boom"), MfaMachine.next(verify, failed(502, "boom")))
        assertEquals(MfaStep.Blocked("Finish two-step sign-in first."), MfaMachine.next(verify, failed(403, "Finish two-step sign-in first.")))
    }

    @Test fun `an unbound result is said once - Retry unlock or Continue - and a retry bind replaces it`() {
        val done = MfaStep.Done(MfaBinding("failed", "The secure Owner sign-in could not be started on this device."))
        assertFalse("the CRM's 'some screens are locked' notice is read first", MfaMachine.passes(done))
        assertFalse(done.binding.bound)
        val bound = MfaMachine.next(done, MfaEvent.Rebound(MfaBinding("bound")))
        assertEquals(MfaStep.Done(MfaBinding("bound")), bound)
        assertTrue("unlocked: straight in", MfaMachine.passes(bound))
        val read = MfaMachine.next(done, MfaEvent.Continue)
        assertEquals(done.copy(acknowledged = true), read)
        assertTrue("read: in, with Owner Firestore screens still locked", MfaMachine.passes(read))
        // A refused retry keeps the notice up with the new reason.
        assertEquals(MfaStep.Done(MfaBinding("failed", "Finish two-step sign-in first.")),
            MfaMachine.next(done, MfaEvent.Rebound(MfaBinding("failed", "Finish two-step sign-in first."))))
        val codes = MfaStep.RecoveryCodes(listOf("a"), MfaBinding("missing_token"))
        assertEquals(codes.copy(binding = MfaBinding("bound")), MfaMachine.next(codes, MfaEvent.Rebound(MfaBinding("bound"))))
        // Continue means nothing on a step that is not a notice.
        for (s in listOf(MfaStep.Verify(3), MfaStep.Blocked("x"), MfaStep.Trouble("y"), codes)) assertEquals(s, MfaMachine.next(s, MfaEvent.Continue))
    }

    @Test fun `a server without two-step routes is said, then the person continues`() {
        val notice = MfaMachine.next(status, failed(404, "Not Found"))
        assertEquals(MfaStep.Unavailable(OwnerMfaGate.UNAVAILABLE_NOTICE), notice)
        assertFalse(MfaMachine.passes(notice))
        assertEquals(MfaStep.NotRequired, MfaMachine.next(notice, MfaEvent.Continue))
        assertEquals(notice, MfaMachine.next(notice, MfaEvent.Retry))
    }

    @Test fun `the observer is signed out at once, every other refusal waits for the person`() {
        val observer = MfaMachine.next(me, MfaEvent.MeLoaded("observer", null))
        assertTrue(MfaMachine.signsOutAtOnce(observer))
        assertTrue(MfaMachine.signsOutAtOnce(MfaMachine.next(me, failed(403, "x", code = "observer_denied"))))
        assertEquals("This account cannot use the app.", OwnerMfaGate.OBSERVER_DENIED_MESSAGE)
        for (s in listOf(MfaStep.Blocked("This account has been deactivated."), MfaStep.Blocked(OwnerMfaGate.NOT_CONFIGURED_MESSAGE),
            MfaStep.Trouble(OwnerMfaGate.OBSERVER_DENIED_MESSAGE), MfaStep.NotRequired, MfaStep.Verify(1))) {
            assertFalse(s.toString(), MfaMachine.signsOutAtOnce(s))
        }
    }

    // ── Codes and lock arithmetic ───────────────────────────────────────────

    @Test fun `codes are normalised the way the server compares them`() {
        assertEquals("123456", MfaMachine.normaliseCode("12 34 56"))
        assertTrue(MfaMachine.codeLooksValid("123 456"))
        assertFalse(MfaMachine.codeLooksValid("12345"))
        assertFalse(MfaMachine.codeLooksValid("123456789"))
        assertEquals("ABCDEFGHJK", MfaMachine.normaliseRecovery("abcd-efgh jk"))
        assertTrue(MfaMachine.recoveryLooksValid("abcd-efgh-jk"))
        assertFalse(MfaMachine.recoveryLooksValid("abc"))
        assertEquals(mapOf("code" to "123456"), MfaMachine.verifyBody(" 123456 ", useRecovery = false))
        assertEquals(mapOf("recovery_code" to "ABCDEFGHJK"), MfaMachine.verifyBody("abcd-efgh-jk", useRecovery = true))
        assertEquals("JBSW Y3DP EHPK 3PXP", MfaMachine.groupedSecret("JBSWY3DPEHPK3PXP"))
    }

    @Test fun `lock sentence counts down and clears`() {
        val until = "2026-11-01T10:15:00Z"
        val tenPast = com.zipper.app.data.api.ApiTime.parseIsoMillis("2026-11-01T10:10:00Z")!!
        assertEquals(5 * 60_000L, MfaMachine.lockRemainingMs(until, tenPast))
        assertEquals("Too many wrong codes. Try again in 5 minutes.", MfaMachine.lockSentence(until, tenPast))
        assertEquals("Too many wrong codes. Try again in a minute.", MfaMachine.lockSentence(until, tenPast + 4 * 60_000L + 30_000L))
        assertEquals("", MfaMachine.lockSentence(until, tenPast + 6 * 60_000L))
        assertEquals("", MfaMachine.lockSentence(null, tenPast))
        assertEquals(0L, MfaMachine.lockRemainingMs("yesterday", tenPast))
    }

    // ── Reading the server's answers ────────────────────────────────────────

    @Test fun `server answers are read into events, the binding without its custom token`() {
        assertEquals(MfaEvent.MeLoaded("owner", false), MfaMachine.meEvent(mapOf("role" to "owner", "mfa_verified" to false)))
        assertEquals(MfaEvent.MeLoaded(null, null), MfaMachine.meEvent("not a map"))
        assertEquals(MfaEvent.StatusLoaded(true, false, true, "2026-11-01T10:15:00+00:00", 7L.toInt()),
            MfaMachine.statusEvent(mapOf("required" to true, "enrolled" to true, "verified" to false, "configured" to true,
                "locked_until" to "2026-11-01T10:15:00+00:00", "recovery_codes_left" to 7L)))
        assertEquals(MfaEvent.EnrolStarted("S", "otpauth://totp/x?secret=S", "2026-11-01T10:30:00Z"),
            MfaMachine.enrolStartEvent(mapOf("secret" to "S", "otpauth_uri" to "otpauth://totp/x?secret=S", "expires_at" to "2026-11-01T10:30:00Z")))
        assertTrue(MfaMachine.enrolStartEvent(mapOf("otpauth_uri" to "x")) is MfaEvent.Failed)
        // Verify: ApiClient has already settled the binding and stripped the custom token.
        val verify = MfaMachine.verifyEvent(mapOf("expires_at" to "x", "user" to mapOf("role" to "owner",
            "mfa" to mapOf("verified" to true, "firestore_binding" to mapOf("state" to "bound")))))
        assertEquals(MfaEvent.CodeAccepted(MfaBinding("bound")), verify)
        val confirm = MfaMachine.enrolConfirmEvent(mapOf("recovery_codes" to listOf("A1", "B2"), "session" to mapOf("user" to mapOf(
            "mfa" to mapOf("firestore_binding" to mapOf("state" to "failed", "reason" to "no"))))))
        assertEquals(MfaEvent.CodeAccepted(MfaBinding("failed", "no"), listOf("A1", "B2")), confirm)
        assertEquals(MfaEvent.CodeAccepted(MfaBinding.NOT_BOUND), MfaMachine.verifyEvent(mapOf("user" to mapOf("role" to "owner"))))
        assertEquals(MfaEvent.Rebound(MfaBinding("bound")), MfaMachine.bindEvent(mapOf("state" to "bound")))
        assertNull(MfaBinding.from(mapOf("state" to "minted", "custom_token" to "x")).reason)
    }

    // ── A full happy path, as the view-model would drive it ─────────────────

    @Test fun `first sign-in of an owner - enrol, confirm, save codes, in`() {
        var step = MfaMachine.start
        step = MfaMachine.next(step, MfaEvent.MeLoaded("owner", false))
        step = MfaMachine.next(step, MfaEvent.StatusLoaded(false, false, true, null, 0))
        step = MfaMachine.next(step, MfaEvent.EnrolStarted("S", "otpauth://totp/x?secret=S", null))
        step = MfaMachine.next(step, MfaEvent.CodeAccepted(MfaBinding("bound"), listOf("A", "B")))
        step = MfaMachine.next(step, MfaEvent.RecoveryCodesSaved)
        assertEquals(MfaStep.Done(MfaBinding("bound"), acknowledged = true), step)
        assertTrue(MfaMachine.passes(step))
    }

    @Test fun `later sign-in with a recovery code, a lockout on the way`() {
        var step = MfaMachine.start
        step = MfaMachine.next(step, MfaEvent.MeLoaded("owner", false))
        step = MfaMachine.next(step, MfaEvent.StatusLoaded(true, false, true, null, 2))
        step = MfaMachine.next(step, MfaEvent.ToggleRecovery)
        assertEquals(MfaStep.Verify(2, useRecovery = true), step)
        assertEquals(mapOf("recovery_code" to "ABCDEFGHJK"), MfaMachine.verifyBody("abcde-fghjk", (step as MfaStep.Verify).useRecovery))
        step = MfaMachine.next(step, failed(429, "Too many wrong codes. Sign-in is paused for a few minutes."))
        step = MfaMachine.next(step, MfaEvent.StatusLoaded(true, false, true, "2026-11-01T10:15:00Z", 2))
        assertEquals("2026-11-01T10:15:00Z", (step as MfaStep.Verify).lockedUntil)
        assertFalse(MfaMachine.passes(step))
        // Passing with a recovery code whose unlock failed: the notice, then in.
        step = MfaMachine.next(step, MfaEvent.CodeAccepted(MfaBinding("missing_token")))
        assertFalse(MfaMachine.passes(step))
        step = MfaMachine.next(step, MfaEvent.Continue)
        assertTrue(MfaMachine.passes(step))
    }

    @Test fun `an owner already verified on this process goes straight in, an ordinary account is never asked`() {
        assertEquals(MfaStep.NotRequired, MfaMachine.next(MfaMachine.start, MfaEvent.MeLoaded("owner", true)))
        assertEquals(MfaStep.NotRequired, MfaMachine.next(status, MfaEvent.StatusLoaded(true, true, true, null, 9)))
        // The pre-filter: only an Owner's cached role makes the gate ask the API at all.
        for (r in listOf("", "agency", "seller", "app_admin", "finance_member", "host")) assertFalse(r, OwnerMfaGate.enforced(r))
    }

    @Test fun `later sign-in of an owner - verify with a code, in`() {
        var step = MfaMachine.start
        step = MfaMachine.next(step, MfaEvent.MeLoaded("owner", false))
        step = MfaMachine.next(step, MfaEvent.StatusLoaded(true, false, true, null, 6))
        assertEquals(MfaStep.Verify(6), step)
        step = MfaMachine.next(step, failed(401, OwnerMfaGate.WRONG_CODE_MESSAGE))
        assertEquals(OwnerMfaGate.WRONG_CODE_MESSAGE, (step as MfaStep.Verify).error)
        step = MfaMachine.next(step, MfaEvent.CodeAccepted(MfaBinding("bound")))
        assertTrue(MfaMachine.passes(step))
    }

    // ── Source pins ─────────────────────────────────────────────────────────

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(path: String) = File(main, "com/zipper/app/$path").readText()

    @Test fun `sign-in names the android client and the gate never logs a code, a key or a token`() {
        val client = src("data/api/ApiClient.kt")
        assertTrue("client: android on /auth/signin", client.contains("mapOf(\"id_token\" to idToken, \"client\" to \"android\")"))
        assertTrue("the adopted token is stripped before the answer reaches a screen", client.contains("(body - \"token\")"))
        for (f in listOf("ui/screens/auth/OwnerMfaGate.kt", "ui/screens/auth/OwnerMfaViewModel.kt", "ui/screens/auth/OwnerMfaScreen.kt",
            "ui/screens/auth/OwnerMfaGateHost.kt", "data/api/ApiClient.kt", "data/work/OwnerWorkFirebase.kt")) {
            val s = src(f)
            assertFalse("$f writes to the log", Regex("""\b(Log|Timber)\.(d|i|w|e|v|wtf)\(""").containsMatchIn(s))
            assertFalse("$f prints", s.contains("println("))
        }
        // The gate reads the server's role, never a local boolean, and signs out on refusal.
        val host = src("ui/screens/auth/OwnerMfaGateHost.kt")
        assertTrue(host.contains("ui.applies == false || MfaMachine.passes(ui.step) -> content()"))
        val vm = src("ui/screens/auth/OwnerMfaViewModel.kt")
        assertTrue(vm.contains("sessionManager.crmRole.first()"))
        assertTrue(vm.contains("api.get(OwnerMfaGate.ME_PATH)"))
        assertTrue(vm.contains("api.post(OwnerMfaGate.VERIFY_PATH, MfaMachine.verifyBody(raw, step.useRecovery))"))
        assertTrue(vm.contains("api.post(OwnerMfaGate.ENROL_CONFIRM_PATH, mapOf(\"code\" to MfaMachine.normaliseCode(raw)))"))
        // The secret is shown as text (no QR dependency in the build) and handed to the authenticator by URI.
        val screen = src("ui/screens/auth/OwnerMfaScreen.kt")
        assertTrue(screen.contains("MfaMachine.groupedSecret(step.secret)"))
        assertTrue(screen.contains("Intent(Intent.ACTION_VIEW, Uri.parse(otpauthUri))"))
        assertTrue(screen.contains("android.content.extra.IS_SENSITIVE"))
        val libs = listOf(File("../gradle/libs.versions.toml"), File("gradle/libs.versions.toml")).first { it.exists() }.readText()
        assertFalse("no QR library is declared (if one is added, render the otpauth URI)", libs.contains("zxing") || libs.contains("qrcode"))
    }

    /** [s] without block and line comments (a `//` inside "https://…" is kept). */
    private fun code(s: String) = s.replace(Regex("""/\*.*?\*/""", RegexOption.DOT_MATCHES_ALL), " ")
        .replace(Regex("""(^|[\s;{}()])//[^\n]*""", RegexOption.MULTILINE), "\$1")

    @Test fun `a wrong code is never replayed, and the API session never touches the disk`() {
        val client = src("data/api/ApiClient.kt")
        // A 401 from a code route is a verdict on the code: handed back before the re-sign-in-and-retry.
        val guard = client.indexOf("if (method == \"POST\" && path in CODE_ROUTES)")
        assertTrue("the code-route guard exists", guard > 0)
        assertTrue("…and runs before the one retry", guard < client.indexOf("ensureSession(forceNew = true)"))
        assertTrue(client.contains("CODE_ROUTES = setOf(MFA_VERIFY, MFA_ENROL_CONFIRM, MFA_RECOVERY_CODES)"))
        assertTrue("only a session the server refuses is dropped", client.contains("if (!sessionRefused(token)) return first"))
        assertTrue(client.contains("MFA_RECOVERY_CODES = \"/api/auth/mfa/recovery-codes\""))
        // The API session — pending or verified — is held in memory only.
        assertTrue(client.contains("@Volatile private var session: Session? = null"))
        val clientCode = code(client)
        for (store in listOf("DataStore", "SharedPreferences", "EncryptedSharedPreferences", "openFileOutput", "FileOutputStream", "SessionManager")) {
            assertFalse("ApiClient persists the session through $store", clientCode.contains(store))
        }
        // …and the one DataStore the sign-in writes holds no API credential (the crm-role pre-filter is not one).
        val sessionManager = code(src("util/SessionManager.kt"))
        for (word in listOf("ApiClient", "api_session", "api_token", "bearer", "mfa")) {
            assertFalse("SessionManager stores '$word'", sessionManager.contains(word, ignoreCase = true))
        }
        assertTrue(sessionManager.contains("stringPreferencesKey(\"session_crm_role\")"))
        assertTrue("signed out means forgotten", sessionManager.contains("prefs.remove(KEY_CRM_ROLE)"))
    }

    @Test fun `enrol and verify always offer a way out, the observer is signed out at once, a refused unlock is shown`() {
        val screen = src("ui/screens/auth/OwnerMfaScreen.kt")
        assertTrue("Sign out on the Enrol and the Verify step", Regex("""ZipperButton\("Sign out", onSignOut""").findAll(screen).count() >= 2)
        assertTrue("the notices have their Continue", Regex("""ZipperButton\("Continue", viewModel::acknowledge""").findAll(screen).count() >= 2)
        val host = src("ui/screens/auth/OwnerMfaGateHost.kt")
        assertTrue(host.contains("if (MfaMachine.signsOutAtOnce(ui.step)) onRefused(OwnerMfaGate.OBSERVER_DENIED_MESSAGE)"))
        val graph = src("navigation/ZipperNavGraph.kt")
        val mainRoute = graph.substring(graph.indexOf("composable(Screen.Main.route) {"))
        assertTrue("a refusal signs out with the sentence shown on Login",
            mainRoute.contains("reason?.let { com.zipper.app.ui.screens.auth.ForcedSignOut.raise(it) }") && mainRoute.contains("signOutAndGoToLogin()"))
        val vm = src("ui/screens/auth/OwnerMfaViewModel.kt")
        assertTrue(vm.contains("is ApiResult.Failure -> MfaEvent.Rebound(MfaBinding(\"failed\", r.error.message))"))
    }

    /**
     * Spec §12, app-wide: no log line carries a token, a code, a key or a
     * password. Every `Log.*` / `Timber.*` call is read (they are one line
     * each); an interpolated or passed value whose name is a credential fails.
     * `e.code` — an error code — is not one; a bare `code` is.
     */
    @Test fun `no app source writes a token, a code or a secret to the log`() {
        val credential = Regex("""(?i)(token|idtoken|id_token|customtoken|apitoken|accesstoken|refreshtoken|sessiontoken|bearer|secret|otp|otpauthuri|password|recoverycodes?|totp|code)""")
        val logCall = Regex("""\b(?:android\.util\.)?(?:Log|Timber)\.(?:d|i|w|e|v|wtf)\((.*)""")
        val interpolated = Regex("""\$\{([^}]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)""")
        val passed = Regex("""[,(]\s*(?:it\.|this\.)?([A-Za-z_][A-Za-z0-9_]*)\s*(?=[,)])""")
        val offenders = mutableListOf<String>()
        var calls = 0
        main.walkTopDown().filter { it.isFile && it.extension == "kt" }.forEach { f ->
            f.readLines().forEachIndexed { n, line ->
                if (line.contains("println(")) offenders += "${f.name}:${n + 1}: println"
                val args = logCall.find(line)?.groupValues?.get(1) ?: return@forEachIndexed
                calls++
                val names = interpolated.findAll(args).map { it.groupValues[1].ifEmpty { it.groupValues[2] } } +
                    passed.findAll("(" + args.replace(Regex(""""(?:[^"\\]|\\.)*""""), "\"\"")).map { it.groupValues[1] }
                for (expr in names) {
                    val last = expr.substringAfterLast('.').substringBefore('(').trim()
                    val isErrorCode = expr.contains('.') && last.equals("code", ignoreCase = true)
                    if (credential.matches(last) && !isErrorCode) offenders += "${f.name}:${n + 1}: $expr"
                }
            }
        }
        assertTrue("the scan found the app's log calls", calls >= 10)
        assertEquals(emptyList<String>(), offenders)
    }
}
