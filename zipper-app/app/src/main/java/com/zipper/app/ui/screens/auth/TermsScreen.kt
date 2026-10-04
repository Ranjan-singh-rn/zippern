package com.zipper.app.ui.screens.auth

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.sp
import com.zipper.app.ui.components.TopBar
import com.zipper.app.ui.components.ZipperScreen
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme

@Composable
fun TermsScreen(onBack: () -> Unit) {
    val c = ZipperTheme.colors
    ZipperScreen(topBar = { TopBar("Terms & Conditions", onBack = onBack) }) { _ ->
        Column(
            Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.lg, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.xxl),
        ) {
            TermsSection(
                title = "1. Acceptance of Terms",
                body = "By downloading, installing, or using the Zipper application (\"App\"), you agree to be bound by these Terms and Conditions (\"Terms\"). If you do not agree to these Terms, do not use the App. These Terms apply to all users including viewers, hosts, and guests.",
            )
            TermsSection(
                title = "2. Eligibility",
                body = "You must be at least 18 years of age to use Zipper. By using the App, you represent and warrant that you are 18 years of age or older. If we discover that a user is under 18, we will immediately terminate their account.",
            )
            TermsSection(
                title = "3. User Account",
                body = "You are responsible for maintaining the confidentiality of your account credentials. You agree to provide accurate, current, and complete information during registration. You are solely responsible for all activities that occur under your account. Zipper reserves the right to terminate accounts that violate these Terms.",
            )
            TermsSection(
                title = "4. Virtual Currency (Diamonds & Beans)",
                body = "Zipper uses two virtual currencies:\n\n• Diamonds: Purchased offline through authorized coin sellers. Diamonds have no real-world monetary value and cannot be refunded or redeemed for cash.\n\n• Beans: Earned by hosts through gifts and calls. Beans can be redeemed for payouts subject to the minimum threshold of 1,00,000 beans. Payouts are processed weekly.\n\nAll virtual currency transactions are final. Zipper reserves the right to modify exchange rates, pricing, and redemption terms at any time.",
            )
            TermsSection(
                title = "5. Prohibited Content",
                body = "You agree NOT to:\n\n• Stream, share, or distribute nudity, sexual content, or adult material\n• Engage in harassment, bullying, or hate speech\n• Impersonate other users or public figures\n• Stream gambling content not provided by Zipper\n• Use the platform for illegal activities\n• Attempt to manipulate the economy system\n• Use bots or automated tools\n\nViolation of these rules may result in immediate account suspension or permanent ban.",
            )
            TermsSection(
                title = "6. Live Streaming & Party Rooms",
                body = "Hosts are solely responsible for the content they broadcast. Zipper does not pre-screen live content but reserves the right to terminate any stream that violates these Terms. Viewers participate at their own discretion. Gifts sent during streams are non-refundable.",
            )
            TermsSection(
                title = "7. Video Calls",
                body = "Video calls are billed per minute based on the host's call rate. Calls require sufficient diamond balance. Zipper is not responsible for call quality issues due to network conditions. Call history is stored for 30 days.",
            )
            TermsSection(
                title = "8. Games",
                body = "Games available on Zipper are for entertainment purposes only. All games use Diamonds as chips. The house edge is built into each game. Zipper does not guarantee any winnings. Game results are final. Games are intended for users 18+ only.",
            )
            TermsSection(
                title = "9. Privacy",
                body = "Your use of Zipper is also governed by our Privacy Policy. We collect profile information, usage data, and device identifiers to provide and improve our services. We do not sell your personal information to third parties. Live stream content may be visible to all users on the platform.",
            )
            TermsSection(
                title = "10. Intellectual Property",
                body = "All content on Zipper including but not limited to graphics, logos, animations, and software is the property of Zipper and protected by applicable intellectual property laws. You may not copy, modify, or distribute Zipper's content without prior written permission.",
            )
            TermsSection(
                title = "11. Limitation of Liability",
                body = "Zipper is provided \"as is\" without warranties of any kind. To the maximum extent permitted by law, Zipper shall not be liable for any indirect, incidental, special, or consequential damages arising from your use of the App, including but not limited to loss of virtual currency, data, or profits.",
            )
            TermsSection(
                title = "12. Termination",
                body = "Zipper reserves the right to suspend or terminate your account at any time for any reason, including but not limited to violation of these Terms, fraudulent activity, or harm to other users. Upon termination, your diamonds and beans balance will be forfeited.",
            )
            TermsSection(
                title = "13. Changes to Terms",
                body = "Zipper may update these Terms at any time. We will notify users of significant changes through the App. Continued use of the App after changes constitutes acceptance of the new Terms.",
            )
            TermsSection(
                title = "14. Governing Law",
                body = "These Terms shall be governed by and construed in accordance with the laws of India. Any disputes arising from these Terms shall be subject to the exclusive jurisdiction of courts in India.",
            )
            TermsSection(
                title = "15. Contact",
                body = "For any questions about these Terms, please contact us through the feedback section in the App settings.",
            )

            Text("Last updated: June 2026", style = ZipperTheme.type.caption, color = c.textMuted, textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().align(Alignment.CenterHorizontally))
            Spacer(Modifier.navigationBarsPadding())
        }
    }
}

@Composable
private fun TermsSection(title: String, body: String) {
    val c = ZipperTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Text(title, style = ZipperTheme.type.labelL, color = c.textPrimary)
        Text(body, style = ZipperTheme.type.bodyM.copy(lineHeight = 22.sp), color = c.textSecondary)
    }
}
