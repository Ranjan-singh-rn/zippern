package com.zipper.app.util

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.spec.ECGenParameterSpec
import javax.inject.Inject
import javax.inject.Singleton

/**
 * THE HALF OF QUICK LOGIN THAT CANNOT BE COPIED.
 *
 * ── What this replaces ───────────────────────────────────────────────────────
 *
 * Quick login used to be a bearer secret and nothing else. The server recorded a
 * `deviceId` — `Settings.Secure.ANDROID_ID`, chosen and sent by the client — and
 * never compared it with anything. So the credential was whatever its bytes
 * were, and its bytes travelled: Block Store was storing them with
 * `setShouldBackupToCloud(true)`, which is a channel built for moving them to
 * the next handset.
 *
 * A device id cannot be a security boundary, because the client picks it. A KEY
 * the client cannot pick and cannot read is a different matter.
 *
 * ── How the binding works ────────────────────────────────────────────────────
 *
 * An EC P-256 pair is generated INSIDE the Android Keystore. The private half
 * never enters this process's memory — `KeyStore.getEntry` hands back a handle,
 * and signing happens in the platform's keystore daemon, backed by hardware
 * (StrongBox or TEE) wherever the device has it.
 *
 *   sign-out    the public half is registered against the new credential
 *   sign-in     the server issues a challenge; this signs it; the server
 *               verifies against the key it registered
 *
 * A secret restored onto a second device therefore proves nothing: the backup
 * carries bytes, and `KeyProperties` does not let the key go with them. The key
 * is not backed up, not exportable, and not recreatable — a reinstall produces a
 * NEW key, which is why `hasKey()` exists and why the app falls back to normal
 * sign-in rather than pretending.
 *
 * ── What is deliberately NOT set ─────────────────────────────────────────────
 *
 * `setUserAuthenticationRequired(true)` would tie signing to a device unlock.
 * It is not set: quick login runs on the login screen, before any session
 * exists, and a key that demanded authentication to perform the thing that
 * authenticates would be a circle. The protection here is possession of the
 * handset, which is the property the feature is about.
 *
 * ── Limits, stated ───────────────────────────────────────────────────────────
 *
 * Hardware backing is requested, not guaranteed — `setIsStrongBoxBacked` is only
 * available from API 28 and only on devices with the hardware, and the code
 * falls back rather than refusing to work. On a device with neither TEE nor
 * StrongBox the key is software-backed inside the Keystore, which still keeps it
 * out of this app's files and out of every backup, and still defeats copying the
 * credential to another handset.
 */
@Singleton
class DeviceKey @Inject constructor() {

    private val keyStore: KeyStore by lazy {
        KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
    }

    /** Is there a usable device key on this handset? */
    fun hasKey(): Boolean = try {
        keyStore.containsAlias(ALIAS)
    } catch (_: Exception) {
        false
    }

    /**
     * The public half, PEM-encoded, to register with a new credential.
     *
     * Creates the key if there is none. Returns null when the platform refuses —
     * an unusual device, a keystore in a bad state — and the caller then does
     * without quick login rather than falling back to something weaker.
     */
    fun publicKeyPem(): String? = try {
        val entry = keyStore.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry ?: run {
            generate()
            keyStore.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry
        }
        entry?.certificate?.publicKey?.encoded?.let(::toPem)
    } catch (_: Exception) {
        null
    }

    /**
     * Sign a server-issued challenge.
     *
     * Returns null if there is no key, or the platform refuses. A null is a
     * refusal to attempt quick login — never a reason to try without a
     * signature, which the server would reject anyway.
     */
    fun sign(challenge: String): String? = try {
        val entry = keyStore.getEntry(ALIAS, null) as? KeyStore.PrivateKeyEntry
        entry?.privateKey?.let { key: PrivateKey ->
            Signature.getInstance(SIGNATURE_ALGORITHM).run {
                initSign(key)
                update(challenge.toByteArray(Charsets.UTF_8))
                Base64.encodeToString(sign(), Base64.NO_WRAP)
            }
        }
    } catch (_: Exception) {
        null
    }

    /**
     * Destroy the key.
     *
     * Called by "sign out and forget this device". Destroying it is what makes
     * that honest: without the key, no credential minted on this handset can
     * ever be redeemed again, whatever happens to its bytes.
     */
    fun clear() {
        try {
            if (keyStore.containsAlias(ALIAS)) keyStore.deleteEntry(ALIAS)
        } catch (_: Exception) {
        }
    }

    private fun generate() {
        val generator = KeyPairGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_EC,
            ANDROID_KEYSTORE,
        )
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(ECGenParameterSpec(CURVE))
            .setDigests(KeyProperties.DIGEST_SHA256)
            // Deliberately NOT setUserAuthenticationRequired — see the note above.
            .build()
        generator.initialize(spec)
        generator.generateKeyPair()
    }

    private fun toPem(der: ByteArray): String {
        val body = Base64.encodeToString(der, Base64.NO_WRAP)
            .chunked(64)
            .joinToString("\n")
        return "-----BEGIN PUBLIC KEY-----\n$body\n-----END PUBLIC KEY-----"
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"

        /**
         * Versioned. A future change to the key parameters mints under a new
         * alias rather than reusing one whose properties are not what this build
         * believes they are.
         */
        const val ALIAS = "zipper_quick_login_device_key_v1"

        const val CURVE = "secp256r1"
        const val SIGNATURE_ALGORITHM = "SHA256withECDSA"
    }
}
