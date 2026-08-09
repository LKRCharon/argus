package com.kairong.argus.data

import android.content.Context
import android.util.Base64
import android.util.Log
import com.kairong.argus.BuildConfig
import com.kairong.argus.crypto.*
import org.json.JSONObject

data class StoredPeer(
    val identityPub: String, val fingerprint: String,
    val deviceName: String, val platform: String,
    val longTermKey: String, val pairedAt: Long
)

/**
 * Device identity, paired peers, relay address and small local preferences.
 *
 * Values are sealed individually with [KeyVault] and kept in a plain
 * SharedPreferences file. This replaces EncryptedSharedPreferences, whose whole
 * API Google deprecated in its final release (1.1.0) in favour of using the
 * Android Keystore directly. Keys are *not* encrypted — there are three of them
 * and their names carry no secrets — which also means no AES-SIV and no Tink.
 */
class IdentityStore(
    private val context: Context,
    /**
     * Storage namespace. Tests pass their own so they never touch the real
     * identity: instrumented tests share the app's data directory, and a reset in
     * a test fixture would delete the user's pairings for real.
     */
    private val prefsName: String = PREFS_NAME,
    keyAlias: String = KEY_ALIAS,
) {
    private val vault = KeyVault(keyAlias)
    private val prefs = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)

    init {
        migrateFromEncryptedPrefsIfNeeded()
    }

    /** Read a sealed value, or null when absent/unreadable. */
    private fun read(key: String): String? {
        val stored = prefs.getString(key, null) ?: return null
        return try {
            String(vault.open(Base64.decode(stored, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (e: Exception) {
            Log.w(TAG, "value for $key unreadable: ${e.message}")
            null
        }
    }

    private fun write(key: String, value: String) {
        val sealed = Base64.encodeToString(vault.seal(value.toByteArray()), Base64.NO_WRAP)
        prefs.edit().putString(key, sealed).apply()
    }

    private fun readBoolean(key: String, fallback: Boolean): Boolean = when (read(key)) {
        "true" -> true
        "false" -> false
        else -> fallback
    }

    /**
     * Carry data over from the deprecated EncryptedSharedPreferences file once.
     *
     * Without this, upgrading silently loses the device identity and every
     * pairing — the user would have to scan the QR code again for no visible
     * reason. Best-effort: if the old file cannot be decrypted (restored backup),
     * there is nothing to carry and a fresh identity is generated.
     */
    @Suppress("DEPRECATION")
    private fun migrateFromEncryptedPrefsIfNeeded() {
        // Only the production namespace migrates; a test namespace has no legacy.
        if (prefsName != PREFS_NAME) return
        if (prefs.getBoolean(MIGRATED_FLAG, false)) return
        try {
            val legacyFile = java.io.File(
                context.filesDir.parentFile, "shared_prefs/$LEGACY_PREFS.xml"
            )
            if (legacyFile.exists()) {
                val masterKey = androidx.security.crypto.MasterKey.Builder(context)
                    .setKeyScheme(androidx.security.crypto.MasterKey.KeyScheme.AES256_GCM)
                    .build()
                val legacy = androidx.security.crypto.EncryptedSharedPreferences.create(
                    context, LEGACY_PREFS, masterKey,
                    androidx.security.crypto.EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    androidx.security.crypto.EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                )
                var carried = 0
                for (key in listOf("identity", "peers", "relayUrl")) {
                    val value = legacy.getString(key, null) ?: continue
                    write(key, value)
                    carried++
                }
                Log.i(TAG, "migrated $carried keys off EncryptedSharedPreferences")
                legacyFile.delete()
            }
        } catch (e: Exception) {
            // A restored backup cannot be decrypted; nothing to carry over.
            Log.w(TAG, "legacy store unreadable, starting fresh: ${e.message}")
        }
        prefs.edit().putBoolean(MIGRATED_FLAG, true).apply()
    }

    companion object {
        private const val TAG = "IdentityStore"
        private const val PREFS_NAME = "argus-v2"
        private const val LEGACY_PREFS = "argus"
        private const val KEY_ALIAS = "argus_identity_key"
        private const val MIGRATED_FLAG = "migratedFromEsp"
        /** Fingerprint of the Host selected by the user, not merely the newest pairing. */
        private const val ACTIVE_PEER_KEY = "activePeerFingerprint"

        /**
         * Wipe identity storage so a fresh one can be created.
         *
         * The Keystore key is destroyed along with the file: leaving it behind
         * would keep unreadable ciphertext paired with a key that no longer
         * matches anything. The identity and pairings are lost and the user
         * re-pairs, which is the only recovery when the store is unreadable.
         */
        fun reset(
            context: Context,
            prefsName: String = PREFS_NAME,
            keyAlias: String = KEY_ALIAS,
        ) {
            KeyVault(keyAlias).destroy()
            runCatching { context.deleteSharedPreferences(prefsName) }
            if (prefsName == PREFS_NAME) {
                runCatching { context.deleteSharedPreferences(LEGACY_PREFS) }
            }
        }

        /** Namespace for instrumented tests, kept away from real user data. */
        const val TEST_PREFS = "argus-test"
        const val TEST_KEY_ALIAS = "argus_test_identity_key"
    }

    fun loadIdentity(): KeyPair {
        val raw = read("identity")
        if (raw != null) {
            val j = JSONObject(raw)
            return KeyPair(b64Decode(j.getString("secretKey")), b64Decode(j.getString("publicKey")))
        }
        val kp = generateKeyPair()
        write("identity", JSONObject().apply {
            put("secretKey", b64Encode(kp.secretKey))
            put("publicKey", b64Encode(kp.publicKey))
        }.toString())
        return kp
    }

    fun getFingerprint(): String = fingerprint(loadIdentity().publicKey)

    fun loadPeers(): Map<String, StoredPeer> {
        val raw = read("peers") ?: return emptyMap()
        val obj = JSONObject(raw)
        val map = mutableMapOf<String, StoredPeer>()
        for (key in obj.keys()) {
            val p = obj.getJSONObject(key)
            map[key] = StoredPeer(
                p.getString("identityPub"), p.getString("fingerprint"),
                p.getString("deviceName"), p.getString("platform"),
                p.getString("longTermKey"), p.getLong("pairedAt")
            )
        }
        return map
    }

    fun savePeer(peer: StoredPeer) {
        val peers = JSONObject(read("peers") ?: "{}")
        peers.put(peer.fingerprint, JSONObject().apply {
            put("identityPub", peer.identityPub)
            put("fingerprint", peer.fingerprint)
            put("deviceName", peer.deviceName)
            put("platform", peer.platform)
            put("longTermKey", peer.longTermKey)
            put("pairedAt", peer.pairedAt)
        })
        write("peers", peers.toString())
    }

    fun getLatestPeer(): StoredPeer? = loadPeers().values.maxByOrNull { it.pairedAt }

    /** The Host the UI should reconnect to on launch, if it still exists. */
    fun getActivePeerFingerprint(): String? = read(ACTIVE_PEER_KEY)

    fun setActivePeerFingerprint(fingerprint: String?) {
        if (fingerprint == null) prefs.edit().remove(ACTIVE_PEER_KEY).apply()
        else write(ACTIVE_PEER_KEY, fingerprint)
    }

    fun removePeer(fp: String) {
        val peers = JSONObject(read("peers") ?: "{}")
        peers.remove(fp)
        write("peers", peers.toString())
        if (getActivePeerFingerprint() == fp) setActivePeerFingerprint(null)
    }

    fun setRelayUrl(url: String) = write("relayUrl", url)
    fun getRelayUrl(): String = read("relayUrl") ?: BuildConfig.DEFAULT_RELAY_URL

    /** Keep the remote-control surface visible while it is open. Defaults on. */
    fun setKeepScreenOn(enabled: Boolean) = write("keepScreenOn", enabled.toString())
    fun getKeepScreenOn(): Boolean = readBoolean("keepScreenOn", fallback = true)

    /** Retry a dropped relay channel unless the user explicitly disconnects. */
    fun setAutoReconnect(enabled: Boolean) = write("autoReconnect", enabled.toString())
    fun getAutoReconnect(): Boolean = readBoolean("autoReconnect", fallback = true)

    /** Whether the compact agent switcher shows names as well as icons. */
    fun setShowAgentLabels(enabled: Boolean) = write("showAgentLabels", enabled.toString())
    fun getShowAgentLabels(): Boolean = readBoolean("showAgentLabels", fallback = false)
}
