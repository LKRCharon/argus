package com.kairong.argus.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.kairong.argus.BuildConfig
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Exercises the Keystore-backed vault and the stores built on it.
 *
 * Every store here is pointed at a test-only namespace. Instrumented tests run
 * inside the real app's data directory, so a fixture that reset the production
 * store deleted the user's actual device identity and pairings — which is what
 * made it look like every reinstall required re-pairing.
 *
 * These have to run on a device: `AndroidKeyStore` has no JVM implementation, so
 * a unit test would only prove the code compiles. This layer holds the device
 * identity and every pairing — getting it wrong silently costs the user their
 * pairings, which is not something to verify by reading.
 */
@RunWith(AndroidJUnit4::class)
class KeyVaultTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun clean() {
        KeyVault(TEST_ALIAS).destroy()
    }

    @Test
    fun sealedDataRoundTrips() {
        val vault = KeyVault(TEST_ALIAS)
        val plain = "配对指纹 ZB99-15JG-T2GY".toByteArray()
        val opened = vault.open(vault.seal(plain))
        assertArrayEquals(plain, opened)
    }

    @Test
    fun eachSealUsesAFreshIv() {
        // Same plaintext must not produce the same ciphertext, or GCM's nonce is
        // being reused — which would leak the keystream.
        val vault = KeyVault(TEST_ALIAS)
        val a = vault.seal("same".toByteArray())
        val b = vault.seal("same".toByteArray())
        assertTrue("ciphertext repeated for identical input", !a.contentEquals(b))
    }

    @Test
    fun aSecondInstanceReadsWhatTheFirstWrote() {
        // The key must come from the Keystore, not from instance state.
        val sealed = KeyVault(TEST_ALIAS).seal("persisted".toByteArray())
        assertEquals("persisted", String(KeyVault(TEST_ALIAS).open(sealed)))
    }

    @Test(expected = Exception::class)
    fun tamperedCiphertextIsRejected() {
        val vault = KeyVault(TEST_ALIAS)
        val sealed = vault.seal("authentic".toByteArray())
        sealed[sealed.size - 1] = (sealed[sealed.size - 1] + 1).toByte()
        vault.open(sealed)
    }

    @Test
    fun destroyingTheKeyMakesOldCiphertextUnreadable() {
        val sealed = KeyVault(TEST_ALIAS).seal("gone".toByteArray())
        KeyVault(TEST_ALIAS).destroy()
        val failed = runCatching { KeyVault(TEST_ALIAS).open(sealed) }.isFailure
        assertTrue("stale ciphertext decrypted under a new key", failed)
    }
}

@RunWith(AndroidJUnit4::class)
class IdentityStoreTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun clean() {
        IdentityStore.reset(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS)
    }

    @Test
    fun identityIsStableAcrossInstances() {
        val first = IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS).loadIdentity()
        val second = IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS).loadIdentity()
        assertArrayEquals(first.publicKey, second.publicKey)
        assertArrayEquals(first.secretKey, second.secretKey)
    }

    @Test
    fun peersSurviveAReopen() {
        val store = IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS)
        store.savePeer(
            StoredPeer(
                identityPub = "cHVi", fingerprint = "FP-1",
                deviceName = "V2502DA", platform = "android",
                longTermKey = "a2V5", pairedAt = 42L,
            )
        )
        val peers = IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS).loadPeers()
        assertEquals(1, peers.size)
        assertEquals("V2502DA", peers["FP-1"]?.deviceName)
    }

    @Test
    fun activePeerSurvivesAReopenAndClearsWhenRemoved() {
        val store = IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS)
        store.savePeer(
            StoredPeer(
                identityPub = "cHVi", fingerprint = "FP-active",
                deviceName = "example-host", platform = "linux",
                longTermKey = "a2V5", pairedAt = 43L,
            )
        )
        store.setActivePeerFingerprint("FP-active")
        assertEquals(
            "FP-active",
            IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS)
                .getActivePeerFingerprint()
        )

        store.removePeer("FP-active")
        assertNull(store.getActivePeerFingerprint())
    }

    @Test
    fun relayUrlDefaultsAndPersists() {
        assertEquals(
            BuildConfig.DEFAULT_RELAY_URL,
            IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS).getRelayUrl()
        )
        IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS).setRelayUrl("wss://example.test/ws")
        assertEquals("wss://example.test/ws", IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS).getRelayUrl())
    }

    @Test
    fun displayAndReconnectPreferencesPersist() {
        val store = IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS)
        assertTrue(store.getKeepScreenOn())
        assertTrue(store.getAutoReconnect())
        assertTrue(!store.getShowAgentLabels())

        store.setKeepScreenOn(false)
        store.setAutoReconnect(false)
        store.setShowAgentLabels(true)

        val reopened = IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS)
        assertTrue(!reopened.getKeepScreenOn())
        assertTrue(!reopened.getAutoReconnect())
        assertTrue(reopened.getShowAgentLabels())
    }

    @Test
    fun resetClearsEverything() {
        val before = IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS).loadIdentity()
        IdentityStore.reset(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS)
        val after = IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS).loadIdentity()
        // A new identity, not the old one recovered from stale ciphertext.
        assertTrue(!before.publicKey.contentEquals(after.publicKey))
        assertTrue(IdentityStore(context, IdentityStore.TEST_PREFS, IdentityStore.TEST_KEY_ALIAS).loadPeers().isEmpty())
    }
}

@RunWith(AndroidJUnit4::class)
class SessionStoreTest {

    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun cachedSessionsRoundTrip() {
        val store = SessionStore(context, "sessions-test.enc", "argus_test_cache_key")
        store.save(
            listOf(
                SessionStore.Cached(
                    sessionId = "s-1", agent = "codex",
                    events = listOf(mapOf("type" to "text", "text" to "你好")),
                    status = "done", lastActivity = 100L,
                )
            )
        )
        val loaded = SessionStore(context, "sessions-test.enc", "argus_test_cache_key").load()
        assertEquals(1, loaded.size)
        assertEquals("codex", loaded[0].agent)
        assertEquals("你好", loaded[0].events[0]["text"])
    }

    @Test
    fun aTruncatedCacheIsDiscardedRatherThanCrashing() {
        val store = SessionStore(context, "sessions-test.enc", "argus_test_cache_key")
        store.save(listOf(SessionStore.Cached("s-2", "qoder", emptyList(), "done", 1L)))
        // Simulate an interrupted write from an older build.
        val file = java.io.File(context.filesDir, "sessions-test.enc")
        assertTrue(file.exists())
        file.writeBytes(file.readBytes().copyOf(8))
        assertTrue(SessionStore(context, "sessions-test.enc", "argus_test_cache_key").load().isEmpty())
    }
}

private const val TEST_ALIAS = "argus_test_key"
