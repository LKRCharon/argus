package com.kairong.argus.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kairong.argus.data.PhoneAgentHistoryConversation
import com.kairong.argus.data.PhoneAgentHistoryStore
import com.kairong.argus.data.PhoneAgentHistorySummary
import com.kairong.argus.data.PhoneAgentStorage
import com.kairong.argus.ui.theme.ArgusTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
internal fun PhoneAgentHistoryScreen(
    storageAccessGranted: Boolean,
    onBack: () -> Unit,
    onGrantAccess: () -> Unit,
) {
    val c = ArgusTheme.colors
    val store = remember { PhoneAgentHistoryStore() }
    var refreshVersion by remember { mutableIntStateOf(0) }
    var selectedFileName by rememberSaveable { mutableStateOf<String?>(null) }
    var summaries by remember { mutableStateOf<List<PhoneAgentHistorySummary>>(emptyList()) }
    var conversation by remember { mutableStateOf<PhoneAgentHistoryConversation?>(null) }
    var listLoading by remember { mutableStateOf(false) }
    var detailLoading by remember { mutableStateOf(false) }
    var listError by remember { mutableStateOf<String?>(null) }
    var detailError by remember { mutableStateOf<String?>(null) }

    fun navigateBack() {
        if (selectedFileName != null) {
            selectedFileName = null
            conversation = null
            detailError = null
        } else {
            onBack()
        }
    }
    BackHandler(onBack = ::navigateBack)

    LaunchedEffect(storageAccessGranted, refreshVersion) {
        if (!storageAccessGranted) {
            summaries = emptyList()
            listError = null
            return@LaunchedEffect
        }
        listLoading = true
        listError = null
        runCatching { withContext(Dispatchers.IO) { store.listConversations() } }
            .onSuccess { summaries = it }
            .onFailure { listError = it.message ?: "无法读取历史记录" }
        listLoading = false
    }

    LaunchedEffect(storageAccessGranted, selectedFileName, refreshVersion) {
        val fileName = selectedFileName
        if (!storageAccessGranted || fileName == null) {
            conversation = null
            detailError = null
            return@LaunchedEffect
        }
        detailLoading = true
        detailError = null
        conversation = null
        runCatching { withContext(Dispatchers.IO) { store.loadConversation(fileName) } }
            .onSuccess { conversation = it }
            .onFailure { detailError = it.message ?: "无法打开历史记录" }
        detailLoading = false
    }

    Column(Modifier.fillMaxSize().padding(horizontal = 16.dp)) {
        HistoryHeader(
            title = conversation?.summary?.title ?: if (selectedFileName == null) "历史记录" else "会话详情",
            onBack = ::navigateBack,
            onRefresh = { refreshVersion++ },
            refreshEnabled = storageAccessGranted && !listLoading && !detailLoading,
        )
        when {
            !storageAccessGranted -> HistoryPermissionRequired(onGrantAccess)
            selectedFileName != null -> HistoryDetail(
                conversation = conversation,
                loading = detailLoading,
                error = detailError,
                onRetry = { refreshVersion++ },
            )
            listLoading && summaries.isEmpty() -> HistoryLoading()
            listError != null -> HistoryError(requireNotNull(listError)) { refreshVersion++ }
            summaries.isEmpty() -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("暂无历史记录", fontSize = 13.sp, color = c.textTertiary)
            }
            else -> LazyColumn(Modifier.fillMaxSize()) {
                items(summaries, key = { it.fileName }) { summary ->
                    HistorySummaryRow(summary) { selectedFileName = summary.fileName }
                    HorizontalDivider(color = c.card)
                }
            }
        }
    }
}

@Composable
private fun HistoryHeader(
    title: String,
    onBack: () -> Unit,
    onRefresh: () -> Unit,
    refreshEnabled: Boolean,
) {
    val c = ArgusTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        IconButton(onClick = onBack) {
            Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回", tint = c.textPrimary)
        }
        Text(
            title,
            fontSize = 15.sp,
            fontWeight = FontWeight.SemiBold,
            color = c.textPrimary,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        IconButton(onClick = onRefresh, enabled = refreshEnabled) {
            Icon(Icons.Default.Refresh, "刷新历史记录", tint = c.textSecondary)
        }
    }
}

