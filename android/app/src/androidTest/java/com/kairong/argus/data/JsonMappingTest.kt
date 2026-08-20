package com.kairong.argus.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class JsonMappingTest {
    @Test
    fun preservesValuesAndNestedOutputItems() {
        val parsed = JSONObject(
            """{
                "status":"completed",
                "count":2,
                "nothing":null,
                "output":[{"type":"function_call","name":"list_files"}]
            }""".trimIndent(),
        ).toDeepMap()

        assertEquals("completed", parsed["status"])
        assertEquals(2, parsed["count"])
        assertNull(parsed["nothing"])

        val output = parsed["output"] as List<*>
        val call = output.single() as Map<*, *>
        assertEquals("function_call", call["type"])
        assertEquals("list_files", call["name"])
    }
}
