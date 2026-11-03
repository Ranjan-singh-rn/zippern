package com.zipper.app.ui.screens.auth

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.hilt.navigation.compose.hiltViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import com.zipper.app.data.repository.AuthRepository
import com.zipper.app.data.repository.SavedAccount
import com.zipper.app.data.repository.SwitchOutcome
import com.zipper.app.ui.components.*
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.QuickLoginStore
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * B10 (4 Nov 2026) — the account switcher (Settings → Switch account), Instagram/HiClub style.
 *
 *   * Lists every account signed in on this device: photo, name, the profile's short ID — never a token.
 *   * Tap one to switch. The other account's saved sign-in is redeemed FIRST; only when the server grants it is
 *     this account signed out (the ordinary way, so it stays one tap away) and the app restarted as the other —
 *     through Splash, which runs every gate a cold start runs. A ban, a suspension, an expired or refused sign-in
 *     leaves the person signed in exactly as they were, with the reason on screen.
 *   * Add account: the ordinary sign-out (this account is remembered), then the sign-in screen.
 *   * Remove: forgets one other account on this device, on the server as well. The account in use is not
 *     removable from here — log out first, then remove it on the sign-in screen.
 */
data class AccountSwitcherState(
    val loading: Boolean = true,
    val accounts: List<SavedAccount> = emptyList(),
    /** The uid being switched to or removed — one action at a time. */
    val busyUid: String? = null,
    val message: String? = null,
)

/** Navigation the switcher asks for; consumed once. */
sealed interface SwitcherNav {
    data object OpenApp : SwitcherNav
    data class ToLogin(val message: String) : SwitcherNav
}

@HiltViewModel
class AccountSwitcherViewModel @Inject constructor(
    private val repo: AuthRepository,
) : ViewModel() {
    private val _state = MutableStateFlow(AccountSwitcherState())
    val state: StateFlow<AccountSwitcherState> = _state.asStateFlow()
    private val _nav = MutableStateFlow<SwitcherNav?>(null)
    val nav: StateFlow<SwitcherNav?> = _nav.asStateFlow()

    init { reload() }

    fun reload() {
        viewModelScope.launch {
            val list = try { repo.savedAccounts() } catch (_: Exception) { emptyList() }
            _state.update { it.copy(loading = false, accounts = withCurrent(list)) }
        }
    }

    /**
     * The signed-in account is always listed, even when this device holds no saved sign-in for it yet (one is
     * minted at sign-in, and that can fail offline) — so the person always sees which account they are in.
     */
    private fun withCurrent(list: List<SavedAccount>): List<SavedAccount> {
        val uid = repo.currentUid() ?: return list
        if (list.any { it.uid == uid }) return list
        return listOf(SavedAccount(uid = uid, displayName = "", photoUrl = "", isCurrent = true)) + list
    }

    fun switchTo(deviceId: String, account: SavedAccount) {
        if (_state.value.busyUid != null || account.isCurrent) return
        _state.update { it.copy(busyUid = account.uid, message = null) }
        viewModelScope.launch {
            val before = repo.currentUid()
            val leavingName = _state.value.accounts.firstOrNull { it.isCurrent }?.title.orEmpty()
            val result = try {
                repo.switchToAccount(deviceId, account.uid)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                com.zipper.app.data.repository.AuthResult.Error(e.message ?: SavedAccount.COULD_NOT_SWITCH)
            }
            when (val outcome = SavedAccount.afterSwitch(before, repo.currentUid(), result, leavingName)) {
                SwitchOutcome.OpenApp -> _nav.value = SwitcherNav.OpenApp
                is SwitchOutcome.ToLogin -> _nav.value = SwitcherNav.ToLogin(outcome.message)
                is SwitchOutcome.StayHere -> {
                    // A refused sign-in may have just been forgotten — re-read the list.
                    val list = try { repo.savedAccounts() } catch (_: Exception) { _state.value.accounts }
                    _state.update { it.copy(busyUid = null, message = outcome.message, accounts = withCurrent(list)) }
                }
            }
        }
    }

    fun remove(deviceId: String, account: SavedAccount) {
        if (_state.value.busyUid != null || account.isCurrent) return
        _state.update { it.copy(busyUid = account.uid, message = null) }
        viewModelScope.launch {
            try { repo.forgetSavedAccount(deviceId, account.uid) } catch (_: Exception) {}
            val list = try { repo.savedAccounts() } catch (_: Exception) { emptyList() }
            _state.update {
                it.copy(busyUid = null, accounts = withCurrent(list), message = "${account.title} was removed from this device.")
            }
        }
    }

    fun onNavigated() { _nav.value = null }
    fun dismissMessage() { _state.update { it.copy(message = null) } }
}

