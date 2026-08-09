package com.kairong.argus.data

import com.kairong.argus.crypto.*
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume

typealias Msg = Map<String, Any?>

private const val TAG = "RelayClient"

data class AgentEvent(val sessionId: String, val agent: String, val event: Map<String, Any?>)

/**
 * A session as catalogued on the Mac. `kind` separates IDE task transcripts
 * ("quest") from CLI sessions ("chat"); both are listed whether or not they are
 * currently active.
 */
data class SessionSummary(
    val id: String,
    val title: String,
    val agent: String,
    val cwd: String?,
    val updatedAt: Long,
    val kind: String,
    /** Set when this session was spawned by another agent (Codex collab). */
    val parentThreadId: String? = null,
    /** Codename the parent gave it ("Pauli", "Hilbert"). */
    val agentNickname: String? = null,
    /** Live status from app-server: running / completed / errored / … */
    val status: String? = null,
)
data class PermissionReq(
    val sessionId: String, val agent: String, val requestId: String,
    val toolName: String, val summary: String,
    val options: List<Map<String, String>>
)

/** A connection phase plus a safe, user-facing explanation for a disconnect. */
data class RelayConnectionStatus(val state: String, val detail: String? = null)

/** Everything pair() learns about the peer — persist it, don't discard it. */
data class PairOutcome(
    val longTermKey: ByteArray,
    val peerIdentityPub: ByteArray,
    val peerName: String,
    val peerPlatform: String,
    val peerFingerprint: String,
)

