package com.kairong.argus.data

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Environment
import org.json.JSONArray
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.CopyOption
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.util.ArrayDeque
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipFile

object PhoneAgentStorage {
    const val ROOT_PATH = "/storage/emulated/0"
    const val CONVERSATION_DIRECTORY_PATH = "$ROOT_PATH/Documents/PhoneAgent/conversations"
    private const val TRANSACTION_DIRECTORY_PATH = "$ROOT_PATH/Documents/PhoneAgent/.transactions"

    fun rootDirectory(): File = File(ROOT_PATH)

    fun conversationDirectory(root: File = rootDirectory()): File =
        File(root, "Documents/PhoneAgent/conversations")

    fun transactionDirectory(root: File = rootDirectory()): File =
        File(root, "Documents/PhoneAgent/.transactions")

    fun hasAccess(context: Context): Boolean = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        Environment.isExternalStorageManager()
    } else {
        context.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED &&
            context.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED
    }
}

internal data class ResolvedPhoneAgentPath(
    val file: File,
    val relativePath: String,
)

internal class PhoneAgentPathResolver(root: File) {
    val root: File = runCatching { resolveRealPath(root) }.getOrElse { root.canonicalFile }
    private val rootNioPath = this.root.toPath()

    fun resolve(raw: String, allowRoot: Boolean): ResolvedPhoneAgentPath {
        val normalized = raw.trim().replace('\\', '/')
        validateRawPath(normalized)
        val rawFile = File(normalized)
        val candidate = if (normalized.startsWith('/') || rawFile.isAbsolute) rawFile else File(root, normalized)
        val canonical = resolveRealPath(candidate)
        assertInside(canonical)
        val relative = rootNioPath.relativize(canonical.toPath()).joinToString("/") { it.toString() }
        if (!allowRoot && relative.isBlank()) throw IllegalArgumentException("路径不能是共享存储根目录")
        validateRelativeSegments(relative)
        return ResolvedPhoneAgentPath(canonical, relative)
    }

    fun assertInside(file: File) {
        val canonical = resolveRealPath(file)
        if (!canonical.toPath().startsWith(rootNioPath)) {
            throw IllegalArgumentException("路径超出共享存储根目录：${file.path}")
        }
    }

    fun relative(file: File): String {
        val canonical = resolveRealPath(file)
        assertInside(canonical)
        return rootNioPath.relativize(canonical.toPath()).joinToString("/") { it.toString() }
    }

    private fun validateRawPath(path: String) {
        if (path.contains('\u0000')) throw IllegalArgumentException("路径包含无效字符")
        if (path.length > 4096) throw IllegalArgumentException("路径过长")
        val segments = path.split('/').filter { it.isNotBlank() }
        if (segments.any { it == "." || it == ".." }) {
            throw IllegalArgumentException("路径不能包含 . 或 ..")
        }
        if (segments.any { it.length > 255 }) throw IllegalArgumentException("路径段过长")
    }

    private fun validateRelativeSegments(path: String) {
        if (path.split('/').filter { it.isNotBlank() }.any { it.length > 255 }) {
            throw IllegalArgumentException("路径段过长")
        }
    }

    private fun resolveRealPath(file: File): File {
        var cursor = file.absoluteFile.toPath().normalize()
        val missing = ArrayDeque<String>()
        while (!Files.exists(cursor, LinkOption.NOFOLLOW_LINKS)) {
            val name = cursor.fileName ?: throw IllegalArgumentException("路径无效：${file.path}")
            missing.addFirst(name.toString())
            cursor = cursor.parent ?: throw IllegalArgumentException("路径无效：${file.path}")
        }
        var resolved = cursor.toRealPath()
        for (segment in missing) resolved = resolved.resolve(segment)
        return resolved.normalize().toFile()
    }
}

internal data class PhoneFileLimits(
    val maxListEntries: Int = 200,
    val maxReadBytes: Int = 512 * 1024,
    val maxWriteBytes: Int = 1024 * 1024,
    val maxZipEntries: Int = 1000,
    val maxZipFileBytes: Long = 10L * 1024 * 1024,
    val maxZipTotalBytes: Long = 50L * 1024 * 1024,
)

