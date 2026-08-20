package com.kairong.argus.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.UUID

data class PhoneAgentEntry(
    val role: String,
    val text: String,
    val toolCall: PhoneToolCall? = null,
    val status: String? = null,
)

data class PhoneToolCall(
    val callId: String,
    val name: String,
    val arguments: String,
)

data class PhoneToolDisplayArguments(
    val paths: List<String>,
    val flags: List<String>,
)

internal fun PhoneToolCall.displayArguments(
    rootPath: String = PhoneAgentStorage.ROOT_PATH,
): PhoneToolDisplayArguments {
    val parsed = runCatching { JSONObject(arguments.ifBlank { "{}" }) }.getOrNull()
        ?: return PhoneToolDisplayArguments(emptyList(), emptyList())

    fun path(name: String, rootWhenBlank: Boolean = false): String? {
        if (!parsed.has(name) && !rootWhenBlank) return null
        return parsed.optString(name, "").trim().ifBlank { if (rootWhenBlank) rootPath else return null }
    }

    val paths = when (name) {
        "list_files" -> listOfNotNull(path("path", rootWhenBlank = true))
        "read_text_file", "write_text_file" -> listOfNotNull(path("path"))
        "unzip_file" -> listOfNotNull(
            path("archive_path"),
            path("destination_path", rootWhenBlank = true),
        )
        else -> listOfNotNull(path("path"), path("archive_path"), path("destination_path"))
    }
    val flags = buildList {
        if (parsed.optBoolean("recursive", false)) add("recursive")
        if (parsed.optBoolean("overwrite", false)) add("overwrite")
    }
    return PhoneToolDisplayArguments(paths, flags)
}

data class ToolExecution(
    val ok: Boolean,
    val output: String,
    val summary: String,
)

data class PhoneAgentState(
    val storageAccessGranted: Boolean = false,
    val storageRoot: String = PhoneAgentStorage.ROOT_PATH,
    val conversationDirectory: String = PhoneAgentStorage.CONVERSATION_DIRECTORY_PATH,
    val conversationFile: String? = null,
    val messages: List<PhoneAgentEntry> = emptyList(),
    val pendingCall: PhoneToolCall? = null,
    val running: Boolean = false,
    val error: String? = null,
)

object PhoneAgentTools {
    val INSTRUCTIONS = """
你是直接运行在 Android 手机上的文件 Agent。文件工具的固定根目录是 /storage/emulated/0。
工具路径可以是相对于该根目录的相对路径，也可以是 canonical 后仍位于该根目录内的绝对路径。
先用 list_files/read_text_file 了解现状；只有在用户明确要求时才调用写入或解压工具。
不要把没有工具返回的操作说成已完成。写入和解压可能覆盖用户文件，调用工具前先说明目标和风险，等待工具结果。
会话与完整工具审计记录保存在 /storage/emulated/0/Documents/PhoneAgent/conversations，文件工具不能修改该记录目录。
目前没有删除工具。没有 root 时不能修改 Android 系统分区、其他应用私有目录或平台仍限制的 Android/data 内容。
""".trimIndent()

