package com.kairong.argus.data

import android.content.Context
import android.util.Base64
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

data class PhoneAgentConfigState(
    val baseUrl: String = PhoneAgentConfigStore.DEFAULT_BASE_URL,
    val model: String = PhoneAgentConfigStore.DEFAULT_MODEL,
    val hasApiKey: Boolean = false,
)

data class LimenResponse(
    val requestId: String,
    val ok: Boolean,
    val response: Map<String, Any?>? = null,
    val error: String? = null,
)

internal fun validateCompletedPhoneAgentResponse(response: JSONObject) {
    val topLevelError = response.opt("error")
    if (topLevelError != null && topLevelError !== JSONObject.NULL) {
        val detail = (topLevelError as? JSONObject)?.optString("message")
            ?.takeIf { it.isNotBlank() }
            ?: topLevelError.toString().take(500)
        throw IllegalStateException("LimenAPI 返回错误：$detail")
    }

    val status = response.optString("status", "").trim()
    if (status != "completed") {
        val reason = response.optJSONObject("incomplete_details")?.optString("reason")
            ?.takeIf { it.isNotBlank() }
            ?: response.optJSONObject("error")?.optString("message")?.takeIf { it.isNotBlank() }
        val suffix = reason?.let { "：$it" }.orEmpty()
        throw IllegalStateException("LimenAPI 响应未完成（status=${status.ifBlank { "missing" }}）$suffix")
    }

    val output = response.optJSONArray("output")
        ?: throw IllegalStateException("LimenAPI 已完成响应，但缺少 output")
    if (output.length() == 0) throw IllegalStateException("LimenAPI 已完成响应，但 output 为空")

    var usable = false
    for (index in 0 until output.length()) {
        val item = output.optJSONObject(index) ?: continue
        when (item.optString("type")) {
            "message" -> {
                val content = item.optJSONArray("content") ?: continue
                for (contentIndex in 0 until content.length()) {
                    val block = content.optJSONObject(contentIndex) ?: continue
                    val text = when (block.optString("type")) {
                        "output_text" -> block.optString("text")
                        "refusal" -> block.optString("refusal")
                        else -> ""
                    }
                    if (text.isNotBlank()) usable = true
                }
            }
            "function_call" -> {
                val callId = item.optString("call_id")
                val name = item.optString("name")
                val arguments = item.opt("arguments") as? String
                if (callId.isBlank() || name.isBlank() || arguments == null) {
                    throw IllegalStateException("LimenAPI 返回了不完整的函数调用")
                }
                try {
                    JSONObject(arguments)
                } catch (_: Exception) {
                    throw IllegalStateException("LimenAPI 函数调用参数不是 JSON object：$name")
                }
                usable = true
            }
        }
    }
    if (!usable) throw IllegalStateException("LimenAPI 已完成响应，但没有可用文本或函数调用")
}

/** LimenAPI settings. Only the API key is secret, so only it is Keystore-sealed. */
class PhoneAgentConfigStore(context: Context) {
    private val prefs = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    private val vault = KeyVault(KEY_ALIAS)

    fun state(): PhoneAgentConfigState = PhoneAgentConfigState(
        baseUrl = prefs.getString(BASE_URL_KEY, null)?.trim().orEmpty().ifBlank { DEFAULT_BASE_URL },
        model = prefs.getString(MODEL_KEY, null)?.trim().orEmpty().ifBlank { DEFAULT_MODEL },
        hasApiKey = apiKey() != null,
    )

    fun validate(baseUrl: String, model: String, apiKey: String?): String? {
        val normalizedUrl = baseUrl.trim().trimEnd('/')
        val endpoint = responseUrl(normalizedUrl).toHttpUrlOrNull()
            ?: return "API 地址无效"
        if (!endpoint.isHttps) return "API 地址必须使用 https://"
        if (endpoint.username.isNotEmpty() || endpoint.password.isNotEmpty()) return "API 地址不能包含用户名或密码"
        if (endpoint.query != null || endpoint.fragment != null) return "API 地址不能包含查询参数或片段"
        if (normalizedUrl.length > 2048) return "API 地址过长"
        if (model.trim().isBlank()) return "模型不能为空"
        if (model.trim().length > 128) return "模型名称过长"
        if (apiKey != null && (apiKey.contains('\n') || apiKey.contains('\r'))) return "API Key 不能包含换行"
        if (apiKey != null && apiKey.length > 8192) return "API Key 过长"
        if (apiKey.isNullOrBlank() && this.apiKey() == null) return "请输入 API Key"
        return null
    }

    fun save(baseUrl: String, model: String, apiKey: String?): PhoneAgentConfigState {
        validate(baseUrl, model, apiKey)?.let { throw IllegalArgumentException(it) }
        val edit = prefs.edit()
            .putString(BASE_URL_KEY, baseUrl.trim().trimEnd('/'))
            .putString(MODEL_KEY, model.trim())
        apiKey?.trim()?.takeIf { it.isNotEmpty() }?.let { key ->
            val sealed = vault.seal(key.toByteArray(Charsets.UTF_8))
            edit.putString(API_KEY_KEY, Base64.encodeToString(sealed, Base64.NO_WRAP))
        }
        edit.apply()
        return state()
    }