internal class PhoneFileTools(
    root: File = PhoneAgentStorage.rootDirectory(),
    private val accessGranted: () -> Boolean = { true },
    private val limits: PhoneFileLimits = PhoneFileLimits(),
) {
    companion object {
        private val MUTATION_LOCK = Any()
    }

    private val resolver = PhoneAgentPathResolver(root)
    private val conversationRoot = PhoneAgentStorage.conversationDirectory(resolver.root)
    private val transactionRoot = PhoneAgentStorage.transactionDirectory(resolver.root)

    val rootPath: String get() = resolver.root.path

    fun execute(call: PhoneToolCall): ToolExecution {
        if (!accessGranted()) return failure("共享存储权限未授权或已被撤销")
        return try {
            val args = JSONObject(call.arguments.ifBlank { "{}" })
            when (call.name) {
                "list_files" -> list(args)
                "read_text_file" -> read(args)
                "write_text_file" -> synchronized(MUTATION_LOCK) { write(args) }
                "unzip_file" -> synchronized(MUTATION_LOCK) { unzip(args) }
                else -> failure("未知工具：${call.name}")
            }
        } catch (e: Exception) {
            failure(e.message ?: "工具执行失败")
        }
    }

    private fun list(args: JSONObject): ToolExecution {
        val requested = resolver.resolve(args.optString("path", ""), allowRoot = true)
        if (!requested.file.isDirectory) return failure("不是目录：${display(requested.relativePath)}")
        val recursive = args.optBoolean("recursive", false)
        val rows = JSONArray()
        val queue = ArrayDeque<ListNode>()
        val visited = mutableSetOf(requested.file.canonicalPath)
        queue.addLast(ListNode(requested.file, requested.relativePath))
        var skipped = 0
        var truncated = false

        listing@ while (queue.isNotEmpty()) {
            val node = queue.removeFirst()
            val children = node.file.listFiles()?.sortedBy { it.name.lowercase() }
            if (children == null) {
                if (node.file == requested.file && rows.length() == 0) {
                    throw IllegalStateException("无法读取目录：${display(node.relativePath)}")
                }
                skipped++
                continue
            }
            for (entry in children) {
                if (rows.length() >= limits.maxListEntries) {
                    truncated = true
                    break@listing
                }
                val resolvedEntry = runCatching { resolver.resolve(entry.absolutePath, allowRoot = false) }.getOrNull()
                if (resolvedEntry == null) {
                    skipped++
                    continue
                }
                val canonical = resolvedEntry.file
                val relative = joinRelative(node.relativePath, entry.name)
                val symbolicLink = runCatching { Files.isSymbolicLink(entry.toPath()) }.getOrDefault(false)
                rows.put(JSONObject().apply {
                    put("path", relative)
                    put("directory", entry.isDirectory)
                    put("size", if (entry.isFile) entry.length() else JSONObject.NULL)
                    put("last_modified", entry.lastModified())
                    put("symbolic_link", symbolicLink)
                })
                if (recursive && entry.isDirectory && !symbolicLink && visited.add(canonical.canonicalPath)) {
                    queue.addLast(ListNode(canonical, relative))
                }
            }
        }

        return success(JSONObject().apply {
            put("path", requested.relativePath)
            put("root", rootPath)
            put("entries", rows)
            put("truncated", truncated)
            put("skipped_unsafe_entries", skipped)
        }.toString(), "列出 ${rows.length()} 个条目")
    }

    private fun read(args: JSONObject): ToolExecution {
        val requested = resolver.resolve(required(args, "path"), allowRoot = false)
        if (!requested.file.isFile) return failure("文件不存在或不是普通文件：${display(requested.relativePath)}")
        val limit = args.optInt("max_bytes", limits.maxReadBytes).coerceIn(1, limits.maxReadBytes)
        if (requested.file.length() > limit) return failure("文件超过 $limit bytes 限制")
        val bytes = FileInputStream(requested.file).use { readLimited(it, limit) }
        val text = try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: Exception) {
            return failure("文件不是有效的 UTF-8 文本：${display(requested.relativePath)}")
        }
        return success(JSONObject().apply {
            put("path", requested.relativePath)
            put("absolute_path", requested.file.path)
            put("content", text)
            put("bytes", bytes.size)
        }.toString(), "读取 ${display(requested.relativePath)}")
    }

    private fun write(args: JSONObject): ToolExecution {
        val rawPath = required(args, "path")
        var requested = resolver.resolve(rawPath, allowRoot = false)
        assertMutable(requested.file)
        val bytes = args.optString("content", "").toByteArray(Charsets.UTF_8)
        if (bytes.size > limits.maxWriteBytes) return failure("写入内容超过 ${limits.maxWriteBytes} bytes 限制")
        val overwrite = args.optBoolean("overwrite", false)
        ensureDirectory(parentOf(requested.file), mutableListOf())
        requested = resolver.resolve(requested.file.path, allowRoot = false)
        assertMutable(requested.file)
        if (requested.file.isDirectory) return failure("目标是目录：${display(requested.relativePath)}")
        val existed = requested.file.exists()
        if (existed && !overwrite) return failure("目标已存在，需显式 overwrite=true：${display(requested.relativePath)}")
        atomicWrite(requested.file, bytes, overwrite)
        return success(JSONObject().apply {
            put("path", requested.relativePath)
            put("absolute_path", requested.file.path)
            put("bytes", bytes.size)
            put("overwritten", existed)
        }.toString(), "写入 ${display(requested.relativePath)}")
    }

    private fun unzip(args: JSONObject): ToolExecution {
        val archive = resolver.resolve(required(args, "archive_path"), allowRoot = false)
        if (!archive.file.isFile) return failure("压缩包不存在或不是普通文件：${display(archive.relativePath)}")
        val destination = resolver.resolve(args.optString("destination_path", ""), allowRoot = true)
        if (destination.file.exists() && !destination.file.isDirectory) {
            return failure("解压目标不是目录：${display(destination.relativePath)}")
        }
        val overwrite = args.optBoolean("overwrite", false)
        ensureTransactionRoot()
        val transaction = File(transactionRoot, UUID.randomUUID().toString())
        if (!transaction.mkdir()) throw IllegalStateException("无法创建解压事务目录")
        val stage = File(transaction, "stage").also { if (!it.mkdir()) throw IllegalStateException("无法创建解压暂存目录") }
        val backup = File(transaction, "backup").also { if (!it.mkdir()) throw IllegalStateException("无法创建解压备份目录") }
        var preserveTransaction = false

        try {
            val targetPlans: List<ZipTargetPlan>
            var totalBytes: Long
            ZipFile(archive.file).use { zip ->
                val entries = inspectZip(zip)
                targetPlans = preflightTargets(entries, destination, archive.file, overwrite)
                totalBytes = extractToStage(zip, entries, stage)
            }
            try {
                commitStagedFiles(targetPlans, stage, backup)
            } catch (e: PreserveTransactionException) {
                preserveTransaction = true
                throw e
            }
            val files = targetPlans.filterNot { it.entry.directory }
            val sample = JSONArray()
            files.take(200).forEach { sample.put(it.targetRelativePath) }
            return success(JSONObject().apply {
                put("archive_path", archive.relativePath)
                put("destination_path", destination.relativePath)
                put("files", files.size)
                put("bytes", totalBytes)
                put("written_sample", sample)
            }.toString(), "解压 ${files.size} 个文件到 ${display(destination.relativePath)}")
        } finally {
            if (!preserveTransaction) transaction.deleteRecursively()
        }
    }

    private fun inspectZip(zip: ZipFile): List<ZipPlanEntry> {
        val plans = mutableListOf<ZipPlanEntry>()
        val normalizedTargets = mutableSetOf<String>()
        var totalBytes = 0L
        val entries = zip.entries()
        while (entries.hasMoreElements()) {
            val entry = entries.nextElement()
            if (plans.size >= limits.maxZipEntries) {
                throw IllegalStateException("压缩包条目超过 ${limits.maxZipEntries} 个")
            }
            val relative = normalizeZipEntryPath(entry.name)
            if (!normalizedTargets.add(relative)) throw IllegalStateException("压缩包包含重复路径：$relative")
            if (entry.size > limits.maxZipFileBytes) {
                throw IllegalStateException("压缩包单文件超过 ${limits.maxZipFileBytes} bytes：$relative")
            }
            var actualBytes = 0L
            if (!entry.isDirectory) {
                zip.getInputStream(entry).use { input ->
                    actualBytes = countLimited(input, limits.maxZipFileBytes) { count ->
                        totalBytes += count
                        if (totalBytes > limits.maxZipTotalBytes) {
                            throw IllegalStateException("压缩包内容超过 ${limits.maxZipTotalBytes} bytes 限制")
                        }
                    }
                }
            }
            plans += ZipPlanEntry(entry, relative, entry.isDirectory, actualBytes)
        }

        val filePaths = plans.filterNot { it.directory }.mapTo(mutableSetOf()) { it.relativePath }
        for (plan in plans) {
            var prefix = plan.relativePath.substringBeforeLast('/', "")
            while (prefix.isNotBlank()) {
                if (prefix in filePaths) throw IllegalStateException("压缩包路径同时被用作文件和目录：$prefix")
                prefix = prefix.substringBeforeLast('/', "")
            }
        }
        return plans
    }

    private fun preflightTargets(
        entries: List<ZipPlanEntry>,
        destination: ResolvedPhoneAgentPath,
        archive: File,
        overwrite: Boolean,
    ): List<ZipTargetPlan> {
        val canonicalTargets = mutableSetOf<String>()
        return entries.map { entry ->
            val targetRelative = joinRelative(destination.relativePath, entry.relativePath)
            val target = resolver.resolve(targetRelative, allowRoot = false)
            assertMutable(target.file)
            if (!canonicalTargets.add(target.file.canonicalPath)) {
                throw IllegalStateException("压缩包中的多个条目指向同一目标：$targetRelative")
            }
            val existingParent = nearestExistingParent(parentOf(target.file))
            if (!existingParent.isDirectory) {
                throw IllegalStateException("解压路径中的条目不是目录：${resolver.relative(existingParent)}")
            }
            if (entry.directory && target.file.exists() && !target.file.isDirectory) {
                throw IllegalStateException("解压目录目标已是文件：$targetRelative")
            }
            if (!entry.directory && target.file.isDirectory) {
                throw IllegalStateException("解压文件目标已是目录：$targetRelative")
            }
            if (!entry.directory && target.file.exists() && !overwrite) {
                throw IllegalStateException("解压目标已存在，需显式 overwrite=true：$targetRelative")
            }
            if (!entry.directory && target.file.canonicalFile == archive.canonicalFile) {
                throw IllegalStateException("不能用压缩包内容覆盖压缩包自身：$targetRelative")
            }
            ZipTargetPlan(entry, target.file, targetRelative, overwrite)
        }
    }

    private fun extractToStage(zip: ZipFile, plans: List<ZipPlanEntry>, stage: File): Long {
        var totalBytes = 0L
        for (plan in plans) {
            val staged = File(stage, plan.relativePath).canonicalFile
            if (!staged.toPath().startsWith(stage.canonicalFile.toPath())) {
                throw IllegalStateException("压缩包路径逃逸：${plan.relativePath}")
            }
            if (plan.directory) {
                if (!staged.mkdirs() && !staged.isDirectory) throw IllegalStateException("无法暂存目录：${plan.relativePath}")
                continue
            }
            val stagedParent = parentOf(staged)
            if (!stagedParent.mkdirs() && !stagedParent.isDirectory) {
                throw IllegalStateException("无法暂存目录：${plan.relativePath}")
            }
            var fileBytes = 0L
            zip.getInputStream(plan.entry).use { input ->
                FileOutputStream(staged).use { output ->
                    val buffer = ByteArray(8192)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        fileBytes += count
                        totalBytes += count
                        if (fileBytes > limits.maxZipFileBytes || totalBytes > limits.maxZipTotalBytes) {
                            throw IllegalStateException("压缩包内容在解压时超过大小限制")
                        }
                        output.write(buffer, 0, count)
                    }
                    output.fd.sync()
                }
            }
            if (fileBytes != plan.measuredBytes) throw IllegalStateException("压缩包内容在预检后发生变化：${plan.relativePath}")
        }
        return totalBytes
    }

    private fun commitStagedFiles(plans: List<ZipTargetPlan>, stage: File, backup: File) {
        val createdDirectories = mutableListOf<File>()
        val committed = mutableListOf<CommittedFile>()
        try {
            plans.filter { it.entry.directory }
                .sortedBy { depth(it.targetRelativePath) }
                .forEach { ensureDirectory(it.target, createdDirectories) }

            plans.filterNot { it.entry.directory }.forEachIndexed { index, plan ->
                ensureDirectory(parentOf(plan.target), createdDirectories)
                val staged = File(stage, plan.entry.relativePath)
                if (plan.target.exists() && !plan.allowOverwrite) {
                    throw IllegalStateException("解压提交时目标已出现，未覆盖：${plan.targetRelativePath}")
                }
                val backupFile = if (plan.target.exists()) File(backup, index.toString()) else null
                val record = CommittedFile(plan.target, backupFile)
                if (backupFile != null) movePath(plan.target, backupFile, overwrite = false)
                committed += record
                movePath(staged, plan.target, overwrite = false)
                record.installed = true
            }
        } catch (failure: Exception) {
            val rollbackErrors = mutableListOf<String>()
            for (record in committed.asReversed()) {
                runCatching {
                    if (record.installed && record.target.exists() && !record.target.delete()) {
                        throw IllegalStateException("无法删除 ${record.target.path}")
                    }
                    record.backup?.takeIf { it.exists() }?.let {
                        if (record.target.exists()) {
                            throw IllegalStateException("目标被其他进程占用，无法恢复 ${record.target.path}")
                        }
                        movePath(it, record.target, overwrite = false)
                    }
                }.onFailure { rollbackErrors += it.message ?: "未知回滚错误" }
            }
            createdDirectories.asReversed().forEach { directory ->
                if (directory.exists() && directory.list()?.isEmpty() == true && !directory.delete()) {
                    rollbackErrors += "无法删除目录 ${directory.path}"
                }
            }
            if (rollbackErrors.isNotEmpty()) {
                throw PreserveTransactionException(
                    "解压失败且回滚不完整；恢复数据保留在 ${parentOf(backup).path}：${rollbackErrors.joinToString("；")}",
                    failure,
                )
            }
            throw IllegalStateException("解压失败，已回滚：${failure.message ?: "未知错误"}", failure)
        }
    }

    private fun ensureTransactionRoot() {
        resolver.assertInside(transactionRoot)
        if (!transactionRoot.mkdirs() && !transactionRoot.isDirectory) {
            throw IllegalStateException("无法创建解压事务目录：${transactionRoot.path}")
        }
        resolver.assertInside(transactionRoot.canonicalFile)
    }

    private fun ensureDirectory(directory: File, created: MutableList<File>) {
        resolver.assertInside(directory)
        val missing = ArrayDeque<File>()
        var current = directory
        while (!current.exists()) {
            missing.addFirst(current)
            current = current.parentFile ?: throw IllegalStateException("目录没有父路径：${directory.path}")
            resolver.assertInside(current)
        }
        if (!current.isDirectory) throw IllegalStateException("路径中的条目不是目录：${current.path}")
        for (item in missing) {
            if (!item.mkdir() && !item.isDirectory) throw IllegalStateException("无法创建目录：${item.path}")
            resolver.assertInside(item.canonicalFile)
            created += item
        }
    }

    private fun nearestExistingParent(start: File): File {
        var current = start
        while (!current.exists()) {
            current = current.parentFile ?: throw IllegalStateException("路径没有现有父目录：${start.path}")
            resolver.assertInside(current)
        }
        return current
    }

    private fun assertMutable(file: File) {
        val canonical = file.canonicalFile
        resolver.assertInside(canonical)
        if (isSameOrDescendant(conversationRoot, canonical) || isSameOrDescendant(transactionRoot, canonical)) {
            throw IllegalArgumentException("Agent 会话与事务目录禁止通过文件工具修改：${resolver.relative(canonical)}")
        }
    }

    private fun display(relative: String): String = relative.ifBlank { rootPath }

    private data class ListNode(val file: File, val relativePath: String)
    private data class ZipPlanEntry(
        val entry: ZipEntry,
        val relativePath: String,
        val directory: Boolean,
        val measuredBytes: Long,
    )
    private data class ZipTargetPlan(
        val entry: ZipPlanEntry,
        val target: File,
        val targetRelativePath: String,
        val allowOverwrite: Boolean,
    )
    private data class CommittedFile(val target: File, val backup: File?, var installed: Boolean = false)
    private class PreserveTransactionException(message: String, cause: Throwable) : IllegalStateException(message, cause)
}

