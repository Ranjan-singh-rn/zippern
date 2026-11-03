package com.zipper.app.data.repository

import com.zipper.app.util.QuickLoginNotice
import com.zipper.app.util.QuickLoginStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * B10 (4 Nov 2026) — the account switcher (Instagram/HiClub style) on quick-login credentials.
 *
 * The pure parts run here on the JVM: the stored format (including a blob saved before B10), which copy wins
 * when Block Store and DataStore disagree, which credential speaks for an appeal, the rows the screens get (never
 * a token), and what a switch ended in. The ordering that keeps a refused switch from signing anybody out is
 * pinned against the source, because it is a property of the repository's call sequence.
 */
class AccountSwitchTest {

    private fun saved(uid: String, at: Long, name: String = "N$uid", token: String = "t".repeat(43) + uid) =
        QuickLoginStore.Saved(token = token, displayName = name, photoUrl = "p$uid", uid = uid, savedAtMs = at)

    // ── The stored format ────────────────────────────────────────────────────

    @Test fun `a blob saved before B10 still reads - with no uid`() {
        val legacy = "T".repeat(43) + "\tavatar:fox\tRahul"
        val s = QuickLoginStore.decodeSaved(legacy)!!
        assertEquals("T".repeat(43), s.token)
        assertEquals("avatar:fox", s.photoUrl)
        assertEquals("Rahul", s.displayName)
        assertEquals("", s.uid)
        assertEquals(0L, s.savedAtMs)
    }

    @Test fun `round trip keeps every field, and a tab or newline in a name cannot shift the uid`() {
        val s = saved("U1", 1234L, name = "Ra\thul\nK")
        val back = QuickLoginStore.decodeSaved(QuickLoginStore.encodeSaved(s))!!
        assertEquals("U1", back.uid)
        assertEquals(1234L, back.savedAtMs)
        assertEquals("Ra hul K", back.displayName)
        assertEquals(s.token, back.token)
        assertFalse(QuickLoginStore.encodeSaved(s).contains('\n'))
    }

    @Test fun `nothing that is not a minted secret decodes`() {
        assertNull(QuickLoginStore.decodeSaved(""))
        assertNull(QuickLoginStore.decodeSaved("short\tp\tname\tU1\t1"))
    }

    @Test fun `the secret never prints`() {
        val s = saved("U1", 1L)
        assertFalse(s.toString().contains(s.token))
        assertTrue(s.toString().contains("<redacted>"))
    }

    @Test fun `the newest copy of each account wins, most recent first`() {
        val stale = saved("U1", 10L, token = "a".repeat(43))
        val fresh = saved("U1", 20L, token = "b".repeat(43))
        val other = saved("U2", 15L)
        val merged = QuickLoginStore.mergeAccounts(listOf(stale, other, fresh, saved("", 99L)))
        assertEquals(listOf("U1", "U2"), merged.map { it.uid })
        assertEquals("b".repeat(43), merged.first().token)
    }

    // ── Which credential speaks for an appeal ────────────────────────────────

    @Test fun `an appeal signs with the restricted account's own credential, never another`() {
        val a = saved("UA", 2L)
        val b = saved("UB", 1L)
        assertEquals("UB", QuickLoginStore.credentialFor(listOf(a, b), "UB")!!.uid)
        // Not remembered here: no device-key appeal at all, rather than one filed for UA.
        assertNull(QuickLoginStore.credentialFor(listOf(a, b), "UC"))
        // Unknown uid: only a device with exactly one account can say whose it is.
        assertNull(QuickLoginStore.credentialFor(listOf(a, b), ""))
        assertEquals("UA", QuickLoginStore.credentialFor(listOf(a), "")!!.uid)
        // The one blob saved before B10 was always the account last signed out here.
        val legacy = saved("", 0L)
        assertEquals(legacy, QuickLoginStore.credentialFor(listOf(legacy), "UX"))
    }

    // ── The rows the screens get ─────────────────────────────────────────────

    @Test fun `rows - the signed-in account first, one per account, with the profile's ID and no token`() {
        val rows = SavedAccount.rowsOf(
            listOf(saved("u1aaaaaaaaa", 30L), saved("u2bbbbbbbbb", 20L, name = " "), saved("u3ccccccccc", 10L)),
            currentUid = "u3ccccccccc",
        )
        assertEquals(listOf("u3ccccccccc", "u1aaaaaaaaa", "u2bbbbbbbbb"), rows.map { it.uid })
        assertTrue(rows.first().isCurrent)
        assertEquals("ID U1AAAAAA", rows[1].idLabel)
        assertEquals("Guest", rows[2].title)
        // A row has no field that could carry a secret.
        val fields = SavedAccount::class.java.declaredFields.map { it.name.lowercase() }
        assertFalse(fields.any { it.contains("token") || it.contains("secret") })
    }

    @Test fun `the blob saved before B10 is a row with no ID`() {
        val rows = SavedAccount.rowsOf(listOf(saved("", 0L)), currentUid = null)
        assertEquals("", rows.single().idLabel)
        assertFalse(rows.single().isCurrent)
    }

    // ── What a switch ended in ───────────────────────────────────────────────