@Composable
fun AccountSwitcherScreen(
    onBack: () -> Unit,
    /** Signed in as the other account: restart the app as it (Splash), nothing of the old one on the stack. */
    onOpenApp: () -> Unit,
    /** Nobody is signed in any more: the sign-in screen. */
    onToLogin: () -> Unit,
    /** The ordinary sign-out (this account is remembered), then the sign-in screen. */
    onAddAccount: () -> Unit,
    viewModel: AccountSwitcherViewModel = hiltViewModel(),
) {
    val s by viewModel.state.collectAsStateWithLifecycle()
    val nav by viewModel.nav.collectAsStateWithLifecycle()
    val c = ZipperTheme.colors
    val context = LocalContext.current
    val deviceId = remember {
        android.provider.Settings.Secure.getString(context.contentResolver, android.provider.Settings.Secure.ANDROID_ID) ?: ""
    }
    var confirmRemove by remember { mutableStateOf<SavedAccount?>(null) }
    // Leaving mid-switch would cancel it half-way — after this account may already be signed out. Held until done.
    BackHandler(enabled = s.busyUid != null) {}
    val canAdd = s.busyUid == null && s.accounts.size < QuickLoginStore.MAX_ACCOUNTS

    LaunchedEffect(nav) {
        when (val n = nav) {
            SwitcherNav.OpenApp -> { viewModel.onNavigated(); onOpenApp() }
            is SwitcherNav.ToLogin -> { viewModel.onNavigated(); ForcedSignOut.raise(n.message); onToLogin() }
            null -> Unit
        }
    }

    ZipperScreen(topBar = { TopBar("Switch account", onBack = if (s.busyUid == null) onBack else null) }) { _ ->
        LazyColumn(contentPadding = PaddingValues(Space.lg), verticalArrangement = Arrangement.spacedBy(Space.sm)) {
            s.message?.let { m ->
                item {
                    Row(
                        Modifier.fillMaxWidth()
                            .background(c.tintDangerSubtle, RoundedCornerShape(Radius.md))
                            .border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.md))
                            .padding(Space.md),
                        horizontalArrangement = Arrangement.spacedBy(Space.md),
                        verticalAlignment = Alignment.Top,
                    ) {
                        Icon(Icons.Outlined.ErrorOutline, null, tint = c.statusWarning, modifier = Modifier.size(18.dp))
                        Text(m, style = ZipperTheme.type.bodyS, color = c.textPrimary, modifier = Modifier.weight(1f))
                        Icon(Icons.Default.Close, "Dismiss", tint = c.textMuted, modifier = Modifier.size(18.dp).clickableNoRipple { viewModel.dismissMessage() })
                    }
                }
            }
            if (s.loading) {
                item { Box(Modifier.fillMaxWidth().padding(Space.xl), contentAlignment = Alignment.Center) { CircularProgressIndicator(color = c.brandPrimary) } }
            }
            items(s.accounts, key = { it.uid.ifBlank { "unfiled" } }) { a ->
                AccountRow(
                    account = a,
                    busy = s.busyUid == a.uid,
                    enabled = s.busyUid == null,
                    onSwitch = { viewModel.switchTo(deviceId, a) },
                    onRemove = { confirmRemove = a },
                )
            }
            item {
                Row(
                    Modifier.fillMaxWidth()
                        .background(c.bgRaised, RoundedCornerShape(Radius.md))
                        .then(if (canAdd) Modifier.clickableNoRipple(onAddAccount) else Modifier)
                        .padding(Space.md),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Space.md),
                ) {
                    Box(Modifier.size(40.dp).background(c.bgElevated, CircleShape), contentAlignment = Alignment.Center) {
                        Icon(Icons.Default.Add, null, tint = c.textPrimary)
                    }
                    Column(Modifier.weight(1f)) {
                        Text("Add account", style = ZipperTheme.type.labelL, color = if (canAdd) c.textPrimary else c.textMuted)
                        Text(
                            if (s.accounts.size >= QuickLoginStore.MAX_ACCOUNTS) "This device remembers ${QuickLoginStore.MAX_ACCOUNTS} accounts already — remove one to add another."
                            else "Sign in to another account. This one stays on this device.",
                            style = ZipperTheme.type.caption, color = c.textMuted,
                        )
                    }
                }
            }
            item {
                Text(
                    "Up to ${QuickLoginStore.MAX_ACCOUNTS} accounts are remembered on this device. A saved sign-in " +
                        "works only on this phone and stops working after 30 days unused, if the account is opened on " +
                        "another phone, or if it is signed out everywhere.",
                    style = ZipperTheme.type.caption, color = c.textMuted,
                    modifier = Modifier.padding(top = Space.sm),
                )
            }
        }
    }

    confirmRemove?.let { a ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null }, containerColor = c.bgElevated,
            title = { Text("Remove ${a.title}?", style = ZipperTheme.type.headingS, color = c.textPrimary) },
            text = {
                Text(
                    "This device forgets the account and its saved sign-in. The account itself is not touched — " +
                        "sign in to it again any time with your phone number or Google.",
                    style = ZipperTheme.type.bodyM, color = c.textSecondary,
                )
            },
            confirmButton = {
                TextButton({ confirmRemove = null; viewModel.remove(deviceId, a) }) { Text("Remove", color = c.statusDanger) }
            },
            dismissButton = { TextButton({ confirmRemove = null }) { Text("Cancel", color = c.textSecondary) } },
        )
    }
}