internal data class PhoneAgentLogRecord(
    val type: String,
    val data: Map<String, Any?> = emptyMap(),
)

internal data class PhoneAgentConversationSession(
    val id: String,
    val file: File,
)

internal class PhoneAgentConversationStore(
    root: File = PhoneAgentStorage.rootDirectory(),
    private val secrets: () -> Collection<String> = { emptyList() },
    private val clock: () -> Instant = { Instant.now() },
) {
    private val resolver = PhoneAgentPathResolver(root)
    private val storageRoot = resolver.root
    private val secretHistory = linkedSetOf<String>()
    val directory: File = PhoneAgentStorage.conversationDirectory(storageRoot)

    @Synchronized
    fun createSession(initialRecords: List<PhoneAgentLogRecord>): PhoneAgentConversationSession {
        val safeDirectory = resolver.resolve("Documents/PhoneAgent/conversations", allowRoot = false).file
        if (!safeDirectory.mkdirs() && !safeDirectory.isDirectory) {
            throw IllegalStateException("无法创建会话记录目录：${safeDirectory.path}")
        }
        resolver.assertInside(safeDirectory)
        val id = UUID.randomUUID().toString()
        val timestamp = FILE_TIME_FORMAT.format(clock())
        val file = File(safeDirectory, "${timestamp}_$id.jsonl")
        if (!file.createNewFile()) throw IllegalStateException("无法创建会话记录：${file.path}")
        val session = PhoneAgentConversationSession(id, file)
        appendInternal(
            session,
            listOf(
                PhoneAgentLogRecord(
                    "session_start",
                    mapOf(
                        "schema_version" to 1,
                        "storage_root" to storageRoot.path,
                    ),
                ),
            ) + initialRecords,
            requireExisting = true,
        )
        return session
    }

    @Synchronized
    fun append(session: PhoneAgentConversationSession, records: List<PhoneAgentLogRecord>) {
        if (records.isEmpty()) return
        appendInternal(session, records, requireExisting = true)
    }

    private fun appendInternal(
        session: PhoneAgentConversationSession,
        records: List<PhoneAgentLogRecord>,
        requireExisting: Boolean,
    ) {
        val canonicalFile = session.file.canonicalFile
        resolver.assertInside(canonicalFile)
        val safeDirectory = resolver.resolve("Documents/PhoneAgent/conversations", allowRoot = false).file
        if (canonicalFile.parentFile != safeDirectory) throw IllegalStateException("会话记录路径无效")
        if (requireExisting && !canonicalFile.isFile) throw IllegalStateException("会话记录文件已丢失：${canonicalFile.path}")
        secretHistory += secrets().filter { it.isNotBlank() }
        val activeSecrets = secretHistory.toList()
        val payload = buildString {
            for (record in records) {
                val redacted = redactPhoneAgentSecrets(record.data, activeSecrets) as Map<*, *>
                val line = JSONObject().apply {
                    put("timestamp", clock().toString())
                    put("session_id", session.id)
                    put("type", record.type)
                    put("data", phoneAgentJsonValue(redacted))
                }
                append(line.toString())
                append('\n')
            }
        }.toByteArray(Charsets.UTF_8)
        FileOutputStream(canonicalFile, true).use { output ->
            output.write(payload)
            output.fd.sync()
        }
    }

    companion object {
        private val FILE_TIME_FORMAT = DateTimeFormatter.ofPattern("yyyyMMdd'T'HHmmss.SSS'Z'")
            .withZone(ZoneOffset.UTC)
    }
}

