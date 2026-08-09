package com.kairong.argus.data

import android.content.Context
import android.util.Log
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * On-disk cache of mirrored sessions, so a cold start shows the last known
 * state instead of an empty list while the channel reconnects.
 *
 * Encrypted at rest: the payload is agent conversation content, and the app's
 * private directory alone is only as private as the device. Writes are
 * debounced by the caller — every mirrored event would otherwise hit the disk.
 *
 * Pending approvals are deliberately not persisted: a stale approval request
 * cannot be answered (the daemon-side hook has long since timed out).
 */
class SessionStore(
    context: Context,
    /** File name; tests override it so they do not clobber the real cache. */
    fileName: String = "sessions.enc",
    keyAlias: String = KEY_ALIAS,
) {

    /** One session as cached on disk. */
    data class Cached(
        val sessionId: String,
        val agent: String,
        val events: List<Map<String, Any?>>,
        val status: String,
        val lastActivity: Long,
    )

    private val appContext = context.applicationContext
    private val file = File(appContext.filesDir, fileName)

    /**
     * Keystore-backed sealing, replacing EncryptedFile (deprecated with the rest
     * of security-crypto in 1.1.0). The cache is a single blob, so one seal/open
     * pair covers it — EncryptedFile's streaming was never needed here, and its
     * refusal to overwrite is what forced the old delete-then-write dance.
     */
    private val vault = KeyVault(keyAlias)

    fun load(): List<Cached> {
        if (!file.exists()) return emptyList()
        return try {
            parse(String(vault.open(file.readBytes()), Charsets.UTF_8))
        } catch (e: Exception) {
            // Corrupt or key-rotated file: drop it rather than crash on launch.
            Log.w(TAG, "session cache unreadable, discarding: ${e.message}")
            file.delete()
            emptyList()
        }
    }

    /**
     * Write atomically: encrypt into a temp file, then rename over the real one.
     *
     * EncryptedFile refuses to overwrite, and the previous delete-then-write left
     * either nothing or a truncated file when it was interrupted — a truncated
     * file then fails to decrypt on load and gets deleted, losing the whole
     * cache. A rename within one directory cannot be observed half-done.
     *
     * Synchronized because onCleared can flush from the main thread while a
     * debounced write is already in flight.
     */
    @Synchronized
    fun save(sessions: List<Cached>) {
        val tmp = File(appContext.filesDir, "${file.name}.tmp")
        try {
            val trimmed = sessions
                .sortedByDescending { it.lastActivity }
                .take(MAX_SESSIONS)
                .map { it.copy(events = it.events.takeLast(MAX_EVENTS)) }
            tmp.writeBytes(vault.seal(serialize(trimmed).toByteArray()))
            if (!tmp.renameTo(file)) {
                // Fall back to replace-in-place; still better than losing the file.
                if (file.exists()) file.delete()
                if (!tmp.renameTo(file)) throw java.io.IOException("rename failed")
            }
        } catch (e: Exception) {
            Log.w(TAG, "session cache write failed: ${e.message}")
            runCatching { tmp.delete() }
        }
    }

    fun clear() {
        if (file.exists()) file.delete()
    }

    // ---- serialization (org.json; the event maps are already JSON-shaped) ----

    private fun serialize(sessions: List<Cached>): String {
        val arr = JSONArray()
        for (s in sessions) {
            val events = JSONArray()
            for (ev in s.events) events.put(toJson(ev))
            arr.put(JSONObject().apply {
                put("sessionId", s.sessionId)
                put("agent", s.agent)
                put("status", s.status)
                put("lastActivity", s.lastActivity)
                put("events", events)
            })
        }
        return JSONObject().apply {
            put("v", 1)
            put("sessions", arr)
        }.toString()
    }

    private fun parse(text: String): List<Cached> {
        val root = JSONObject(text)
        if (root.optInt("v") != 1) return emptyList()
        val arr = root.optJSONArray("sessions") ?: return emptyList()
        val out = mutableListOf<Cached>()
        for (i in 0 until arr.length()) {
            val o = arr.optJSONObject(i) ?: continue
            val evArr = o.optJSONArray("events") ?: JSONArray()
            val events = mutableListOf<Map<String, Any?>>()
            for (j in 0 until evArr.length()) {
                evArr.optJSONObject(j)?.let { events.add(fromJson(it)) }
            }
            out.add(Cached(
                sessionId = o.optString("sessionId"),
                agent = o.optString("agent"),
                events = events,
                status = o.optString("status", "done"),
                lastActivity = o.optLong("lastActivity"),
            ))
        }
        return out
    }

    private fun toJson(map: Map<String, Any?>): JSONObject =
        JSONObject().also { o -> map.forEach { (k, v) -> o.put(k, toJsonValue(v)) } }

    private fun toJsonValue(v: Any?): Any = when (v) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().also { o ->
            v.forEach { (k, x) -> o.put(k.toString(), toJsonValue(x)) }
        }
        is List<*> -> JSONArray().also { a -> v.forEach { a.put(toJsonValue(it)) } }
        else -> v
    }

    private fun fromJson(o: JSONObject): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        for (key in o.keys()) {
            map[key] = when (val v = o.get(key)) {
                JSONObject.NULL -> null
                is JSONObject -> fromJson(v)
                is JSONArray -> (0 until v.length()).map { i ->
                    when (val e = v.get(i)) {
                        is JSONObject -> fromJson(e)
                        else -> e
                    }
                }
                else -> v
            }
        }
        return map
    }

    private companion object {
        const val TAG = "SessionStore"
        const val KEY_ALIAS = "argus_session_cache_key"
        /** Keep the cache small: it is a warm-start convenience, not an archive. */
        const val MAX_SESSIONS = 20
        const val MAX_EVENTS = 200
    }
}
