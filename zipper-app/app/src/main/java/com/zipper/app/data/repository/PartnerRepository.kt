package com.zipper.app.data.repository

import android.content.Context
import android.net.Uri
import com.google.firebase.auth.FirebaseAuth
import com.google.firebase.storage.FirebaseStorage
import com.google.firebase.storage.StorageException
import com.google.firebase.storage.StorageMetadata
import com.zipper.app.util.MediaUtils
import com.zipper.app.util.UploadLimits
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.security.SecureRandom
import javax.inject.Inject
import javax.inject.Singleton

/**
 * The upload half of applying: documents go to Cloud Storage, the URLs go to
 * the server through [PartnerFunctions].
 *
 * ── WHERE THINGS GO, AND WHY THERE ──────────────────────────────────────────
 *
 * Every path below is one `storage.rules` lets a signed-in user CREATE and
 * never overwrite:
 *
 *   kyc/agencies/signup/{name}   agency and sub-agency identity documents —
 *                                the same prefix the CRM signup form uses
 *   sellerDocs/signup/{name}     a coin seller's ID proof and UPI QR
 *   kyc/applicants/{uid}/{name}  a self-filed host application's documents
 *                                and reference photo (owner-scoped)
 *   rechargeProofs/{uid}/{name}  a buyer's payment screenshot (owner-scoped)
 *
 * Names carry 128 random bits, as `lib/signupDocName.ts` does in the CRM, so
 * an object cannot be guessed and two applicants cannot collide. Content type
 * is set explicitly because the rules check it.
 *
 * QA #32: each of those paths takes at most 10 MB. A photo is compressed
 * first (`MediaUtils.compressDocumentImage` — upright, readable, JPEG), and a
 * file that still does not fit is refused HERE with its size, instead of
 * being sent and refused by the rules as "does not have permission".
 */
@Singleton
class PartnerRepository @Inject constructor(
    private val auth: FirebaseAuth,
    private val storage: FirebaseStorage,
    private val functions: PartnerFunctions,
    @ApplicationContext private val context: Context,
) {

    sealed interface Upload {
        data class Ok(val url: String) : Upload
        data class Failed(val message: String) : Upload
    }

    private val random = SecureRandom()

    private fun randomName(slot: String, ext: String): String {
        val bytes = ByteArray(16).also(random::nextBytes)
        val hex = bytes.joinToString("") { "%02x".format(it) }
        return "${slot}_$hex.$ext"
    }

    private fun uid(): String = auth.currentUser?.uid.orEmpty()

    /** The signed-in account's verified identity, for prefilling — never typed again. */
    data class Identity(val uid: String, val phone: String, val email: String, val name: String)

    fun identity(): Identity {
        val u = auth.currentUser
        return Identity(
            uid = u?.uid.orEmpty(),
            phone = u?.phoneNumber.orEmpty(),
            email = u?.email.orEmpty(),
            name = u?.displayName.orEmpty(),
        )
    }

    /**
     * One application document. A photo goes up compressed; a PDF (or an image
     * that cannot be decoded) goes up as it is, after its size is checked.
     */
    private suspend fun upload(path: String, uri: Uri, contentType: String): Upload {
        val metadata = StorageMetadata.Builder().setContentType(contentType).build()
        return try {
            val ref = storage.reference.child(path)
            val photo = if (contentType.startsWith("image/")) {
                withContext(Dispatchers.Default) { MediaUtils.compressDocumentImage(context, uri) }
            } else null
            if (photo != null) {
                UploadLimits.documentTooLarge(photo.size.toLong())?.let { return Upload.Failed(it) }
                ref.putBytes(photo, metadata).await()
            } else {
                val size = withContext(Dispatchers.IO) { MediaUtils.sizeOf(context, uri) }
                UploadLimits.documentTooLarge(size)?.let { return Upload.Failed(it) }
                ref.putFile(uri, metadata).await()
            }
            Upload.Ok(ref.downloadUrl.await().toString())
        } catch (e: StorageException) {
            // The rules answer a refusal as "not authorized" whatever its cause.
            Upload.Failed(
                if (e.errorCode == StorageException.ERROR_NOT_AUTHORIZED) UploadLimits.DOCUMENT_REFUSED
                else e.message ?: "The file could not be uploaded.",
            )
        } catch (e: Exception) {
            Upload.Failed(e.message ?: "The file could not be uploaded.")
        }
    }

    /** One identity document for an Agency / Sub-agency application. [slot] is doc1/doc2/doc3. */
    suspend fun uploadAgencyDocument(slot: String, uri: Uri, isPdf: Boolean = false): Upload =
        upload(
            "kyc/agencies/signup/${randomName(slot, if (isPdf) "pdf" else "jpg")}",
            uri, if (isPdf) "application/pdf" else "image/jpeg",
        )

    /** A seller's government ID, or their UPI QR image. */
    suspend fun uploadSellerDocument(slot: String, uri: Uri, isPdf: Boolean = false): Upload =
        upload(
            "sellerDocs/signup/${randomName(slot, if (isPdf) "pdf" else "jpg")}",
            uri, if (isPdf) "application/pdf" else "image/jpeg",
        )

    /** A host applicant's own documents and reference photo, under their uid. */
    suspend fun uploadHostDocument(slot: String, uri: Uri, isPdf: Boolean = false): Upload {
        val me = uid()
        if (me.isBlank()) return Upload.Failed("Sign in to continue.")
        return upload(
            "kyc/applicants/$me/${randomName(slot, if (isPdf) "pdf" else "jpg")}",
            uri, if (isPdf) "application/pdf" else "image/jpeg",
        )
    }

    /** The buyer's screenshot of paying a seller. */
    suspend fun uploadRechargeProof(uri: Uri): Upload {
        val me = uid()
        if (me.isBlank()) return Upload.Failed("Sign in to continue.")
        return upload("rechargeProofs/$me/${randomName("proof", "jpg")}", uri, "image/jpeg")
    }

    // Pass-throughs, so a screen depends on one repository.
    suspend fun eligibility() = functions.eligibility()
    suspend fun parents(forKind: String) = functions.parents(forKind)
    suspend fun myApplications() = functions.myApplications()
    suspend fun submitPartnerApplication(kind: String, form: Map<String, Any>, parentId: String?) =
        functions.submitPartnerApplication(kind, form, parentId)
    suspend fun submitHostApplication(form: Map<String, Any>, parentId: String) =
        functions.submitHostApplication(form, parentId)
    /** C2: ask for a revoked role back. Validate with [RoleAppealStatement] first. */
    suspend fun submitRoleAppeal(kind: String, statement: String) =
        functions.submitRoleAppeal(kind, statement)
    suspend fun myRoleAppeals() = functions.myRoleAppeals()
    /** Decision 15 (RC): what is verified, and the approved roles that wait for it. */
    suspend fun verificationState() = functions.verificationState()
    /** Decision 15 (RC): ask the server to start what both verified contacts now allow. */
    suspend fun checkActivation() = functions.checkActivation()
    suspend fun reportContactConflict(contact: String, value: String) =
        functions.reportContactConflict(contact, value)
    suspend fun submitRechargeRequest(
        sellerId: String, diamonds: Int, amountMinor: Long, currency: String,
        paymentMethod: String, reference: String, proofUrl: String,
        /** RF-30: one id per recharge form, the same on every retry of it. */
        requestId: String,
    ) = functions.submitRechargeRequest(
        sellerId, diamonds, amountMinor, currency, paymentMethod, reference, proofUrl, requestId,
    )
}
