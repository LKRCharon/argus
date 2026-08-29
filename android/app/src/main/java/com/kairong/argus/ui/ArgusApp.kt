package com.kairong.argus.ui

import android.content.Intent
import android.net.Uri
import android.util.Log
import android.os.Build
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import com.kairong.argus.BuildConfig
import com.kairong.argus.crypto.*
import com.kairong.argus.data.*
import com.kairong.argus.ui.theme.*
import com.kairong.argus.voice.VoiceInputHelper
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

// ===== ViewModel =====
data class SessionState(
    val sessionId: String, val agent: String,
    val events: List<Map<String, Any?>>, val permissions: List<PermissionReq>,
    val status: String, val lastActivity: Long,
    /** Transient progress for a read-only, newest-first Codex history stream. */
    val historyRequestId: String? = null,
    val historyLoaded: Int = 0,
    val historyTotal: Int = 0,
    val historyLoading: Boolean = false,
    val historyLastProgressAt: Long = 0L,
)

/** What can cover the session list or a session detail. */
enum class Overlay { Pair, Devices, NewSession, Settings, PhoneAgent }

/** Longest a pending cache write may be deferred by new events. */
private const val PERSIST_MAX_DELAY_MS = 15_000L

class ArgusViewModel : ViewModel() {
    var identity by mutableStateOf<KeyPair?>(null)
        private set
    var myFingerprint by mutableStateOf("")
        private set
    var peers by mutableStateOf<Map<String, StoredPeer>>(emptyMap())
        private set
    /** The Host selected by the user. Pairing recency must never pick a Host. */
    var activePeerFingerprint by mutableStateOf<String?>(null)
        private set
    val activePeer: StoredPeer?
        get() = activePeerFingerprint?.let { peers[it] }
    var connectionStatus by mutableStateOf("disconnected")
        private set
    /** Why the last channel closed; retained while the automatic retry runs. */
    var connectionDetail by mutableStateOf<String?>(null)
        private set
    var relayUrl by mutableStateOf(BuildConfig.DEFAULT_RELAY_URL)
        private set
    /** Display preference, kept on by default for a live control surface. */
    var keepScreenOn by mutableStateOf(true)
        private set
    /** Whether an unexpected relay close should be retried automatically. */
    var autoReconnect by mutableStateOf(true)
        private set
    var sessions by mutableStateOf<Map<String, SessionState>>(emptyMap())
        private set
    var activeSessionId by mutableStateOf<String?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    /** Which overlay covers the session list, if any. Sessions are the only
     *  root screen now — pairing and devices are reached from the connection menu. */
    var overlay by mutableStateOf<Overlay?>(null)
    /** Full session inventory from the Mac, idle sessions included. */
    var catalog by mutableStateOf<List<SessionSummary>>(emptyList())
    var catalogLoading by mutableStateOf(false)
    /** Cloud-session URL from route C, surfaced as a tappable card. */
    var cloudUrl by mutableStateOf<String?>(null)
    /** True between tapping "new session" and the Mac reporting its id. */
    var pendingNewSession by mutableStateOf(false)
    /** Agent switcher at the top of the sessions sheet (null = all). Base list
     *  is qoder/codex; anything new appearing in the feed joins automatically. */
    var agentFilter by mutableStateOf<String?>(null)
    /** QR scanner overlay, kept inside the pairing flow rather than the home bar. */
    var showScanner by mutableStateOf(false)
    /** Agent switcher shows icons only by default; the chevron reveals names. */
    var showAgentLabels by mutableStateOf(false)
        private set
    /** Independent phone-side Agent session; its tools run on Android. */
    var phoneAgent by mutableStateOf(PhoneAgentState())
        private set
    var phoneAgentConfig by mutableStateOf(PhoneAgentConfigState())
        private set
    /** Explicit connection intent: Disconnect used to be instantly undone by
     *  the auto-reconnect effect (it only checked status == disconnected). */
    var userWantsConnection by mutableStateOf(true)
        private set

    private var store: IdentityStore? = null
    private var sessionStore: SessionStore? = null
    private var applicationContext: android.content.Context? = null
    /** Application ContentResolver, for the device-name fallbacks. */
    private var appResolver: android.content.ContentResolver? = null
    /** Debounced disk write: every mirrored event would otherwise hit the disk. */
    private var persistJob: Job? = null
    /** When the cache was last actually written, for the max-delay cap. */
    private var lastPersistAt = 0L
    private var relayClient: RelayClient? = null
    /** Prevent the Compose retry effect from starting overlapping handshakes. */
    private var channelConnectJob: Job? = null
    private var voiceHelper: VoiceInputHelper? = null
    private var phoneAgentRuntime: PhoneAgentRuntime? = null
    private var phoneAgentConfigStore: PhoneAgentConfigStore? = null
    /** A refresh needs both the transcript directory and Codex's app-server list. */
    private var catalogRefreshTimeoutJob: Job? = null
    private var refreshCatalogAfterConnection = false
    private var awaitingSessionList = false
    private var awaitingCodexThreadList = false
    /** Guards against stale callbacks: an old client's onClosed fires after a
     *  reconnect and used to clobber the fresh connection's status. */
    private var clientSeq = 0
    /** Monotonic per-process id; queued frames from a superseded read are ignored. */
    private var historyRequestSeq = 0L
    /** A cold-start deep link can arrive before Keystore-backed state is ready. */
    private var pendingPairLink: Pair<String, String?>? = null

    fun init(activity: ComponentActivity) {
        if (store != null) return
        val appCtx = activity.applicationContext
        appResolver = appCtx.contentResolver
        viewModelScope.launch(Dispatchers.IO) {
            // Keystore + disk I/O off the main thread.
            // Guarded: EncryptedSharedPreferences.create throws when the keyset
            // cannot be decrypted (restored backup, cleared Keystore), and an
            // uncaught throw here kills the process on every launch. Losing the
            // identity and re-pairing beats a crash loop.
            val s = try {
                IdentityStore(appCtx as android.content.Context)
            } catch (e: Exception) {
                Log.w("ArgusVM", "identity store unreadable, rebuilding: ${e.message}")
                IdentityStore.reset(appCtx as android.content.Context)
                try {
                    IdentityStore(appCtx as android.content.Context)
                } catch (e2: Exception) {
                    withContext(Dispatchers.Main) {
                        error = "身份存储不可用，请清除应用数据后重试"
                    }
                    return@launch
                }
            }
            val id = s.loadIdentity()
            val fp = s.getFingerprint()
            val ps = s.loadPeers()
            val relay = s.getRelayUrl()
            val keepAwake = s.getKeepScreenOn()
            val reconnectAutomatically = s.getAutoReconnect()
            val showAgentNames = s.getShowAgentLabels()
            val selectedPeer = s.getActivePeerFingerprint()?.takeIf { it in ps }
                ?: ps.values.maxByOrNull { it.pairedAt }?.fingerprint
            // Existing single-Host installs had no selection. Preserve their
            // latest pairing as the initial selection once, then persist it.
            if (selectedPeer != s.getActivePeerFingerprint()) s.setActivePeerFingerprint(selectedPeer)
            val cache = SessionStore(appCtx as android.content.Context, cacheFileName(selectedPeer))
            val agentConfigStore = PhoneAgentConfigStore(appCtx as android.content.Context)
            val agentConfig = agentConfigStore.state()
            val agentApiClient = PhoneAgentApiClient(agentConfigStore)
            val agentStorageAccess = { PhoneAgentStorage.hasAccess(appCtx as android.content.Context) }
            val restored = cache.load().associate { c ->
                c.sessionId to SessionState(
                    c.sessionId, c.agent, c.events, emptyList(), c.status, c.lastActivity
                )
            }
            withContext(Dispatchers.Main) {
                store = s
                sessionStore = cache
                applicationContext = appCtx as android.content.Context
                phoneAgentConfigStore = agentConfigStore
                phoneAgentRuntime = PhoneAgentRuntime(
                    scope = viewModelScope,
                    sendRequest = { requestId, instructions, input, tools ->
                        viewModelScope.launch(Dispatchers.IO) {
                            val response = agentApiClient.responses(requestId, instructions, input, tools)
                            withContext(Dispatchers.Main) { phoneAgentRuntime?.onResponse(response) }
                        }
                    },
                    onState = { next -> phoneAgent = next },
                    storageAccess = agentStorageAccess,
                    fileTools = PhoneFileTools(accessGranted = agentStorageAccess),
                    conversationStore = PhoneAgentConversationStore(
                        secrets = { listOfNotNull(agentConfigStore.apiKey()) },
                    ),
                )
                phoneAgentRuntime?.refreshStorageAccess()
                phoneAgentConfig = agentConfig
                identity = id
                myFingerprint = fp
                peers = ps
                activePeerFingerprint = selectedPeer
                relayUrl = relay
                keepScreenOn = keepAwake
                autoReconnect = reconnectAutomatically
                showAgentLabels = showAgentNames
                // Cached first: a cold start shows the last known state while
                // the channel reconnects, instead of an empty list.
                if (sessions.isEmpty()) sessions = restored
                pendingPairLink?.also {
                    pendingPairLink = null
                    applyPairLink(it.first, it.second)
                }
            }
        }
    }

    fun updateRelayUrl(url: String) {
        relayUrl = url
        store?.setRelayUrl(url)
    }

    /** Save a user-entered relay endpoint and, on request, make it active now. */
    fun saveRelayUrl(url: String, reconnect: Boolean): Boolean {
        val normalized = url.trim()
        val endpoint = Uri.parse(normalized)
        if (normalized.isBlank() || endpoint.scheme !in setOf("ws", "wss") || endpoint.host.isNullOrBlank()) {
            error = "中继地址应为 ws:// 或 wss:// 地址"
            return false
        }
        error = null
        updateRelayUrl(normalized)
        if (reconnect && activePeer != null) connectChannel()
        return true
    }

    fun updateKeepScreenOn(enabled: Boolean) {
        keepScreenOn = enabled
        store?.setKeepScreenOn(enabled)
    }

    fun updateAutoReconnect(enabled: Boolean) {
        autoReconnect = enabled
        store?.setAutoReconnect(enabled)
    }

    fun updateShowAgentLabels(enabled: Boolean) {
        showAgentLabels = enabled
        store?.setShowAgentLabels(enabled)
    }

    fun refreshPhoneAgentStorageAccess() {
        phoneAgentRuntime?.refreshStorageAccess()
            ?: run {
                val context = applicationContext ?: return
                phoneAgent = phoneAgent.copy(storageAccessGranted = PhoneAgentStorage.hasAccess(context))
            }
    }

    fun startPhoneAgent(prompt: String) {
        if (!phoneAgentConfig.hasApiKey) {
            phoneAgent = phoneAgent.copy(error = "请先配置 LimenAPI Key")
            return
        }
        phoneAgentRuntime?.sendPrompt(prompt)
    }

    fun approvePhoneAgentTool(allow: Boolean) {
        phoneAgentRuntime?.approvePending(allow)
    }

    fun resetPhoneAgent() {
        phoneAgentRuntime?.reset()
    }

    fun savePhoneAgentConfig(baseUrl: String, model: String, apiKey: String): String? {
        val configStore = phoneAgentConfigStore ?: return "手机 Agent 尚未初始化"
        val error = configStore.validate(baseUrl, model, apiKey.ifBlank { null })
        if (error != null) return error
        return try {
            phoneAgentConfig = configStore.save(baseUrl, model, apiKey.ifBlank { null })
            phoneAgent = phoneAgent.copy(error = null)
            null
        } catch (e: Exception) {
            e.message ?: "无法保存 LimenAPI 配置"
        }
    }

    fun clearPhoneAgentApiKey() {
        val configStore = phoneAgentConfigStore ?: return
        phoneAgentConfig = configStore.clearApiKey()
        phoneAgentRuntime?.reset()
        phoneAgent = phoneAgent.copy(error = "LimenAPI Key 已移除")
    }

    /** Stop only an abandoned, observational history download. */
    private fun cancelPendingCodexHistory(threadId: String) {
        val current = sessions[threadId] ?: return
        val requestId = current.historyRequestId ?: return
        if (!current.historyLoading) return
        sessions = sessions + (threadId to current.copy(
            historyRequestId = null,
            historyLoaded = maxOf(current.historyLoaded, current.events.size),
            historyTotal = maxOf(current.historyTotal, current.historyLoaded, current.events.size),
            historyLoading = false,
        ))
        val client = relayClient ?: return
        viewModelScope.launch(Dispatchers.IO) {
            client.cancelCodexHistory(threadId, requestId)
        }
    }

    fun setActiveSession(id: String?) {
        val previous = activeSessionId
        if (previous != null && previous != id) cancelPendingCodexHistory(previous)
        activeSessionId = id
    }

