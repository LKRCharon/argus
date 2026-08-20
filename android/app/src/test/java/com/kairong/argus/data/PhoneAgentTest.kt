package com.kairong.argus.data

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeNoException
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.nio.file.Files
import java.time.Instant
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class PhoneAgentPathResolverTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun resolvesRelativeAndAbsolutePathsInsideRoot() {
        val root = temporaryFolder.newFolder("shared")
        val file = File(root, "folder/file.txt").also {
            requireNotNull(it.parentFile).mkdirs()
            it.writeText("ok")
        }
        val resolver = PhoneAgentPathResolver(root)

        assertEquals("folder/file.txt", resolver.resolve("folder\\file.txt", false).relativePath)
        assertEquals(file.canonicalFile, resolver.resolve(file.absolutePath, false).file)
    }

    @Test
    fun rejectsTraversalAndAbsolutePathsOutsideRoot() {
        val root = temporaryFolder.newFolder("shared")
        val outside = temporaryFolder.newFile("outside.txt")
        val resolver = PhoneAgentPathResolver(root)

        assertThrows(IllegalArgumentException::class.java) { resolver.resolve("../outside.txt", false) }
        assertThrows(IllegalArgumentException::class.java) { resolver.resolve(outside.absolutePath, false) }
        assertThrows(IllegalArgumentException::class.java) { resolver.resolve("folder/./file.txt", false) }
        assertThrows(IllegalArgumentException::class.java) { resolver.resolve("folder\u0000name/file.txt", false) }
    }

    @Test
    fun rejectsCanonicalEscapeThroughSymbolicLink() {
        val root = temporaryFolder.newFolder("shared")
        val outside = temporaryFolder.newFolder("outside")
        File(outside, "secret.txt").writeText("secret")
        val link = File(root, "escape")
        try {
            Files.createSymbolicLink(link.toPath(), outside.toPath())
        } catch (error: Exception) {
            assumeNoException(error)
        }

        val resolver = PhoneAgentPathResolver(root)
        assertThrows(IllegalArgumentException::class.java) {
            resolver.resolve("escape/secret.txt", false)
        }
    }

    @Test
    fun rejectsOverlongPathSegments() {
        val resolver = PhoneAgentPathResolver(temporaryFolder.newFolder("shared"))
        assertThrows(IllegalArgumentException::class.java) {
            resolver.resolve("folder/${"x".repeat(256)}", false)
        }
    }
}

class PhoneFileToolsTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun atomicallyOverwritesTextWithoutLeavingTemporaryFiles() {
        val root = temporaryFolder.newFolder("shared")
        val target = File(root, "notes/item.txt").also {
            requireNotNull(it.parentFile).mkdirs()
            it.writeText("old")
        }
        val tools = PhoneFileTools(root)
        val result = tools.execute(
            PhoneToolCall(
                "call-1",
                "write_text_file",
                JSONObject()
                    .put("path", target.absolutePath)
                    .put("content", "new content")
                    .put("overwrite", true)
                    .toString(),
            ),
        )

