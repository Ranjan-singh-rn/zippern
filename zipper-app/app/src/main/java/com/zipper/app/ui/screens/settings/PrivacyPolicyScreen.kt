package com.zipper.app.ui.screens.settings

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.sp
import com.zipper.app.ui.components.TopBar
import com.zipper.app.ui.components.ZipperScreen
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import com.zipper.app.util.DeletionWindow

@Composable
fun PrivacyPolicyScreen(onBack: () -> Unit) {
    val c = ZipperTheme.colors
    ZipperScreen(topBar = { TopBar("Privacy Policy", onBack = onBack) }) { _ ->
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md),
            verticalArrangement = Arrangement.spacedBy(Space.xxl),
        ) {
            item { Text("Last updated: June 2025", style = ZipperTheme.type.caption, color = c.textMuted) }
            item {
                PolicySection(
                    title = "1. Introduction",
                    body  = "Zipper (\"we\", \"us\", or \"our\") operates the Zipper live-streaming and social application. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our mobile application. By using Zipper, you agree to the terms described in this policy.",
                )
            }
            item {
                PolicySection(
                    title = "2. Information We Collect",
                    body  = "We collect information you provide directly — including your name, phone number, profile photo, gender, and date of birth — when you register. We also collect usage data, device identifiers, IP addresses, and activity logs to provide and improve our services. When you go live or join a live stream, video and audio data is transmitted through our third-party streaming partner and is not stored unless you or the host explicitly record the session.",
                )
            }
            item {
                PolicySection(
                    title = "3. How We Use Your Information",
                    body  = "We use your information to: operate and maintain the app; personalise your experience; facilitate live streams and video calls; process in-app currency (diamonds and beans) transactions; send notifications about activity and important updates; detect fraud, enforce our Terms of Service, and comply with legal obligations.",
                )
            }
            item {
                PolicySection(
                    title = "4. Sharing of Information",
                    body  = "We do not sell your personal data to third parties. We may share data with: service providers (cloud hosting, analytics, crash reporting) under strict confidentiality agreements; authorised coin sellers who facilitate diamond top-ups — they receive only the information necessary to complete the transaction; law enforcement or regulators if required by applicable law.",
                )
            }
            item {
                PolicySection(
                    title = "5. In-App Economy & Payments",
                    body  = "Zipper uses an offline coin-seller model for all diamond purchases. Payments are made directly to authorised sellers, not through the app. Zipper does not store credit card or banking information. Bean and diamond balances are stored securely in Firebase Firestore and are subject to our Terms of Service regarding withdrawals and conversions.",
                )
            }
            item {
                PolicySection(
                    title = "6. Live Streaming & Video Calls",
                    body  = "Live streams and one-to-one video calls use Agora RTC for transmission. We do not record calls unless you opt into a recording feature that will be clearly disclosed. Viewers' display names and profile photos may be visible to other participants in a live room.",
                )
            }
            item {
                PolicySection(
                    title = "7. Children's Privacy",
                    body  = "Zipper is not intended for users under the age of 18. We do not knowingly collect personal information from minors. If we become aware that a user is under 18, we will immediately delete their account and associated data.",
                )
            }
            item {
                PolicySection(
                    title = "8. Data Retention",
                    // C8 (B28): the recovery window is the server's — sixty days, not thirty.
                    body  = "We retain your personal data for as long as your account is active or as needed to provide our services. You may request deletion of your account and personal data at any time through Settings → Delete Account. Deleted accounts are permanently removed within ${DeletionWindow.GRACE_DAYS} days.",
                )
            }
            item {
                PolicySection(
                    title = "9. Security",
                    body  = "We implement industry-standard security measures including TLS encryption in transit and access controls on our Firebase infrastructure. No method of electronic transmission or storage is 100% secure, and we cannot guarantee absolute security.",
                )
            }
            item {
                PolicySection(
                    title = "10. Your Rights",
                    body  = "Depending on your jurisdiction, you may have the right to: access the personal data we hold about you; correct inaccurate data; request deletion of your data; restrict or object to our processing; data portability. To exercise these rights, contact us at ${com.zipper.app.util.ZipperContacts.SUPPORT}.",
                )
            }
            item {
                PolicySection(
                    title = "11. Changes to This Policy",
                    body  = "We may update this Privacy Policy from time to time. We will notify you of significant changes via an in-app notification or a prominent notice in the app. Continued use of the app after changes constitutes acceptance of the revised policy.",
                )
            }
            item {
                PolicySection(
                    title = "12. Contact Us",
                    body  = "If you have questions or concerns about this Privacy Policy, please contact us at:\n\nZipper Support\nEmail: ${com.zipper.app.util.ZipperContacts.SUPPORT}",
                )
            }
            item { Spacer(Modifier.navigationBarsPadding()) }
        }
    }
}

@Composable
private fun PolicySection(title: String, body: String) {
    val c = ZipperTheme.colors
    Column(verticalArrangement = Arrangement.spacedBy(Space.sm)) {
        Text(title, style = ZipperTheme.type.labelL, color = c.textPrimary)
        Text(body, style = ZipperTheme.type.bodyM.copy(lineHeight = 22.sp), color = c.textSecondary)
    }
}