class RelayClient(
    private val relayUrl: String,
    private val onEvent: (AgentEvent) -> Unit,
    private val onPermission: (PermissionReq) -> Unit,
    private val onStatus: (RelayConnectionStatus) -> Unit,
) {
    companion object {
        // One client per process: each instance used to build its own
        // OkHttpClient (thread pools never shut down -> leak per reconnect).
        private val client = OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.SECONDS) // no timeout for WS
            .pingInterval(30, TimeUnit.SECONDS)
            .build()
    }
    private var ws: WebSocket? = null
    private var chan: SecureChannel? = null
    private var longTermKey: ByteArray? = null
    private var heartbeatExecutor: ScheduledExecutorService? = null

    /** input-ack from the daemon: (sessionId, status, note). */
    var onInputAck: ((String, String, String) -> Unit)? = null
    /** Full session inventory from the Mac, idle sessions included. */
    var onSessionList: ((List<SessionSummary>) -> Unit)? = null
    /** Cloud session URL (route C) — opened in the phone's browser. */
    var onCloudSessionUrl: ((String, String) -> Unit)? = null
    /** Codex's own thread inventory, from its app-server. */
    var onCodexThreads: ((List<SessionSummary>) -> Unit)? = null
    /** First, recent slice of a read-only Codex history stream. */
    var onCodexHistoryStart: ((String, String, List<Map<String, Any?>>, Int, Boolean, Boolean) -> Unit)? = null
    /** Earlier history, prepended while the user can already read the latest slice. */
    var onCodexHistoryChunk: ((String, String, List<Map<String, Any?>>, Int) -> Unit)? = null
    /** The Host finished sending every persisted history slice. */
    var onCodexHistoryComplete: ((String, String, Int) -> Unit)? = null
    /** Codex control-plane errors (app-server unreachable, history read failed, …). */
    var onCodexError: ((String, String, String) -> Unit)? = null
    /** (threadId, notification method) — drives the running indicator. */
    var onCodexTurnState: ((String, String) -> Unit)? = null
    /** (threadId, persisted history events, canAcceptDirectInput) after a read. */
    var onCodexHistory: ((String, List<Map<String, Any?>>, Boolean) -> Unit)? = null
    /** (sessionId, agent, first prompt) for a session the phone just started. */
    var onSessionStarted: ((String, String, String) -> Unit)? = null

    private val queue = mutableListOf<Msg>()
    private val waiters = mutableListOf<Pair<(Msg) -> Boolean, kotlin.coroutines.Continuation<Msg>>>()

    private fun reportStatus(state: String, detail: String? = null) {
        onStatus(RelayConnectionStatus(state, detail))
    }

    /** Do not surface arbitrary relay text verbatim; it is remote input. */
    private fun closeDetail(code: Int, reason: String): String = when {
        code == 4001 || reason == "replaced by reconnect" -> "同一设备发起了新的连接"
        code == 1006 -> "网络连接意外中断"
        code == 4000 -> "中继保活超时"
        code == 1000 -> "中继已正常关闭连接"
        else -> "中继关闭了连接（代码 $code）"
    }

    private fun failureDetail(error: Throwable): String = when (error) {
        is java.net.UnknownHostException -> "找不到中继服务器"
        is java.net.SocketTimeoutException -> "连接中继超时"
        is javax.net.ssl.SSLException -> "中继的安全连接失败"
        else -> "网络连接失败"
    }

    private suspend fun wait(timeoutMs: Long = 15000, pred: (Msg) -> Boolean): Msg = kotlinx.coroutines.suspendCancellableCoroutine { cont ->
        synchronized(queue) {
            val qi = queue.indexOfFirst { pred(it) }
            if (qi >= 0) { cont.resume(queue.removeAt(qi)); return@suspendCancellableCoroutine }
            waiters.add(pred to cont)
        }
        // timeout
        Thread {
            Thread.sleep(timeoutMs)
            synchronized(queue) {
                val wi = waiters.indexOfFirst { it.second === cont }
                if (wi >= 0) { waiters.removeAt(wi); cont.resumeWith(Result.failure(Exception("timeout"))) }
            }
        }.start()
    }

    // org.json stringifies unknown types (LinkedHashMap included) via
    // toString(), turning nested payloads into "{v=1, kind=hello}" strings the
    // daemon can't parse — deep-convert to JSONObject/JSONArray first.
    private fun toJsonValue(v: Any?): Any? = when (v) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().also { o -> v.forEach { (k, x) -> o.put(k.toString(), toJsonValue(x)) } }
        is List<*> -> org.json.JSONArray().also { a -> v.forEach { a.put(toJsonValue(it)) } }
        else -> v
    }

    /** Returns false when the frame could not be queued for sending. */
    private fun send(obj: Msg): Boolean {
        val socket = ws
        if (socket == null) {
            Log.w(TAG, "send dropped: no socket (op=${obj["op"]})")
            return false
        }
        val ok = socket.send((toJsonValue(obj) as JSONObject).toString())
        if (!ok) Log.w(TAG, "send refused by socket (op=${obj["op"]})")
        return ok
    }

    /** Keep an otherwise quiet control channel observable to the relay. */
    @Synchronized
    private fun startHeartbeat() {
        stopHeartbeat()
        heartbeatExecutor = Executors.newSingleThreadScheduledExecutor { task ->
            Thread(task, "argus-relay-heartbeat").apply { isDaemon = true }
        }.also { executor ->
            executor.scheduleAtFixedRate({
                if (!send(mapOf("op" to "heartbeat"))) disconnect("与中继的连接已失效")
            }, 25, 25, TimeUnit.SECONDS)
        }
    }

    @Synchronized
    private fun stopHeartbeat() {
        heartbeatExecutor?.shutdownNow()
        heartbeatExecutor = null
    }

    private fun dispatch(raw: String) {
        val msg = JSONObject(raw).toMap()
        synchronized(queue) {
            val wi = waiters.indexOfFirst { try { it.first(msg) } catch (e: Exception) { false } }
            if (wi >= 0) { val w = waiters.removeAt(wi); w.second.resume(msg); return }
            // Not a waited message — handle async
        }
        // Relay transport metadata. The Host uses peer departure to abandon
        // bulk history reads; Android has no local work to queue for it.
        if (msg["op"] == "chan-peer-left") return
        if (msg["op"] == "chan-data" && chan != null) {
            val enc = (msg["data"] as? Map<*, *>)?.get("enc") as? String
            if (enc != null) {
                try {
                    val payload = chan!!.open(enc)
                    when (payload["kind"]) {
                        "agent-event" -> onEvent(AgentEvent(
                            payload["sessionId"] as? String ?: "",
                            payload["agent"] as? String ?: "",
                            payload["event"] as? Map<String, Any?> ?: emptyMap()
                        ))
                        "input-ack" -> onInputAck?.invoke(
                            payload["sessionId"] as? String ?: "",
                            payload["status"] as? String ?: "",
                            payload["note"] as? String ?: ""
                        )
                        "session-list" -> {
                            val raw = payload["sessions"] as? List<*> ?: emptyList<Any>()
                            onSessionList?.invoke(raw.mapNotNull { item ->
                                val m = item as? Map<*, *> ?: return@mapNotNull null
                                SessionSummary(
                                    id = m["id"] as? String ?: return@mapNotNull null,
                                    title = m["title"] as? String ?: "",
                                    agent = m["agent"] as? String ?: "qoder",
                                    cwd = m["cwd"] as? String,
                                    updatedAt = (m["updatedAt"] as? Number)?.toLong() ?: 0L,
                                    kind = m["kind"] as? String ?: "chat",
                                )
                            })
                        }
                        "codex-thread-list" -> {
                            val raw = payload["threads"] as? List<*> ?: emptyList<Any>()
                            onCodexThreads?.invoke(raw.mapNotNull { item ->
                                val m = item as? Map<*, *> ?: return@mapNotNull null
                                SessionSummary(
                                    id = m["id"] as? String ?: return@mapNotNull null,
                                    // Codex titles its own threads; fall back to
                                    // the first-message preview.
                                    title = (m["name"] as? String)?.takeIf { it.isNotBlank() }
                                        ?: (m["preview"] as? String ?: ""),
                                    agent = "codex",
                                    cwd = m["cwd"] as? String,
                                    updatedAt = (m["updatedAt"] as? Number)?.toLong() ?: 0L,
                                    kind = "chat",
                                    parentThreadId = m["parentThreadId"] as? String,
                                    agentNickname = m["agentNickname"] as? String,
                                    status = m["status"] as? String,
                                )
                            })
                        }
                        "codex-event" -> {
                            // Live turn state from app-server. The transcript
                            // watcher carries the conversation itself, so this
                            // is used only to know whether a turn is running —
                            // merging both streams would duplicate content.
                            val method = payload["method"] as? String ?: ""
                            val params = payload["params"] as? Map<*, *>
                            val threadId = params?.get("threadId") as? String
                            if (threadId != null) {
                                onCodexTurnState?.invoke(threadId, method)
                            }
                        }
                        "session-started" -> onSessionStarted?.invoke(
                            payload["sessionId"] as? String ?: "",
                            payload["agent"] as? String ?: "qoder",
                            payload["prompt"] as? String ?: "",
                        )
                        "codex-resumed" -> {
                            // Pre-streaming Hosts send one complete body. Keep
                            // accepting that shape so an Android update can
                            // safely precede a Host update.
                            val raw = payload["events"] as? List<*> ?: emptyList<Any>()
                            onCodexHistory?.invoke(
                                payload["sessionId"] as? String ?: "",
                                raw.mapNotNull { it as? Map<String, Any?> },
                                payload["canAcceptDirectInput"] == true,
                            )
                        }
                        "codex-history-start" -> {
                            val raw = payload["events"] as? List<*> ?: emptyList<Any>()
                            val total = (payload["totalEvents"] as? Number)?.toInt() ?: raw.size
                            onCodexHistoryStart?.invoke(
                                payload["sessionId"] as? String ?: "",
                                payload["requestId"] as? String ?: "",
                                raw.mapNotNull { it as? Map<String, Any?> },
                                total,
                                // New paged Hosts cannot know the final total on
                                // page one. Older Hosts omit this and carry a
                                // complete total instead, so derive it there.
                                payload["hasMore"] as? Boolean ?: (raw.size < total),
                                payload["canAcceptDirectInput"] == true,
                            )
                        }
                        "codex-history-chunk" -> {
                            val raw = payload["events"] as? List<*> ?: emptyList<Any>()
                            onCodexHistoryChunk?.invoke(
                                payload["sessionId"] as? String ?: "",
                                payload["requestId"] as? String ?: "",
                                raw.mapNotNull { it as? Map<String, Any?> },
                                (payload["loadedEvents"] as? Number)?.toInt() ?: raw.size,
                            )
                        }
                        "codex-history-complete" -> onCodexHistoryComplete?.invoke(
                            payload["sessionId"] as? String ?: "",
                            payload["requestId"] as? String ?: "",
                            (payload["totalEvents"] as? Number)?.toInt() ?: 0,
                        )
                        "codex-error" -> onCodexError?.invoke(
                            payload["sessionId"] as? String ?: "",
                            payload["requestId"] as? String ?: "",
                            payload["note"] as? String ?: "",
                        )
                        "cloud-session-url" -> onCloudSessionUrl?.invoke(
                            payload["url"] as? String ?: "",
                            payload["note"] as? String ?: ""
                        )
                        "permission-request" -> onPermission(PermissionReq(
                            payload["sessionId"] as? String ?: "",
                            payload["agent"] as? String ?: "",
                            payload["requestId"] as? String ?: "",
                            payload["toolName"] as? String ?: "unknown",
                            payload["summary"] as? String ?: "",
                            (payload["options"] as? List<*>)?.mapNotNull { it as? Map<String, String> } ?: emptyList()
                        ))
                    }
                } catch (_: Exception) {}
            }
        } else {
            synchronized(queue) { queue.add(msg) }
        }
    }

    suspend fun pair(codeStr: String, identity: KeyPair, device: Pair<String, String>): PairOutcome {
        val code = parsePairCode(codeStr)
        reportStatus("connecting")
        connectWs()
        reportStatus("pairing")

        send(mapOf("op" to "join-pair", "nameplate" to code.nameplate))
        val joined = wait { it["op"] == "pair-joined" || it["op"] == "error" }
        if (joined["op"] == "error") throw Exception(joined["message"] as? String ?: "error")
        if (joined["role"] != "B") throw Exception("未找到等待中的配对发起方")

        val pepper = pepperFromSecret(code.secret)
        val eph = generateKeyPair()
        val helloMsg = mapOf(
            "v" to 1, "kind" to "hello", "role" to "B",
            "ephPub" to b64Encode(eph.publicKey), "device" to mapOf("name" to device.first, "platform" to device.second)
        )

        // Wait for A's hello
        val aHello = wait { it["op"] == "pair-data" }
        val aData = aHello["data"] as Map<String, Any?>
        val aEphPub = b64Decode(aData["ephPub"] as String)
        val shared = dh(eph.secretKey, aEphPub)

        val helloA = aData // A's hello
        val helloB = helloMsg // B's hello
        // TS side double-stringifies: pairing.ts feeds stableStringify(hello)
        // into transcriptHash, which stringifies again (quoted+escaped).
        // Mirror that exactly or the confirm tags can never match.
        val transcript = transcriptHash(stableStringify(helloA), stableStringify(helloB))
        val confirmKey = deriveConfirmKey(shared, pepper)
        val channelKey = deriveChannelKey(shared)
        val chan = SecureChannel(channelKey)
        this.chan = chan

        // Send hello + confirm + identity
        val bConfirm = confirmTag(confirmKey, "B2A", transcript)
        val identityPayload = mapOf(
            "v" to 1, "kind" to "identity",
            "identityPub" to b64Encode(identity.publicKey),
            "device" to mapOf("name" to device.first, "platform" to device.second)
        )
        val identityBlob = chan.seal(identityPayload)

        // Send all three messages
        send(mapOf("op" to "pair-data", "data" to helloMsg))
        send(mapOf("op" to "pair-data", "data" to mapOf("v" to 1, "kind" to "confirm", "tag" to b64Encode(bConfirm))))
        send(mapOf("op" to "pair-data", "data" to mapOf("v" to 1, "kind" to "identity", "blob" to identityBlob)))

        // Wait for A's confirm
        val aConfirmMsg = wait { it["op"] == "pair-data" }
        val aConfirmData = aConfirmMsg["data"] as Map<String, Any?>
        if (aConfirmData["kind"] != "confirm") throw Exception("protocol error")
        val expectedConfirm = confirmTag(confirmKey, "A2B", transcript)
        if (!constantTimeEquals(expectedConfirm, b64Decode(aConfirmData["tag"] as String)))
            throw Exception("密钥确认失败")

        // Wait for A's identity
        val aIdentityMsg = wait { it["op"] == "pair-data" }
        val aIdentityData = aIdentityMsg["data"] as Map<String, Any?>
        val aIdentityPayload = chan.open(aIdentityData["blob"] as String)
        val peerIdentityPub = b64Decode(aIdentityPayload["identityPub"] as String)
        val peerDevice = aIdentityPayload["device"] as Map<String, Any?>

        val ltk = deriveLongTermKey(dh(identity.secretKey, peerIdentityPub))
        longTermKey = ltk

        send(mapOf("op" to "leave-pair"))

        // Join channel
        val token = deriveChanToken(ltk)
        this.chan = SecureChannel(ltk) // switch to longTermKey for channel
        send(mapOf("op" to "join-chan", "token" to token, "endpoint" to "android"))
        val chanRes = wait { it["op"] == "chan-joined" || it["op"] == "error" }
        if (chanRes["op"] == "error") throw Exception("进入设备通道失败")
        reportStatus("channel-ready")
        startHeartbeat()

        return PairOutcome(
            longTermKey = ltk,
            peerIdentityPub = peerIdentityPub,
            peerName = peerDevice["name"] as? String ?: "Host",
            peerPlatform = peerDevice["platform"] as? String ?: "macos",
            peerFingerprint = fingerprint(peerIdentityPub),
        )
    }

    suspend fun connectChannel(ltkB64: String) {
        val ltk = b64Decode(ltkB64)
        longTermKey = ltk
        reportStatus("connecting")
        connectWs()
        val token = deriveChanToken(ltk)
        chan = SecureChannel(ltk)
        send(mapOf("op" to "join-chan", "token" to token, "endpoint" to "android"))
        val res = wait { it["op"] == "chan-joined" || it["op"] == "error" }
        if (res["op"] == "error") throw Exception("进入设备通道失败")
        reportStatus("channel-ready")
        startHeartbeat()
    }

    private fun connectWs() {
        val request = Request.Builder().url(relayUrl).build()
        ws = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) = dispatch(text)
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "websocket closing code=$code reason=$reason")
                if (ws !== webSocket) return
                ws = null; chan = null; stopHeartbeat()
                reportStatus("disconnected", closeDetail(code, reason))
                webSocket.close(code, null)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                Log.i(TAG, "websocket closed code=$code reason=$reason")
                if (ws !== webSocket) return
                ws = null; chan = null; stopHeartbeat()
                reportStatus("disconnected", closeDetail(code, reason))
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "websocket failure: ${t.javaClass.simpleName}: ${t.message}")
                if (ws !== webSocket) return
                ws = null; chan = null; stopHeartbeat()
                reportStatus("disconnected", failureDetail(t))
            }
        })
    }

    suspend fun sendPermissionResponse(sessionId: String, requestId: String, optionId: String) {
        val chan = chan ?: return
        val enc = chan.seal(mapOf(
            "kind" to "permission-response", "sessionId" to sessionId, "requestId" to requestId, "optionId" to optionId
        ))
        send(mapOf("op" to "chan-data", "data" to mapOf("enc" to enc)))
    }

    /** Returns false when the message could not be handed to the socket. */
    suspend fun sendUserInput(sessionId: String, text: String): Boolean {
        val chan = chan ?: run {
            Log.w(TAG, "user-input dropped: channel not ready")
            return false
        }
        val enc = chan.seal(mapOf("kind" to "user-input", "sessionId" to sessionId, "text" to text))
        return send(mapOf("op" to "chan-data", "data" to mapOf("enc" to enc)))
    }

    /** Ask the Mac for every session it knows about. */
    suspend fun requestSessionList(): Boolean {
        val chan = chan ?: return false
        return send(mapOf("op" to "chan-data", "data" to mapOf(
            "enc" to chan.seal(mapOf("kind" to "list-sessions")))))
    }

    /**
     * Start a fresh session on the Mac with `prompt` as its first message.
     *
     * `agent` picks the backend: Qoder goes through ACP, Codex through
     * app-server's thread/start. Without it every new session was a Qoder one.
     */
    suspend fun startNewSession(prompt: String, agent: String, cwd: String? = null) {
        val chan = chan ?: return
        val body = mutableMapOf<String, Any?>(
            "kind" to "new-session", "text" to prompt, "agent" to agent,
        )
        if (cwd != null) body["cwd"] = cwd
        send(mapOf("op" to "chan-data", "data" to mapOf("enc" to chan.seal(body))))
    }

    /** Route C: create a cloud session and get back a URL to open. */
    suspend fun createCloudSession(task: String, cwd: String? = null) {
        val chan = chan ?: return
        val body = mutableMapOf<String, Any?>("kind" to "cloud-session", "text" to task)
        if (cwd != null) body["cwd"] = cwd
        send(mapOf("op" to "chan-data", "data" to mapOf("enc" to chan.seal(body))))
    }

    /** Ask Codex's app-server for its thread inventory. */
    suspend fun requestCodexThreads(): Boolean {
        val chan = chan ?: return false
        return send(mapOf("op" to "chan-data", "data" to mapOf(
            "enc" to chan.seal(mapOf("kind" to "codex-threads")))))
    }

    /** Read a Codex thread's persisted history without resuming its live work. */
    suspend fun readCodexHistory(threadId: String, requestId: String): Boolean {
        val chan = chan ?: return false
        return send(mapOf("op" to "chan-data", "data" to mapOf("enc" to chan.seal(
            mapOf("kind" to "codex-resume", "sessionId" to threadId, "requestId" to requestId)))))
    }

    /** Stop a read-only, low-priority history stream after the reader leaves it. */
    suspend fun cancelCodexHistory(threadId: String, requestId: String): Boolean {
        val chan = chan ?: return false
        return send(mapOf("op" to "chan-data", "data" to mapOf("enc" to chan.seal(
            mapOf("kind" to "codex-history-cancel", "sessionId" to threadId, "requestId" to requestId)))))
    }

    /**
     * Send a message into a Codex thread. Unlike Qoder, this reaches the very
     * thread the desktop app has open — app-server owns the session, so a mid-turn
     * message steers the running turn instead of queueing behind it.
     */
    /** Returns false when the message could not be handed to the socket. */
    suspend fun sendCodexInput(threadId: String, text: String): Boolean {
        val chan = chan ?: run {
            Log.w(TAG, "codex-input dropped: channel not ready")
            return false
        }
        return send(mapOf("op" to "chan-data", "data" to mapOf("enc" to chan.seal(
            mapOf("kind" to "codex-input", "sessionId" to threadId, "text" to text)))))
    }

    /** Stop whatever the thread is doing right now. */
    suspend fun interruptCodex(threadId: String) {
        val chan = chan ?: return
        send(mapOf("op" to "chan-data", "data" to mapOf("enc" to chan.seal(
            mapOf("kind" to "codex-interrupt", "sessionId" to threadId)))))
    }

    /** Route B: bring up Qoder's own remote-control bridge on the Mac. */
    suspend fun startRemoteControl(name: String? = null, cwd: String? = null) {
        val chan = chan ?: return
        val body = mutableMapOf<String, Any?>("kind" to "remote-control")
        if (name != null) body["text"] = name
        if (cwd != null) body["cwd"] = cwd
        send(mapOf("op" to "chan-data", "data" to mapOf("enc" to chan.seal(body))))
    }

    fun disconnect(detail: String? = null) {
        val socket = ws
        ws = null
        chan = null
        stopHeartbeat()
        socket?.close(1000, "bye")
        reportStatus("disconnected", detail)
    }
}

private fun JSONObject.toMap(): Map<String, Any?> {
    val map = mutableMapOf<String, Any?>()
    for (key in keys()) map[key] = when (val v = get(key)) {
        is JSONObject -> v.toMap()
        is org.json.JSONArray -> (0 until v.length()).map { i ->
            when (val e = v.get(i)) { is JSONObject -> e.toMap(); else -> e }
        }
        else -> v
    }
    return map
}
