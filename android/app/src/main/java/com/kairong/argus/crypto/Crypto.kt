package com.kairong.argus.crypto

import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.generators.HKDFBytesGenerator
import org.bouncycastle.crypto.params.HKDFParameters
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.bouncycastle.crypto.digests.SHA256Digest
import org.bouncycastle.crypto.macs.HMac
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

data class KeyPair(val secretKey: ByteArray, val publicKey: ByteArray)

fun generateKeyPair(): KeyPair {
    val priv = X25519PrivateKeyParameters(java.security.SecureRandom())
    return KeyPair(priv.encoded, priv.generatePublicKey().encoded)
}

fun dh(secretKey: ByteArray, peerPublicKey: ByteArray): ByteArray {
    val priv = X25519PrivateKeyParameters(secretKey, 0)
    val agreement = X25519Agreement()
    agreement.init(priv)
    val shared = ByteArray(agreement.agreementSize)
    agreement.calculateAgreement(X25519PublicKeyParameters(peerPublicKey, 0), shared, 0)
    return shared
}

fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

fun hkdf(ikm: ByteArray, salt: ByteArray?, info: String, length: Int): ByteArray {
    val gen = HKDFBytesGenerator(SHA256Digest())
    gen.init(HKDFParameters(ikm, salt, info.toByteArray()))
    val out = ByteArray(length)
    gen.generateBytes(out, 0, length)
    return out
}

fun hmacSha256(key: ByteArray, data: ByteArray): ByteArray {
    val mac = HMac(SHA256Digest())
    mac.init(org.bouncycastle.crypto.params.KeyParameter(key))
    mac.update(data, 0, data.size)
    val out = ByteArray(mac.macSize)
    mac.doFinal(out, 0)
    return out
}

fun pepperFromSecret(secret: String): ByteArray = sha256("agentlink/pepper/v1:$secret".toByteArray())

fun deriveConfirmKey(shared: ByteArray, pepper: ByteArray): ByteArray =
    hkdf(shared, pepper, "agentlink/confirm/v1", 32)

fun deriveChannelKey(shared: ByteArray): ByteArray =
    hkdf(shared, null, "agentlink/channel/v1", 32)

fun deriveLongTermKey(identityDh: ByteArray): ByteArray =
    hkdf(identityDh, null, "agentlink/longterm/v1", 32)

fun deriveChanToken(longTermKey: ByteArray): String =
    b64Encode(hkdf(longTermKey, null, "agentlink/chan-token/v1", 24))

fun fingerprint(publicKey: ByteArray): String {
    val hash = sha256(publicKey).copyOfRange(0, 12)
    return base32Encode(hash).take(20).chunked(4).joinToString("-")
}

fun constantTimeEquals(a: ByteArray, b: ByteArray): Boolean {
    if (a.size != b.size) return false
    var diff = 0
    for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
    return diff == 0
}

fun stableStringify(v: Any?): String = when (v) {
    null -> "null"
    is Map<*, *> -> v.entries.sortedBy { it.key.toString() }.joinToString(",", "{", "}") {
        "${JSONString(it.key.toString())}:${stableStringify(it.value)}"
    }
    is List<*> -> v.joinToString(",", "[", "]") { stableStringify(it) }
    is String -> JSONString(v)
    is Number, is Boolean -> v.toString()
    else -> JSONString(v.toString())
}

private fun JSONString(s: String): String = "\"" + escapeJson(s) + "\""

/** JSON.stringify-compatible escaping — control chars included. The old
 *  quote/backslash-only version made multi-line user input illegal JSON
 *  (silently dropped by the daemon) and could skew the pairing transcript. */
private fun escapeJson(s: String): String {
    val sb = StringBuilder(s.length + 8)
    for (ch in s) when (ch) {
        '\\' -> sb.append("\\\\")
        '"' -> sb.append("\\\"")
        '\n' -> sb.append("\\n")
        '\r' -> sb.append("\\r")
        '\t' -> sb.append("\\t")
        '\b' -> sb.append("\\b")
        '\u000C' -> sb.append("\\f")
        else -> if (ch < ' ') sb.append("\\u%04x".format(ch.code)) else sb.append(ch)
    }
    return sb.toString()
}

fun transcriptHash(a: Any?, b: Any?): ByteArray =
    sha256("${stableStringify(a)}|${stableStringify(b)}".toByteArray())

fun confirmTag(confirmKey: ByteArray, direction: String, transcript: ByteArray): ByteArray =
    hmacSha256(confirmKey, transcript + ":$direction".toByteArray())

// AES-256-GCM: [version(1)=0 | nonce(12) | ciphertext | authTag(16)]
fun aesEncrypt(key: ByteArray, plaintext: ByteArray, aad: ByteArray? = null): ByteArray {
    val nonce = randomBytes(12)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    aad?.let { cipher.updateAAD(it) }
    val ct = cipher.doFinal(plaintext)
    val out = ByteArray(1 + 12 + ct.size)
    out[0] = 0
    System.arraycopy(nonce, 0, out, 1, 12)
    System.arraycopy(ct, 0, out, 13, ct.size)
    return out
}

fun aesDecrypt(key: ByteArray, blob: ByteArray, aad: ByteArray? = null): ByteArray {
    require(blob.size >= 29 && blob[0].toInt() == 0) { "密文格式不正确" }
    val nonce = blob.copyOfRange(1, 13)
    val ct = blob.copyOfRange(13, blob.size)
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
    aad?.let { cipher.updateAAD(it) }
    return cipher.doFinal(ct)
}

class SecureChannel(private val key: ByteArray) {
    suspend fun seal(payload: Map<String, Any?>): String {
        val json = serialize(payload).toByteArray()
        return b64Encode(aesEncrypt(key, json))
    }
    fun open(blob: String): Map<String, Any?> {
        val plain = aesDecrypt(key, b64Decode(blob))
        return parseJson(String(plain))
    }
}

// Minimal JSON serializer/parser for Map<String, Any?>
private fun serialize(m: Map<String, Any?>): String =
    m.entries.joinToString(",", "{", "}") { "\"${it.key}\":${serializeValue(it.value)}" }
private fun serializeValue(v: Any?): String = when (v) {
    null -> "null"
    is String -> "\"${escapeJson(v)}\""
    is Number, is Boolean -> v.toString()
    is Map<*, *> -> serialize(v.entries.associate { it.key.toString() to it.value })
    is List<*> -> v.joinToString(",", "[", "]") { serializeValue(it) }
    else -> "\"$v\""
}

private fun parseJson(s: String): Map<String, Any?> {
    // Use org.json.JSONObject (available on Android)
    val obj = org.json.JSONObject(s)
    return obj.toMap()
}

private fun org.json.JSONObject.toMap(): Map<String, Any?> {
    val map = mutableMapOf<String, Any?>()
    for (key in keys()) {
        map[key] = when (val v = get(key)) {
            is org.json.JSONObject -> v.toMap()
            is org.json.JSONArray -> v.toList()
            else -> v
        }
    }
    return map
}

private fun org.json.JSONArray.toList(): List<Any?> =
    (0 until length()).map { i ->
        when (val v = get(i)) {
            is org.json.JSONObject -> v.toMap()
            is org.json.JSONArray -> v.toList()
            else -> v
        }
    }
