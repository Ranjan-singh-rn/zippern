package com.zipper.app.ui.components

import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp
import com.zipper.app.ui.theme.ZipperTheme
import java.text.NumberFormat
import java.util.Locale

/*
 * Live badge — Figma set 16:28. Height 20, radius full, pad 4/9/4/8, gap 5,
 * a 6dp dot and Inter Bold 10 in white.
 *   Live    → coral fill, "LIVE", the dot pulses
 *   Viewers → ink/950 fill, the count
 *   Party   → violet fill, "PARTY"
 */

enum class LiveBadgeKind { Live, Viewers, Party }

@Composable
fun LiveBadge(kind: LiveBadgeKind, modifier: Modifier = Modifier, viewers: Long = 0L) {
    val c = ZipperTheme.colors
    val fill = when (kind) {
        LiveBadgeKind.Live -> c.statusLive
        LiveBadgeKind.Viewers -> c.bgScrim
        LiveBadgeKind.Party -> c.brandSecondary
    }
    val label = when (kind) {
        LiveBadgeKind.Live -> "LIVE"
        LiveBadgeKind.Viewers -> compactCount(viewers)
        LiveBadgeKind.Party -> "PARTY"
    }

    // The live dot breathes. A static red dot reads as an icon; a pulsing one
    // reads as "happening now", which is the whole message of the badge.
    val pulse = rememberInfiniteTransition(label = "live")
    val dotAlpha by pulse.animateFloat(
        initialValue = 1f, targetValue = 0.35f,
        animationSpec = infiniteRepeatable(tween(900, easing = FastOutSlowInEasing), RepeatMode.Reverse),
        label = "dot",
    )

    Row(
        modifier = modifier
            .height(20.dp)
            .background(fill, CircleShape)
            .padding(start = 8.dp, end = 9.dp, top = 4.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(5.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(6.dp)
                .alpha(if (kind == LiveBadgeKind.Live) dotAlpha else 1f)
                .background(Color.White, CircleShape)
        )
        Text(label, style = ZipperTheme.type.overline, color = Color.White, maxLines = 1)
    }
}

/*
 * Currency pill — Figma set 16:38. Height 32, radius full, pad 0/12/0/6, gap 6,
 * a 20dp currency disc and Inter Semi Bold 13. Fill is bg/elevated.
 *
 * Indian digit grouping (1,04,200), because that is how the audience reads a
 * number and a Western-grouped balance looks subtly foreign.
 */

enum class Currency { Diamond, Bean, Coin }

@Composable
fun CurrencyPill(
    currency: Currency,
    amount: Long,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
) {
    val c = ZipperTheme.colors
    val disc = when (currency) {
        Currency.Diamond -> c.currencyDiamond
        Currency.Bean -> c.currencyBean
        Currency.Coin -> c.currencyCoin
    }
    Row(
        modifier = modifier
            .height(32.dp)
            .background(c.bgElevated, CircleShape)
            .then(if (onClick != null) Modifier.clickableNoRipple(onClick) else Modifier)
            .padding(start = 6.dp, end = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        CurrencyDisc(currency, 20.dp)
        Text(indianGrouping(amount), style = ZipperTheme.type.numericS, color = c.textPrimary, maxLines = 1)
    }
}

/** The currency's coloured disc, used inside pills and beside prices. */
@Composable
fun CurrencyDisc(currency: Currency, size: androidx.compose.ui.unit.Dp) {
    val c = ZipperTheme.colors
    val disc = when (currency) {
        Currency.Diamond -> c.currencyDiamond
        Currency.Bean -> c.currencyBean
        Currency.Coin -> c.currencyCoin
    }
    Box(Modifier.size(size).background(disc, CircleShape))
}

/** Small "price" row: disc + amount, for gift tiles and shop items. */
@Composable
fun Price(currency: Currency, amount: Long, modifier: Modifier = Modifier, color: Color = ZipperTheme.colors.textSecondary) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        CurrencyDisc(currency, 12.dp)
        Text(indianGrouping(amount), style = ZipperTheme.type.numericS, color = color, maxLines = 1)
    }
}

// ── Formatting ───────────────────────────────────────────────────────────────

private val indianFormat: NumberFormat by lazy { NumberFormat.getIntegerInstance(Locale("en", "IN")) }

/** 104200 → "1,04,200". */
fun indianGrouping(n: Long): String = indianFormat.format(n)

/** 1234 → "1.2K", 1_500_000 → "1.5M". For badges and counters, not balances. */
fun compactCount(n: Long): String {
    fun one(v: Double, suffix: String) = String.format(Locale.US, "%.1f", v).removeSuffix(".0") + suffix
    return when {
        n >= 10_000_000 -> one(n / 10_000_000.0, "Cr")
        n >= 100_000 -> one(n / 100_000.0, "L")
        n >= 1_000 -> one(n / 1_000.0, "K")
        else -> n.toString()
    }
}

