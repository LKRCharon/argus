package com.kairong.argus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.AdminPanelSettings
import androidx.compose.material.icons.filled.Archive
import androidx.compose.material.icons.filled.Build
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.FolderOpen
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Key
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Visibility
import androidx.compose.material.icons.filled.VisibilityOff
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kairong.argus.data.PhoneAgentConfigState
import com.kairong.argus.data.PhoneAgentEntry
import com.kairong.argus.data.PhoneAgentState
import com.kairong.argus.data.PhoneToolCall
import com.kairong.argus.data.displayArguments
import com.kairong.argus.ui.theme.ArgusRadius
import com.kairong.argus.ui.theme.ArgusTheme
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography

@Composable
fun PhoneAgentScreen(
    vm: ArgusViewModel,
    onGrantAccess: () -> Unit,
) {
    PhoneAgentContent(
        state = vm.phoneAgent,
        config = vm.phoneAgentConfig,
        onGrantAccess = onGrantAccess,
        onStart = vm::startPhoneAgent,
        onApprove = vm::approvePhoneAgentTool,
        onReset = vm::resetPhoneAgent,
        onSaveConfig = vm::savePhoneAgentConfig,
        onClearApiKey = vm::clearPhoneAgentApiKey,
    )
}

@Composable
fun PhoneAgentScreen(
    vm: PhoneAgentViewModel,
    onGrantAccess: () -> Unit,
) {
    PhoneAgentContent(
        state = vm.phoneAgent,
        config = vm.phoneAgentConfig,
        onGrantAccess = onGrantAccess,
        onStart = vm::startPhoneAgent,
        onApprove = vm::approvePhoneAgentTool,
        onReset = vm::resetPhoneAgent,
        onSaveConfig = vm::savePhoneAgentConfig,
        onClearApiKey = vm::clearPhoneAgentApiKey,
    )
}