        assertTrue(result.output, result.ok)
        assertEquals("new content", target.readText())
        assertTrue(requireNotNull(target.parentFile).listFiles().orEmpty().none { it.name.endsWith(".tmp") })
    }

    @Test
    fun refusesToModifyConversationDirectory() {
        val root = temporaryFolder.newFolder("shared")
        val tools = PhoneFileTools(root)
        val result = tools.execute(
            PhoneToolCall(
                "call-2",
                "write_text_file",
                JSONObject()
                    .put("path", "Documents/PhoneAgent/conversations/tamper.jsonl")
                    .put("content", "tamper")
                    .toString(),
            ),
        )

        assertFalse(result.ok)
        assertTrue(result.summary.contains("禁止"))
    }

    @Test
    fun rejectsZipTraversalAndDuplicateNormalizedTargets() {
        val root = temporaryFolder.newFolder("shared")
        val traversal = File(root, "traversal.zip")
        writeZip(traversal, listOf("../escaped.txt" to "bad".toByteArray()))
        val duplicate = File(root, "duplicate.zip")
        writeZip(
            duplicate,
            listOf(
                "folder\\same.txt" to "one".toByteArray(),
                "folder/same.txt" to "two".toByteArray(),
            ),
        )
        val tools = PhoneFileTools(root)

        val traversalResult = tools.execute(unzipCall("traversal.zip", "out"))
        val duplicateResult = tools.execute(unzipCall("duplicate.zip", "out"))

        assertFalse(traversalResult.ok)
        assertFalse(duplicateResult.ok)
        assertFalse(File(requireNotNull(root.parentFile), "escaped.txt").exists())
        assertFalse(File(root, "out").exists())
    }

    @Test
    fun enforcesZipEntryCountAndSizeLimits() {
        val root = temporaryFolder.newFolder("shared")
        writeZip(
            File(root, "count.zip"),
            listOf("one.txt" to byteArrayOf(1), "two.txt" to byteArrayOf(2)),
        )
        writeZip(File(root, "large.zip"), listOf("large.txt" to ByteArray(6) { 1 }))
        writeZip(
            File(root, "total.zip"),
            listOf("one.txt" to ByteArray(4) { 1 }, "two.txt" to ByteArray(4) { 2 }),
        )

        val countResult = PhoneFileTools(root, limits = PhoneFileLimits(maxZipEntries = 1))
            .execute(unzipCall("count.zip", "count-out"))
        val fileSizeResult = PhoneFileTools(root, limits = PhoneFileLimits(maxZipFileBytes = 5))
            .execute(unzipCall("large.zip", "large-out"))
        val totalSizeResult = PhoneFileTools(root, limits = PhoneFileLimits(maxZipTotalBytes = 7))
            .execute(unzipCall("total.zip", "total-out"))

        assertFalse(countResult.ok)
        assertFalse(fileSizeResult.ok)
        assertFalse(totalSizeResult.ok)
        assertFalse(File(root, "count-out").exists())
        assertFalse(File(root, "large-out").exists())
        assertFalse(File(root, "total-out").exists())
    }

    @Test
    fun zipPreflightLeavesNoPartialOutputWhenTargetConflicts() {
        val root = temporaryFolder.newFolder("shared")
        writeZip(
            File(root, "bundle.zip"),
            listOf("new.txt" to "new".toByteArray(), "existing.txt" to "replacement".toByteArray()),
        )
        val destination = File(root, "out").also { it.mkdirs() }
        File(destination, "existing.txt").writeText("keep")
        val result = PhoneFileTools(root).execute(unzipCall("bundle.zip", "out", overwrite = false))

        assertFalse(result.ok)
        assertFalse(File(destination, "new.txt").exists())
        assertEquals("keep", File(destination, "existing.txt").readText())
    }
}

class PhoneAgentConversationStoreTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun persistsJsonlAuditAndRedactsConfiguredApiKey() {
        val root = temporaryFolder.newFolder("shared")
        val oldApiKey = "limen-old-secret-key"
        val newApiKey = "limen-new-secret-key"
        var currentApiKey = oldApiKey
        val store = PhoneAgentConversationStore(root, secrets = { listOf(currentApiKey) })
        val session = store.createSession(
            listOf(
                PhoneAgentLogRecord("user_message", mapOf("text" to "use $oldApiKey")),
                PhoneAgentLogRecord(
                    "tool_call",
                    mapOf("name" to "write_text_file", "arguments" to "{\"content\":\"$oldApiKey\"}"),
                ),
            ),
        )
        currentApiKey = newApiKey
        store.append(
            session,
            listOf(
                PhoneAgentLogRecord(
                    "tool_result",
                    mapOf("ok" to true, "output" to "stored $oldApiKey and $newApiKey", "summary" to "done"),
                ),
            ),
        )