internal fun redactPhoneAgentSecrets(value: Any?, secrets: Collection<String>): Any? = when (value) {
    is String -> secrets.fold(value) { text, secret -> text.replace(secret, "[REDACTED]") }
    is Map<*, *> -> value.entries.associate { (key, child) -> key.toString() to redactPhoneAgentSecrets(child, secrets) }
    is Iterable<*> -> value.map { redactPhoneAgentSecrets(it, secrets) }
    is Array<*> -> value.map { redactPhoneAgentSecrets(it, secrets) }
    else -> value
}

internal fun normalizeZipEntryPath(raw: String): String {
    val normalized = raw.replace('\\', '/').trimEnd('/')
    if (normalized.isBlank()) throw IllegalArgumentException("压缩包包含空路径")
    if (normalized.startsWith('/') || DRIVE_ABSOLUTE.matches(normalized) || normalized.contains('\u0000')) {
        throw IllegalArgumentException("压缩包包含绝对或无效路径：$raw")
    }
    val segments = normalized.split('/').filter { it.isNotBlank() }
    if (segments.any { it == "." || it == ".." }) throw IllegalArgumentException("压缩包包含路径穿越：$raw")
    if (segments.any { it.length > 255 }) throw IllegalArgumentException("压缩包路径段过长：$raw")
    if (normalized.length > 4096) throw IllegalArgumentException("压缩包路径过长")
    return segments.joinToString("/")
}

