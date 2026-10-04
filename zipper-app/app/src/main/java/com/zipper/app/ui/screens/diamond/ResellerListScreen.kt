package com.zipper.app.ui.screens.diamond

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.QrCode
import androidx.compose.material.icons.outlined.Storefront
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil.compose.AsyncImage
import com.google.firebase.firestore.ktx.firestore
import com.google.firebase.ktx.Firebase
import com.zipper.app.ui.components.*
import com.zipper.app.ui.screens.profile.GlassCard
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.tasks.await

data class SellerFirestoreItem(
    val uid: String = "",
    val displayName: String = "",
    val phone: String = "",
    val isOnline: Boolean = false,
    val qrCodeUrl: String = "",
    val description: String = "",
    val photoUrl: String = "",
)

/*
 * Verified resellers — Figma "03 Reseller list".
 *
 *   Info notice, then one glass row per reseller: 56 avatar (online ring),
 *   name + aqua Verified check, description caption, "Message" gradient
 *   button. A QR icon button opens the reseller's payment QR in a sheet.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ResellerListScreen(
    onBack: () -> Unit = {},
    onMessage: (String) -> Unit = {},
    onViewProfile: (String) -> Unit = {},
) {
    var sellers by remember { mutableStateOf<List<SellerFirestoreItem>>(emptyList()) }
    var isLoading by remember { mutableStateOf(true) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var qrSeller by remember { mutableStateOf<SellerFirestoreItem?>(null) }
    val c = ZipperTheme.colors

    LaunchedEffect(Unit) {
        try {
            /*
             * ── `publicSellers`, NOT `sellers` ────────────────────────────
             *
             * This used to query `sellers` filtered on `isApproved` and
             * `isActive`. The filter was honest and the exposure was not:
             * Firestore returns a document WHOLE or not at all, so every row
             * this screen received also carried that seller's KYC document
             * URLs, their coin balance, their commission rate, their email and
             * the approval trail. Rules cannot filter fields, so no rule could
             * have closed it.
             *
             * `publicSellers` holds six fields and a document id, projected by
             * the `syncPublicSeller` Cloud Function from an explicit allowlist.
             * The filters are gone because the collection IS the filter: a
             * seller who is pending, rejected or suspended has no document here
             * at all.
             */
            val snap = Firebase.firestore
                .collection("publicSellers")
                .get()
                .await()
            sellers = snap.documents.mapNotNull { doc ->
                val uid = doc.id
                val displayName = doc.getString("displayName") ?: return@mapNotNull null
                val phone = doc.getString("phone") ?: ""
                val isOnline = doc.getBoolean("isOnline") ?: false
                val qrCodeUrl = doc.getString("qrCodeUrl") ?: ""
                val description = doc.getString("description") ?: ""
                val photoUrl = doc.getString("photoUrl") ?: ""
                SellerFirestoreItem(
                    uid = uid,
                    displayName = displayName,
                    phone = phone,
                    isOnline = isOnline,
                    qrCodeUrl = qrCodeUrl,
                    description = description,
                    photoUrl = photoUrl,
                )
            }
        } catch (e: Exception) {
            errorMessage = e.message ?: "Failed to load sellers"
        } finally {
            isLoading = false
        }
    }

    ZipperScreen(topBar = { TopBar("Verified resellers", onBack = onBack) }) { _ ->
        if (isLoading) { LoadingState(); return@ZipperScreen }
        LazyColumn(contentPadding = PaddingValues(horizontal = Space.lg, vertical = Space.md), verticalArrangement = Arrangement.spacedBy(Space.md)) {
            item {
                Row(
                    Modifier.fillMaxWidth().background(c.tintGoldSubtle, RoundedCornerShape(Radius.md)).border(1.dp, c.currencyCoin.copy(alpha = 0.4f), RoundedCornerShape(Radius.md)).padding(Space.md),
                    horizontalArrangement = Arrangement.spacedBy(Space.sm), verticalAlignment = Alignment.Top,
                ) {
                    Icon(Icons.Outlined.Info, null, tint = c.currencyCoin, modifier = Modifier.size(18.dp))
                    Text("Pay only verified resellers. Zipper never asks for OTPs or passwords.", style = ZipperTheme.type.bodyS, color = c.textSecondary)
                }
            }
            when {
                errorMessage != null -> item { EmptyState(Icons.Outlined.Storefront, "Couldn't load resellers", errorMessage ?: "Check your connection and come back in a moment.") }
                sellers.isEmpty() -> item { EmptyState(Icons.Outlined.Storefront, "No resellers right now", "Check back soon — approved resellers appear here as they come online.") }
                else -> items(sellers, key = { it.uid }) { seller ->
                    SellerRow(seller, onMessage = { onMessage(seller.uid) }, onViewProfile = { onViewProfile(seller.uid) }, onShowQr = { qrSeller = seller })
                }
            }
            item { Spacer(Modifier.navigationBarsPadding()) }
        }
    }

    qrSeller?.let { seller ->
        ModalBottomSheet(onDismissRequest = { qrSeller = null }, containerColor = c.bgElevated, dragHandle = null, shape = RoundedCornerShape(topStart = Radius.xl, topEnd = Radius.xl)) {
            Column(Modifier.fillMaxWidth().padding(horizontal = Space.lg, vertical = Space.md), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(Space.md)) {
                Box(Modifier.size(36.dp, 4.dp).background(c.borderDefault, CircleShape))
                Text(seller.displayName, style = ZipperTheme.type.headingS, color = c.textPrimary)
                if (seller.phone.isNotBlank()) Text(maskPhone(seller.phone), style = ZipperTheme.type.bodyS, color = c.textMuted)
                AsyncImage(
                    model = seller.qrCodeUrl, contentDescription = "Payment QR code", contentScale = ContentScale.Fit,
                    modifier = Modifier.size(240.dp).background(Color.White, RoundedCornerShape(Radius.lg)).clip(RoundedCornerShape(Radius.lg)).padding(Space.sm),
                )
                Text("Scan to pay, then message the reseller with your Zipper ID.", style = ZipperTheme.type.bodyS, color = c.textSecondary, textAlign = TextAlign.Center)
                ZipperButton("Message ${seller.displayName}", { qrSeller = null; onMessage(seller.uid) }, size = ButtonSize.Medium, gradient = true, fullWidth = true)
                Spacer(Modifier.navigationBarsPadding())
            }
        }
    }
}

