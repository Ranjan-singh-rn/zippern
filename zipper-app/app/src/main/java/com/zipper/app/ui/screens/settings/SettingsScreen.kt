package com.zipper.app.ui.screens.settings

import android.content.Intent
import android.provider.Settings
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * Settings — Figma "07 Settings / 01 Settings" (96:2).
 *
 * Grouped glass cards with 52h rows: leading 20 icon in a tinted disc,
 * label 15, optional value, chevron. Theme is a three-way segmented row.
 * Notification preferences open the system channel settings — the app no
 * longer keeps three switches that were wired to nothing.
 */

data class AppLanguage(val code: String, val nativeName: String, val englishName: String)

private val SUPPORTED_LANGUAGES = listOf(
    AppLanguage("en", "English", "English"),
    AppLanguage("hi", "हिन्दी", "Hindi"),
    AppLanguage("mr", "मराठी", "Marathi"),
    AppLanguage("bn", "বাংলা", "Bengali"),
    AppLanguage("ta", "தமிழ்", "Tamil"),
    AppLanguage("te", "తెలుగు", "Telugu"),
    AppLanguage("kn", "ಕನ್ನಡ", "Kannada"),
    AppLanguage("gu", "ગુજરાતી", "Gujarati"),
    AppLanguage("pa", "ਪੰਜਾਬੀ", "Punjabi"),
    AppLanguage("ur", "اردو", "Urdu"),
    AppLanguage("ar", "العربية", "Arabic"),
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    appVersion: String = "1.0.0",
    savedTheme: String = "system",
    savedLanguage: String = "en",
    isAgent: Boolean = false,
    isSeller: Boolean = false,
    onThemeChange: (String) -> Unit = {},
    onLanguageChange: (String) -> Unit = {},
    onBack: () -> Unit = {},
    onNavigateToBlockedUsers: () -> Unit = {},
    onNavigateToAgencyDashboard: () -> Unit = {},
    onNavigateToSellerDashboard: () -> Unit = {},
    onFeedback: () -> Unit = {},
    onDeleteAccount: () -> Unit = {},
    onSwitchAccount: () -> Unit = {},
    onPrivacyPolicy: () -> Unit = {},
    onTerms: () -> Unit = {},
    onLogout: () -> Unit = {},
    /**
     * Sign out AND erase the quick-sign-in secret from this handset.
     *
     * Deliberately separate from [onLogout]. An ordinary sign-out REMEMBERS the
     * account — that is the feature, not an oversight — so on a borrowed or
     * shared phone "Log out" leaves a one-tap route straight back into the
     * account, photo and name included, for whoever picks it up next.
     */
    onSignOutAndForget: () -> Unit = {},
    /**
     * Open the flow that attaches a phone number to a guest account.
     *
     * Shown to guests and nobody else — see the section in the body for what a
     * guest account actually is and why this is the most important row on the
     * screen for the people who can see it.
     */
    onSecureAccount: () -> Unit = {},
    /**
     * Open the flow that attaches an EMAIL address to a guest account.
     *
     * A separate destination rather than a mode on [onSecureAccount], because
     * the two flows differ where it matters: one never leaves the app and one
     * ends by leaving it for a mail client and being reopened by a link. See
     * `SecureEmailScreen` for the whole argument.
     */
    onSecureEmail: () -> Unit = {},
    /**
     * Whether this account is still a guest — an anonymous account with no
     * provider attached to it. Decides whether the "Secure your account"
     * section below appears at all.
     *
     * Passed in, and answered by the SERVER. It used to be read here as
     * `FirebaseAuth.getInstance().currentUser?.isAnonymous == true`, which is
     * wrong in both directions and wrong for the people who matter most:
     *
     *   * FALSE for a guest who returned through quick sign-in, because that
     *     path redeems a custom token rather than an anonymous credential —
     *     which is the whole reason it can recover a guest account at all. So
     *     the row was hidden from every returning guest, the exact group whose
     *     account exists on one handset and nowhere else.
     *   * TRUE for a guest who has just linked a number in this session,
     *     because `sign_in_provider` records how the session began and does
     *     not change on a link. They would be invited to add a number they
     *     had already added.
     *
     * `resolveIdentity` answers it from `providerData` — the account itself —
     * and `SessionManager` caches that answer. See [com.zipper.app.util.SessionManager].
     */
    isGuest: Boolean = false,
    /**
     * Run the OTA update check by hand. Null when in-app updating is off — see
     * `BuildConfig.OTA_ENABLED` in app/build.gradle.kts — in which case the row
     * below is the plain, untappable version line it has always been.
     *
     * Null-as-absent rather than a separate `otaEnabled` boolean, so there is one
     * thing to be wrong about instead of two, and so this screen never has to
     * read BuildConfig itself (which would also break its @Preview).
     */
    onCheckForUpdates: (() -> Unit)? = null,
) {
    val c = ZipperTheme.colors
    val context = LocalContext.current
    var showDelete by remember { mutableStateOf(false) }
    var showLogout by remember { mutableStateOf(false) }
    var showForget by remember { mutableStateOf(false) }
    var showLanguage by remember { mutableStateOf(false) }
    val currentLanguage = remember(savedLanguage) { SUPPORTED_LANGUAGES.find { it.code == savedLanguage } ?: SUPPORTED_LANGUAGES.first() }

    ZipperScreen(topBar = { TopBar("Settings", onBack = onBack) }) { _ ->
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.lg)) {
            /*
             * ── GUESTS ONLY, AND ABOVE EVERYTHING ────────────────────────────
             *
             * A guest account IS the anonymous credential sitting on this
             * handset. No SMS and no Google account can produce it again, so a
             * lost or wiped phone is a lost account — with its diamonds, its
             * level and its history — and an ordinary sign-out very nearly was
             * one until quick sign-in started surviving it.
             *
             * The app had no way at all to attach a number:
             * `AuthRepository.linkPhone` existed and had zero callers, so there
             * was no screen, no button and nothing a guest could do about any of
             * this. These rows are that door.
             *
             * It sits above "Account" because for the person who can see it there
             * is nothing else on this screen of comparable consequence, and
             * anybody who already has a number never sees it at all.
             *
             * ── TWO ROWS, NOT A CHOOSER ──────────────────────────────────────
             *
             * Either identifier is enough on its own — the server binds whichever
             * one it is given and asks for no second one — so this is two ways in
             * rather than two steps. A single row leading to a "phone or email?"
             * screen would add a decision in front of the phone flow, which is
             * the one most of these people will take, to make room for the one
             * fewer of them will. Whoever has no SIM in this handset, or no
             * number they are willing to give, now has a door of their own.
             */
            if (isGuest) {
                Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
                    Group("Secure your account") {
                        SettingRow(Icons.Outlined.Phone, "Add your phone number", onClick = onSecureAccount)
                        SettingRow(Icons.Outlined.MailOutline, "Add your email", onClick = onSecureEmail)
                    }
                    /*
                     * The sentence goes under the card rather than on the row.
                     * `SettingRow` is a fixed 52dp with the label on `weight(1f)`,
                     * so anything long enough to explain the stakes would either
                     * wrap out of the row or push the label out of it.
                     */
                    Text(
                        "You are signed in as a guest, so this account only exists on " +
                            "this phone. Adding either one keeps it.",
                        style = ZipperTheme.type.caption, color = c.textMuted,
                        modifier = Modifier.padding(horizontal = Space.xs),
                    )
                }
            }

            Group("Account") {
                if (isAgent) SettingRow(Icons.Outlined.Groups, "My agency", onClick = onNavigateToAgencyDashboard)
                if (isSeller) SettingRow(Icons.Outlined.Storefront, "Seller panel", onClick = onNavigateToSellerDashboard)
                SettingRow(Icons.Outlined.Block, "Blocked users", onClick = onNavigateToBlockedUsers)
                SettingRow(Icons.Outlined.SwitchAccount, "Switch account", onClick = onSwitchAccount)
            }

            /*
             * The theme picker is GONE, deliberately.
             *
             * It offered Light / Dark / System and wrote the choice to
             * `users/{uid}.theme`. Nothing reads that field any more: the app is
             * pinned dark (see ZipperTheme), because the light palette existed but
             * had never been finished — `textOnBrand` is white in both palettes,
             * so on a light-mode phone the Secondary buttons were white text on a
             * white fill and the login screen had two invisible controls.
             *
             * A control that visibly does nothing is worse than a missing one: it
             * reads as the app being broken, and it invites a support ticket for
             * every person who taps Light and sees no change. `onThemeChange` and
             * the stored field are left in place so reviving this is a UI change
             * rather than a plumbing one.
             */
            Group("Appearance") {
                SettingRow(Icons.Outlined.Language, "App language", value = currentLanguage.nativeName, onClick = { showLanguage = true })
            }

            Group("Notifications") {
                SettingRow(Icons.Outlined.Notifications, "Notification settings", value = "Calls, messages, live", onClick = {
                    val intent = Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
                    context.startActivity(intent)
                })
            }

            Group("About") {
                SettingRow(Icons.AutoMirrored.Outlined.HelpOutline, "Help & support", onClick = onFeedback)
                SettingRow(Icons.Outlined.PrivacyTip, "Privacy policy", onClick = onPrivacyPolicy)
                SettingRow(Icons.Outlined.Description, "Terms of service", onClick = onTerms)
                /*
                 * ── ONE ROW, NOT TWO ─────────────────────────────────────────
                 *
                 * The version line and the update check are the same row,
                 * because they answer the same question: "am I on the current
                 * build?". Two rows a centimetre apart, one saying 1.0.7 and one
                 * saying "Check for updates", make the reader work out that they
                 * are related.
                 *
                 * The value is `versionName (versionCode)`. The code is in there
                 * on purpose and is not developer noise here: versionCode is the
                 * ONLY thing the updater compares, and while builds are still
                 * hand-shared it is the only way to tell two APKs with the same
                 * versionName apart — which has already happened more than once.
                 *
                 * Untappable with no chevron when OTA is off, rather than hidden.
                 * A build with the updater switched off still needs a version
                 * number somebody can read out over a support call.
                 */
                if (onCheckForUpdates != null) {
                    SettingRow(
                        Icons.Outlined.SystemUpdate,
                        "Check for updates",
                        value = appVersion,
                        onClick = onCheckForUpdates,
                    )
                } else {
                    SettingRow(Icons.Outlined.Info, "Version", value = appVersion, chevron = false)
                }
            }

            Group(null) {
                SettingRow(Icons.AutoMirrored.Outlined.Logout, "Log out", onClick = { showLogout = true })
                /*
                 * THE HONEST "LOG OUT" FOR A PHONE THAT IS NOT YOURS.
                 *
                 * "Log out" above deliberately keeps the quick-sign-in secret:
                 * remembering the account across a sign-out is the whole point
                 * of it, and for a guest it is the only thing that can ever
                 * return their balance, since an anonymous credential cannot be
                 * re-obtained from an SMS or a Google picker.
                 *
                 * That is exactly wrong on a borrowed handset. Somebody who
                 * signs in on a friend's phone, taps Log out and hands it back
                 * has left a button on the login screen showing their photo and
                 * their name that signs straight back into their account, with
                 * their diamonds in it, for whoever holds the phone next. They
                 * did the one thing the app offered and it did not do what they
                 * assumed.
                 *
                 * So there are two rows, and the difference is stated in words
                 * rather than implied: this is the one that forgets. Kept as a
                 * separate row rather than a checkbox on the dialog above
                 * because a person reaching for "log out" on a shared phone is
                 * not in a mood to read a dialog, and a second unticked box is
                 * how you end up with the default anyway.
                 *
                 * No `value` text on this row on purpose. `SettingRow` gives the
                 * label `weight(1f)` and everything else takes its width first,
                 * so a trailing chip would push the longest label in Settings
                 * onto a second line inside a row that is a fixed 52dp tall. The
                 * sentence that explains it lives in the dialog, one tap away,
                 * where there is room to say it properly.
                 */
                SettingRow(
                    Icons.AutoMirrored.Outlined.Logout,
                    "Sign out and forget this device",
                    onClick = { showForget = true },
                )
                SettingRow(Icons.Outlined.DeleteForever, "Delete account", danger = true, onClick = { showDelete = true })
            }
            Spacer(Modifier.navigationBarsPadding().height(Space.lg))
        }
    }

    if (showLogout) {
        AlertDialog(
            onDismissRequest = { showLogout = false }, containerColor = c.bgElevated,
            title = { Text("Log out?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = { Text("Your balances stay on your account.", style = ZipperTheme.type.bodyM, color = c.textSecondary) },
            confirmButton = { TextButton({ showLogout = false; onLogout() }) { Text("Log out", color = c.statusDanger) } },
            dismissButton = { TextButton({ showLogout = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
    if (showForget) {
        AlertDialog(
            onDismissRequest = { showForget = false }, containerColor = c.bgElevated,
            title = { Text("Forget this device?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            /*
             * Says what it does and what it costs, in that order, without the
             * word "token" in it.
             *
             * The second sentence matters most to guests: signing in again means
             * a phone number or a Google account, and a guest account has
             * neither. Better they read that here than discover it on a login
             * screen with no button on it.
             */
            text = {
                Text(
                    "For a shared phone. Removes quick sign-in for this account, so " +
                        "nobody can tap straight back in from this handset.\n\n" +
                        "Your account and balances are untouched — but you will need your " +
                        "phone number or Google account to sign in again.",
                    style = ZipperTheme.type.bodyM, color = c.textSecondary,
                )
            },
            confirmButton = { TextButton({ showForget = false; onSignOutAndForget() }) { Text("Sign out and forget", color = c.statusDanger) } },
            dismissButton = { TextButton({ showForget = false }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
    if (showDelete) {
        /*
         * ── THIS DIALOG USED TO BE FALSE ─────────────────────────────────────
         *
         * It said: "This is permanent. Unspent diamonds and unpaid beans are
         * forfeited, and your profile, chats and history are removed." Three
         * claims, and the product does none of them.
         *
         * It is not permanent — `requestAccountDeletion` in
         * functions/src/accounts.ts moves the account to `recovery_pending` and
         * it can be restored in one tap for thirty days. The history is not
         * removed — `RETAINED_SUBCOLLECTIONS` names seven that survive for the
         * life of the CRM, the user document itself becomes the historical
         * record rather than being deleted, and messages, coin purchases and
         * gift history are never touched by the purge at all. And nothing is
         * forfeited on the day they tap this; it happens thirty days later, if
         * they do not come back.
         *
         * Every one of those errors runs the same way: it frightens somebody out
         * of a reversible decision, and then quietly keeps what it told them was
         * destroyed. That is the worst pairing a deletion dialog can have, and it
         * is why this text is now four plain sentences in the order the person
         * experiences them — what happens now, the thirty days, what is lost at
         * the end, and what is kept regardless.
         *
         * `AuthRepository.softDeleteAccount` and `deleteAccountNow` have
         * described the real behaviour in their comments the whole time. This is
         * the copy catching up with them.
         */
        AlertDialog(
            onDismissRequest = { showDelete = false }, containerColor = c.bgElevated,
            title = { Text("Delete account?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Text(
                    "You are signed out straight away and your profile disappears — " +
                        "calls and messages stop, and nobody can find you.\n\n" +
                        "For 30 days nothing is destroyed. Sign in again before then " +
                        "and we will offer your account back, exactly as it was.\n\n" +
                        "After 30 days it is final: your profile, photos, followers and " +
                        "anything you bought are deleted, you can no longer sign in, and " +
                        "any diamonds or beans left on the account go with it.\n\n" +
                        "Your purchase and earnings records are kept, so a payment " +
                        "question can still be answered later. Messages you have " +
                        "already sent stay in the other person's chat.",
                    style = ZipperTheme.type.bodyM, color = c.textSecondary,
                )
            },
            confirmButton = { TextButton({ showDelete = false; onDeleteAccount() }) { Text("Delete", color = c.statusDanger) } },
            dismissButton = { TextButton({ showDelete = false }) { Text("Keep my account", color = c.textSecondary) } },
        )
    }
    if (showLanguage) {
        ModalBottomSheet(onDismissRequest = { showLanguage = false }, containerColor = c.bgElevated, dragHandle = null, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
            Column(Modifier.navigationBarsPadding().padding(bottom = Space.md)) {
                Box(Modifier.padding(top = 6.dp).size(36.dp, 4.dp).background(c.borderDefault, CircleShape).align(Alignment.CenterHorizontally))
                Text("App language", style = ZipperTheme.type.headingS, color = c.textPrimary, modifier = Modifier.padding(Space.lg))
                LazyColumn(Modifier.heightIn(max = 480.dp)) {
                    items(SUPPORTED_LANGUAGES, key = { it.code }) { lang ->
                        val on = lang.code == currentLanguage.code
                        Row(
                            Modifier.fillMaxWidth().clickableNoRipple { showLanguage = false; onLanguageChange(lang.code) }.padding(horizontal = Space.lg, vertical = Space.md),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(lang.nativeName, style = ZipperTheme.type.bodyL, color = c.textPrimary)
                                if (lang.code != "en") Text(lang.englishName, style = ZipperTheme.type.caption, color = c.textSecondary)
                            }
                            if (on) Icon(Icons.Outlined.CheckCircle, null, tint = c.brandPrimary, modifier = Modifier.size(20.dp))
                        }
                    }
                }
            }
        }
    }
}

// ── Pieces ───────────────────────────────────────────────────────────────────

@Composable
private fun Group(title: String?, content: @Composable ColumnScope.() -> Unit) {
    val c = ZipperTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        if (title != null) Text(title.uppercase(), style = ZipperTheme.type.overline, color = c.textMuted, modifier = Modifier.padding(start = Space.xs))
        Column(
            Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)),
            content = content,
        )
    }
}

@Composable
private fun SettingRow(icon: ImageVector, label: String, value: String? = null, danger: Boolean = false, chevron: Boolean = true, onClick: (() -> Unit)? = null) {
    val c = ZipperTheme.colors
    val tint = if (danger) c.statusDanger else c.textPrimary
    Row(
        Modifier.fillMaxWidth().height(52.dp).then(if (onClick != null) Modifier.clickableNoRipple(onClick) else Modifier).padding(horizontal = Space.lg),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Box(Modifier.size(32.dp).background(if (danger) c.tintDangerSubtle else c.glassMid, CircleShape), contentAlignment = Alignment.Center) {
            Icon(icon, null, tint = tint, modifier = Modifier.size(18.dp))
        }
        Text(label, style = ZipperTheme.type.bodyL, color = tint, modifier = Modifier.weight(1f))
        if (value != null) Text(value, style = ZipperTheme.type.bodyS, color = c.textSecondary)
        if (chevron && onClick != null) Icon(Icons.Default.ChevronRight, null, tint = c.textMuted, modifier = Modifier.size(18.dp))
    }
}
