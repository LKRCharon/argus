package com.kairong.argus.data

import org.json.JSONObject
import java.io.File
import java.io.FileInputStream

data class PhoneAgentHistorySummary(
    val fileName: String,
    val sessionId: String,
    val title: String,
    val startedAt: String?,
    val updatedAtMillis: Long,
    val sizeBytes: Long,
)

data class PhoneAgentHistoryConversation(
    val summary: PhoneAgentHistorySummary,
    val entries: List<PhoneAgentEntry>,
    val skippedRecords: Int,
    val truncated: Boolean,
)

internal class PhoneAgentHistoryStore(
    root: File = PhoneAgentStorage.rootDirectory(),
    private val maxSessions: Int = 200,
    private val maxConversationBytes: Long = 32L * 1024L * 1024L,
    private val maxRecords: Int = 5_000,
) {
    private val resolver = PhoneAgentPathResolver(root)
    private val directory = PhoneAgentStorage.conversationDirectory(resolver.root)

    fun listConversations(): List<PhoneAgentHistorySummary> {
        val safeDirectory = safeDirectory(requireExisting = false) ?: return emptyList()
        val files = safeDirectory.listFiles().orEmpty()
            .mapNotNull(::safeHistoryFile)
            .sortedWith(compareByDescending<File> { it.lastModified() }.thenByDescending { it.name })
        return files.take(maxSessions).map(::summarize)
    }

    fun loadConversation(fileName: String): PhoneAgentHistoryConversation {
        val file = resolveHistoryFile(fileName)
        if (file.length() > maxConversationBytes) {
            throw IllegalStateException("会话记录超过 ${maxConversationBytes / (1024 * 1024)} MB，无法在手机中打开")
        }

        val entries = mutableListOf<PhoneAgentEntry>()
        val toolEntryIndexes = mutableMapOf<String, Int>()
        var skippedRecords = 0
        var truncated = false
        file.bufferedReader(Charsets.UTF_8).use { reader ->
            var recordCount = 0
            while (true) {
                val line = reader.readLine() ?: break
                if (recordCount >= maxRecords) {
                    truncated = true
                    break
                }
                recordCount++
                val parsed = runCatching { JSONObject(line) }.getOrNull()
                if (parsed == null || !appendHistoryEntry(parsed, entries, toolEntryIndexes)) {
                    skippedRecords++
                }
            }
        }
        return PhoneAgentHistoryConversation(
            summary = summarize(file),
            entries = entries,
            skippedRecords = skippedRecords,
            truncated = truncated,
        )
    }

    private fun summarize(file: File): PhoneAgentHistorySummary {
        var sessionId = file.nameWithoutExtension.substringAfterLast('_', file.nameWithoutExtension)
        var startedAt: String? = null
        var title: String? = null
        val prefix = readHistoryPrefix(file)
        for (line in prefix.lineSequence().take(SUMMARY_RECORD_LIMIT)) {
            val record = runCatching { JSONObject(line) }.getOrNull() ?: continue
            if (startedAt == null) startedAt = record.optString("timestamp").takeIf(String::isNotBlank)
            record.optString("session_id").takeIf(String::isNotBlank)?.let { sessionId = it }
            if (record.optString("type") == "user_message") {
                val text = record.optJSONObject("data")?.optString("text").orEmpty()
                if (text.isNotBlank()) {
                    title = text.replace(WHITESPACE, " ").trim().take(TITLE_LIMIT)
                    break
                }
            }
        }
        return PhoneAgentHistorySummary(
            fileName = file.name,
            sessionId = sessionId,
            title = title ?: "无标题会话",
            startedAt = startedAt,
            updatedAtMillis = file.lastModified(),
            sizeBytes = file.length(),
        )
    }

    private fun safeDirectory(requireExisting: Boolean): File? {
        val canonical = directory.canonicalFile
        resolver.assertInside(canonical)
        if (!canonical.exists()) {
            if (requireExisting) throw IllegalStateException("历史记录目录不存在")
            return null
        }
        if (!canonical.isDirectory) throw IllegalStateException("历史记录路径不是目录")
        if (canonical != resolver.resolve("Documents/PhoneAgent/conversations", allowRoot = false).file) {
            throw IllegalStateException("历史记录目录路径无效")
        }
        return canonical
    }

    private fun safeHistoryFile(candidate: File): File? {
        if (!candidate.name.endsWith(".jsonl") || candidate.name.contains('/') || candidate.name.contains('\\')) {
            return null
        }
        val canonicalDirectory = safeDirectory(requireExisting = true) ?: return null
        val canonical = runCatching { candidate.canonicalFile }.getOrNull() ?: return null
        if (!canonical.isFile || canonical.parentFile != canonicalDirectory) return null
        return runCatching { resolver.assertInside(canonical); canonical }.getOrNull()
    }

    private fun resolveHistoryFile(fileName: String): File {
        if (fileName.isBlank() || !fileName.endsWith(".jsonl") || fileName.contains('/') || fileName.contains('\\')) {
            throw IllegalArgumentException("历史记录文件名无效")
        }
        val safeDirectory = safeDirectory(requireExisting = true)
            ?: throw IllegalStateException("历史记录目录不存在")
        val canonical = File(safeDirectory, fileName).canonicalFile
        resolver.assertInside(canonical)
        if (canonical.parentFile != safeDirectory || !canonical.isFile) {
            throw IllegalArgumentException("历史记录文件无效")
        }
        return canonical
    }

    private fun readHistoryPrefix(file: File): String {
        val bytes = ByteArray(SUMMARY_BYTE_LIMIT)
        var total = 0
        FileInputStream(file).use { input ->
            while (total < bytes.size) {
                val count = input.read(bytes, total, bytes.size - total)
                if (count < 0) break
                total += count
            }
        }
        return String(bytes, 0, total, Charsets.UTF_8)
    }

    companion object {
        private const val SUMMARY_RECORD_LIMIT = 8
        private const val SUMMARY_BYTE_LIMIT = 256 * 1024
        private const val TITLE_LIMIT = 80
        private val WHITESPACE = Regex("\\s+")
    }
}