/** Masks a phone number: shows first 2 and last 2 digits, hides the rest. */
private fun maskPhone(phone: String): String {
    val digits = phone.filter { it.isDigit() }
    if (digits.length < 5) return phone
    val visible = 2
    val masked = "*".repeat(digits.length - visible * 2)
    return "${digits.take(visible)}$masked${digits.takeLast(visible)}"
}

@Composable
private fun SellerRow(seller: SellerFirestoreItem, onMessage: () -> Unit, onViewProfile: () -> Unit, onShowQr: () -> Unit) {
    val c = ZipperTheme.colors
    GlassCard(Modifier.clickableNoRipple(onViewProfile), padding = PaddingValues(Space.md)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.md)) {
            Avatar(seller.photoUrl, size = AvatarSize.LG, ring = if (seller.isOnline) AvatarRing.Online else AvatarRing.None, initial = seller.displayName)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Space.xs)) {
                    Text(seller.displayName, style = ZipperTheme.type.labelL, color = c.textPrimary, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    Icon(Icons.Default.Verified, "Verified", tint = c.currencyDiamond, modifier = Modifier.size(16.dp))
                }
                val sub = seller.description.ifBlank { if (seller.phone.isNotBlank()) maskPhone(seller.phone) else if (seller.isOnline) "Online now" else "Offline" }
                Text(sub, style = ZipperTheme.type.caption, color = c.textMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (seller.qrCodeUrl.isNotBlank()) IconButtonCircle(Icons.Outlined.QrCode, "Payment QR", onShowQr, size = 32.dp)
            ZipperButton("Message", onMessage, size = ButtonSize.Small, gradient = true)
        }
    }
}