    fun definitions(): List<Any?> = listOf(
        mapOf(
            "type" to "function",
            "name" to "list_files",
            "description" to "List entries under Android shared storage /storage/emulated/0.",
            "parameters" to mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "path" to mapOf("type" to "string", "description" to "Relative path, or an absolute path inside the shared-storage root; empty means root."),
                    "recursive" to mapOf("type" to "boolean", "description" to "Whether to include descendants."),
                ),
                "additionalProperties" to false,
            ),
        ),
        mapOf(
            "type" to "function",
            "name" to "read_text_file",
            "description" to "Read a UTF-8 text file under Android shared storage.",
            "parameters" to mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "path" to mapOf("type" to "string", "description" to "Relative path or an absolute path inside the shared-storage root."),
                    "max_bytes" to mapOf("type" to "integer", "description" to "Maximum bytes to return, capped at 524288."),
                ),
                "required" to listOf("path"),
                "additionalProperties" to false,
            ),
        ),
        mapOf(
            "type" to "function",
            "name" to "write_text_file",
            "description" to "Atomically write UTF-8 text under Android shared storage.",
            "parameters" to mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "path" to mapOf("type" to "string", "description" to "Relative path or an absolute path inside the shared-storage root."),
                    "content" to mapOf("type" to "string", "description" to "Complete UTF-8 file content."),
                    "overwrite" to mapOf("type" to "boolean", "description" to "Whether an existing file may be replaced."),
                ),
                "required" to listOf("path", "content"),
                "additionalProperties" to false,
            ),
        ),
        mapOf(
            "type" to "function",
            "name" to "unzip_file",
            "description" to "Transactionally extract a ZIP archive under Android shared storage with traversal and size protection.",
            "parameters" to mapOf(
                "type" to "object",
                "properties" to mapOf(
                    "archive_path" to mapOf("type" to "string", "description" to "Relative or in-root absolute path to the ZIP archive."),
                    "destination_path" to mapOf("type" to "string", "description" to "Relative or in-root absolute destination; empty means shared-storage root."),
                    "overwrite" to mapOf("type" to "boolean", "description" to "Whether existing files may be replaced."),
                ),
                "required" to listOf("archive_path"),
                "additionalProperties" to false,
            ),
        ),
    )

    fun needsApproval(name: String): Boolean = name == "write_text_file" || name == "unzip_file"
}