internal fun atomicWrite(target: File, bytes: ByteArray, overwrite: Boolean) {
    val parent = target.parentFile ?: throw IllegalArgumentException("目标文件没有父目录")
    val temporary = File.createTempFile(".phone-agent-", ".tmp", parent)
    try {
        FileOutputStream(temporary).use { output ->
            output.write(bytes)
            output.fd.sync()
        }
        movePath(temporary, target, overwrite)
    } finally {
        if (temporary.exists()) temporary.delete()
    }
}

private fun movePath(source: File, target: File, overwrite: Boolean) {
    val atomicOptions = mutableListOf<CopyOption>(StandardCopyOption.ATOMIC_MOVE)
    val fallbackOptions = mutableListOf<CopyOption>()
    if (overwrite) {
        atomicOptions += StandardCopyOption.REPLACE_EXISTING
        fallbackOptions += StandardCopyOption.REPLACE_EXISTING
    }
    try {
        Files.move(source.toPath(), target.toPath(), *atomicOptions.toTypedArray())
    } catch (_: AtomicMoveNotSupportedException) {
        Files.move(source.toPath(), target.toPath(), *fallbackOptions.toTypedArray())
    } catch (_: UnsupportedOperationException) {
        Files.move(source.toPath(), target.toPath(), *fallbackOptions.toTypedArray())
    }
}