/** A small status chip: "Verified", "Host", "Lv.12". Text only, tinted. */
@Composable
fun Chip(
    text: String,
    modifier: Modifier = Modifier,
    tint: Color = ZipperTheme.colors.tintBrandSubtle,
    contentColor: Color = ZipperTheme.colors.textBrand,
    icon: ImageVector? = null,
) {
    Row(
        modifier = modifier
            .height(22.dp)
            .background(tint, CircleShape)
            .padding(horizontal = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, null, tint = contentColor, modifier = Modifier.size(12.dp))
        Text(text, style = ZipperTheme.type.labelS, color = contentColor, maxLines = 1)
    }
}

// ── Role badges ───────────────────────────────────────────────────────────────

/**
 * Who somebody is, as one ordered list.
 *
 * There used to be no such list. Each profile screen decided for itself, from
 * the same user document, and they disagreed: your own profile showed AGENT and
 * not OFFICIAL, somebody else's showed OFFICIAL and SELLER and not AGENT, and
 * nothing showed the CRM owner at all. Two private badge composables, three
 * hand-written `if` chains, one source of truth missing.
 *
 * So the decision lives here and the screens render what it returns. A badge
 * added once appears everywhere a person is shown, which is the property that
 * was missing — a badge is a claim the platform makes about somebody, and it
 * should not depend on which screen you happened to be looking at.
 *
 * Order is precedence: the platform's own roles first, then what somebody has
 * earned. A person can legitimately hold several — an agency owner who also
 * sells coins and hosts is three of these at once.
 */
data class ZipperRole(val label: String, val tint: Color)

@Composable
fun roleBadgesFor(
    isHost: Boolean = false,
    isVerifiedHost: Boolean = false,
    isAgent: Boolean = false,
    isSeller: Boolean = false,
    isOfficial: Boolean = false,
    crmRole: String = "",
    /**
     * Own profile shows "HOST · PENDING" so a host who has not captured yet is
     * told why they cannot withdraw. Nobody else needs to know that, so on
     * another person's profile an unverified host is simply HOST.
     */
    showPendingHost: Boolean = false,
): List<ZipperRole> {
    val c = ZipperTheme.colors
    val out = mutableListOf<ZipperRole>()

    // `crmRole` is stamped by syncMyRoles from `crmUsers/{uid}`, so it carries
    // the CRM's real vocabulary: 'superadmin' for an owner, and the twelve
    // department roles as `<team>_admin` / `<team>_member`.
    //
    // It used to list six strings — superadmin, admin, ops, tech, finance,
    // support — which was the vocabulary the CRM abandoned when departments
    // were split into admin and member tiers. `ops_admin` matched none of the
    // six, so an ops admin's profile showed no badge at all. Rather than write
    // out twelve more branches that would rot the same way the first five did,
    // the label is derived from the role, so a thirteenth department needs no
    // change here.
    //
    // 'superadmin' is what the CRM calls the OWNER — there is no separate
    // 'owner' string, which is worth knowing before going to look for one.
    // Partners are deliberately absent: an agency or a coin seller is flagged
    // through isAgent / isSeller below, and syncMyRoles leaves their crmRole
    // empty so they cannot also be labelled as staff.
    if (crmRole == "superadmin") {
        out += ZipperRole("OWNER", c.brandVip)
    } else if (crmRole.isNotBlank()) {
        val team = crmRole.substringBefore('_')
        val isDeptAdmin = crmRole.endsWith("_admin")
        val tint = when (team) {
            "app"       -> c.brandPrimary
            "ops", "tech" -> c.currencyDiamond
            "finance"   -> c.statusSuccess
            "support"   -> c.statusWarning
            "marketing" -> c.brandSecondary
            else        -> c.brandPrimary
        }
        val label = team.uppercase() + if (isDeptAdmin) " ADMIN" else ""
        out += ZipperRole(label, tint)
    }
    if (isOfficial) out += ZipperRole("OFFICIAL", c.currencyDiamond)
    if (isAgent)    out += ZipperRole("AGENT", c.brandSecondary)
    if (isSeller)   out += ZipperRole("SELLER", c.currencyBean)
    when {
        isHost && isVerifiedHost  -> out += ZipperRole("VERIFIED HOST", c.brandVip)
        isHost && showPendingHost -> out += ZipperRole("HOST · PENDING", c.statusWarning)
        isHost                    -> out += ZipperRole("HOST", c.brandVip)
    }
    return out
}

/** One role badge. The only badge shape; the screens no longer keep their own. */
@Composable
fun RoleBadgePill(badge: ZipperRole, modifier: Modifier = Modifier) {
    Box(
        modifier
            .height(18.dp)
            .background(badge.tint.copy(alpha = 0.14f), CircleShape)
            .border(1.dp, badge.tint, CircleShape)
            .padding(horizontal = 8.dp),
        contentAlignment = Alignment.Center,
    ) { Text(badge.label, style = ZipperTheme.type.overline, color = badge.tint) }
}

/** Every badge this person holds, in order. Nothing rendered when they hold none. */
@Composable
fun RoleBadgeRow(badges: List<ZipperRole>, modifier: Modifier = Modifier) {
    if (badges.isEmpty()) return
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        badges.forEach { RoleBadgePill(it) }
    }
}
