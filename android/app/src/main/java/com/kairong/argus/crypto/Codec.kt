package com.kairong.argus.crypto

import java.util.Base64

private val B32_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ".toCharArray()
private val B32_REV = HashMap<Char, Int>().apply {
    B32_ALPHABET.forEachIndexed { i, c -> put(c, i) }
    put('I', 1); put('L', 1); put('O', 0)
}

fun base32Encode(data: ByteArray): String {
    val sb = StringBuilder()
    var bits = 0; var value = 0
    for (b in data) {
        value = (value shl 8) or (b.toInt() and 0xFF)
        bits += 8
        while (bits >= 5) {
            sb.append(B32_ALPHABET[(value ushr (bits - 5)) and 0x1F])
            bits -= 5
        }
    }
    if (bits > 0) sb.append(B32_ALPHABET[(value shl (5 - bits)) and 0x1F])
    return sb.toString()
}

fun base32Decode(input: String): ByteArray {
    val clean = input.uppercase().replace(Regex("[-\\s]"), "")
    val out = ArrayList<Int>()
    var bits = 0; var value = 0
    for (ch in clean) {
        val v = B32_REV[ch] ?: throw IllegalArgumentException("invalid base32: $ch")
        value = (value shl 5) or v
        bits += 5
        if (bits >= 8) { out.add((value ushr (bits - 8)) and 0xFF); bits -= 8 }
    }
    return out.map { it.toByte() }.toByteArray()
}

fun b64Encode(data: ByteArray): String = Base64.getEncoder().encodeToString(data)
fun b64Decode(s: String): ByteArray = Base64.getDecoder().decode(s)

fun randomBytes(n: Int): ByteArray = ByteArray(n).also { java.security.SecureRandom().nextBytes(it) }

data class PairCode(val nameplate: String, val secret: String, val display: String)

fun generatePairCode(): PairCode {
    val nameplate = String.format("%04d", (Math.random() * 10000).toInt())
    val secret = base32Encode(randomBytes(4)).take(6)
    return PairCode(nameplate, secret, "$nameplate-$secret")
}

fun parsePairCode(input: String): PairCode {
    val clean = input.trim().uppercase().replace(Regex("\\s+"), "")
    val m = Regex("^(\\d{4})-?([0-9A-Z]{6})$").find(clean)
        ?: throw IllegalArgumentException("配对码格式不正确，应为 NNNN-XXXXXX")
    val nameplate = m.groupValues[1]
    val secretRaw = m.groupValues[2]
    val secret = secretRaw.map { ch ->
        val v = B32_REV[ch] ?: throw IllegalArgumentException("非法字符: $ch")
        B32_ALPHABET[v]
    }.joinToString("")
    return PairCode(nameplate, secret, "$nameplate-$secret")
}