    private fun cacheFileName(peerFingerprint: String?): String {
        if (peerFingerprint == null) return "sessions.enc"
        val safe = peerFingerprint.replace(Regex("[^A-Za-z0-9._-]"), "_")
        return "sessions-$safe.enc"
    }

    private fun sessionSnapshot(): List<SessionStore.Cached> = sessions.values.map { s ->
        SessionStore.Cached(s.sessionId, s.agent, s.events, s.status, s.lastActivity)
    }

    /** Save the old Host before replacing the active cache target. */
    private fun flushCurrentSessions() {
        persistJob?.cancel()
        persistJob = null
        val cache = sessionStore ?: return
        val snapshot = sessionSnapshot()
        viewModelScope.launch(Dispatchers.IO) { cache.save(snapshot) }
    }

    /** Forget only in-memory state belonging to the previously selected Host. */
    private fun clearHostView() {
        setActiveSession(null)
        sessions = emptyMap()
        catalog = emptyList()
        cancelCatalogRefresh()
        cloudUrl = null
        pendingNewSession = false
        lastPersistAt = 0L
    }

    /** Load the selected Host's encrypted cache without blocking composition. */
    private fun loadPeerCache(peerFingerprint: String?) {
        val ctx = applicationContext ?: return
        val cache = SessionStore(ctx, cacheFileName(peerFingerprint))
        sessionStore = cache
        viewModelScope.launch(Dispatchers.IO) {
            val restored = cache.load().associate { c ->
                c.sessionId to SessionState(
                    c.sessionId, c.agent, c.events, emptyList(), c.status, c.lastActivity
                )
            }
            withContext(Dispatchers.Main) {
                // A second switch may have happened while Keystore I/O ran.
                if (activePeerFingerprint == peerFingerprint && sessions.isEmpty()) sessions = restored
            }
        }
    }

    private fun activatePeer(
        fingerprint: String,
        keepCurrentConnection: Boolean,
        reconnect: Boolean,
    ) {
        if (peers[fingerprint] == null) return
        if (activePeerFingerprint != fingerprint) {
            flushCurrentSessions()
            if (!keepCurrentConnection) {
                clientSeq++ // silence late events from the previously selected Host
                relayClient?.disconnect()
                relayClient = null
                connectionStatus = "disconnected"
            }
            activePeerFingerprint = fingerprint
            store?.setActivePeerFingerprint(fingerprint)
            clearHostView()
            loadPeerCache(fingerprint)
        }
        if (reconnect) {
            userWantsConnection = true
            connectChannel()
        }
    }

    /** Select a Host explicitly; never infer it from pairing time. */
    fun selectPeer(fingerprint: String) {
        if (activePeerFingerprint == fingerprint) {
            overlay = null
            if (connectionStatus == "disconnected") connectChannel()
            return
        }
        error = null
        activatePeer(fingerprint, keepCurrentConnection = false, reconnect = true)
        overlay = null
    }

