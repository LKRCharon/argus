package com.kairong.argus.data

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The friendly name can only be checked on a device: the vendor property that
 * holds it does not exist on an emulator or the JVM.
 */
@RunWith(AndroidJUnit4::class)
class DeviceNameTest {

    private val resolver
        get() = InstrumentationRegistry.getInstrumentation().targetContext.contentResolver

    @Test
    fun resolvesToSomethingNonEmpty() {
        val name = DeviceName.friendly(resolver)
        println("DeviceName.friendly() = $name (Build.MODEL = ${Build.MODEL})")
        assertTrue("name was blank", name.isNotBlank())
    }

    @Test
    fun prefersTheMarketingNameOverTheModelCode() {
        // On a device that publishes a marketing name, returning the bare model
        // means the property lookup silently failed — the exact regression this
        // guards, since the fallback chain still yields a plausible-looking name.
        val name = DeviceName.friendly(resolver)
        val hasMarketName = listOf(
            "ro.vivo.market.name", "ro.product.marketname",
            "ro.oppo.market.name", "ro.config.marketing_name",
        ).any { prop ->
            runCatching {
                val clazz = Class.forName("android.os.SystemProperties")
                val get = clazz.getMethod("get", String::class.java)
                (get.invoke(null, prop) as? String)?.isNotBlank() == true
            }.getOrDefault(false)
        }
        if (hasMarketName) {
            assertFalse("fell back to the model code", name.equals(Build.MODEL, ignoreCase = true))
        }
    }

    @Test
    fun survivesAMissingResolver() {
        assertTrue(DeviceName.friendly(null).isNotBlank())
    }
}