@Composable
private fun PhoneAgentContent(
    state: PhoneAgentState,
    config: PhoneAgentConfigState,
    onGrantAccess: () -> Unit,
    onStart: (String) -> Unit,
    onApprove: (Boolean) -> Unit,
    onReset: () -> Unit,
    onSaveConfig: (String, String, String) -> String?,
    onClearApiKey: () -> Unit,
) {
    val c = ArgusTheme.colors
    var prompt by rememberSaveable { mutableStateOf("") }
    var showConfig by rememberSaveable { mutableStateOf(!config.hasApiKey) }
    var showHistory by rememberSaveable { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val ready = config.hasApiKey && state.storageAccessGranted

    LaunchedEffect(state.messages.size) {
        if (state.messages.isNotEmpty()) listState.animateScrollToItem(state.messages.lastIndex)
    }
    LaunchedEffect(config.hasApiKey) {
        if (!config.hasApiKey) showConfig = true
    }

    if (showHistory) {
        PhoneAgentHistoryScreen(
            storageAccessGranted = state.storageAccessGranted,
            onBack = { showHistory = false },
            onGrantAccess = onGrantAccess,
        )
        return
    }

    Column(Modifier.fillMaxSize().imePadding().padding(horizontal = 16.dp)) {
        Row(
            Modifier.fillMaxWidth().clip(RoundedCornerShape(ArgusRadius.CARD.dp))
                .background(c.card).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.FolderOpen, null, tint = c.textSecondary, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(9.dp))
            Column(Modifier.weight(1f)) {
                Text(
                    if (state.storageAccessGranted) "全部文件访问已授权" else "全部文件访问未授权",
                    fontSize = 11.sp,
                    color = if (state.storageAccessGranted) c.statusGreen else c.statusAmberText,
                )
                Text(
                    state.storageRoot,
                    fontSize = 13.sp,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text("会话记录", fontSize = 10.sp, color = c.textTertiary, modifier = Modifier.padding(top = 5.dp))
                Text(
                    state.conversationFile ?: state.conversationDirectory,
                    fontSize = 11.sp,
                    color = c.textSecondary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            TextButton(
                onClick = onGrantAccess,
                enabled = !state.running,
            ) {
                Icon(Icons.Default.AdminPanelSettings, null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(4.dp))
                Text(if (state.storageAccessGranted) "设置" else "授权")
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(top = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Key, null, tint = c.accent, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(7.dp))
            Text(
                "LimenAPI · 本机直连 · ${if (config.hasApiKey) "已配置" else "未配置"}",
                fontSize = 12.sp,
                color = c.textSecondary,
            )
            Spacer(Modifier.weight(1f))
            IconButton(
                onClick = { showHistory = true },
                enabled = state.storageAccessGranted && !state.running,
            ) {
                Icon(Icons.Default.History, "历史记录", tint = c.textSecondary)
            }
            IconButton(onClick = { showConfig = true }, enabled = !state.running) {
                Icon(Icons.Default.Settings, "LimenAPI 设置", tint = c.textSecondary)
            }
            IconButton(onClick = onReset, enabled = state.messages.isNotEmpty() || state.error != null) {
                Icon(Icons.Default.Refresh, "清空会话", tint = c.textSecondary)
            }
        }

        state.error?.let {
            Text(it, color = c.danger, fontSize = 12.sp, modifier = Modifier.padding(vertical = 4.dp))
        }

        LazyColumn(
            state = listState,
            modifier = Modifier.weight(1f).fillMaxWidth(),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            itemsIndexed(
                state.messages,
                key = { index, entry -> entry.toolCall?.let { "tool-${it.callId}" } ?: "$index-${entry.role}" },
                contentType = { _, entry -> entry.role },
            ) { _, entry ->
                PhoneAgentEntryRow(entry)
            }
            state.pendingCall?.let { call ->
                item(key = "pending-${call.callId}") {
                    PendingToolCall(call, onApprove)
                }
            }
        }

        Row(
            Modifier.fillMaxWidth().padding(vertical = 10.dp),
            verticalAlignment = Alignment.Bottom,
        ) {
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                modifier = Modifier.weight(1f),
                minLines = 1,
                maxLines = 4,
                enabled = ready && !state.running && state.pendingCall == null,
            )
            Spacer(Modifier.width(8.dp))
            IconButton(
                onClick = {
                    onStart(prompt)
                    prompt = ""
                },
                enabled = ready && prompt.isNotBlank() && !state.running && state.pendingCall == null,
            ) {
                Icon(Icons.AutoMirrored.Filled.Send, "发送", tint = if (ready && prompt.isNotBlank()) c.accent else c.textTertiary)
            }
        }
    }

    if (showConfig) {
        PhoneAgentConfigDialog(
            config = config,
            onDismiss = { showConfig = false },
            onSave = onSaveConfig,
            onClearApiKey = {
                onClearApiKey()
                showConfig = false
            },
        )
    }
}

@Composable
private fun PhoneAgentConfigDialog(
    config: PhoneAgentConfigState,
    onDismiss: () -> Unit,
    onSave: (String, String, String) -> String?,
    onClearApiKey: () -> Unit,
) {
    var baseUrl by rememberSaveable { mutableStateOf(config.baseUrl) }
    var model by rememberSaveable { mutableStateOf(config.model) }
    // Never put plaintext credentials into Android's saveable instance state.
    var apiKey by remember { mutableStateOf("") }
    var showKey by remember { mutableStateOf(false) }
    var error by rememberSaveable { mutableStateOf<String?>(null) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("LimenAPI 设置") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = baseUrl,
                    onValueChange = { baseUrl = it; error = null },
                    label = { Text("API 地址") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = model,
                    onValueChange = { model = it; error = null },
                    label = { Text("模型") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = apiKey,
                    onValueChange = { apiKey = it; error = null },
                    label = { Text("API Key") },
                    placeholder = { Text(if (config.hasApiKey) "已保存，留空保持不变" else "输入 API Key") },
                    singleLine = true,
                    visualTransformation = if (showKey) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    trailingIcon = {
                        IconButton(onClick = { showKey = !showKey }) {
                            Icon(if (showKey) Icons.Default.VisibilityOff else Icons.Default.Visibility, if (showKey) "隐藏" else "显示")
                        }
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let { Text(it, color = ArgusTheme.colors.danger, fontSize = 12.sp) }
            }
        },
        confirmButton = {
            TextButton(onClick = {
                error = onSave(baseUrl, model, apiKey)
                if (error == null) onDismiss()
            }) { Text("保存") }
        },
        dismissButton = {
            Row {
                if (config.hasApiKey) TextButton(onClick = onClearApiKey) { Text("移除密钥") }
                TextButton(onClick = onDismiss) { Text("取消") }
            }
        },
    )
}

@Composable
internal fun PhoneAgentEntryRow(entry: PhoneAgentEntry) {
    val c = ArgusTheme.colors
    when (entry.role) {
        "user" -> BoxWithConstraints(
            Modifier.fillMaxWidth(),
            contentAlignment = Alignment.CenterEnd,
        ) {
            Text(
                entry.text,
                fontSize = 14.sp,
                lineHeight = 20.sp,
                color = c.textPrimary,
                modifier = Modifier.widthIn(max = maxWidth * 0.88f)
                    .clip(RoundedCornerShape(ArgusRadius.CARD.dp))
                    .background(c.accentFill)
                    .padding(horizontal = 12.dp, vertical = 10.dp),
            )
        }
        "assistant" -> AssistantEntry(entry.text)
        "tool" -> entry.toolCall?.let { call ->
            ToolCallBody(
                call = call,
                status = entry.status ?: "",
                summary = entry.text,
                modifier = Modifier.fillMaxWidth().padding(vertical = 5.dp),
            )
        } ?: Text(entry.text, fontSize = 12.sp, color = c.textSecondary)
        "error" -> Text(
            entry.text,
            fontSize = 13.sp,
            lineHeight = 18.sp,
            color = c.danger,
            modifier = Modifier.fillMaxWidth().padding(horizontal = 2.dp, vertical = 4.dp),
        )
        else -> Text(entry.text, fontSize = 13.sp, color = c.textPrimary)
    }
}

@Composable
private fun AssistantEntry(text: String) {
    val c = ArgusTheme.colors
    val body = LocalTextStyle.current.copy(
        fontSize = 14.sp,
        lineHeight = 20.sp,
        color = c.textPrimary,
    )
    Box(Modifier.fillMaxWidth().padding(horizontal = 2.dp, vertical = 4.dp)) {
        Markdown(
            content = text,
            colors = markdownColor(
                text = c.textPrimary,
                codeText = c.textPrimary,
                codeBackground = c.card,
                inlineCodeText = c.textPrimary,
                inlineCodeBackground = c.card,
                linkText = c.accent,
            ),
            typography = markdownTypography(
                h1 = body.copy(fontSize = 19.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold),
                h2 = body.copy(fontSize = 17.sp, lineHeight = 24.sp, fontWeight = FontWeight.Bold),
                h3 = body.copy(fontSize = 16.sp, lineHeight = 22.sp, fontWeight = FontWeight.SemiBold),
                h4 = body.copy(fontSize = 15.sp, lineHeight = 21.sp, fontWeight = FontWeight.SemiBold),
                h5 = body.copy(fontWeight = FontWeight.SemiBold),
                h6 = body.copy(fontWeight = FontWeight.SemiBold, color = c.textSecondary),
                text = body,
                paragraph = body,
                ordered = body,
                bullet = body,
                list = body,
                quote = body.copy(color = c.textSecondary),
                code = body.copy(fontSize = 12.sp, lineHeight = 17.sp, fontFamily = FontFamily.Monospace),
                inlineCode = body.copy(fontSize = 13.sp, fontFamily = FontFamily.Monospace),
            ),
        )
    }
}

@Composable
private fun PendingToolCall(call: PhoneToolCall, onApprove: (Boolean) -> Unit) {
    val c = ArgusTheme.colors
    Column(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(ArgusRadius.CARD.dp))
            .background(c.statusAmberFill).padding(12.dp),
    ) {
        ToolCallBody(call, status = "waiting", summary = null)
        Row(Modifier.padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { onApprove(true) },
                colors = ButtonDefaults.buttonColors(containerColor = c.accent),
            ) {
                Icon(Icons.Default.Check, null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(5.dp))
                Text("执行")
            }
            TextButton(onClick = { onApprove(false) }) {
                Icon(Icons.Default.Close, null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(5.dp))
                Text("拒绝")
            }
        }
    }
}

@Composable
private fun ToolCallBody(
    call: PhoneToolCall,
    status: String,
    summary: String?,
    modifier: Modifier = Modifier,
) {
    val c = ArgusTheme.colors
    val details = remember(call.name, call.arguments) { call.displayArguments() }
    val statusColor = when (status) {
        "waiting" -> c.statusAmberText
        "running" -> c.accent
        "done" -> c.statusGreen
        "denied", "error" -> c.danger
        else -> c.textSecondary
    }

    Row(modifier, verticalAlignment = Alignment.Top) {
        Box(
            Modifier.size(28.dp).clip(CircleShape).background(c.card),
            contentAlignment = Alignment.Center,
        ) {
            Icon(toolIcon(call.name), null, tint = statusColor, modifier = Modifier.size(16.dp))
        }
        Spacer(Modifier.width(9.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    call.name,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 12.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = c.textPrimary,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (status == "running") {
                    CircularProgressIndicator(
                        modifier = Modifier.size(12.dp),
                        strokeWidth = 1.5.dp,
                        color = statusColor,
                    )
                    Spacer(Modifier.width(5.dp))
                }
                Text(toolStatusLabel(status), fontSize = 10.sp, color = statusColor)
            }
            details.paths.forEachIndexed { index, path ->
                Row(Modifier.fillMaxWidth().padding(top = 3.dp), verticalAlignment = Alignment.Top) {
                    if (index > 0) {
                        Text("→", fontSize = 11.sp, color = c.textTertiary, modifier = Modifier.padding(end = 5.dp))
                    }
                    Text(
                        path,
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        lineHeight = 15.sp,
                        color = c.textSecondary,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
            if (details.flags.isNotEmpty()) {
                Text(
                    details.flags.joinToString(" · "),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 10.sp,
                    color = c.textTertiary,
                    modifier = Modifier.padding(top = 3.dp),
                )
            }
            if (!summary.isNullOrBlank()) {
                Text(
                    summary,
                    fontSize = 11.sp,
                    color = if (status == "error" || status == "denied") c.danger else c.textSecondary,
                    modifier = Modifier.padding(top = 3.dp),
                )
            }
        }
    }
}

private fun toolIcon(name: String): ImageVector = when (name) {
    "list_files" -> Icons.Default.FolderOpen
    "read_text_file" -> Icons.Default.Description
    "write_text_file" -> Icons.Default.Edit
    "unzip_file" -> Icons.Default.Archive
    else -> Icons.Default.Build
}

private fun toolStatusLabel(status: String): String = when (status) {
    "waiting" -> "等待确认"
    "running" -> "执行中"
    "done" -> "已完成"
    "denied" -> "已拒绝"
    "error" -> "失败"
    else -> "工具"
}