    /** Build a client whose callbacks go dead once a newer client exists. */
    private fun newClient(): RelayClient {
        val seq = ++clientSeq
        return RelayClient(relayUrl,
            onEvent = { ev ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) { onAgentEvent(ev) }
            },
            onPermission = { req ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) { onPermissionReq(req) }
            },
            onStatus = { status ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    connectionStatus = status.state
                    when (status.state) {
                        // A successful fresh channel makes an old disconnect
                        // explanation irrelevant.
                        "channel-ready" -> {
                            connectionDetail = null
                            if (refreshCatalogAfterConnection) {
                                refreshCatalogAfterConnection = false
                                requestCatalog()
                            }
                        }
                        "disconnected" -> connectionDetail = status.detail
                        // Retain a useful cause while Compose's reconnect effect
                        // advances through connecting/pairing.
                        else -> if (status.detail != null) connectionDetail = status.detail
                    }
                }
            }
        ).also { c ->
            c.onInputAck = { sid, status, note ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) { onInputAck(sid, status, note) }
            }
            c.onMeshError = { meshError ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    if (meshError.code == "legacy-control-disabled") {
                        cancelCatalogRefresh()
                        pendingNewSession = false
                    }
                    error = meshError.message
                }
            }
            c.onSessionList = { list ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    // Keep whatever app-server already told us about codex: its
                    // titles and status beat anything scraped from transcripts.
                    val fromCodex = catalog.filter { it.agent == "codex" }
                    val ids = fromCodex.map { it.id }.toSet()
                    catalog = (fromCodex + list.filterNot { it.id in ids })
                        .sortedByDescending { it.updatedAt }
                    completeCatalogRefreshPart(sessionList = true)
                }
            }
            c.onCodexThreads = { list ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    val ids = list.map { it.id }.toSet()
                    catalog = (list + catalog.filterNot { it.id in ids })
                        .sortedByDescending { it.updatedAt }
                    completeCatalogRefreshPart(sessionList = false)
                }
            }
            c.onCodexTurnState = { threadId, method ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    // app-server knows a turn's real state; the transcript only
                    // shows it once output lands, so the spinner used to lag.
                    val s = sessions[threadId] ?: return@launch
                    val status = when (method) {
                        "turn/started" -> "running"
                        "turn/completed", "turn/aborted" -> "done"
                        else -> return@launch
                    }
                    if (s.status != status) {
                        sessions = sessions + (threadId to s.copy(status = status))
                    }
                }
            }
            c.onSessionStarted = { sessionId, agent, prompt ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    // Seed the session and open it. Starting a session used to
                    // leave the user on an unchanged list with no way to tell it
                    // had worked — the agent answered into a session the phone
                    // did not know existed.
                    if (sessions[sessionId] == null) {
                        sessions = sessions + (sessionId to SessionState(
                            sessionId, agent,
                            if (prompt.isBlank()) emptyList()
                            else listOf(mapOf("type" to "user-text", "text" to prompt, "ack" to "delivered")),
                            emptyList(), "running", System.currentTimeMillis(),
                        ))
                    }
                    pendingNewSession = false
                    setActiveSession(sessionId)
                    persistSessions()
                }
            }
            c.onCodexHistory = { threadId, events, canInput ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    // Compatibility with Hosts that still return a single body.
                    // A live session is never replaced by a read snapshot:
                    // events arriving while that request was in flight are newer.
                    val existing = sessions[threadId]
                    // Legacy replies have no request id.  A local cancellation
                    // therefore requires an explicit loading guard so a late
                    // full snapshot cannot repopulate a card the user left.
                    if (existing?.historyLoading != true) return@launch
                    if (canReplaceHistory(existing)) {
                        sessions = sessions + (threadId to (existing ?: SessionState(
                            threadId, "codex", emptyList(), emptyList(), "done", 0L
                        )).copy(
                            events = events,
                            historyRequestId = null,
                            historyLoaded = events.size,
                            historyTotal = events.size,
                            historyLoading = false,
                            lastActivity = System.currentTimeMillis(),
                        ))
                        persistSessions()
                    } else if (existing?.historyLoading == true) {
                        sessions = sessions + (threadId to existing.copy(
                            historyRequestId = null,
                            historyLoaded = existing.events.size,
                            historyTotal = existing.events.size,
                            historyLoading = false,
                        ))
                    }
                    if (!canInput) error = "该会话不接受远程输入"
                }
            }
            c.onCodexHistoryStart = { threadId, requestId, events, total, hasMore, canInput ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    val existing = sessions[threadId]
                    if (existing == null || existing.historyRequestId != requestId) {
                        return@launch
                    }
                    if (canReplaceHistory(existing)) {
                        val loaded = events.size
                        val totalEvents = if (total > 0) maxOf(total, loaded) else 0
                        sessions = sessions + (threadId to (existing ?: SessionState(
                            threadId, "codex", emptyList(), emptyList(), "done", 0L
                        )).copy(
                            events = events,
                            // Retain the completed id too: a stale queued start
                            // frame must not overwrite a newer completed read.
                            historyRequestId = requestId,
                            historyLoaded = loaded,
                            historyTotal = totalEvents,
                            historyLoading = hasMore,
                            historyLastProgressAt = System.currentTimeMillis(),
                            // Start at the newest slice; older chunks only prepend.
                            lastActivity = System.currentTimeMillis(),
                        ))
                        persistSessions()
                    } else if (existing?.historyLoading == true) {
                        // A real live turn wins over a delayed persisted read.
                        sessions = sessions + (threadId to existing.copy(
                            historyRequestId = requestId,
                            historyLoaded = existing.events.size,
                            historyTotal = existing.events.size,
                            historyLoading = false,
                        ))
                    }
                    if (!canInput) error = "该会话不接受远程输入"
                }
            }
            c.onCodexHistoryChunk = { threadId, requestId, events, loadedEvents ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    val existing = sessions[threadId] ?: return@launch
                    if (!existing.historyLoading || existing.historyRequestId != requestId) return@launch
                    sessions = sessions + (threadId to existing.copy(
                        // Host sends the closest earlier slice first, so prepend
                        // preserves chronological order without moving the reader.
                        events = events + existing.events,
                        historyLoaded = maxOf(loadedEvents, existing.historyLoaded + events.size),
                        historyLastProgressAt = System.currentTimeMillis(),
                    ))
                    persistSessions()
                }
            }
            c.onCodexHistoryComplete = { threadId, requestId, total ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    val existing = sessions[threadId] ?: return@launch
                    if (existing.historyRequestId != requestId) return@launch
                    sessions = sessions + (threadId to existing.copy(
                        historyRequestId = requestId,
                        historyLoaded = maxOf(total, existing.historyLoaded),
                        historyTotal = maxOf(total, existing.historyTotal),
                        historyLoading = false,
                    ))
                    persistSessions()
                }
            }
            c.onCodexError = { threadId, requestId, note ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    // A catalog refresh can also emit codex-error. Only an
                    // addressed history request is allowed to stop this loader.
                    val target = threadId.takeIf { it.isNotEmpty() }?.let { sessions[it] }
                    if (threadId.isNotEmpty() && requestId.isNotEmpty() &&
                        (target == null || target.historyRequestId != requestId)) return@launch
                    if (target != null && target.historyLoading &&
                        (requestId.isEmpty() || target.historyRequestId == requestId)) {
                        sessions = sessions + (target.sessionId to target.copy(
                            historyRequestId = null,
                            historyLoading = false,
                        ))
                    }
                    error = note
                    catalogLoading = false
                }
            }
            c.onCloudSessionUrl = { url, note ->
                if (seq == clientSeq) viewModelScope.launch(Dispatchers.Main) {
                    cloudUrl = url.ifEmpty { null }
                    if (url.isEmpty()) error = note
                }
            }
        }
    }

    /** Resolve the oldest pending echo bubble with the daemon's ack. */
    private fun onInputAck(sessionId: String, status: String, note: String) {
        val s = sessions[sessionId] ?: return
        val idx = s.events.indexOfFirst { it["type"] == "user-text" && it["ack"] == "pending" }
        if (idx < 0) return
        val updated = s.events.toMutableList()
        updated[idx] = updated[idx] + mapOf("ack" to status.ifEmpty { "queued" }, "note" to note)
        sessions = sessions + (sessionId to s.copy(events = updated))
    }

    fun pair(code: String) {
        error = null
        connectionDetail = null
        val s = store ?: return
        val id = identity ?: return
        flushCurrentSessions()
        userWantsConnection = true
        val device = Pair(DeviceName.friendly(appResolver), "android")
        viewModelScope.launch(Dispatchers.IO) {
            val client = newClient()
            try {
                relayClient?.disconnect()
                relayClient = client
                val outcome = client.pair(code, id, device)
                s.savePeer(StoredPeer(
                    b64Encode(outcome.peerIdentityPub), outcome.peerFingerprint,
                    outcome.peerName, outcome.peerPlatform,
                    b64Encode(outcome.longTermKey), System.currentTimeMillis()
                ))
                val ps = s.loadPeers()
                withContext(Dispatchers.Main) {
                    peers = ps
                    // pair() already connected this exact client, so keep it
                    // alive while switching the UI and cache to the new Host.
                    activatePeer(outcome.peerFingerprint, keepCurrentConnection = true, reconnect = false)
                    // Dismiss the pair sheet: leaving it up hid the very list the
                    // user just paired in order to see.
                    if (overlay == Overlay.Pair) overlay = null
                }
            } catch (e: Exception) {
                // Close the socket (frees the pairing room) and reset status —
                // a stuck "pairing" left the whole pair screen disabled forever.
                client.disconnect("无法建立配对连接")
                withContext(Dispatchers.Main) {
                    if (relayClient === client) relayClient = null
                    error = e.message
                }
            }
        }
    }

    fun connectChannel(keepDisconnectNotice: Boolean = false) {
        val peer = activePeer ?: run { error = "请先选择一台主机"; return }
        if (channelConnectJob?.isActive == true ||
            connectionStatus == "connecting" || connectionStatus == "pairing"
        ) return
        error = null
        if (!keepDisconnectNotice) connectionDetail = null
        userWantsConnection = true
        // Mark the attempt before dispatching to IO. The retry effect is keyed
        // on this state and otherwise can start a second handshake while the
        // first WebSocket is still waiting for chan-joined.
        connectionStatus = "connecting"
        val job = viewModelScope.launch(Dispatchers.IO, start = CoroutineStart.LAZY) {
            val connectJob = coroutineContext[Job]
            val client = newClient()
            try {
                relayClient?.disconnect()
                relayClient = client
                client.connectChannel(peer.longTermKey)
            } catch (_: CancellationException) {
                client.disconnect()
            } catch (e: Exception) {
                client.disconnect("无法建立与中继的连接")
                withContext(Dispatchers.Main) {
                    if (relayClient === client) relayClient = null
                    error = e.message
                }
            } finally {
                // This callback is separate from the cancelled connect job so
                // a manual disconnect cannot leave the retry gate stuck.
                viewModelScope.launch(Dispatchers.Main) {
                    if (channelConnectJob === connectJob) channelConnectJob = null
                }
            }
        }
        channelConnectJob = job
        job.start()
    }

    private fun onAgentEvent(ev: AgentEvent) {
        val existing = sessions[ev.sessionId] ?: SessionState(
            ev.sessionId, ev.agent, emptyList(), emptyList(), "running", System.currentTimeMillis()
        )
        val eventType = ev.event["type"] as? String ?: ""
        val newStatus = when (eventType) {
            "turn-done" -> "done"; "error" -> "error"
            else -> if (existing.status == "waiting_permission") existing.status else "running"
        }
        // A message typed here is echoed straight away *and* comes back through
        // the transcript once the IDE accepts it. Fold the returning copy into
        // the local bubble instead of showing the same text twice.
        if (eventType == "user-text") {
            val incoming = (ev.event["text"] as? String)?.trim()
            val idx = existing.events.indexOfLast {
                it["type"] == "user-text" && it["ack"] != null &&
                    (it["text"] as? String)?.trim() == incoming
            }
            if (incoming != null && idx >= 0) {
                val merged = existing.events.toMutableList()
                merged[idx] = merged[idx] + mapOf("ack" to "delivered")
                sessions = sessions + (ev.sessionId to existing.copy(
                    events = merged, status = newStatus,
                    lastActivity = System.currentTimeMillis()
                ))
                persistSessions()
                return
            }
        }
        sessions = sessions + (ev.sessionId to existing.copy(
            // A progressive history can be longer than the warm-start cache.
            // Keep it in memory while it is open; SessionStore still bounds
            // what is retained at rest.
            events = existing.events + ev.event,
            status = newStatus, lastActivity = System.currentTimeMillis()
        ))
        persistSessions()
    }

    /**
     * Coalesce bursts into one write ~2s after they settle, but never wait longer
     * than 15s. A pure debounce reset itself on every event, so during an active
     * agent run — exactly when the data matters — nothing was ever written.
     */
    private fun persistSessions() {
        val cache = sessionStore ?: return
        val snapshot = sessionSnapshot()
        val now = System.currentTimeMillis()
        if (lastPersistAt == 0L) lastPersistAt = now
        if (now - lastPersistAt >= PERSIST_MAX_DELAY_MS) {
            persistJob?.cancel()
            persistJob = null
            lastPersistAt = now
            viewModelScope.launch(Dispatchers.IO) { cache.save(snapshot) }
            return
        }
        persistJob?.cancel()
        persistJob = viewModelScope.launch(Dispatchers.IO) {
            delay(2000)
            lastPersistAt = System.currentTimeMillis()
            cache.save(snapshot)
        }
    }

    /**
     * Open a session that only exists on the Mac. The detail screen reads from
     * `sessions`, so seed a shell entry with what the catalog knows; live events
     * fill it in if the session wakes up again.
     */
    fun openCatalogSession(summary: SessionSummary) {
        if (sessions[summary.id] == null) {
            sessions = sessions + (summary.id to SessionState(
                summary.id, summary.agent,
                listOf(mapOf("type" to "user-text", "text" to summary.title)),
                emptyList(),
                if (summary.status in setOf("running", "inProgress", "started")) "running" else "done",
                summary.updatedAt,
            ))
        }
        setActiveSession(summary.id)
        // Codex can hand back the real history; without this the card only ever
        // showed the seeded title line.
        if (summary.agent == "codex") {
            requestCodexHistory(summary.id)
        }
    }

    /** Cached cards and fresh catalog cards must take the same read-only path.
     *  Previously a cached shell only called setActiveSession(), leaving its
     *  one-line title visible forever and bypassing the history loader. */
    fun openSession(sessionId: String) {
        setActiveSession(sessionId)
        val session = sessions[sessionId] ?: return
        if (session.agent == "codex" && !session.historyLoading) {
            requestCodexHistory(sessionId)
        }
    }

    /** A completed/cache-only session may be safely refreshed; an active turn
     *  is not replaced by a delayed `thread/read` snapshot. */
    private fun canReplaceHistory(existing: SessionState?): Boolean =
        existing == null || existing.events.size <= 1 ||
            existing.status !in setOf("running", "waiting_permission")

    private fun requestCodexHistory(threadId: String) {
        val current = sessions[threadId] ?: return
        // A process restart can repeat a small sequence number; include time so
        // a queued frame from a cancelled earlier app instance cannot match it.
        val requestId = "history-${System.currentTimeMillis()}-${++historyRequestSeq}"
        sessions = sessions + (threadId to current.copy(
            historyRequestId = requestId,
            historyLoaded = 0,
            historyTotal = 0,
            historyLoading = true,
            historyLastProgressAt = System.currentTimeMillis(),
        ))
        val client = relayClient
        if (client == null) {
            sessions = sessions + (threadId to sessions.getValue(threadId).copy(
                historyLoading = false,
            ))
            error = "历史记录未发出：连接未就绪"
            return
        }
        viewModelScope.launch(Dispatchers.IO) {
            if (!client.readCodexHistory(threadId, requestId)) {
                withContext(Dispatchers.Main) {
                    val pending = sessions[threadId]
                    if (pending?.historyRequestId == requestId) {
                        sessions = sessions + (threadId to pending.copy(
                            historyLoading = false,
                        ))
                        error = "历史记录未发出：连接已断开"
                    }
                }
            }
        }
        // The relay may drop mid-read. Keep a long paged history alive while
        // chunks arrive, but never leave the user on a silent 25-second stall.
        viewModelScope.launch {
            while (true) {
                delay(25_000)
                val pending = sessions[threadId]
                if (pending?.historyRequestId != requestId || !pending.historyLoading) return@launch
                if (System.currentTimeMillis() - pending.historyLastProgressAt >= 25_000) {
                    cancelPendingCodexHistory(threadId)
                    error = "历史记录读取超时，请稍后重试"
                    return@launch
                }
            }
        }
    }

    /** Stop a pending directory refresh without affecting any live session. */
    private fun cancelCatalogRefresh() {
        catalogRefreshTimeoutJob?.cancel()
        catalogRefreshTimeoutJob = null
        refreshCatalogAfterConnection = false
        awaitingSessionList = false
        awaitingCodexThreadList = false
        catalogLoading = false
    }

    private fun armCatalogRefreshTimeout() {
        catalogRefreshTimeoutJob?.cancel()
        catalogRefreshTimeoutJob = viewModelScope.launch {
            delay(8_000)
            if (catalogLoading) {
                awaitingSessionList = false
                awaitingCodexThreadList = false
                refreshCatalogAfterConnection = false
                catalogLoading = false
                error = "会话目录读取超时，请下拉重试"
            }
        }
    }

    /** Both sources are needed before the pull indicator can honestly finish. */
    private fun completeCatalogRefreshPart(sessionList: Boolean) {
        if (!catalogLoading) return
        if (sessionList) awaitingSessionList = false else awaitingCodexThreadList = false
        if (!awaitingSessionList && !awaitingCodexThreadList) {
            catalogRefreshTimeoutJob?.cancel()
            catalogRefreshTimeoutJob = null
            catalogLoading = false
        }
    }

    /** Request the transcript directory and Codex app-server directory together. */
    private fun requestCatalog() {
        val client = relayClient
        if (connectionStatus != "channel-ready" || client == null) {
            cancelCatalogRefresh()
            error = "会话目录未发出：连接未就绪"
            return
        }
        catalogLoading = true
        awaitingSessionList = true
        awaitingCodexThreadList = true
        armCatalogRefreshTimeout()
        viewModelScope.launch(Dispatchers.IO) {
            val sessionsSent = client.requestSessionList()
            // Codex knows its own threads better than our transcript scan does
            // (model-written titles, live status), so ask it too.
            val threadsSent = client.requestCodexThreads()
            if (!sessionsSent || !threadsSent) withContext(Dispatchers.Main) {
                if (relayClient === client) {
                    cancelCatalogRefresh()
                    error = "会话目录未发出：连接已断开"
                }
            }
        }
    }

    /** Refresh the Home list when ready; a pull while disconnected reconnects first. */
    fun refreshHome() {
        if (catalogLoading) return
        if (activePeer == null) {
            error = "请先选择一台主机"
            return
        }
        error = null
        if (connectionStatus == "channel-ready" && relayClient != null) {
            requestCatalog()
            return
        }
        catalogLoading = true
        refreshCatalogAfterConnection = true
        armCatalogRefreshTimeout()
        // A swipe is explicit intent to refresh, so it may reconnect after a
        // manual disconnect. Do not start a second socket while one is opening.
        if (connectionStatus == "disconnected") connectChannel(keepDisconnectNotice = true)
    }

    /** Pull the Mac's full session inventory (idle sessions included). */
    fun refreshCatalog() {
        if (catalogLoading) return
        error = null
        requestCatalog()
    }

    fun startNewSession(prompt: String, agent: String, cwd: String?) {
        val client = relayClient ?: return
        overlay = null
        pendingNewSession = true
        viewModelScope.launch(Dispatchers.IO) { client.startNewSession(prompt, agent, cwd) }
        // Give up the spinner if the Mac never answers, rather than showing
        // "starting…" forever.
        viewModelScope.launch {
            delay(30_000)
            if (pendingNewSession) {
                pendingNewSession = false
                error = "新建会话没有响应，请检查主机端"
            }
        }
    }

    /** Route C: cloud session, answered with a URL to open. */
    fun createCloudSession(task: String, cwd: String?) {
        val client = relayClient ?: return
        overlay = null
        viewModelScope.launch(Dispatchers.IO) { client.createCloudSession(task, cwd) }
    }

    private fun onPermissionReq(req: PermissionReq) {
        val existing = sessions[req.sessionId] ?: SessionState(
            req.sessionId, req.agent, emptyList(), emptyList(), "running", System.currentTimeMillis()
        )
        sessions = sessions + (req.sessionId to existing.copy(
            permissions = existing.permissions + req,
            status = "waiting_permission", lastActivity = System.currentTimeMillis()
        ))
    }

    fun respondPermission(sessionId: String, requestId: String, optionId: String) {
        viewModelScope.launch(Dispatchers.IO) {
            relayClient?.sendPermissionResponse(sessionId, requestId, optionId)
            withContext(Dispatchers.Main) {
                val s = sessions[sessionId] ?: return@withContext
                sessions = sessions + (sessionId to s.copy(
                    permissions = s.permissions.filterNot { it.requestId == requestId },
                    status = "running"
                ))
            }
        }
    }

    fun sendInput(sessionId: String, text: String) {
        // Local echo first — sent messages used to vanish with zero feedback.
        val s = sessions[sessionId]
        if (s != null) {
            sessions = sessions + (sessionId to s.copy(
                events = (s.events + mapOf("type" to "user-text", "text" to text, "ack" to "pending"))
                    .takeLast(500),
                lastActivity = System.currentTimeMillis()
            ))
        }
        persistSessions()
        armAckTimeout(sessionId)
        val codex = (s?.agent ?: "") == "codex"
        viewModelScope.launch(Dispatchers.IO) {
            // Codex owns its sessions in app-server, so input can be delivered
            // into the running thread (and steers it mid-turn). Qoder has no
            // such protocol; its input goes to Argus for keystroke injection.
            val sent = if (codex) relayClient?.sendCodexInput(sessionId, text)
                       else relayClient?.sendUserInput(sessionId, text)
            if (sent != true) {
                // Surface it now rather than leaving the bubble spinning until
                // the ack timeout: the message never left the phone.
                withContext(Dispatchers.Main) {
                    error = "消息未发出：连接未就绪"
                    failPendingAck(sessionId, "未发出，请检查连接")
                }
            }
        }
    }

    /**
     * Fail a still-pending echo bubble after a while. A message sent while the
     * channel was half-open used to spin indefinitely with no way to tell.
     */
    /** Mark the newest pending bubble as failed with `note`. */
    private fun failPendingAck(sessionId: String, note: String) {
        val s = sessions[sessionId] ?: return
        val idx = s.events.indexOfLast { it["type"] == "user-text" && it["ack"] == "pending" }
        if (idx < 0) return
        val updated = s.events.toMutableList()
        updated[idx] = updated[idx] + mapOf("ack" to "failed", "note" to note)
        sessions = sessions + (sessionId to s.copy(events = updated))
    }

    private fun armAckTimeout(sessionId: String) {
        viewModelScope.launch {
            delay(20_000)
            val s = sessions[sessionId] ?: return@launch
            val idx = s.events.indexOfLast { it["type"] == "user-text" && it["ack"] == "pending" }
            if (idx < 0) return@launch
            val updated = s.events.toMutableList()
            updated[idx] = updated[idx] + mapOf("ack" to "failed", "note" to "主机未响应，请检查连接")
            sessions = sessions + (sessionId to s.copy(events = updated))
        }
    }

    /** Stop a running Codex turn. Only Codex can be interrupted remotely. */
    fun interruptSession(sessionId: String) {
        viewModelScope.launch(Dispatchers.IO) { relayClient?.interruptCodex(sessionId) }
    }

    fun disconnect() {
        userWantsConnection = false
        cancelCatalogRefresh()
        setActiveSession(null)
        channelConnectJob?.cancel()
        channelConnectJob = null
        clientSeq++  // silence any in-flight callbacks from the old client
        relayClient?.disconnect(); relayClient = null
        connectionStatus = "disconnected"
        connectionDetail = null
    }

    override fun onCleared() {
        // Flush synchronously: the debounced job dies with the scope.
        persistJob?.cancel()
        catalogRefreshTimeoutJob?.cancel()
        channelConnectJob?.cancel()
        sessionStore?.save(sessionSnapshot())
        relayClient?.disconnect()
        voiceHelper?.destroy()
    }
    fun clearError() { error = null }
    fun removePeer(fp: String) {
        val wasActive = activePeerFingerprint == fp
        val shouldReconnect = userWantsConnection
        if (wasActive) {
            flushCurrentSessions()
            disconnect()
        }
        store?.removePeer(fp)
        peers = store?.loadPeers() ?: emptyMap()
        if (!wasActive) return

        val replacement = peers.values.maxByOrNull { it.pairedAt }?.fingerprint
        activePeerFingerprint = replacement
        store?.setActivePeerFingerprint(replacement)
        clearHostView()
        if (replacement != null) loadPeerCache(replacement)
        if (replacement != null && shouldReconnect) {
            userWantsConnection = true
            connectChannel()
        }
    }

    /** Deep-link / scan entry: optionally switch relay, then pair right away. */
    fun applyPairLink(code: String, relay: String?) {
        overlay = Overlay.Pair
        if (store == null || identity == null) {
            pendingPairLink = Pair(code, relay)
            return
        }
        relay?.takeIf { it.isNotBlank() }?.let { updateRelayUrl(it) }
        pair(code)
    }

    fun setupVoice(activity: ComponentActivity): VoiceInputHelper {
        val existing = voiceHelper
        if (existing != null && existing.host === activity) return existing
        existing?.destroy()  // stale activity after recreation — rebind
        return VoiceInputHelper(activity).also { voiceHelper = it }
    }
}