@Composable
private fun HistorySummaryRow(summary: PhoneAgentHistorySummary, onClick: () -> Unit) {
    val c = ArgusTheme.colors
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 4.dp, vertical = 13.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Icon(
            Icons.Default.Description,
            null,
            tint = c.textSecondary,
            modifier = Modifier.size(20.dp),
        )
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                summary.title,
                fontSize = 14.sp,
                lineHeight = 19.sp,
                fontWeight = FontWeight.Medium,
                color = c.textPrimary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                "${formatHistoryTime(summary)} · ${formatHistorySize(summary.sizeBytes)}",
                fontSize = 11.sp,
                color = c.textTertiary,
                modifier = Modifier.padding(top = 3.dp),
            )
        }
    }
}

@Composable
private fun HistoryDetail(
    conversation: PhoneAgentHistoryConversation?,
    loading: Boolean,
    error: String?,
    onRetry: () -> Unit,
) {
    val c = ArgusTheme.colors
    when {
        loading -> HistoryLoading()
        error != null -> HistoryError(error, onRetry)
        conversation == null -> HistoryLoading()
        else -> LazyColumn(
            Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            item(key = "metadata") {
                Column(Modifier.fillMaxWidth().padding(bottom = 6.dp)) {
                    Text(
                        "${formatHistoryTime(conversation.summary)} · ${formatHistorySize(conversation.summary.sizeBytes)}",
                        fontSize = 11.sp,
                        color = c.textTertiary,
                    )
                    Text(
                        "${PhoneAgentStorage.CONVERSATION_DIRECTORY_PATH}/${conversation.summary.fileName}",
                        fontFamily = FontFamily.Monospace,
                        fontSize = 10.sp,
                        lineHeight = 14.sp,
                        color = c.textTertiary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 3.dp),
                    )
                }
            }
            if (conversation.entries.isEmpty()) {
                item(key = "empty") {
                    Text("此记录没有可展示的对话内容", fontSize = 13.sp, color = c.textTertiary)
                }
            }
            itemsIndexed(
                conversation.entries,
                key = { index, entry -> entry.toolCall?.let { "tool-${it.callId}" } ?: "$index-${entry.role}" },
                contentType = { _, entry -> entry.role },
            ) { _, entry ->
                PhoneAgentEntryRow(entry)
            }
            if (conversation.skippedRecords > 0 || conversation.truncated) {
                item(key = "warning") {
                    val parts = buildList {
                        if (conversation.skippedRecords > 0) add("${conversation.skippedRecords} 条记录无法解析")
                        if (conversation.truncated) add("记录过长，已截断")
                    }
                    Text(parts.joinToString(" · "), fontSize = 11.sp, color = c.statusAmberText)
                }
            }
            item(key = "bottom-space") { Spacer(Modifier.size(8.dp)) }
        }
    }
}

@Composable
private fun HistoryPermissionRequired(onGrantAccess: () -> Unit) {
    val c = ArgusTheme.colors
    Column(
        Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Icon(Icons.Default.AdminPanelSettings, null, tint = c.statusAmberText, modifier = Modifier.size(28.dp))
        Text(
            "需要全部文件访问权限",
            fontSize = 13.sp,
            color = c.textPrimary,
            modifier = Modifier.padding(top = 10.dp),
        )
        Button(onClick = onGrantAccess, modifier = Modifier.padding(top = 12.dp)) {
            Text("前往系统设置")
        }
    }
}

@Composable
private fun HistoryLoading() {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
    }
}

@Composable
private fun HistoryError(message: String, onRetry: () -> Unit) {
    val c = ArgusTheme.colors
    Column(
        Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(message, fontSize = 13.sp, color = c.danger)
        TextButton(onClick = onRetry, modifier = Modifier.padding(top = 4.dp)) {
            Text("重试")
        }
    }
}

private fun formatHistoryTime(summary: PhoneAgentHistorySummary): String {
    val instant = summary.startedAt?.let { runCatching { Instant.parse(it) }.getOrNull() }
        ?: Instant.ofEpochMilli(summary.updatedAtMillis)
    return HISTORY_TIME_FORMAT.format(instant)
}

private fun formatHistorySize(bytes: Long): String = when {
    bytes < 1024L -> "$bytes B"
    bytes < 1024L * 1024L -> "${bytes / 1024L} KB"
    else -> "${bytes / (1024L * 1024L)} MB"
}

private val HISTORY_TIME_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
    .withZone(ZoneId.systemDefault())
