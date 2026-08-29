package com.kairong.argus.ui

import android.app.Application
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.kairong.argus.data.PhoneAgentApiClient
import com.kairong.argus.data.PhoneAgentConfigState
import com.kairong.argus.data.PhoneAgentConfigStore
import com.kairong.argus.data.PhoneAgentConversationStore
import com.kairong.argus.data.PhoneAgentStorage
import com.kairong.argus.data.PhoneFileTools
import com.kairong.argus.data.PhoneAgentRuntime
import com.kairong.argus.data.PhoneAgentState
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Standalone Android Agent state. It never creates a relay client. */
class PhoneAgentViewModel(application: Application) : AndroidViewModel(application) {
    private val configStore = PhoneAgentConfigStore(application)
    private val apiClient = PhoneAgentApiClient(configStore)
    private val storageAccess = { PhoneAgentStorage.hasAccess(application) }

    var phoneAgent by mutableStateOf(PhoneAgentState(storageAccessGranted = storageAccess()))
        private set
    var phoneAgentConfig by mutableStateOf(configStore.state())
        private set

    private lateinit var runtime: PhoneAgentRuntime

    init {
        runtime = PhoneAgentRuntime(
            scope = viewModelScope,
            sendRequest = { requestId, instructions, input, tools ->
                viewModelScope.launch(Dispatchers.IO) {
                    val response = apiClient.responses(requestId, instructions, input, tools)
                    withContext(Dispatchers.Main) { runtime.onResponse(response) }
                }
            },
            onState = { phoneAgent = it },
            storageAccess = storageAccess,
            fileTools = PhoneFileTools(accessGranted = storageAccess),
            conversationStore = PhoneAgentConversationStore(
                secrets = { listOfNotNull(configStore.apiKey()) },
            ),
        )
    }

    fun refreshPhoneAgentStorageAccess() = runtime.refreshStorageAccess()

    fun startPhoneAgent(prompt: String) {
        if (!phoneAgentConfig.hasApiKey) {
            phoneAgent = phoneAgent.copy(error = "请先配置 LimenAPI Key")
            return
        }
        runtime.sendPrompt(prompt)
    }

    fun approvePhoneAgentTool(allow: Boolean) = runtime.approvePending(allow)

    fun resetPhoneAgent() = runtime.reset()

    fun savePhoneAgentConfig(baseUrl: String, model: String, apiKey: String): String? {
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
        phoneAgentConfig = configStore.clearApiKey()
        runtime.reset()
        phoneAgent = phoneAgent.copy(error = "LimenAPI Key 已移除")
    }
}