// ===== Compose App =====
//
// Control-center language: dot-grid canvas, one big rounded sheet as the
// working surface, pill-shaped controls, a single accent color, and status
// colors reserved for status. Three-tier vertical IA: can I control (status
// pill) -> control what (chips) -> what is happening (session feed).

@Composable
fun ArgusApp(
    activity: ComponentActivity,
    pairLink: MutableState<Uri?> = mutableStateOf(null),
    onGrantPhoneAgentAccess: () -> Unit = {},
    providedViewModel: ArgusViewModel? = null,
) {
    val vm: ArgusViewModel = providedViewModel ?: viewModel()  // survives config changes
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(Unit) { vm.init(activity) }
    LaunchedEffect(vm.error) {
        val message = vm.error ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(message, withDismissAction = true)
        if (vm.error == message) vm.clearError()
    }
    DisposableEffect(activity.lifecycle, vm) {
        val observer = LifecycleEventObserver { _, event ->
            if (event == Lifecycle.Event.ON_RESUME) vm.refreshPhoneAgentStorageAccess()
        }
        activity.lifecycle.addObserver(observer)
        onDispose { activity.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(activity, vm.keepScreenOn) {
        if (vm.keepScreenOn) {
            activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
    LaunchedEffect(pairLink.value) {
        val uri = pairLink.value ?: return@LaunchedEffect
        if (uri.scheme == "argus" && uri.host == "pair") {
            uri.getQueryParameter("code")?.let { vm.applyPairLink(it, uri.getQueryParameter("relay")) }
        }
        pairLink.value = null
    }
    LaunchedEffect(
        vm.peers, vm.activePeerFingerprint, vm.connectionStatus,
        vm.userWantsConnection, vm.autoReconnect,
    ) {
        // Reconnect only while the user wants a connection, with a small
        // backoff so an unreachable relay doesn't produce a tight retry loop.
        if (vm.userWantsConnection && vm.autoReconnect &&
            vm.activePeerFingerprint != null && vm.connectionStatus == "disconnected"
        ) {
            delay(1500)
            if (vm.userWantsConnection && vm.autoReconnect && vm.connectionStatus == "disconnected") {
                vm.connectChannel(keepDisconnectNotice = true)
            }
        }
    }

    ArgusAppTheme {
        val c = ArgusTheme.colors
        Box(Modifier.fillMaxSize().background(c.canvas)) {
            DotGrid(Modifier.fillMaxSize())
            Column(Modifier.fillMaxSize().statusBarsPadding()) {
                TopBar(vm)
                Surface(
                    color = c.sheet,
                    shape = RoundedCornerShape(topStart = ArgusRadius.SHEET.dp, topEnd = ArgusRadius.SHEET.dp),
                    modifier = Modifier.fillMaxWidth().weight(1f)
                ) {
                    Box(Modifier.navigationBarsPadding()) {
                        if (vm.activeSessionId != null) SessionDetailScreen(vm)
                        else MainSheet(vm, onGrantPhoneAgentAccess)
                        // The status menu stays visible above a detail view.
                        // Render an overlay here too, so opening Settings never
                        // requires closing the conversation the user was reading.
                        if (vm.activeSessionId != null && vm.overlay != null) OverlayPane(vm, onGrantPhoneAgentAccess)
                    }
                }
            }
            if (vm.showScanner) {
                BackHandler { vm.showScanner = false }
                Box(Modifier.fillMaxSize().background(c.sheet).statusBarsPadding()) {
                    ScanScreen(onResult = { raw ->
                        val parsed = parsePairLink(raw)
                        if (parsed != null) {
                            vm.showScanner = false
                            parsed.second?.let(vm::updateRelayUrl)
                            vm.pair(parsed.first)
                            true
                        } else false
                    }, onClose = { vm.showScanner = false })
                }
            }
            SnackbarHost(
                hostState = snackbarHostState,
                modifier = Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(16.dp),
            )
        }
    }
}

/** Regular dot grid: "this is a desk you can put things on". */
@Composable
private fun DotGrid(modifier: Modifier = Modifier) {
    val dotColor = ArgusTheme.colors.canvasDot
    Canvas(modifier) {
        val step = 28.dp.toPx()
        val r = 2.dp.toPx()
        var y = step / 2
        while (y < size.height) {
            var x = step / 2
            while (x < size.width) {
                drawCircle(dotColor, r, Offset(x, y))
                x += step
            }
            y += step
        }
    }
}

private val BASE_AGENTS = listOf("qoder", "codex")

private enum class ConnectionUiState { Connected, Connecting, Disconnected, Error }

private fun connectionUiState(vm: ArgusViewModel): ConnectionUiState = when {
    vm.connectionStatus == "channel-ready" -> ConnectionUiState.Connected
    vm.connectionStatus == "connecting" || vm.connectionStatus == "pairing" -> ConnectionUiState.Connecting
    vm.connectionStatus == "disconnected" && !vm.connectionDetail.isNullOrBlank() -> ConnectionUiState.Error
    vm.connectionStatus == "disconnected" && vm.userWantsConnection && vm.autoReconnect && vm.activePeer != null -> {
        ConnectionUiState.Connecting
    }
    else -> ConnectionUiState.Disconnected
}

private fun connectionStateLabel(vm: ArgusViewModel, state: ConnectionUiState): String = when (state) {
    ConnectionUiState.Connected -> "已连接"
    ConnectionUiState.Connecting -> if (vm.connectionStatus == "pairing") "正在配对" else "正在连接"
    ConnectionUiState.Error -> if (vm.userWantsConnection && vm.autoReconnect) {
        "连接出错，正在重试"
    } else {
        "连接出错"
    }
    ConnectionUiState.Disconnected -> "未连接"
}

private fun platformLabel(platform: String): String = when (platform.lowercase()) {
    "windows", "win32" -> "Windows"
    "macos", "darwin" -> "macOS"
    "linux" -> "Linux"
    else -> platform
}

// ===== Top bar: connection menu + agent filter + new session =====

@Composable
private fun TopBar(vm: ArgusViewModel) {
    val c = ArgusTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        ConnectionMenuButton(vm)
        Spacer(Modifier.weight(1f))
        AgentSwitcher(vm)
        Spacer(Modifier.width(8.dp))
        CircleButton(icon = { Icon(Icons.Default.Add, "新建会话", tint = c.textPrimary, modifier = Modifier.size(22.dp)) }) {
            vm.overlay = Overlay.NewSession
        }
    }
}

@Composable
private fun ConnectionStateIcon(
    vm: ArgusViewModel,
    modifier: Modifier = Modifier,
) {
    val c = ArgusTheme.colors
    val state = connectionUiState(vm)
    val rotation = if (state == ConnectionUiState.Connecting) {
        val transition = rememberInfiniteTransition(label = "connection-spin")
        val value by transition.animateFloat(
            initialValue = 0f,
            targetValue = 360f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 1_000, easing = LinearEasing),
                repeatMode = RepeatMode.Restart,
            ),
            label = "connection-spin-angle",
        )
        value
    } else {
        0f
    }
    val iconAlpha = if (state == ConnectionUiState.Error) {
        val transition = rememberInfiniteTransition(label = "connection-error-pulse")
        val value by transition.animateFloat(
            initialValue = 0.45f,
            targetValue = 1f,
            animationSpec = infiniteRepeatable(
                animation = tween(durationMillis = 800),
                repeatMode = RepeatMode.Reverse,
            ),
            label = "connection-error-alpha",
        )
        value
    } else {
        1f
    }
    val icon = when (state) {
        ConnectionUiState.Connected -> Icons.Default.Language
        ConnectionUiState.Connecting -> Icons.Default.Sync
        ConnectionUiState.Disconnected -> Icons.Default.LinkOff
        ConnectionUiState.Error -> Icons.Default.ErrorOutline
    }
    val tint = when (state) {
        ConnectionUiState.Connected -> c.textPrimary
        ConnectionUiState.Connecting -> c.statusAmberText
        ConnectionUiState.Disconnected -> c.textSecondary
        ConnectionUiState.Error -> c.danger
    }
    Icon(
        icon,
        null,
        tint = tint,
        modifier = modifier.rotate(rotation).alpha(iconAlpha),
    )
}

@Composable
private fun ConnectionMenuButton(vm: ArgusViewModel) {
    val c = ArgusTheme.colors
    var menu by remember { mutableStateOf(false) }
    val state = connectionUiState(vm)
    val stateLabel = connectionStateLabel(vm, state)
    val peer = vm.activePeer
    Box {
        Box(
            Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(c.sheet)
                .border(1.dp, c.textSecondary.copy(alpha = 0.25f), CircleShape)
                .clickable { menu = true }
                .semantics {
                    contentDescription = stateLabel
                    role = Role.Button
                }
                .padding(9.dp),
            contentAlignment = Alignment.Center,
        ) {
            ConnectionStateIcon(vm, Modifier.size(22.dp))
        }
        DropdownMenu(
            expanded = menu,
            onDismissRequest = { menu = false },
            modifier = Modifier.width(288.dp),
            containerColor = c.sheet,
            tonalElevation = 0.dp,
        ) {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    ConnectionStateIcon(vm, Modifier.size(22.dp))
                    Spacer(Modifier.width(10.dp))
                    Column(Modifier.weight(1f)) {
                        Text(
                            peer?.deviceName ?: "未选择主机",
                            fontSize = 14.sp,
                            fontWeight = FontWeight.SemiBold,
                            color = c.textPrimary,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                        )
                        Text(stateLabel, fontSize = 12.sp, color = c.textSecondary)
                    }
                }
                peer?.let {
                    Text(
                        "${platformLabel(it.platform)} · ${it.fingerprint}",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        color = c.textTertiary,
                        modifier = Modifier.padding(top = 8.dp),
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            vm.connectionDetail?.let { detail ->
                Text(
                    if (state == ConnectionUiState.Error) "连接事件：$detail" else "上次连接事件：$detail",
                    fontSize = 12.sp,
                    color = c.textSecondary,
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, bottom = 12.dp),
                )
            }
            HorizontalDivider(color = c.textSecondary.copy(alpha = 0.18f))
            if (peer != null) {
                when (state) {
                    ConnectionUiState.Connected -> DropdownMenuItem(
                        text = { Text("断开连接") },
                        leadingIcon = { Icon(Icons.Default.LinkOff, null) },
                        onClick = { menu = false; vm.disconnect() },
                    )
                    ConnectionUiState.Connecting -> DropdownMenuItem(
                        text = { Text("取消连接") },
                        leadingIcon = { Icon(Icons.Default.Close, null) },
                        onClick = { menu = false; vm.disconnect() },
                    )
                    ConnectionUiState.Disconnected, ConnectionUiState.Error -> DropdownMenuItem(
                        text = { Text(if (state == ConnectionUiState.Error) "立即重试" else "连接") },
                        leadingIcon = { Icon(Icons.Default.Refresh, null) },
                        onClick = { menu = false; vm.connectChannel() },
                    )
                }
            }
            HorizontalDivider(color = c.textSecondary.copy(alpha = 0.18f))
            DropdownMenuItem(
                text = { Text("设置") },
                leadingIcon = { Icon(Icons.Default.Settings, null) },
                onClick = { menu = false; vm.overlay = Overlay.Settings },
            )
            DropdownMenuItem(
                text = { Text("手机 Agent") },
                leadingIcon = { Icon(Icons.Default.SmartToy, null) },
                onClick = { menu = false; vm.overlay = Overlay.PhoneAgent },
            )
            DropdownMenuItem(
                text = { Text("切换主机") },
                leadingIcon = { Icon(Icons.Default.Computer, null) },
                onClick = { menu = false; vm.overlay = Overlay.Devices },
            )
            DropdownMenuItem(
                text = { Text("配对新主机") },
                leadingIcon = { Icon(Icons.Default.AddLink, null) },
                onClick = { menu = false; vm.overlay = Overlay.Pair },
            )
        }
    }
}

@Composable
private fun CircleButton(icon: @Composable () -> Unit, onClick: () -> Unit) {
    val c = ArgusTheme.colors
    Box(
        Modifier
            .size(40.dp)
            .clip(CircleShape)
            .background(c.sheet)
            .border(1.dp, c.textSecondary.copy(alpha = 0.25f), CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) { icon() }
}

/** Agent switcher for the top bar: icon-only pills (an icon is enough to
 *  recognise the target), chevron toggles the names on. Sits between the
 *  status capsule and the new-session action. */
@Composable
private fun AgentSwitcher(vm: ArgusViewModel) {
    val c = ArgusTheme.colors
    // derivedStateOf: the input changes on every event, the output almost never
    // does, so this keeps the whole top bar out of the per-event recomposition.
    val agents by remember {
        derivedStateOf { (BASE_AGENTS + vm.sessions.values.map { it.agent }).distinct() }
    }
    Row(
        Modifier
            .clip(CircleShape)
            .background(c.sheet)
            .border(1.dp, c.textSecondary.copy(alpha = 0.25f), CircleShape)
            .padding(3.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        AgentPill(null, vm.agentFilter == null, vm.showAgentLabels) { vm.agentFilter = null }
        agents.forEach { agent ->
            AgentPill(agent, vm.agentFilter == agent, vm.showAgentLabels) { vm.agentFilter = agent }
        }
        Box(
            Modifier
                .size(24.dp)
                .clip(CircleShape)
                .clickable { vm.updateShowAgentLabels(!vm.showAgentLabels) },
            contentAlignment = Alignment.Center
        ) {
            Icon(
                if (vm.showAgentLabels) Icons.Default.ChevronLeft else Icons.Default.ChevronRight,
                if (vm.showAgentLabels) "隐藏名称" else "显示名称",
                tint = c.textSecondary, modifier = Modifier.size(15.dp)
            )
        }
    }
}

/** `null` agent is the "all" entry. */
@Composable
private fun AgentPill(agent: String?, selected: Boolean, showLabel: Boolean, onClick: () -> Unit) {
    val c = ArgusTheme.colors
    // Brand marks live in AgentIcons — Material Icons ships no third-party
    // logos, and Bolt/Terminal were placeholders unrelated to either product.
    val icon = when (agent) {
        null -> AgentIcons.All
        "qoder" -> AgentIcons.Qoder
        "codex" -> AgentIcons.Codex
        else -> AgentIcons.Generic
    }
    Row(
        Modifier
            .clip(CircleShape)
            .background(if (selected) c.accentFill else Color.Transparent)
            .clickable(onClick = onClick)
            .padding(horizontal = if (showLabel) 9.dp else 6.dp, vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            icon, agent ?: "全部",
            tint = if (selected) c.textPrimary else c.textSecondary,
            modifier = Modifier.size(16.dp)
        )
        if (showLabel) {
            Spacer(Modifier.width(5.dp))
            Text(
                agent ?: "全部", fontSize = 12.sp,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                color = if (selected) c.textPrimary else c.textSecondary
            )
        }
    }
}

// ===== Main sheet: tab content =====

@Composable
private fun MainSheet(
    vm: ArgusViewModel,
    onGrantPhoneAgentAccess: () -> Unit,
) {
    Box(Modifier.fillMaxSize()) {
        SessionListScreen(vm)
        // Overlays rather than tabs: pairing and devices are occasional errands,
        // so they cover the list instead of permanently costing it a row.
        if (vm.overlay != null) OverlayPane(vm, onGrantPhoneAgentAccess)
    }
}

@Composable
private fun OverlayPane(
    vm: ArgusViewModel,
    onGrantPhoneAgentAccess: () -> Unit,
) {
    val which = vm.overlay ?: return
    val c = ArgusTheme.colors
    BackHandler { vm.overlay = null }
    Column(Modifier.fillMaxSize().background(c.sheet)) {
        OverlayHeader(
            title = when (which) {
                Overlay.Pair -> "配对新主机"
                Overlay.Devices -> "选择主机"
                Overlay.NewSession -> "新建会话"
                Overlay.Settings -> "设置"
                Overlay.PhoneAgent -> "手机 Agent"
            },
            onBack = { vm.overlay = null }
        )
        Box(Modifier.weight(1f)) {
            when (which) {
                Overlay.Pair -> PairScreen(vm)
                Overlay.Devices -> DeviceScreen(vm)
                Overlay.NewSession -> NewSessionScreen(vm)
                Overlay.Settings -> SettingsScreen(vm)
                Overlay.PhoneAgent -> PhoneAgentScreen(vm, onGrantPhoneAgentAccess)
            }
        }
    }
}

@Composable
private fun OverlayHeader(title: String, onBack: () -> Unit) {
    val c = ArgusTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        CircleButton(icon = {
            Icon(Icons.Default.ArrowBack, "返回", tint = c.textPrimary, modifier = Modifier.size(20.dp))
        }, onClick = onBack)
        Spacer(Modifier.width(12.dp))
        Text(title, fontSize = 17.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
    }
}

// ===== Sessions =====

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SessionListScreen(vm: ArgusViewModel) {
    if (vm.peers.isEmpty()) {
        EmptyHint("尚未配对任何主机", "打开左上角主机菜单，选择配对新主机")
        return
    }
    // Ask the Mac for its full inventory once the channel is up: mirrored events
    // only ever reveal sessions that happen to be busy right now.
    LaunchedEffect(vm.connectionStatus, vm.peers.size) {
        // Keyed on peers too: right after pairing the status is already
        // channel-ready and never transitions again, so a status-only key could
        // miss the one moment a refresh is needed.
        if (vm.connectionStatus == "channel-ready" && vm.catalog.isEmpty()) vm.refreshCatalog()
    }

    val live = vm.sessions.values
        .filter { vm.agentFilter == null || it.agent == vm.agentFilter }
        .sortedByDescending { it.lastActivity }
    val liveIds = live.map { it.sessionId }.toSet()
    val filtered = vm.catalog
        .filter { vm.agentFilter == null || it.agent == vm.agentFilter }
        .filterNot { it.id in liveIds }
    // Sub-agents (Codex collab) hang under their parent rather than cluttering
    // the top level; group them by the thread that spawned them.
    val subAgentsByParent = filtered
        .filter { it.parentThreadId != null }
        .groupBy { it.parentThreadId!! }
    val past = filtered.filter { it.parentThreadId == null }

    PullToRefreshBox(
        isRefreshing = vm.catalogLoading,
        onRefresh = vm::refreshHome,
        modifier = Modifier.fillMaxSize(),
    ) {
        when {
            vm.pendingNewSession && live.isEmpty() && past.isEmpty() -> {
                EmptyHint("正在新建会话…", "主机上的 agent 正在启动")
            }
            live.isEmpty() && past.isEmpty() -> {
                EmptyHint(
                    // Distinct headline while loading: "暂无会话" reads as a verdict, and
                    // the list takes a moment to arrive right after pairing.
                    if (vm.catalogLoading) "正在读取会话…"
                    else if (vm.agentFilter == null) "暂无会话"
                    else "暂无 ${vm.agentFilter} 会话",
                    if (vm.catalogLoading) "正在从主机拉取会话目录"
                    else "点右上角 + 新建一个,或在主机上开始干活",
                )
            }
            else -> LazyColumn(
                Modifier.fillMaxSize().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                vm.cloudUrl?.let { url ->
                    item { CloudSessionCard(url) { vm.cloudUrl = null } }
                }
                if (vm.pendingNewSession) {
                    // Immediate acknowledgement of the tap: the Mac takes a second or two
                    // to hand back the session id, and an unchanged list read as failure.
                    item { StartingSessionCard() }
                }
                if (live.isNotEmpty()) {
                    item { SectionLabel("进行中", live.size) }
                    items(live, key = { it.sessionId }) { s ->
                        SessionCard(s) { vm.openSession(s.sessionId) }
                    }
                }
                if (past.isNotEmpty()) {
                    item { SectionLabel("历史会话", past.size) }
                    items(past, key = { it.id }) { summary ->
                        // Seed a shell session first: the detail screen reads from
                        // vm.sessions, and a Mac-only session has no entry there yet, so
                        // tapping used to look like a dead card.
                        Column {
                            CatalogCard(summary) { vm.openCatalogSession(summary) }
                            subAgentsByParent[summary.id]?.let { kids ->
                                SubAgentGroup(kids) { vm.openCatalogSession(it) }
                            }
                        }
                    }
                }
                // Sub-agents whose parent is not shown (live, or filtered out) still
                // need a home rather than vanishing.
                val shownParents = past.map { it.id }.toSet()
                val orphans = subAgentsByParent.filterKeys { it !in shownParents }
                if (orphans.isNotEmpty()) {
                    item { SectionLabel("子 agent", orphans.values.sumOf { it.size }) }
                    orphans.forEach { (_, kids) ->
                        item { SubAgentGroup(kids, alwaysExpanded = true) { vm.openCatalogSession(it) } }
                    }
                }
                item { Spacer(Modifier.height(8.dp)) }
            }
        }
    }
}

/**
 * Agents a session spawned, as a folded row that expands to the list. Codex
 * renders these inline under the parent; the small screen wants the conclusion
 * (how many, how many done) before the detail.
 */
@Composable
private fun SubAgentGroup(
    kids: List<SessionSummary>,
    alwaysExpanded: Boolean = false,
    onOpen: (SessionSummary) -> Unit,
) {
    val c = ArgusTheme.colors
    var expanded by remember { mutableStateOf(alwaysExpanded) }
    Column(
        Modifier.fillMaxWidth().padding(start = 16.dp, top = 4.dp)
            .clip(RoundedCornerShape(ArgusRadius.ROW.dp)).background(c.sheet)
    ) {
        Row(
            Modifier.fillMaxWidth().clickable { expanded = !expanded }.padding(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(Icons.Default.AccountTree, null, tint = c.textSecondary, modifier = Modifier.size(14.dp))
            Spacer(Modifier.width(8.dp))
            Text("派生 ${kids.size} 个 agent", fontSize = 12.sp, color = c.textSecondary)
            Spacer(Modifier.weight(1f))
            Icon(
                if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                null, tint = c.textTertiary, modifier = Modifier.size(16.dp),
            )
        }
        if (expanded) {
            kids.forEach { kid ->
                Row(
                    Modifier.fillMaxWidth().clickable { onOpen(kid) }
                        .padding(horizontal = 12.dp, vertical = 8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    // No status is better than a fictional one: thread/list
                    // reports these children as notLoaded until the user opens one.
                    Text(kid.agentNickname ?: kid.id.take(8), fontSize = 13.sp,
                        color = c.textPrimary, fontWeight = FontWeight.Medium)
                    Spacer(Modifier.width(8.dp))
                    Text(kid.title, fontSize = 12.sp, color = c.textSecondary,
                        maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

/** Placeholder card shown while the Mac spins up a newly requested session. */
@Composable
private fun StartingSessionCard() {
    val c = ArgusTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
            .background(c.card)
            .padding(14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = c.accent)
        Spacer(Modifier.width(10.dp))
        Text("正在新建会话…", fontSize = 14.sp, color = c.textPrimary)
    }
}

@Composable
private fun SectionLabel(text: String, count: Int) {
    val c = ArgusTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(text, fontSize = 12.sp, fontWeight = FontWeight.SemiBold, color = c.textSecondary)
        Spacer(Modifier.width(6.dp))
        Text("$count", fontSize = 12.sp, color = c.textTertiary)
    }
}

/** An idle session from the Mac's inventory: title, origin and age only. */
@Composable
private fun CatalogCard(s: SessionSummary, onClick: () -> Unit) {
    val c = ArgusTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
            .background(c.card)
            .clickable(onClick = onClick)
            .padding(14.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                if (s.kind == "quest") "Quest" else "Chat",
                fontSize = 11.sp, fontWeight = FontWeight.Medium, color = c.textSecondary,
                modifier = Modifier
                    .clip(CircleShape)
                    .background(c.sheet)
                    .padding(horizontal = 7.dp, vertical = 2.dp)
            )
            Spacer(Modifier.width(6.dp))
            Text(s.agent, fontSize = 11.sp, color = c.textTertiary)
            Spacer(Modifier.weight(1f))
            Text(relativeTime(s.updatedAt), fontSize = 11.sp, color = c.textTertiary)
        }
        Spacer(Modifier.height(7.dp))
        Text(
            s.title.ifEmpty { s.id },
            fontSize = 14.sp, color = c.textPrimary,
            maxLines = 2, overflow = TextOverflow.Ellipsis
        )
        s.cwd?.let { dir ->
            Spacer(Modifier.height(4.dp))
            Text(
                dir.substringAfterLast('/'),
                fontSize = 11.sp, color = c.textTertiary, maxLines = 1, overflow = TextOverflow.Ellipsis
            )
        }
    }
}

private fun relativeTime(ms: Long): String {
    if (ms <= 0) return ""
    val diff = System.currentTimeMillis() - ms
    return when {
        diff < 60_000 -> "刚刚"
        diff < 3_600_000 -> "${diff / 60_000} 分钟前"
        diff < 86_400_000 -> "${diff / 3_600_000} 小时前"
        else -> "${diff / 86_400_000} 天前"
    }
}

/** Route C result: a cloud session URL to open in the browser. */
@Composable
private fun CloudSessionCard(url: String, onDismiss: () -> Unit) {
    val c = ArgusTheme.colors
    val ctx = LocalContext.current
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
            .background(c.accentFill)
            .border(1.dp, c.accentStroke, RoundedCornerShape(ArgusRadius.CARD.dp))
            .clickable {
                runCatching {
                    ctx.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                }
            }
            .padding(14.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Cloud, null, tint = c.accent, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(8.dp))
            Text("云会话已就绪", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
            Spacer(Modifier.weight(1f))
            Text("关闭", fontSize = 12.sp, color = c.textSecondary, modifier = Modifier.clickable(onClick = onDismiss))
        }
        Spacer(Modifier.height(6.dp))
        Text("点此在浏览器中打开", fontSize = 12.sp, color = c.textSecondary)
    }
}

/**
 * New session. Two routes: a local session on the Mac (its transcript mirrors
 * back here), or a cloud session that answers with a URL.
 */
@Composable
private fun NewSessionScreen(vm: ArgusViewModel) {
    val c = ArgusTheme.colors
    var prompt by remember { mutableStateOf("") }
    // Default to whatever the top-bar filter is on, else Qoder: the filter is
    // the closest thing to "the agent I am working with right now".
    var agent by remember { mutableStateOf(vm.agentFilter ?: "qoder") }
    // Default to the directory of the most recent session: new work almost
    // always continues in the project you were last in.
    val recentDirs = remember(vm.catalog) {
        vm.catalog.mapNotNull { it.cwd }.distinct().take(6)
    }
    var cwd by remember(recentDirs) { mutableStateOf(recentDirs.firstOrNull()) }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp).imePadding()) {
        Text("使用哪个 agent", fontSize = 12.sp, color = c.textSecondary)
        Spacer(Modifier.height(8.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            BASE_AGENTS.forEach { candidate ->
                val selected = agent == candidate
                Row(
                    Modifier
                        .clip(CircleShape)
                        .background(if (selected) c.accentFill else c.card)
                        .border(1.dp, if (selected) c.accentStroke else c.card, CircleShape)
                        .clickable { agent = candidate }
                        .padding(horizontal = 14.dp, vertical = 9.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        if (candidate == "codex") AgentIcons.Codex else AgentIcons.Qoder,
                        null,
                        tint = if (selected) c.textPrimary else c.textSecondary,
                        modifier = Modifier.size(15.dp),
                    )
                    Spacer(Modifier.width(7.dp))
                    Text(
                        candidate, fontSize = 13.sp,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Medium,
                        color = if (selected) c.textPrimary else c.textSecondary,
                    )
                }
            }
        }
        Spacer(Modifier.height(18.dp))
        Text("第一句话", fontSize = 12.sp, color = c.textSecondary)
        Spacer(Modifier.height(8.dp))
        BasicPillField(
            value = prompt,
            onValueChange = { prompt = it },
            placeholder = "想让 agent 做什么",
            modifier = Modifier.fillMaxWidth().heightIn(min = 96.dp),
        )
        if (recentDirs.isNotEmpty()) {
            Spacer(Modifier.height(18.dp))
            Text("项目目录", fontSize = 12.sp, color = c.textSecondary)
            Spacer(Modifier.height(8.dp))
            recentDirs.forEach { dir ->
                val selected = dir == cwd
                Row(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
                        .background(if (selected) c.accentFill else c.card)
                        .border(1.dp, if (selected) c.accentStroke else c.card, RoundedCornerShape(ArgusRadius.CARD.dp))
                        .clickable { cwd = dir }
                        .padding(horizontal = 12.dp, vertical = 10.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        dir.substringAfterLast('/'),
                        fontSize = 13.sp, color = c.textPrimary,
                        maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f)
                    )
                    if (selected) Icon(Icons.Default.Check, null, tint = c.accent, modifier = Modifier.size(16.dp))
                }
                Spacer(Modifier.height(6.dp))
            }
        }
        Spacer(Modifier.weight(1f))
        val ready = prompt.isNotBlank()
        Row(Modifier.fillMaxWidth().padding(vertical = 14.dp)) {
            Text(
                if (agent == "codex") "新建 Codex 会话" else "新建 Qoder 会话",
                fontSize = 14.sp, fontWeight = FontWeight.SemiBold,
                color = if (ready) c.textPrimary else c.textTertiary,
                modifier = Modifier
                    .weight(1f)
                    .clip(CircleShape)
                    .background(if (ready) c.accentFill else c.card)
                    .border(1.dp, if (ready) c.accentStroke else c.card, CircleShape)
                    .clickable(enabled = ready) { vm.startNewSession(prompt.trim(), agent, cwd) }
                    .padding(vertical = 12.dp),
                textAlign = TextAlign.Center
            )
            // Cloud sessions are a Qoder feature (`qodercli --remote`); offering
            // the button for Codex would only produce an error on tap.
            if (agent == "qoder") {
                Spacer(Modifier.width(10.dp))
                Text(
                    "云会话",
                    fontSize = 14.sp, fontWeight = FontWeight.Medium,
                    color = if (ready) c.textSecondary else c.textTertiary,
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(c.card)
                        .clickable(enabled = ready) { vm.createCloudSession(prompt.trim(), cwd) }
                        .padding(horizontal = 18.dp, vertical = 12.dp),
                    textAlign = TextAlign.Center
                )
            }
        }
    }
}

@Composable
private fun EmptyHint(title: String, subtitle: String) {
    val c = ArgusTheme.colors
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(title, color = c.textSecondary, fontSize = 14.sp)
            Text(subtitle, color = c.textTertiary, fontSize = 12.sp, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

/** First user prompt, trimmed to one line — sessions are otherwise
 *  indistinguishable when several run under the same agent. */
private fun sessionTitle(s: SessionState): String? {
    val raw = s.events.firstOrNull { it["type"] == "user-text" }?.get("text") as? String ?: return null
    val oneLine = raw.trim().replace(Regex("\\s+"), " ").take(60)
    return oneLine.ifEmpty { null }
}

/** A blue dot is reserved for work that ended normally and still needs a review. */
private fun isAwaitingAcceptance(s: SessionState): Boolean {
    val reason = s.events.lastOrNull { it["type"] == "turn-done" }
        ?.get("reason") as? String ?: return false
    return reason.lowercase() in setOf("completed", "complete", "success", "succeeded", "finished", "done", "stop")
}

@Composable
private fun SessionCard(s: SessionState, onClick: () -> Unit) {
    val c = ArgusTheme.colors
    // Status dots belong only to work that needs attention: green while it is
    // active, blue once it is ready for the user to inspect. Idle/error shells
    // deliberately carry no dot rather than adding decorative gray or red noise.
    val statusDot = when {
        s.status == "running" || s.status == "waiting_permission" -> c.statusGreen
        s.status == "done" && isAwaitingAcceptance(s) -> c.accent
        else -> null
    }
    val lastEvent = s.events.lastOrNull()
    val preview = lastEvent?.get("text") as? String
        ?: lastEvent?.get("summary") as? String
        ?: lastEvent?.get("reason") as? String ?: ""
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
            .background(c.card)
            .clickable(onClick = onClick)
            .padding(16.dp)
    ) {
        val title = sessionTitle(s)
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(title ?: s.agent,
                    fontFamily = if (title == null) FontFamily.Monospace else null,
                    fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (title != null) {
                    Text(s.agent, fontFamily = FontFamily.Monospace, fontSize = 11.sp,
                        color = c.textTertiary, modifier = Modifier.padding(top = 2.dp))
                }
            }
            if (s.permissions.isNotEmpty()) {
                Spacer(Modifier.width(8.dp))
                AmberBadge("${s.permissions.size} 待审批")
            }
            statusDot?.let { color ->
                Spacer(Modifier.width(8.dp))
                Box(Modifier.size(8.dp).background(color, CircleShape))
            }
        }
        if (preview.isNotEmpty()) {
            Text(preview, fontSize = 13.sp, color = c.textSecondary,
                maxLines = 1, overflow = TextOverflow.Ellipsis,
                modifier = Modifier.padding(top = 6.dp))
        }
    }
}

@Composable
private fun AmberBadge(text: String) {
    val c = ArgusTheme.colors
    Text(
        text, fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = c.statusAmberText,
        modifier = Modifier
            .clip(CircleShape)
            .background(c.statusAmberFill)
            .padding(horizontal = 8.dp, vertical = 2.dp)
    )
}

// ===== Pair =====

@Composable
private fun PairScreen(vm: ArgusViewModel) {
    val c = ArgusTheme.colors
    var code by remember { mutableStateOf("") }
    val busy = vm.connectionStatus == "connecting" || vm.connectionStatus == "pairing"
    Column(
        Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Text("配对新主机", fontSize = 20.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
        Text("扫主机上的二维码,或手动输入配对码", fontSize = 13.sp, color = c.textSecondary,
            modifier = Modifier.padding(top = 4.dp))
        OutlinedTextField(
            value = code, onValueChange = { code = it.uppercase() },
            placeholder = { Text("NNNN-XXXXXX", color = c.textTertiary) },
            modifier = Modifier.fillMaxWidth().padding(vertical = 24.dp),
            textStyle = LocalTextStyle.current.copy(
                fontSize = 24.sp, fontFamily = FontFamily.Monospace,
                textAlign = androidx.compose.ui.text.style.TextAlign.Center, color = c.textPrimary),
            shape = RoundedCornerShape(ArgusRadius.CARD.dp),
            singleLine = true, enabled = !busy
        )
        vm.error?.let {
            Text(it, color = c.danger, fontSize = 13.sp, modifier = Modifier.padding(bottom = 8.dp))
        }
        Button(
            onClick = { vm.pair(code.trim()) },
            enabled = !busy && code.length >= 10,  // dash-less 10-char codes are valid too
            modifier = Modifier.fillMaxWidth().height(48.dp),
            shape = CircleShape,
            colors = ButtonDefaults.buttonColors(containerColor = c.accent, contentColor = c.onAccent)
        ) { Text(if (busy) "配对中..." else "配对", fontWeight = FontWeight.SemiBold) }
        OutlinedButton(
            onClick = { vm.showScanner = true }, enabled = !busy,
            modifier = Modifier.fillMaxWidth().padding(top = 10.dp).height(48.dp),
            shape = CircleShape
        ) { Text("扫码配对", color = c.textPrimary) }
    }
}

// ===== Session detail: header + folded activity feed + input =====

/** Feed model: text stays visible, tool chatter folds into counted groups. */
private sealed class FeedBlock {
    /** Present for persisted history; live events use the content fallback. */
    abstract val sourceId: String?

    data class Message(val text: String, override val sourceId: String? = null) : FeedBlock()
    data class UserMessage(
        val text: String, val ack: String, val note: String,
        override val sourceId: String? = null,
    ) : FeedBlock()
    data class Activities(
        val items: List<Map<String, Any?>>, override val sourceId: String? = null,
    ) : FeedBlock()
    data class TurnDone(val reason: String, override val sourceId: String? = null) : FeedBlock()
    data class Failure(val message: String, override val sourceId: String? = null) : FeedBlock()

    /**
     * Content-derived identity for LazyColumn keys. Index alone is not identity:
     * prepending a history chunk shifts every index, which used to move a
     * card's remembered expand state onto its neighbour.
     */
    fun identity(): String = when (this) {
        is Message -> "m:${text.take(24)}"
        is UserMessage -> "u:${text.take(24)}"
        is Activities -> "a:${items.size}:${items.firstOrNull()?.get("name") ?: ""}"
        is TurnDone -> "d:$reason"
        is Failure -> "f:${message.take(24)}"
    }
}

private fun buildFeed(events: List<Map<String, Any?>>): List<FeedBlock> {
    val out = mutableListOf<FeedBlock>()
    var run = mutableListOf<Map<String, Any?>>()
    fun flush() {
        if (run.isNotEmpty()) {
            out.add(FeedBlock.Activities(run.toList(), run.first()["eventId"] as? String))
            run = mutableListOf()
        }
    }
    for (ev in events) {
        val eventId = ev["eventId"] as? String
        when (ev["type"] as? String) {
            "text" -> {
                flush()
                val text = ev["text"] as? String ?: ""
                // Merge with the previous message rather than starting a card:
                // streamed replies arrive in fragments, and markdown only parses
                // as a whole — split across cards it rendered as literal
                // asterisks and half-formed lists.
                val prev = out.lastOrNull()
                if (prev is FeedBlock.Message) {
                    out[out.size - 1] = FeedBlock.Message(prev.text + text, prev.sourceId ?: eventId)
                } else {
                    out.add(FeedBlock.Message(text, eventId))
                }
            }
            "user-text" -> {
                flush()
                out.add(FeedBlock.UserMessage(
                    ev["text"] as? String ?: "",
                    ev["ack"] as? String ?: "",   // empty => came from the Mac transcript
                    ev["note"] as? String ?: "",
                    eventId,
                ))
            }
            "thinking", "tool-call", "tool-result" -> run.add(ev)
            "turn-done" -> { flush(); out.add(FeedBlock.TurnDone(ev["reason"] as? String ?: "", eventId)) }
            "error" -> { flush(); out.add(FeedBlock.Failure(ev["message"] as? String ?: "", eventId)) }
        }
    }
    flush()
    return out
}

@Composable
private fun SessionDetailScreen(vm: ArgusViewModel) {
    val c = ArgusTheme.colors
    val session = vm.activeSessionId?.let { vm.sessions[it] } ?: run {
        LaunchedEffect(Unit) { vm.setActiveSession(null) }  // no writes during composition
        return
    }
    BackHandler { vm.setActiveSession(null) }
    var input by remember { mutableStateOf("") }
    val ctx = LocalContext.current
    val voiceHelper = remember { vm.setupVoice(ctx as ComponentActivity) }
    val listState = rememberLazyListState()
    // Keyed on the active event list; earlier history chunks are prepended and
    // rebuilt here, while their stable ids preserve visible card state.
    val feed = remember(session.events) { buildFeed(session.events) }
    // Keyed on lastActivity, not events.size: a text delta can merge into an
    // existing block, leaving the block count unchanged.
    LaunchedEffect(session.lastActivity, session.permissions.size) {
        val total = feed.size + session.permissions.size
        if (total == 0) return@LaunchedEffect
        // Only follow along when the user is already near the bottom; scrolling
        // unconditionally yanked them out of the history they were reading.
        val last = listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
        val atBottom = last < 0 || last >= total - 3
        if (atBottom) listState.animateScrollToItem(total - 1)
    }
    Column(Modifier.fillMaxSize()) {
        // Header: back circle + centered agent + badge + running spinner
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            CircleButton(icon = { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = c.textPrimary, modifier = Modifier.size(18.dp)) }) {
                vm.setActiveSession(null)
            }
            Spacer(Modifier.width(10.dp))
            val headerTitle = sessionTitle(session)
            Column(Modifier.weight(1f)) {
                Text(headerTitle ?: session.agent,
                    fontFamily = if (headerTitle == null) FontFamily.Monospace else null,
                    fontSize = 15.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (headerTitle != null) {
                    Text(session.agent, fontFamily = FontFamily.Monospace, fontSize = 11.sp,
                        color = c.textTertiary)
                }
            }
            if (session.permissions.isNotEmpty()) {
                AmberBadge("待审批")
                Spacer(Modifier.width(8.dp))
            }
            if (session.historyLoading) {
                HistoryLoadIndicator(session.historyLoaded, session.historyTotal)
                Spacer(Modifier.width(8.dp))
            }
            if (session.status == "running") {
                // Interrupt is Codex-only: app-server owns the turn, so it can
                // be stopped. Qoder input is keystroke injection, which cannot
                // reach a turn already in flight.
                if (session.agent == "codex") {
                    CircleButton(icon = {
                        Icon(Icons.Default.Stop, "打断", tint = c.statusAmberText,
                            modifier = Modifier.size(18.dp))
                    }) { vm.interruptSession(session.sessionId) }
                    Spacer(Modifier.width(8.dp))
                }
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = c.textSecondary)
            }
        }
        // Feed with a top scrim so rows fade under the header instead of
        // hard-clipping (the reference deck's known flaw).
        Box(Modifier.weight(1f)) {
            LazyColumn(
                state = listState,
                modifier = Modifier.fillMaxSize().padding(horizontal = 16.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                itemsIndexed(
                    feed,
                    // Older history is prepended in chunks. Position is not
                    // identity: use Host-assigned ids where possible so an
                    // expanded activity group stays attached to its own turn.
                    key = { i, block -> block.sourceId ?: "$i-${block.identity()}" },
                    contentType = { _, block -> block::class },
                ) { i, block ->
                    FeedBlockView(block, running = session.status == "running" && i == feed.lastIndex)
                }
                items(session.permissions) { perm ->
                    PermissionCard(perm) { vm.respondPermission(session.sessionId, perm.requestId, it) }
                }
                item { Spacer(Modifier.height(4.dp)) }
            }
            Box(
                Modifier.fillMaxWidth().height(12.dp).align(Alignment.TopCenter)
                    .background(Brush.verticalGradient(listOf(c.sheet, c.sheet.copy(alpha = 0f))))
            )
        }
        InputBar(
            agent = session.agent,
            input = input,
            onInput = { input = it },
            voiceHelper = voiceHelper,
            onSend = {
                if (input.isNotBlank()) { vm.sendInput(session.sessionId, input.trim()); input = "" }
            }
        )
    }
}

/** Persistent, compact progress beside the title: content stays readable. */
@Composable
private fun HistoryLoadIndicator(loaded: Int, total: Int) {
    val c = ArgusTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(
            modifier = Modifier.size(14.dp), strokeWidth = 1.8.dp, color = c.textSecondary,
        )
        Spacer(Modifier.width(5.dp))
        Text(
            when {
                total > 0 -> "历史 $loaded/$total"
                loaded > 0 -> "已加载 $loaded · 读取早期记录"
                else -> "历史加载中"
            },
            fontSize = 12.sp, color = c.textSecondary, maxLines = 1,
        )
    }
}

@Composable
private fun FeedBlockView(block: FeedBlock, running: Boolean) {
    val c = ArgusTheme.colors
    when (block) {
        is FeedBlock.Message -> Box(
            Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
                .background(c.card)
                .padding(12.dp)
        ) {
            // Agent replies are markdown-heavy (code fences, lists, bold) —
            // plain Text rendered them as literal asterisks and backticks.
            Markdown(
                content = block.text,
                colors = markdownColor(
                    text = c.textPrimary,
                    codeText = c.textPrimary,
                    codeBackground = c.sheet,
                    inlineCodeText = c.textPrimary,
                    inlineCodeBackground = c.sheet,
                    linkText = c.accent,
                ),
                typography = run {
                    // Specify every slot: the m3 defaults map h1..h6 to
                    // display/headline styles (h1 = 57sp!), which is what made
                    // random giant text show up inside chat bubbles.
                    val body = LocalTextStyle.current.copy(fontSize = 14.sp, lineHeight = 20.sp, color = c.textPrimary)
                    markdownTypography(
                        h1 = body.copy(fontSize = 19.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold),
                        h2 = body.copy(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.Bold),
                        h3 = body.copy(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
                        h4 = body.copy(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold),
                        h5 = body.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold),
                        h6 = body.copy(fontSize = 14.sp, fontWeight = FontWeight.SemiBold, color = c.textSecondary),
                        text = body,
                        paragraph = body,
                        ordered = body,
                        bullet = body,
                        list = body,
                        quote = body.copy(color = c.textSecondary),
                        code = body.copy(fontSize = 12.sp, lineHeight = 17.sp, fontFamily = FontFamily.Monospace),
                        inlineCode = body.copy(fontSize = 13.sp, fontFamily = FontFamily.Monospace),
                    )
                }
            )
        }
        is FeedBlock.UserMessage -> Column(
            Modifier.fillMaxWidth(),
            horizontalAlignment = Alignment.End
        ) {
            Text(
                block.text, fontSize = 14.sp, color = c.textPrimary, lineHeight = 20.sp,
                modifier = Modifier
                    .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
                    .background(c.accentFill)
                    .padding(12.dp)
            )
            if (block.ack.isNotEmpty()) {
                Text(
                    if (block.ack == "pending") "发送中…" else block.note.ifEmpty { "已送达主机" },
                    fontSize = 11.sp, color = c.textTertiary,
                    modifier = Modifier.padding(top = 3.dp, end = 4.dp)
                )
            }
        }
        is FeedBlock.Activities -> ActivityGroupCard(block.items, running)
        is FeedBlock.TurnDone -> Text(
            "轮次结束 · ${block.reason}", fontSize = 11.sp, color = c.textTertiary,
            modifier = Modifier.fillMaxWidth().padding(vertical = 2.dp),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center
        )
        is FeedBlock.Failure -> Text(
            block.message, fontSize = 13.sp, color = c.danger,
            modifier = Modifier.padding(4.dp)
        )
    }
}

/** N tool calls collapse into one counted card; details on demand. */
@Composable
private fun ActivityGroupCard(items: List<Map<String, Any?>>, running: Boolean) {
    val c = ArgusTheme.colors
    var expanded by remember { mutableStateOf(false) }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
            .background(c.card)
            .clickable { expanded = !expanded }
            .padding(horizontal = 12.dp, vertical = 10.dp)
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("{…}", fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = c.textSecondary)
            Spacer(Modifier.width(8.dp))
            Text("${items.size} activities", fontSize = 13.sp, fontWeight = FontWeight.Medium, color = c.textPrimary)
            Spacer(Modifier.weight(1f))
            if (running && !expanded) {
                CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = c.textSecondary)
                Spacer(Modifier.width(8.dp))
            }
            Icon(
                if (expanded) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                null, tint = c.textSecondary, modifier = Modifier.size(18.dp)
            )
        }
        if (expanded) {
            Spacer(Modifier.height(6.dp))
            items.forEach { ev -> ActivityRow(ev) }
        }
    }
}