@Composable
private fun AccountRow(
    account: SavedAccount,
    busy: Boolean,
    enabled: Boolean,
    onSwitch: () -> Unit,
    onRemove: () -> Unit,
) {
    val c = ZipperTheme.colors
    Row(
        Modifier.fillMaxWidth()
            .background(if (account.isCurrent) c.tintBrandSubtle else c.bgRaised, RoundedCornerShape(Radius.md))
            .then(if (enabled && !account.isCurrent) Modifier.clickableNoRipple(onSwitch) else Modifier)
            .padding(Space.md),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Space.md),
    ) {
        Avatar(account.photoUrl, size = AvatarSize.MD, initial = account.title)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(
                if (account.isCurrent && account.displayName.isBlank()) "This account" else account.title,
                style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1,
            )
            val sub = listOf(account.idLabel, if (account.isCurrent) "Signed in" else "").filter { it.isNotBlank() }
            if (sub.isNotEmpty()) Text(sub.joinToString("  ·  "), style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 1)
        }
        when {
            busy -> CircularProgressIndicator(Modifier.size(20.dp), color = c.brandPrimary, strokeWidth = 2.dp)
            account.isCurrent -> Icon(Icons.Default.Check, "Signed in", tint = c.brandPrimary)
            else -> Icon(
                Icons.Default.Close, "Remove ${account.title} from this device", tint = c.textMuted,
                modifier = Modifier.size(22.dp).then(if (enabled) Modifier.clickableNoRipple(onRemove) else Modifier),
            )
        }
    }
}
