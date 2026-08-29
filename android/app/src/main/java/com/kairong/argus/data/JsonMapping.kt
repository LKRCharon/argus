package com.kairong.argus.data

import org.json.JSONArray
import org.json.JSONObject

internal fun JSONObject.toDeepMap(): Map<String, Any?> {
    val source = this
    return buildMap {
        for (key in source.keys()) {
            put(key, jsonToKotlinValue(source.get(key)))
        }
    }
}

private fun jsonToKotlinValue(value: Any?): Any? = when {
    value === JSONObject.NULL -> null
    value is JSONObject -> value.toDeepMap()
    value is JSONArray -> (0 until value.length()).map { index ->
        jsonToKotlinValue(value.get(index))
    }
    else -> value
}