private fun appendHistoryEntry(
    record: JSONObject,
    entries: MutableList<PhoneAgentEntry>,
    toolEntryIndexes: MutableMap<String, Int>,
): Boolean {
    val data = record.optJSONObject("data") ?: JSONObject()
    return when (record.optString("type")) {
        "session_start" -> true
        "user_message" -> appendTextEntry(entries, "user", data.optString("text"))
        "assistant_message" -> appendTextEntry(entries, "assistant", data.optString("text"))
        "api_error", "agent_error" -> appendTextEntry(entries, "error", data.optString("message"))
        "tool_call" -> {
            val call = historyToolCall(data) ?: return false
            val status = if (data.optBoolean("approval_required", false)) "waiting" else "running"
            upsertHistoryTool(entries, toolEntryIndexes, call, "", status)
            true
        }
        "tool_execution" -> updateHistoryTool(entries, toolEntryIndexes, data, "", "running")
        "tool_decision" -> {
            if (data.optBoolean("approved", false)) true
            else updateHistoryTool(entries, toolEntryIndexes, data, "用户拒绝执行", "denied")
        }
        "tool_result" -> {
            val callId = data.optString("call_id")
            if (callId.isBlank()) return false
            val previousStatus = toolEntryIndexes[callId]?.let { entries.getOrNull(it)?.status }
            val ok = data.optBoolean("ok", false)
            val status = when {
                ok -> "done"
                previousStatus == "denied" -> "denied"
                else -> "error"
            }
            updateHistoryTool(entries, toolEntryIndexes, data, data.optString("summary"), status)
        }
        else -> true
    }
}

private fun appendTextEntry(entries: MutableList<PhoneAgentEntry>, role: String, text: String): Boolean {
    if (text.isBlank()) return false
    entries += PhoneAgentEntry(role, text)
    return true
}

private fun historyToolCall(data: JSONObject): PhoneToolCall? {
    val callId = data.optString("call_id")
    val name = data.optString("name")
    val arguments = data.optString("arguments", "{}")
    if (callId.isBlank() || name.isBlank()) return null
    return PhoneToolCall(callId, name, arguments)
}

private fun updateHistoryTool(
    entries: MutableList<PhoneAgentEntry>,
    toolEntryIndexes: MutableMap<String, Int>,
    data: JSONObject,
    text: String,
    status: String,
): Boolean {
    val callId = data.optString("call_id")
    if (callId.isBlank()) return false
    val existing = toolEntryIndexes[callId]?.let(entries::getOrNull)
    val call = existing?.toolCall ?: historyToolCall(data) ?: PhoneToolCall(
        callId = callId,
        name = data.optString("name", "unknown_tool"),
        arguments = "{}",
    )
    upsertHistoryTool(entries, toolEntryIndexes, call, text, status)
    return true
}

private fun upsertHistoryTool(
    entries: MutableList<PhoneAgentEntry>,
    toolEntryIndexes: MutableMap<String, Int>,
    call: PhoneToolCall,
    text: String,
    status: String,
) {
    val entry = PhoneAgentEntry("tool", text, toolCall = call, status = status)
    val existingIndex = toolEntryIndexes[call.callId]
    if (existingIndex == null) {
        toolEntryIndexes[call.callId] = entries.size
        entries += entry
    } else {
        entries[existingIndex] = entry
    }
}
