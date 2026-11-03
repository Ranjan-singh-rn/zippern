package com.zipper.app.util

import java.util.Locale

/**
 * QA #32 (3 Nov 2026) — partner application documents: the limit the Storage
 * rules apply, said in words before anything is sent.
 *
 * Every application document path (`kyc/agencies/signup`, `sellerDocs/signup`,
 * `kyc/applicants/{uid}`, `rechargeProofs/{uid}`) is `maxSize(10)` in
 * `storage.rules`. Documents were uploaded unchanged, so a 12 MP phone photo
 * (often over 10 MB) was refused by the rules with Firebase's "User does not
 * have permission to access this object." Photos are now compressed first
 * (`MediaUtils.compressDocumentImage`); what still cannot fit — a large PDF,
 * an image that cannot be decoded — is refused here, with its size.
 *
 * Pure: `UploadLimitsTest` runs it on the JVM.
 */
object UploadLimits {
    const val DOCUMENT_MAX_MB = 10
    const val DOCUMENT_MAX_BYTES: Long = DOCUMENT_MAX_MB * 1024L * 1024L

    /** Shown when Storage refuses a document anyway (type, or a session that ended). */
    const val DOCUMENT_REFUSED =
        "The file was refused. Use a photo (JPG or PNG) or a PDF under $DOCUMENT_MAX_MB MB, then try again."

    fun megabytes(bytes: Long): String = String.format(Locale.US, "%.1f", bytes / (1024.0 * 1024.0))

    /** Why a document of [bytes] cannot be uploaded, or null when it can (or its size is unknown). */
    fun documentTooLarge(bytes: Long?): String? =
        if (bytes != null && bytes > DOCUMENT_MAX_BYTES) {
            "This file is ${megabytes(bytes)} MB. The limit is $DOCUMENT_MAX_MB MB — choose a smaller file, " +
                "or take a photo of the document instead."
        } else null
}