        assertEquals(store.directory.canonicalFile, requireNotNull(session.file.parentFile).canonicalFile)
        val text = session.file.readText()
        assertFalse(text.contains(oldApiKey))
        assertFalse(text.contains(newApiKey))
        assertTrue(text.contains("[REDACTED]"))
        val rows = session.file.readLines().map(::JSONObject)
        assertEquals(listOf("session_start", "user_message", "tool_call", "tool_result"), rows.map { it.getString("type") })
        assertTrue(rows.all { it.getString("session_id") == session.id })
    }

    @Test
    fun refusesConversationDirectorySymlinkEscape() {
        val root = temporaryFolder.newFolder("shared")
        val outside = temporaryFolder.newFolder("outside")
        val agentDirectory = File(root, "Documents/PhoneAgent").also { it.mkdirs() }
        try {
            Files.createSymbolicLink(File(agentDirectory, "conversations").toPath(), outside.toPath())
        } catch (error: Exception) {
            assumeNoException(error)
        }

        val store = PhoneAgentConversationStore(root)
        assertThrows(IllegalArgumentException::class.java) {
            store.createSession(listOf(PhoneAgentLogRecord("user_message", mapOf("text" to "blocked"))))
        }
        assertTrue(outside.listFiles().orEmpty().isEmpty())
    }
}

class PhoneAgentHistoryStoreTest {
    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun listsNewestConversationsWithFirstUserMessageAsTitle() {
        val root = temporaryFolder.newFolder("shared")
        var now = Instant.parse("2026-08-20T10:00:00Z")
        val writer = PhoneAgentConversationStore(root, clock = { now })
        val older = writer.createSession(
            listOf(PhoneAgentLogRecord("user_message", mapOf("text" to "  First   conversation  "))),
        )
        now = Instant.parse("2026-08-20T11:00:00Z")
        val newer = writer.createSession(
            listOf(PhoneAgentLogRecord("user_message", mapOf("text" to "Second conversation"))),
        )
        assertTrue(older.file.setLastModified(1_000L))
        assertTrue(newer.file.setLastModified(2_000L))

        val summaries = PhoneAgentHistoryStore(root).listConversations()

        assertEquals(listOf("Second conversation", "First conversation"), summaries.map { it.title })
        assertEquals(listOf(newer.file.name, older.file.name), summaries.map { it.fileName })
    }

    @Test
    fun loadsMessagesAndCollapsesToolLifecycleByCallId() {
        val root = temporaryFolder.newFolder("shared")
        val writer = PhoneAgentConversationStore(root)
        val session = writer.createSession(
            listOf(PhoneAgentLogRecord("user_message", mapOf("text" to "Read my note"))),
        )
        val arguments = JSONObject().put("path", "Documents/note.txt").toString()
        writer.append(
            session,
            listOf(
                PhoneAgentLogRecord("assistant_message", mapOf("text" to "I will read it.")),
                PhoneAgentLogRecord(
                    "tool_call",
                    mapOf(
                        "call_id" to "call-1",
                        "name" to "read_text_file",
                        "arguments" to arguments,
                        "approval_required" to false,
                    ),
                ),
                PhoneAgentLogRecord("tool_execution", mapOf("call_id" to "call-1", "name" to "read_text_file")),
                PhoneAgentLogRecord(
                    "tool_result",
                    mapOf(
                        "call_id" to "call-1",
                        "name" to "read_text_file",
                        "ok" to true,
                        "summary" to "读取 Documents/note.txt",
                    ),
                ),
            ),
        )

        val conversation = PhoneAgentHistoryStore(root).loadConversation(session.file.name)
        val tool = conversation.entries.single { it.role == "tool" }

        assertEquals(listOf("user", "assistant", "tool"), conversation.entries.map { it.role })
        assertEquals("done", tool.status)
        assertEquals("read_text_file", tool.toolCall?.name)
        assertEquals(listOf("Documents/note.txt"), tool.toolCall?.displayArguments()?.paths)
        assertThrows(IllegalArgumentException::class.java) {
            PhoneAgentHistoryStore(root).loadConversation("../outside.jsonl")
        }
    }
}