@Composable
private fun ActivityRow(ev: Map<String, Any?>) {
    val c = ArgusTheme.colors
    when (ev["type"] as? String) {
        "thinking" -> Row(
            Modifier.fillMaxWidth().padding(vertical = 5.dp),
            verticalAlignment = Alignment.Top
        ) {
            Text("◦", fontSize = 11.sp, color = c.textTertiary)
            Spacer(Modifier.width(8.dp))
            Text("深度思考", fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = c.textSecondary)
            Spacer(Modifier.width(8.dp))
            Text(ev["text"] as? String ?: "", fontSize = 12.sp, color = c.textTertiary,
                maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        }
        else -> {
            val isCall = ev["type"] == "tool-call"
            val name = ev["name"] as? String ?: "tool"
            val summary = ev["summary"] as? String ?: ""
            Row(
                Modifier.fillMaxWidth().padding(vertical = 5.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(if (isCall) "▸" else "▪", fontSize = 11.sp, color = c.textTertiary)
                Spacer(Modifier.width(8.dp))
                Text(name, fontSize = 13.sp, fontWeight = FontWeight.SemiBold, color = c.textPrimary)
                Spacer(Modifier.width(8.dp))
                // Sans + gray for the truncated preview (mono only when expanded views
                // arrive later) — deliberate readability tradeoff from the reference.
                Text(summary, fontSize = 12.sp, color = c.textTertiary,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            }
        }
    }
}

@Composable
private fun PermissionCard(perm: PermissionReq, onRespond: (String) -> Unit) {
    val c = ArgusTheme.colors
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
            .background(c.statusAmberFill)
            .padding(14.dp)
    ) {
        Text("需要审批", fontSize = 11.sp, fontWeight = FontWeight.SemiBold, color = c.statusAmberText)
        Text(perm.toolName, fontFamily = FontFamily.Monospace, fontSize = 14.sp,
            color = c.textPrimary, modifier = Modifier.padding(top = 4.dp))
        if (perm.summary.isNotEmpty()) {
            Text(perm.summary, fontSize = 12.sp, color = c.textSecondary, maxLines = 3,
                overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 4.dp))
        }
        Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            perm.options.forEach { opt ->
                val id = opt["id"] ?: ""
                val accept = id.contains("accept") || id == "allow"
                val deny = id.contains("decline") || id == "deny"
                Button(
                    onClick = { onRespond(id) },
                    modifier = Modifier.weight(1f).height(40.dp),
                    shape = CircleShape,
                    colors = ButtonDefaults.buttonColors(
                        containerColor = when {
                            accept -> c.accent
                            deny -> c.danger
                            else -> c.sheet
                        },
                        contentColor = if (accept || deny) c.onAccent else c.textPrimary
                    )
                ) { Text(opt["label"] ?: "", fontSize = 13.sp, maxLines = 1) }
            }
        }
    }
}

