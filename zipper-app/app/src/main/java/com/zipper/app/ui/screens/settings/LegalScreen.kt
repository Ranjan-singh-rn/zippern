package com.zipper.app.ui.screens.settings

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.firebase.Timestamp
import com.google.firebase.firestore.FirebaseFirestore
import com.zipper.app.ui.components.Chip
import com.zipper.app.ui.components.EmptyState
import com.zipper.app.ui.components.LoadingState
import com.zipper.app.ui.components.TopBar
import com.zipper.app.ui.components.ZipperScreen
import com.zipper.app.ui.theme.Radius
import com.zipper.app.ui.theme.Space
import com.zipper.app.ui.theme.ZipperTheme
import kotlinx.coroutines.tasks.await
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

// ── Data model ────────────────────────────────────────────────────────────────

private data class PolicyDocument(
    val docType: String = "",
    val content: String = "",
    val version: Long = 0L,
    val lastUpdatedByName: String = "",
    val updatedAt: Timestamp? = null,
    val publishedAt: Timestamp? = null,
    val isPublished: Boolean = false,
)

// ── Screen ────────────────────────────────────────────────────────────────────

/**
 * LegalScreen — fetches and displays a published policy document from Firestore.
 *
 * @param docType One of "privacy_policy", "terms_of_service", or "faq"
 * @param onBack  Navigation callback to pop this screen
 */
@Composable
fun LegalScreen(
    docType: String,
    onBack: () -> Unit,
) {
    val screenTitle = when (docType) {
        "privacy_policy"   -> "Privacy Policy"
        "terms_of_service" -> "Terms of Service"
        "faq"              -> "FAQ"
        else               -> "Legal"
    }

    // ── State ─────────────────────────────────────────────────────────────────
    var policy by remember { mutableStateOf<PolicyDocument?>(null) }
    var isLoading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }

    // ── Fetch from Firestore ──────────────────────────────────────────────────
    LaunchedEffect(docType) {
        isLoading = true
        error = null
        try {
            val firestore = FirebaseFirestore.getInstance()
            val snapshot = firestore.collection("policies").document(docType).get().await()

            if (!snapshot.exists()) {
                error = "Content not available"
                isLoading = false
                return@LaunchedEffect
            }

            val data = snapshot.data ?: run {
                error = "Content not available"
                isLoading = false
                return@LaunchedEffect
            }

            val doc = PolicyDocument(
                docType          = (data["docType"] as? String).orEmpty(),
                content          = (data["content"] as? String).orEmpty(),
                version          = (data["version"] as? Long) ?: 0L,
                lastUpdatedByName = (data["lastUpdatedByName"] as? String).orEmpty(),
                updatedAt        = data["updatedAt"] as? Timestamp,
                publishedAt      = data["publishedAt"] as? Timestamp,
                isPublished      = (data["isPublished"] as? Boolean) ?: false,
            )

            if (!doc.isPublished) {
                error = "Content not available"
                isLoading = false
                return@LaunchedEffect
            }

            policy = doc
        } catch (e: Exception) {
            error = "Content not available"
        } finally {
            isLoading = false
        }
    }

    // ── UI ────────────────────────────────────────────────────────────────────
    val c = ZipperTheme.colors
    ZipperScreen(topBar = { TopBar(screenTitle, onBack = onBack) }) { _ ->
        val doc = policy
        when {
            isLoading -> LoadingState()
            error != null -> EmptyState(Icons.Outlined.Description, error ?: "Content not available", "Check your connection and open this page again.", actionLabel = "Go back", onAction = onBack)
            doc == null -> EmptyState(Icons.Outlined.Description, "Content not available", "Check your connection and open this page again.", actionLabel = "Go back", onAction = onBack)
            else -> Column(
                Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = Space.lg, vertical = Space.md),
                verticalArrangement = Arrangement.spacedBy(Space.md),
            ) {
                VersionHeader(doc = doc)
                Text(doc.content, style = ZipperTheme.type.bodyM.copy(lineHeight = 22.sp), color = c.textSecondary)
                Spacer(Modifier.navigationBarsPadding())
            }
        }
    }
}

// ── Version header composable ─────────────────────────────────────────────────

@Composable
private fun VersionHeader(doc: PolicyDocument) {
    val c = ZipperTheme.colors
    val dateFormatter = remember { SimpleDateFormat("d MMM yyyy", Locale.getDefault()) }

    val updatedDateStr = doc.updatedAt?.toDate()?.let { dateFormatter.format(it) } ?: ""
    val publishedDateStr = doc.publishedAt?.toDate()?.let { dateFormatter.format(it) } ?: ""

    Column(
        Modifier.fillMaxWidth().background(Brush.verticalGradient(listOf(Color(0x12FFFFFF), Color(0x05FFFFFF))), RoundedCornerShape(Radius.lg)).border(1.dp, c.borderSubtle, RoundedCornerShape(Radius.lg)).padding(horizontal = Space.lg, vertical = Space.md),
        verticalArrangement = Arrangement.spacedBy(Space.xs),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Chip("Version ${doc.version}")
            Spacer(Modifier.weight(1f))
            if (publishedDateStr.isNotEmpty()) Text("Published $publishedDateStr", style = ZipperTheme.type.caption, color = c.textMuted)
        }
        if (updatedDateStr.isNotEmpty()) Text("Last updated: $updatedDateStr", style = ZipperTheme.type.caption, color = c.textMuted)
    }
}