    fun clearApiKey(): PhoneAgentConfigState {
        prefs.edit().remove(API_KEY_KEY).apply()
        return state()
    }

    fun apiKey(): String? {
        val encoded = prefs.getString(API_KEY_KEY, null) ?: return null
        return try {
            String(vault.open(Base64.decode(encoded, Base64.NO_WRAP)), Charsets.UTF_8)
                .trim().takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
    }

    companion object {
        const val DEFAULT_BASE_URL = "https://api.limen.codes"
        const val DEFAULT_MODEL = "gpt-5.6-luna"
        private const val PREFS_NAME = "phone-agent-config"
        private const val KEY_ALIAS = "argus_phone_agent_api_key"
        private const val BASE_URL_KEY = "baseUrl"
        private const val MODEL_KEY = "model"
        private const val API_KEY_KEY = "apiKey"

        fun responseUrl(baseUrl: String): String {
            val clean = baseUrl.trim().trimEnd('/')
            return if (clean.endsWith("/v1")) "$clean/responses" else "$clean/v1/responses"
        }
    }
}

/** Direct Responses client used by the standalone Android Agent. */
class PhoneAgentApiClient(private val configStore: PhoneAgentConfigStore) {
    companion object {
        private const val MAX_REQUEST_BYTES = 8_000_000
        private const val MAX_RESPONSE_BYTES = 8L * 1024 * 1024
        private val JSON = "application/json; charset=utf-8".toMediaType()
        private val HTTP = OkHttpClient.Builder()
            .followRedirects(false)
            .followSslRedirects(false)
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(90, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .callTimeout(100, TimeUnit.SECONDS)
            .build()
    }

    fun responses(
        requestId: String,
        instructions: String,
        input: List<Any?>,
        tools: List<Any?>,
        maxOutputTokens: Int = 1600,
    ): LimenResponse {
        return try {
            if (input.isEmpty()) throw IllegalArgumentException("Responses input 不能为空")
            val config = configStore.state()
            val apiKey = configStore.apiKey() ?: throw IllegalStateException("请先配置 LimenAPI Key")
            val body = JSONObject().apply {
                put("model", config.model)
                put("input", jsonValue(input))
                put("tools", jsonValue(tools))
                put("instructions", instructions)
                put("max_output_tokens", maxOutputTokens.coerceIn(128, 4096))
                put("store", false)
            }.toString()
            if (body.toByteArray(Charsets.UTF_8).size > MAX_REQUEST_BYTES) {
                throw IllegalStateException("对话内容过大，请清空手机 Agent 会话")
            }

            val request = Request.Builder()
                .url(PhoneAgentConfigStore.responseUrl(config.baseUrl))
                .header("Authorization", "Bearer $apiKey")
                .header("Accept", "application/json")
                .post(body.toRequestBody(JSON))
                .build()
            HTTP.newCall(request).execute().use { result ->
                val responseBody = result.body ?: throw IllegalStateException("LimenAPI 返回空响应")
                if (responseBody.contentLength() > MAX_RESPONSE_BYTES) {
                    throw IllegalStateException("LimenAPI 响应过大")
                }
                val bytes = responseBody.byteStream().use { input ->
                    val output = java.io.ByteArrayOutputStream()
                    val buffer = ByteArray(8192)
                    var total = 0L
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        if (total > MAX_RESPONSE_BYTES) throw IllegalStateException("LimenAPI 响应过大")
                        output.write(buffer, 0, count)
                    }
                    output.toByteArray()
                }
                val text = bytes.toString(Charsets.UTF_8)
                val parsed = try {
                    JSONObject(text)
                } catch (_: Exception) {
                    throw IllegalStateException("LimenAPI 返回了非 JSON 响应（HTTP ${result.code}）")
                }
                if (!result.isSuccessful) {
                    val detail = parsed.optJSONObject("error")?.optString("message")
                        ?.takeIf { it.isNotBlank() } ?: "未知错误"
                    throw IllegalStateException("LimenAPI 请求失败（HTTP ${result.code}）：$detail")
                }
                validateCompletedPhoneAgentResponse(parsed)
                LimenResponse(requestId, true, response = parsed.toDeepMap())
            }
        } catch (e: Exception) {
            LimenResponse(requestId, false, error = e.message ?: "LimenAPI 请求失败")
        }
    }

    private fun jsonValue(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().also { obj ->
            value.forEach { (key, child) -> obj.put(key.toString(), jsonValue(child)) }
        }
        is Iterable<*> -> JSONArray().also { array -> value.forEach { array.put(jsonValue(it)) } }
        is Array<*> -> JSONArray().also { array -> value.forEach { array.put(jsonValue(it)) } }
        else -> value
    }

}
