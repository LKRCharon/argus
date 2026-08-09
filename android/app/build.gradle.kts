import java.util.Properties

val configuredRelayUrl = providers.gradleProperty("argusRelayUrl")
    .orElse(providers.environmentVariable("ARGUS_RELAY_URL"))
    .orNull
    ?.trim()
    .orEmpty()
val escapedRelayUrl = configuredRelayUrl
    .replace("\\", "\\\\")
    .replace("\"", "\\\"")

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
}

android {
    namespace = "com.kairong.argus"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.kairong.argus"
        minSdk = 29
        // Instrumented tests: the Keystore-backed vault can only be exercised on
        // a real device, and it guards the identity and pairings.
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Note: AGP's connectedAndroidTest always uninstalls the app afterwards
        // and offers no switch for it (issuetracker 37077961) — which wipes the
        // device identity and every pairing. Use scripts/test-device.sh instead;
        // it installs both APKs and drives `am instrument` directly.
        targetSdk = 35
        versionCode = 3
        versionName = "0.2.1"
        // Public source never embeds a relay endpoint. A local developer may
        // supply ARGUS_RELAY_URL or -PargusRelayUrl for a private build.
        buildConfigField("String", "DEFAULT_RELAY_URL", "\"$escapedRelayUrl\"")
    }

    buildTypes {
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release { isMinifyEnabled = false }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures {
        compose = true
        buildConfig = true
    }

    // Release signing lives outside the repo (~/.android-keys); absent file
    // means unsigned release builds, so other machines still compile.
    val ksProps = Properties()
    val ksFile = File(System.getProperty("user.home"), ".android-keys/argus-keystore.properties")
    if (ksFile.exists()) {
        ksFile.inputStream().use { ksProps.load(it) }
        signingConfigs.create("release") {
            storeFile = file(ksProps.getProperty("storeFile"))
            storePassword = ksProps.getProperty("storePassword")
            keyAlias = ksProps.getProperty("keyAlias")
            keyPassword = ksProps.getProperty("keyPassword")
        }
        buildTypes.getByName("release").signingConfig = signingConfigs.getByName("release")
    }
}

dependencies {
    val composeBom = platform("androidx.compose:compose-bom:2024.10.00")
    implementation(composeBom)
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.ui:ui-tooling-preview")
    implementation("androidx.activity:activity-compose:1.9.2")
    implementation("androidx.navigation:navigation-compose:2.8.2")
    implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.8.6")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
    // Only still here for the one-time migration off it in IdentityStore;
    // Google deprecated the whole API in 1.1.0 ("use Android Keystore directly").
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    implementation("androidx.camera:camera-camera2:1.3.4")
    implementation("androidx.camera:camera-lifecycle:1.3.4")
    implementation("androidx.camera:camera-view:1.3.4")
    implementation("com.google.mlkit:barcode-scanning:17.3.0")
    implementation("com.mikepenz:multiplatform-markdown-renderer-m3:0.27.0")
    debugImplementation("androidx.compose.ui:ui-tooling")
}
