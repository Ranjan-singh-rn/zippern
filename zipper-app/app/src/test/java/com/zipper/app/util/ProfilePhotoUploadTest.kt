package com.zipper.app.util

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * APK 20 / A-1, A-2 — the signup avatar is compressed like the Edit Profile
 * one, and a refused upload never blocks the profile save.
 */
class ProfilePhotoUploadTest {

    @Test fun `a refused upload is always saved without the photo`() {
        assertTrue(ProfilePhotoUpload.saveWithoutPhoto(RuntimeException("User does not have permission to access this object.")))
        assertTrue(ProfilePhotoUpload.saveWithoutPhoto(java.io.IOException("connection reset")))
    }

    @Test fun `a storage refusal gets the exact sentence`() {
        val refused = RuntimeException("User does not have permission to access this object.")
        assertTrue(ProfilePhotoUpload.isStorageRefusal(refused))
        assertEquals(ProfilePhotoUpload.UPLOAD_FAILED_MESSAGE, ProfilePhotoUpload.messageFor(refused))
        assertEquals(
            "Photo could not be uploaded (too large or refused). Try a smaller photo or skip it.",
            ProfilePhotoUpload.UPLOAD_FAILED_MESSAGE,
        )
        assertTrue(ProfilePhotoUpload.isStorageRefusal(RuntimeException("HTTP 403 Forbidden")))
        assertTrue(ProfilePhotoUpload.isStorageRefusal(RuntimeException("Quota exceeded")))
    }

    @Test fun `a connection failure keeps the same advice and adds the later option`() {
        val dropped = java.io.IOException("connection reset")
        assertFalse(ProfilePhotoUpload.isStorageRefusal(dropped))
        val msg = ProfilePhotoUpload.messageFor(dropped)
        assertTrue(msg.startsWith(ProfilePhotoUpload.UPLOAD_FAILED_MESSAGE))
        assertTrue(msg.contains("Edit profile"))
    }

    @Test fun `the storage cap is five MiB and zero bytes is not a photo`() {
        assertEquals(5L * 1024 * 1024, ProfilePhotoUpload.MAX_UPLOAD_BYTES)
        assertTrue(ProfilePhotoUpload.acceptableSize(1L))
        assertTrue(ProfilePhotoUpload.acceptableSize(ProfilePhotoUpload.MAX_UPLOAD_BYTES))
        assertFalse(ProfilePhotoUpload.acceptableSize(ProfilePhotoUpload.MAX_UPLOAD_BYTES + 1))
        assertFalse(ProfilePhotoUpload.acceptableSize(0L))
    }

    @Test fun `signup compresses through MediaUtils and a skipped photo does not fail the save`() {
        val main = listOf(File("src/main/java"), File("app/src/main/java")).first { it.exists() }
        val repo = File(main, "com/zipper/app/data/repository/AuthRepository.kt").readText()
        val fn = repo.substring(repo.indexOf("private suspend fun uploadSignupAvatar("))
        assertTrue(fn.contains("MediaUtils.compressImage(appContext, photoUri)"))
        assertTrue(fn.contains("ref.putBytes(bytes, meta)"))
        val save = repo.substring(repo.indexOf("suspend fun saveUserProfile("), repo.indexOf("private suspend fun uploadSignupAvatar("))
        assertFalse("the raw gallery file is no longer uploaded from the save", save.contains("ref.putFile(photoUri"))
        assertTrue(save.contains("AuthResult.SavedWithoutPhoto(skipped)"))
        val vm = File(main, "com/zipper/app/ui/screens/auth/AuthViewModel.kt").readText()
        assertTrue(vm.contains("is AuthResult.SavedWithoutPhoto -> {"))
        assertTrue(vm.contains("fun continueWithoutPhoto()"))
        val screen = File(main, "com/zipper/app/ui/screens/auth/ProfileSetupScreen.kt").readText()
        assertTrue(screen.contains("uiState.photoUploadFailed?.let"))
        assertTrue(screen.contains("Try another photo"))
    }
}
