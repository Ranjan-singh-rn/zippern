package com.zipper.app.ui.screens.work

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import com.zipper.app.BuildConfig
import com.zipper.app.data.work.Caps
import com.zipper.app.data.work.CrmWebLink
import com.zipper.app.ui.components.clickableNoRipple
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

/*
 * "Open the full CRM" — the Work hub's door to every CRM page that has no screen in the app yet (5 Nov 2026).
 *
 * It opens the CRM as a browser tab over the app (the Custom Tabs protocol, spoken without the androidx.browser
 * library: a SESSION extra on a plain VIEW intent). Nothing of the app's sign-in is handed over: the CRM signs the
 * person in itself and enforces its own roles, MFA and sessions, exactly as on a computer. The page runs in the
 * browser, never in an embedded web view, so no page script runs inside the app's process or reaches its storage.
 */

private const val EXTRA_CUSTOM_TABS_SESSION = "android.support.customtabs.extra.SESSION"
private const val EXTRA_CUSTOM_TABS_TOOLBAR_COLOR = "android.support.customtabs.extra.TOOLBAR_COLOR"

/** Opens [url] as a browser tab over the app. False when the phone has no browser to open it. */
internal fun openCrmTab(context: Context, url: String, toolbarColor: Int? = null): Boolean {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
        // A Custom Tabs session extra — even a null binder — asks a supporting browser for a tab over this app.
        putExtras(Bundle().apply { putBinder(EXTRA_CUSTOM_TABS_SESSION, null) })
        toolbarColor?.let { putExtra(EXTRA_CUSTOM_TABS_TOOLBAR_COLOR, it) }
        addCategory(Intent.CATEGORY_BROWSABLE)
        if (context !is Activity) addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    return try {
        context.startActivity(intent)
        true
    } catch (_: ActivityNotFoundException) {
        false
    }
}

@Composable
internal fun CrmWebCard(caps: Caps) {
    if (!CrmWebLink.offered(caps)) return
    val url = CrmWebLink.url(BuildConfig.CRM_WEB_URL, caps) ?: return
    val context = LocalContext.current
    val c = ZipperTheme.colors
    var noBrowser by remember { mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth()
            .background(c.bgRaised, RoundedCornerShape(Radius.lg))
            .clickableNoRipple { noBrowser = !openCrmTab(context, url) }
            .padding(Space.md),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Open the full CRM", style = ZipperTheme.type.labelL, color = c.textPrimary)
                Text(
                    if (caps.isExternal) "Invite hosts, salary requests, sub-agencies, KYC and payment details — everything " +
                        "the CRM has that is not on this screen. Sign in with your CRM email."
                    else "Every CRM page, in a browser tab over the app. Sign in as you do on the computer.",
                    style = ZipperTheme.type.caption, color = c.textSecondary,
                )
            }
            Icon(Icons.Default.ChevronRight, null, tint = c.textMuted, modifier = Modifier.size(18.dp))
        }
        if (noBrowser) Text(
            "No browser on this phone can open it. Install Chrome, or open $url on a computer.",
            style = ZipperTheme.type.caption, color = c.statusWarning, modifier = Modifier.padding(top = Space.xs),
        )
    }
}