class PhoneAgentResponseValidationTest {
    @Test
    fun acceptsCompletedTextAndFunctionCallResponses() {
        validateCompletedPhoneAgentResponse(
            JSONObject(
                """{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}""",
            ),
        )
        validateCompletedPhoneAgentResponse(
            JSONObject(
                """{"status":"completed","output":[{"type":"reasoning"},{"type":"function_call","call_id":"call-1","name":"list_files","arguments":"{}"}]}""",
            ),
        )
    }

    @Test
    fun rejectsIncompleteFailedAndEmptyCompletedResponses() {
        val invalid = listOf(
            """{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[]}""",
            """{"status":"failed","error":{"message":"upstream failed"},"output":[]}""",
            """{"status":"completed","output":[]}""",
            """{"status":"completed","output":[{"type":"reasoning"}]}""",
        )
        invalid.forEach { raw ->
            assertThrows(IllegalStateException::class.java) {
                validateCompletedPhoneAgentResponse(JSONObject(raw))
            }
        }
    }

    @Test
    fun rejectsMalformedFunctionCalls() {
        assertThrows(IllegalStateException::class.java) {
            validateCompletedPhoneAgentResponse(
                JSONObject(
                    """{"status":"completed","output":[{"type":"function_call","call_id":"call-1","name":"list_files","arguments":"not-json"}]}""",
                ),
            )
        }
    }
}

class PhoneToolCallDisplayTest {
    @Test
    fun distillsWritePathAndFlagsWithoutExposingContent() {
        val secretContent = "private file body"
        val call = PhoneToolCall(
            "call-write",
            "write_text_file",
            JSONObject()
                .put("path", "Documents/notes.txt")
                .put("content", secretContent)
                .put("overwrite", true)
                .toString(),
        )

        val display = call.displayArguments()

        assertEquals(listOf("Documents/notes.txt"), display.paths)
        assertEquals(listOf("overwrite"), display.flags)
        assertFalse(display.toString().contains(secretContent))
    }

    @Test
    fun displaysArchiveDestinationAndSharedStorageRoot() {
        val unzip = PhoneToolCall(
            "call-unzip",
            "unzip_file",
            JSONObject().put("archive_path", "Download/bundle.zip").toString(),
        )
        val listRoot = PhoneToolCall("call-list", "list_files", "{}")

        assertEquals(
            listOf("Download/bundle.zip", PhoneAgentStorage.ROOT_PATH),
            unzip.displayArguments().paths,
        )
        assertEquals(listOf(PhoneAgentStorage.ROOT_PATH), listRoot.displayArguments().paths)
    }
}

class PhoneAgentConfigTest {
    @Test
    fun buildsResponsesEndpointWithoutDuplicatingV1() {
        assertEquals(
            "https://api.limen.codes/v1/responses",
            PhoneAgentConfigStore.responseUrl("https://api.limen.codes"),
        )
        assertEquals(
            "https://api.limen.codes/v1/responses",
            PhoneAgentConfigStore.responseUrl("https://api.limen.codes/v1/"),
        )
    }
}

private fun unzipCall(archive: String, destination: String, overwrite: Boolean = false): PhoneToolCall = PhoneToolCall(
    "unzip-${archive.hashCode()}",
    "unzip_file",
    JSONObject()
        .put("archive_path", archive)
        .put("destination_path", destination)
        .put("overwrite", overwrite)
        .toString(),
)

private fun writeZip(file: File, entries: List<Pair<String, ByteArray>>) {
    ZipOutputStream(file.outputStream()).use { zip ->
        entries.forEach { (name, bytes) ->
            zip.putNextEntry(ZipEntry(name))
            zip.write(bytes)
            zip.closeEntry()
        }
    }
}