private fun readLimited(input: InputStream, limit: Int): ByteArray {
    val output = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    var total = 0
    while (true) {
        val count = input.read(buffer)
        if (count < 0) break
        total += count
        if (total > limit) throw IllegalStateException("文件超过 $limit bytes 限制")
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}

private fun countLimited(input: InputStream, limit: Long, onRead: (Long) -> Unit): Long {
    val buffered = if (input is BufferedInputStream) input else BufferedInputStream(input)
    val buffer = ByteArray(8192)
    var total = 0L
    while (true) {
        val count = buffered.read(buffer)
        if (count < 0) break
        total += count
        if (total > limit) throw IllegalStateException("压缩包单文件超过 $limit bytes 限制")
        onRead(count.toLong())
    }
    return total
}

private fun required(args: JSONObject, key: String): String = args.optString(key, "").trim().ifBlank {
    throw IllegalArgumentException("缺少参数：$key")
}

private fun joinRelative(parent: String, child: String): String = listOf(parent, child)
    .filter { it.isNotBlank() }
    .joinToString("/")

private fun depth(path: String): Int = path.count { it == '/' }

private fun parentOf(file: File): File = file.parentFile
    ?: throw IllegalArgumentException("路径没有父目录：${file.path}")

private fun isSameOrDescendant(base: File, target: File): Boolean =
    target.canonicalFile.toPath().startsWith(base.canonicalFile.toPath())

private fun phoneAgentJsonValue(value: Any?): Any = when (value) {
    null -> JSONObject.NULL
    is Map<*, *> -> JSONObject().also { obj ->
        value.forEach { (key, child) -> obj.put(key.toString(), phoneAgentJsonValue(child)) }
    }
    is Iterable<*> -> JSONArray().also { array -> value.forEach { array.put(phoneAgentJsonValue(it)) } }
    is Array<*> -> JSONArray().also { array -> value.forEach { array.put(phoneAgentJsonValue(it)) } }
    else -> value
}

private fun success(output: String, summary: String): ToolExecution = ToolExecution(true, output, summary)

private fun failure(message: String): ToolExecution = ToolExecution(
    false,
    JSONObject().apply {
        put("ok", false)
        put("error", message)
    }.toString(),
    message,
)

private val DRIVE_ABSOLUTE = Regex("^[A-Za-z]:/")
