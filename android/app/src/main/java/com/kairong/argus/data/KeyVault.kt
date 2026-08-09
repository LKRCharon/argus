package com.kairong.argus.data

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * AES-256-GCM sealing with a non-exportable key held in the AndroidKeyStore.
 *
 * Replaces `androidx.security:security-crypto`, whose entire API Google
 * deprecated in 1.1.0 (the final release) with the guidance "Use Android
 * Keystore directly instead". This is that, minus the Tink dependency: the app
 * needs one primitive — seal/open a byte array — and Keystore plus `javax.crypto`
 * cover it on every supported API level (the project's minSdk is 29; Keystore
 * AES-GCM has been available since 23).
 *
 * The key never leaves the Keystore, so ciphertext is worthless on another
 * device — which is also why encrypted data must stay out of Auto Backup.
 */
class KeyVault(private val alias: String) {

    /**
     * Seal `plain`, returning `iv || ciphertext`.
     *
     * The IV is prefixed rather than stored separately because every caller
     * needs it back and a split representation invites losing one half.
     */
    fun seal(plain: ByteArray): ByteArray {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val body = cipher.doFinal(plain)
        return cipher.iv + body
    }

    /** Reverse of [seal]. Throws when the data is corrupt or the key changed. */
    fun open(sealed: ByteArray): ByteArray {
        require(sealed.size > IV_BYTES) { "sealed payload too short" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(
            Cipher.DECRYPT_MODE, key(),
            GCMParameterSpec(TAG_BITS, sealed, 0, IV_BYTES),
        )
        return cipher.doFinal(sealed, IV_BYTES, sealed.size - IV_BYTES)
    }

    /** Drop the key, making every existing ciphertext permanently unreadable. */
    fun destroy() {
        runCatching { keyStore().deleteEntry(alias) }
    }

    /** Existing key, or a freshly generated one. */
    private fun key(): SecretKey {
        val store = keyStore()
        (store.getEntry(alias, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        generator.init(
            KeyGenParameterSpec.Builder(
                alias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                // Deliberately not requiring user authentication: the daemon can
                // push events while the phone is locked, and a key gated on
                // unlock would make those undecryptable.
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return generator.generateKey()
    }

    private fun keyStore(): KeyStore =
        KeyStore.getInstance(PROVIDER).apply { load(null) }

    private companion object {
        const val PROVIDER = "AndroidKeyStore"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        /** GCM's standard IV length; Keystore generates it for us. */
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