/** Phone-owned Responses loop. The model is remote; file tools execute locally on Android. */
internal class PhoneAgentRuntime(
    private val scope: CoroutineScope,
    private val sendRequest: (String, String, List<Any?>, List<Any?>) -> Unit,
    private val onState: (PhoneAgentState) -> Unit,
    private val storageAccess: () -> Boolean,
    private val fileTools: PhoneFileTools,
    private val conversationStore: PhoneAgentConversationStore,
) {
    private val inputItems = mutableListOf<Any?>()
    private val pendingCalls = ArrayDeque<PhoneToolCall>()
    private var currentRequestId: String? = null
    private var conversationSession: PhoneAgentConversationSession? = null
    private var rounds = 0
    private var generation = 0L
    private var state = PhoneAgentState(
        storageAccessGranted = storageAccess(),
        storageRoot = fileTools.rootPath,
        conversationDirectory = conversationStore.directory.path,
    )

    fun refreshStorageAccess() {
        state = state.copy(storageAccessGranted = storageAccess())
        onState(state)
    }

    fun reset() {
        generation++
        inputItems.clear()
        pendingCalls.clear()
        currentRequestId = null
        conversationSession = null
        rounds = 0
        state = PhoneAgentState(
            storageAccessGranted = storageAccess(),
            storageRoot = fileTools.rootPath,
            conversationDirectory = conversationStore.directory.path,
        )
        onState(state)
    }

    fun sendPrompt(prompt: String) {
        val text = prompt.trim()
        if (text.isBlank() || state.running || state.pendingCall != null) return
        val access = storageAccess()
        if (!access) {
            state = state.copy(storageAccessGranted = false, error = "请先授予共享存储管理权限")
            onState(state)
            return
        }
        rounds = 0
        state = state.copy(
            storageAccessGranted = true,
            messages = state.messages + PhoneAgentEntry("user", text),
            running = true,
            error = null,
        )
        onState(state)
        persistThen(
            records = listOf(PhoneAgentLogRecord("user_message", mapOf("text" to text))),
            createSession = true,
        ) {
            inputItems += mapOf("role" to "user", "content" to text)
            requestNext()
        }
    }

    fun approvePending(allow: Boolean) {
        val call = state.pendingCall ?: return
        state = state.copy(pendingCall = null, error = null)
        onState(state)
        val decision = PhoneAgentLogRecord(
            "tool_decision",
            mapOf("call_id" to call.callId, "name" to call.name, "approved" to allow),
        )
        if (allow) {
            persistThen(listOf(decision)) { execute(call) }
            return
        }

        val deniedOutput = JSONObject().put("ok", false).put("error", "用户拒绝执行").toString()
        persistThen(
            listOf(
                decision,
                PhoneAgentLogRecord(
                    "tool_result",
                    mapOf(
                        "call_id" to call.callId,
                        "name" to call.name,
                        "ok" to false,
                        "output" to deniedOutput,
                        "summary" to "用户拒绝执行",
                    ),
                ),
            ),
        ) {
            state = state.copy(
                messages = upsertToolEntry(call, "用户拒绝执行", "denied"),
            )
            inputItems += mapOf(
                "type" to "function_call_output",
                "call_id" to call.callId,
                "output" to deniedOutput,
            )
            onState(state)
            processNextCall()
        }
    }

    fun onResponse(response: LimenResponse) {
        if (currentRequestId != response.requestId) return
        currentRequestId = null
        if (!response.ok || response.response == null) {
            val message = response.error ?: "LimenAPI 请求失败"
            persistThen(listOf(PhoneAgentLogRecord("api_error", mapOf("message" to message)))) {
                state = state.copy(running = false, error = message)
                onState(state)
            }
            return
        }
        rounds++
        if (rounds > 20) {
            stopWithRecordedError("工具调用轮数超过 20 次，已停止")
            return
        }

        val rawOutput = response.response["output"] as? List<*>
        if (rawOutput.isNullOrEmpty()) {
            stopWithRecordedError("LimenAPI 已完成响应，但没有可用输出")
            return
        }
        val outputItems = rawOutput.mapNotNull(::stringKeyMap)
        if (outputItems.size != rawOutput.size) {
            stopWithRecordedError("LimenAPI 输出结构无效")
            return
        }

        val assistantEntries = mutableListOf<PhoneAgentEntry>()
        val calls = mutableListOf<PhoneToolCall>()
        val records = mutableListOf<PhoneAgentLogRecord>()
        for (item in outputItems) {
            when (item["type"]) {
                "message" -> {
                    val text = outputText(item)
                    if (text.isNotBlank()) {
                        assistantEntries += PhoneAgentEntry("assistant", text)
                        records += PhoneAgentLogRecord("assistant_message", mapOf("text" to text))
                    }
                }
                "function_call" -> {
                    val callId = item["call_id"] as? String
                    val name = item["name"] as? String
                    val arguments = item["arguments"] as? String
                    if (callId.isNullOrBlank() || name.isNullOrBlank() || arguments == null) {
                        stopWithRecordedError("LimenAPI 返回了不完整的函数调用")
                        return
                    }
                    val call = PhoneToolCall(callId, name, arguments)
                    calls += call
                    records += PhoneAgentLogRecord(
                        "tool_call",
                        mapOf(
                            "call_id" to call.callId,
                            "name" to call.name,
                            "arguments" to call.arguments,
                            "approval_required" to PhoneAgentTools.needsApproval(call.name),
                        ),
                    )
                }
            }
        }
        if (assistantEntries.isEmpty() && calls.isEmpty()) {
            stopWithRecordedError("LimenAPI 已完成响应，但没有文本或函数调用")
            return
        }

        persistThen(records) {
            inputItems.addAll(outputItems)
            pendingCalls.addAll(calls)
            state = state.copy(
                messages = state.messages + assistantEntries,
                error = null,
            )
            onState(state)
            if (calls.isEmpty()) {
                state = state.copy(running = false)
                onState(state)
            } else {
                processNextCall()
            }
        }
    }

    private fun requestNext() {
        if (currentRequestId != null || inputItems.isEmpty()) return
        val requestId = UUID.randomUUID().toString()
        currentRequestId = requestId
        state = state.copy(running = true, error = null)
        onState(state)
        runCatching {
            sendRequest(requestId, PhoneAgentTools.INSTRUCTIONS, inputItems.toList(), PhoneAgentTools.definitions())
        }.onFailure { error ->
            onResponse(LimenResponse(requestId, false, error = error.message ?: "无法发起 LimenAPI 请求"))
        }
    }

    private fun processNextCall() {
        if (currentRequestId != null) return
        val call = pendingCalls.removeFirstOrNull()
        if (call == null) {
            requestNext()
            return
        }
        if (PhoneAgentTools.needsApproval(call.name)) {
            state = state.copy(
                running = true,
                pendingCall = call,
            )
            onState(state)
        } else {
            execute(call)
        }
    }

    private fun execute(call: PhoneToolCall) {
        val session = conversationSession
        if (session == null) {
            failForLogging(IllegalStateException("会话记录尚未创建"))
            return
        }
        state = state.copy(
            running = true,
            messages = upsertToolEntry(call, "", "running"),
        )
        onState(state)
        val executionGeneration = generation
        scope.launch(Dispatchers.IO) {
            val startFailure = runCatching {
                conversationStore.append(
                    session,
                    listOf(PhoneAgentLogRecord("tool_execution", mapOf("call_id" to call.callId, "name" to call.name))),
                )
            }.exceptionOrNull()
            if (startFailure != null) {
                withContext(Dispatchers.Main) {
                    if (executionGeneration == generation) failForLogging(startFailure)
                }
                return@launch
            }

            val result = fileTools.execute(call)
            val resultFailure = runCatching {
                conversationStore.append(
                    session,
                    listOf(
                        PhoneAgentLogRecord(
                            "tool_result",
                            mapOf(
                                "call_id" to call.callId,
                                "name" to call.name,
                                "ok" to result.ok,
                                "output" to result.output,
                                "summary" to result.summary,
                            ),
                        ),
                    ),
                )
            }.exceptionOrNull()
            withContext(Dispatchers.Main) {
                if (executionGeneration != generation) return@withContext
                state = state.copy(
                    storageAccessGranted = storageAccess(),
                    messages = upsertToolEntry(
                        call,
                        result.summary,
                        if (result.ok) "done" else "error",
                    ),
                    error = if (result.ok) null else result.summary,
                )
                onState(state)
                if (resultFailure != null) {
                    failForLogging(resultFailure)
                    return@withContext
                }
                inputItems += mapOf(
                    "type" to "function_call_output",
                    "call_id" to call.callId,
                    "output" to result.output,
                )
                processNextCall()
            }
        }
    }

    private fun upsertToolEntry(call: PhoneToolCall, text: String, status: String): List<PhoneAgentEntry> {
        val entry = PhoneAgentEntry(
            role = "tool",
            text = text,
            toolCall = call,
            status = status,
        )
        val existingIndex = state.messages.indexOfLast { it.toolCall?.callId == call.callId }
        if (existingIndex < 0) return state.messages + entry
        return state.messages.toMutableList().also { it[existingIndex] = entry }
    }

    private fun persistThen(
        records: List<PhoneAgentLogRecord>,
        createSession: Boolean = false,
        continuation: () -> Unit,
    ) {
        val executionGeneration = generation
        val existingSession = conversationSession
        scope.launch(Dispatchers.IO) {
            val result = runCatching {
                if (existingSession == null) {
                    if (!createSession) throw IllegalStateException("会话记录尚未创建")
                    conversationStore.createSession(records)
                } else {
                    conversationStore.append(existingSession, records)
                    existingSession
                }
            }
            withContext(Dispatchers.Main) {
                if (executionGeneration != generation) return@withContext
                result.fold(
                    onSuccess = { session ->
                        if (conversationSession == null) conversationSession = session
                        state = state.copy(conversationFile = session.file.path)
                        onState(state)
                        continuation()
                    },
                    onFailure = ::failForLogging,
                )
            }
        }
    }

    private fun stopWithRecordedError(message: String) {
        persistThen(listOf(PhoneAgentLogRecord("agent_error", mapOf("message" to message)))) {
            pendingCalls.clear()
            state = state.copy(running = false, pendingCall = null, error = message)
            onState(state)
        }
    }

    private fun failForLogging(error: Throwable) {
        generation++
        inputItems.clear()
        pendingCalls.clear()
        currentRequestId = null
        conversationSession = null
        state = state.copy(
            running = false,
            pendingCall = null,
            error = "会话记录写入失败，当前会话已停止：${error.message ?: "未知错误"}",
        )
        onState(state)
    }

    private fun outputText(item: Map<String, Any?>): String {
        val content = item["content"] as? List<*> ?: return item["text"] as? String ?: ""
        return content.mapNotNull { block ->
            val map = block as? Map<*, *> ?: return@mapNotNull null
            when (map["type"]) {
                "output_text" -> map["text"] as? String
                "refusal" -> map["refusal"] as? String
                else -> null
            }
        }.joinToString("")
    }

    private fun stringKeyMap(value: Any?): Map<String, Any?>? {
        val source = value as? Map<*, *> ?: return null
        val result = linkedMapOf<String, Any?>()
        for ((key, child) in source) {
            if (key !is String) return null
            result[key] = child
        }
        return result
    }
}