@Composable
private fun InputBar(
    agent: String,
    input: String,
    onInput: (String) -> Unit,
    voiceHelper: VoiceInputHelper,
    onSend: () -> Unit,
) {
    val c = ArgusTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).imePadding(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (voiceHelper.isAvailable()) {
            var isListening by remember { mutableStateOf(false) }
            CircleButton(icon = {
                Icon(if (isListening) Icons.Default.Mic else Icons.Default.MicNone,
                    "语音输入", tint = if (isListening) c.statusAmberText else c.textSecondary,
                    modifier = Modifier.size(20.dp))
            }) {
                if (isListening) { voiceHelper.stop(); isListening = false }
                else {
                    isListening = true
                    voiceHelper.start(
                        onResult = { text -> onInput(text); isListening = false },
                        onPartial = { text -> onInput(text) },
                        onError = { isListening = false }
                    )
                }
            }
            Spacer(Modifier.width(8.dp))
        }
        BasicPillField(
            value = input, onValueChange = onInput,
            placeholder = "发送给 $agent",
            modifier = Modifier.weight(1f)
        )
        Spacer(Modifier.width(8.dp))
        val canSend = input.isNotBlank()
        Box(
            Modifier
                .size(40.dp)
                .clip(CircleShape)
                .background(if (canSend) c.accent else c.card)
                .clickable(enabled = canSend, onClick = onSend),
            contentAlignment = Alignment.Center
        ) {
            Icon(Icons.Default.ArrowUpward, "发送",
                tint = if (canSend) c.onAccent else c.textTertiary,
                modifier = Modifier.size(20.dp))
        }
    }
}