    @Test fun `the other account is in - restart the app as it`() {
        assertEquals(SwitchOutcome.OpenApp, SavedAccount.afterSwitch("UA", "UB", AuthResult.Success, "Asha"))
        assertEquals(SwitchOutcome.OpenApp, SavedAccount.afterSwitch("UA", "UB", AuthResult.ProfileIncomplete, "Asha"))
    }

    @Test fun `a suspended account is refused and the person stays signed in, told so`() {
        val until = 1_793_000_000_000L
        val r = AuthResult.Banned("Spam in party rooms", RestrictionKind.Suspension, until)
        val o = SavedAccount.afterSwitch("UA", "UA", r, "Asha") as SwitchOutcome.StayHere
        assertTrue(o.message.startsWith("That account is suspended until "))
        assertTrue(o.message.contains("IST"))
        assertTrue(o.message.contains("Reason: Spam in party rooms"))
        assertTrue(o.message.endsWith("You're still signed in as Asha."))
    }

    @Test fun `a banned account, a barred device, an expired sign-in - all stay put`() {
        val banned = SavedAccount.afterSwitch("UA", "UA", AuthResult.Banned("Fraud", RestrictionKind.Account), "") as SwitchOutcome.StayHere
        assertTrue(banned.message.startsWith("That account is banned. Reason: Fraud"))
        assertTrue(banned.message.endsWith("You're still signed in."))
        val device = SavedAccount.afterSwitch("UA", "UA", AuthResult.Banned("x", RestrictionKind.Device), "Asha") as SwitchOutcome.StayHere
        assertTrue(device.message.startsWith("This device has been blocked"))
        val expired = SavedAccount.afterSwitch("UA", "UA", AuthResult.Error(QuickLoginNotice.REMOVED), "Asha") as SwitchOutcome.StayHere
        assertTrue(expired.message.startsWith(SavedAccount.SIGN_IN_AGAIN))
    }

    @Test fun `nobody signed in afterwards - the sign-in screen, with why`() {
        val o = SavedAccount.afterSwitch("UA", null, AuthResult.Error("Network down"), "Asha")
        assertEquals(SwitchOutcome.ToLogin("Network down"), o)
        assertEquals(
            SwitchOutcome.ToLogin(SavedAccount.COULD_NOT_SWITCH),
            SavedAccount.afterSwitch("UA", null, AuthResult.Success, "Asha"),
        )
    }

    // ── The order that makes a refused switch harmless (source) ─────────────

    private val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
    private fun src(p: String) = File(main, "com/zipper/app/$p").readText()
    private val repo by lazy { src("data/repository/AuthRepository.kt") }

    @Test fun `the leaving account is signed out only after the other one is granted`() {
        val fn = repo.substring(repo.indexOf("suspend fun signInWithQuickLogin("), repo.indexOf("private suspend fun refuseQuickLogin("))
        val redeem = fn.indexOf("money.redeemQuickLogin(")
        val restricted = fn.indexOf("return AuthResult.Banned(", redeem)
        val leave = fn.indexOf("if (beforeSignIn != null) beforeSignIn()")
        val open = fn.indexOf("auth.signInWithCustomToken(value.customToken).await()")
        assertTrue(redeem in 0 until leave)
        assertTrue("a ban or suspension returns before anybody is signed out", restricted in redeem until leave)
        assertTrue("the rotation is saved before the old account leaves", fn.indexOf("if (value.token.isNotBlank())") in redeem until leave)
        assertTrue(leave < open)
        // The switch itself: the ordinary sign-out (mints the leaving account's credential, closes its session).
        val sw = repo.substring(repo.indexOf("suspend fun switchToAccount("), repo.indexOf("suspend fun signInWithQuickLogin("))
        assertTrue(sw.contains("beforeSignIn = if (current != null) ({ signOut(deviceId) }) else null"))
        assertTrue(sw.contains("accountUid = targetUid"))
    }

    @Test fun `removing, deleting or abandoning ONE account never forgets the others`() {
        val forget = repo.substring(repo.indexOf("suspend fun forgetSavedAccount("), repo.indexOf("suspend fun switchToAccount("))
        assertTrue(forget.contains("money.forgetQuickLogin("))
        assertTrue(forget.contains("quickLogin.remove(uid)"))
        assertFalse(forget.contains("quickLogin.clear()"))
        val abandon = repo.substring(repo.indexOf("suspend fun abandonSignup("))
        assertTrue(abandon.contains("quickLogin.remove(uid)"))
        assertFalse(abandon.contains("quickLogin.clear()"))
        assertTrue("the key stays while other accounts need it", abandon.contains("if (!othersRemembered) deviceKey.clear()"))
        assertTrue(abandon.contains("money.revokeQuickLogin(token = \"\", allDevices = true)"))
    }

    @Test fun `the screens never see a token`() {
        for (p in listOf("ui/screens/auth/AccountSwitcherScreen.kt", "ui/screens/auth/LoginScreen.kt")) {
            val ui = src(p)
            assertFalse("$p reads a token", ui.contains(".token"))
            assertFalse("$p holds a QuickLoginStore.Saved", ui.contains("QuickLoginStore.Saved"))
        }
        assertTrue(src("navigation/ZipperNavGraph.kt").contains("onSwitchAccount               = { navController.navigate(Screen.AccountSwitcher.route) }"))
    }
}
