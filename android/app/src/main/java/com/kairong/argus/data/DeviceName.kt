package com.kairong.argus.data

import android.content.ContentResolver
import android.os.Build
import android.provider.Settings

/**
 * The device name to show on the Mac after pairing.
 *
 * `Build.MODEL` is an internal designation — "V2502DA" rather than
 * "vivo X300 Pro" — which is useless for telling two paired phones apart. Vendors
 * keep the marketing name in a private system property instead, and there is no
 * platform API for it, so the property is read reflectively.
 *
 * Measured on the vivo test device:
 *   ro.vivo.market.name          = vivo X300 Pro 卫星通信版
 *   settings get secure bluetooth_name = vivo X300 Pro 卫星通信版
 *   settings get global device_name     = V2502DA   (not the friendly one)
 *   Build.MODEL                  = V2502DA
 *
 * Note that `Settings.Global.DEVICE_NAME` is *not* preferred: on this device it
 * echoes the model, so trusting it first would have kept the unhelpful name.
 */
object DeviceName {

    /** Vendor properties holding a marketing name, in the order worth trying. */
    private val MARKET_NAME_PROPS = listOf(
        "ro.vivo.market.name",      // vivo / iQOO
        "ro.product.marketname",    // Xiaomi / Redmi / POCO
        "ro.oppo.market.name",      // OPPO / OnePlus / realme
        "ro.config.marketing_name", // Honor / Huawei
    )

    /**
     * Best available human-readable name, falling back through vendor property →
     * Bluetooth name → manufacturer + model. Never empty.
     */
    fun friendly(resolver: ContentResolver?): String {
        for (prop in MARKET_NAME_PROPS) {
            systemProperty(prop)?.let { return it }
        }
        // The Bluetooth name is usually the marketing name and is user-visible,
        // which makes it a better guess than the model.
        resolver?.let { r ->
            runCatching { Settings.Secure.getString(r, "bluetooth_name") }
                .getOrNull()
                ?.takeIf { it.isNotBlank() && !it.equals(Build.MODEL, ignoreCase = true) }
                ?.let { return it }
        }
        val manufacturer = Build.MANUFACTURER.orEmpty().trim()
        val model = Build.MODEL.orEmpty().trim()
        return when {
            model.isEmpty() -> manufacturer.ifEmpty { "Android" }
            model.startsWith(manufacturer, ignoreCase = true) -> model
            manufacturer.isEmpty() -> model
            // "vivo V2502DA" still beats a bare code when no marketing name exists.
            else -> "${manufacturer.replaceFirstChar { it.uppercase() }} $model"
        }
    }

    /**
     * Read a read-only system property.
     *
     * `android.os.SystemProperties` is hidden API, so reflection is the only way
     * in; a vendor without the property simply yields null.
     */
    private fun systemProperty(key: String): String? = runCatching {
        val clazz = Class.forName("android.os.SystemProperties")
        val get = clazz.getMethod("get", String::class.java)
        (get.invoke(null, key) as? String)?.trim()?.takeIf { it.isNotEmpty() }
    }.getOrNull()
}