@Composable
private fun BasicPillField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
) {
    val c = ArgusTheme.colors
    Box(
        modifier
            .clip(CircleShape)
            .background(c.card)
            .padding(horizontal = 16.dp, vertical = 10.dp)
    ) {
        if (value.isEmpty()) Text(placeholder, fontSize = 14.sp, color = c.textTertiary)
        androidx.compose.foundation.text.BasicTextField(
            value = value, onValueChange = onValueChange,
            textStyle = LocalTextStyle.current.copy(fontSize = 14.sp, color = c.textPrimary),
            maxLines = 4,
            modifier = Modifier.fillMaxWidth()
        )
    }
}

// ===== Settings =====

@Composable
private fun SettingsScreen(vm: ArgusViewModel) {
    val c = ArgusTheme.colors
    var relayDraft by rememberSaveable { mutableStateOf(vm.relayUrl) }
    var relayError by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(vm.relayUrl) { relayDraft = vm.relayUrl }

    val connectionState = connectionStateLabel(vm, connectionUiState(vm))

    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .padding(start = 16.dp, end = 16.dp, bottom = 28.dp)
    ) {
        SettingsSection("连接") {
            SettingActionRow(
                title = "当前主机",
                detail = "${vm.activePeer?.deviceName ?: "未选择主机"} · $connectionState",
                action = "切换",
                onClick = { vm.overlay = Overlay.Devices },
            )
            SettingsDivider()
            SettingSwitchRow(
                title = "自动重连",
                detail = "连接意外断开后继续尝试",
                checked = vm.autoReconnect,
                onCheckedChange = vm::updateAutoReconnect,
            )
            vm.connectionDetail?.let { detail ->
                SettingsDivider()
                SettingStaticRow("最近连接事件", detail)
            }
        }

        SettingsSection("中继") {
            Column(Modifier.padding(14.dp)) {
                Text("中继地址", fontSize = 14.sp, fontWeight = FontWeight.Medium, color = c.textPrimary)
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = relayDraft,
                    onValueChange = {
                        relayDraft = it
                        relayError = null
                    },
                    placeholder = { Text("wss://relay.example/ws", fontSize = 14.sp, color = c.textTertiary) },
                    modifier = Modifier.fillMaxWidth(),
                    textStyle = LocalTextStyle.current.copy(
                        fontFamily = FontFamily.Monospace,
                        fontSize = 13.sp,
                        color = c.textPrimary,
                    ),
                    shape = RoundedCornerShape(ArgusRadius.ROW.dp),
                    singleLine = true,
                )
                relayError?.let {
                    Text(it, fontSize = 12.sp, color = c.danger, modifier = Modifier.padding(top = 6.dp))
                }
                Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.End) {
                    Text(
                        if (vm.activePeer != null) "保存并重连" else "保存",
                        fontSize = 14.sp,
                        fontWeight = FontWeight.SemiBold,
                        color = c.accent,
                        modifier = Modifier
                            .clip(CircleShape)
                            .background(c.accentFill)
                            .clickable {
                                if (vm.saveRelayUrl(relayDraft, reconnect = vm.activePeer != null)) {
                                    relayError = null
                                } else {
                                    relayError = "请输入有效的 ws:// 或 wss:// 地址"
                                }
                            }
                            .padding(horizontal = 14.dp, vertical = 8.dp),
                    )
                }
            }
        }

        SettingsSection("使用") {
            SettingSwitchRow(
                title = "保持亮屏",
                detail = "仅在 Argus 前台时生效",
                checked = vm.keepScreenOn,
                onCheckedChange = vm::updateKeepScreenOn,
            )
            SettingsDivider()
            SettingSwitchRow(
                title = "顶部显示 agent 名称",
                detail = "关闭后只显示图标",
                checked = vm.showAgentLabels,
                onCheckedChange = vm::updateShowAgentLabels,
            )
        }

        SettingsSection("会话") {
            SettingActionRow(
                title = "刷新会话列表",
                detail = if (vm.catalogLoading) "正在从主机读取" else null,
                action = if (vm.catalogLoading) "读取中…" else "刷新",
                enabled = vm.connectionStatus == "channel-ready" && !vm.catalogLoading,
                onClick = vm::refreshCatalog,
            )
        }

        if (vm.myFingerprint.isNotBlank()) {
            SettingsSection("诊断") {
                SettingStaticRow("本机指纹", vm.myFingerprint)
            }
        }
        Text(
            "Argus · 远程控制",
            fontSize = 12.sp,
            color = c.textTertiary,
            modifier = Modifier.fillMaxWidth().padding(top = 2.dp),
            textAlign = TextAlign.Center,
        )
    }
}

@Composable
private fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    val c = ArgusTheme.colors
    Text(
        title,
        fontSize = 12.sp,
        fontWeight = FontWeight.SemiBold,
        color = c.textSecondary,
        modifier = Modifier.padding(top = 14.dp, bottom = 6.dp),
    )
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
            .background(c.card),
        content = content,
    )
}

@Composable
private fun SettingsDivider() {
    HorizontalDivider(
        color = ArgusTheme.colors.textSecondary.copy(alpha = 0.16f),
        modifier = Modifier.padding(start = 14.dp),
    )
}

@Composable
private fun SettingActionRow(
    title: String,
    detail: String? = null,
    action: String,
    enabled: Boolean = true,
    onClick: () -> Unit,
) {
    val c = ArgusTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = c.textPrimary)
            detail?.let {
                Text(
                    it,
                    fontSize = 12.sp,
                    color = c.textSecondary,
                    modifier = Modifier.padding(top = 2.dp),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Spacer(Modifier.width(12.dp))
        Text(
            action,
            fontSize = 13.sp,
            fontWeight = FontWeight.Medium,
            color = if (enabled) c.accent else c.textTertiary,
        )
    }
}

@Composable
private fun SettingStaticRow(title: String, detail: String) {
    val c = ArgusTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = c.textPrimary)
        Spacer(Modifier.width(12.dp))
        Text(
            detail,
            fontSize = 12.sp,
            color = c.textSecondary,
            modifier = Modifier.weight(1f),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            textAlign = TextAlign.End,
        )
    }
}

@Composable
private fun SettingSwitchRow(
    title: String,
    detail: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
) {
    val c = ArgusTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable { onCheckedChange(!checked) }
            .padding(horizontal = 14.dp, vertical = 11.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, fontSize = 14.sp, fontWeight = FontWeight.Medium, color = c.textPrimary)
            Text(detail, fontSize = 12.sp, color = c.textSecondary, modifier = Modifier.padding(top = 2.dp))
        }
        Spacer(Modifier.width(12.dp))
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            colors = SwitchDefaults.colors(
                checkedThumbColor = c.onAccent,
                checkedTrackColor = c.accent,
            ),
        )
    }
}

// ===== Devices =====

@Composable
private fun DeviceScreen(vm: ArgusViewModel) {
    val c = ArgusTheme.colors
    val list = vm.peers.values.sortedByDescending { it.pairedAt }
    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        if (list.isEmpty()) {
            Text("尚未配对主机", color = c.textTertiary, fontSize = 13.sp,
                modifier = Modifier.padding(vertical = 8.dp))
        } else {
            list.forEach { peer ->
                val selected = peer.fingerprint == vm.activePeerFingerprint
                Row(
                    Modifier
                        .fillMaxWidth()
                        .padding(vertical = 4.dp)
                        .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
                        .background(if (selected) c.accentFill else c.card)
                        .border(1.dp, if (selected) c.accentStroke else c.card, RoundedCornerShape(ArgusRadius.CARD.dp))
                        .clickable { vm.selectPeer(peer.fingerprint) }
                        .padding(14.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(peer.deviceName, fontWeight = FontWeight.Medium, color = c.textPrimary, fontSize = 14.sp)
                        Text(peer.platform, fontSize = 11.sp, color = c.textSecondary, modifier = Modifier.padding(top = 2.dp))
                        Text(peer.fingerprint, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = c.textTertiary)
                    }
                    if (selected) {
                        Icon(Icons.Default.Check, "当前主机", tint = c.accent, modifier = Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                    }
                    Text("移除", color = c.danger, fontSize = 13.sp,
                        modifier = Modifier
                            .clip(CircleShape)
                            .clickable { vm.removePeer(peer.fingerprint) }
                            .padding(horizontal = 10.dp, vertical = 6.dp))
                }
            }
        }
        Text("中继", fontSize = 12.sp, color = c.textSecondary, modifier = Modifier.padding(top = 20.dp))
        Text(vm.relayUrl, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = c.textTertiary)
        Text("本机指纹", fontSize = 12.sp, color = c.textSecondary, modifier = Modifier.padding(top = 14.dp))
        Text(vm.myFingerprint, fontFamily = FontFamily.Monospace, fontSize = 11.sp, color = c.textTertiary)
        vm.error?.let {
            Text(it, color = c.danger, fontSize = 12.sp, modifier = Modifier.padding(top = 12.dp))
        }
    }
}
