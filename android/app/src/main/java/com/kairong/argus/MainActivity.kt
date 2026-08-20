package com.kairong.argus

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.runtime.mutableStateOf
import com.kairong.argus.ui.ArgusApp
import com.kairong.argus.ui.ArgusViewModel

class MainActivity : ComponentActivity() {
    /** argus://pair deep link — set on cold start and warm re-entry (singleTask). */
    private val pairLink = mutableStateOf<Uri?>(null)
    private val argusViewModel: ArgusViewModel by viewModels()
    private val legacyStoragePermissions: ActivityResultLauncher<Array<String>> =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            argusViewModel.refreshPhoneAgentStorageAccess()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        pairLink.value = intent?.data
        setContent {
            ArgusApp(
                this,
                pairLink,
                onGrantPhoneAgentAccess = ::requestStorageAccess,
                providedViewModel = argusViewModel,
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pairLink.value = intent.data
    }

    private fun requestStorageAccess() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
            legacyStoragePermissions.launch(
                arrayOf(Manifest.permission.READ_EXTERNAL_STORAGE, Manifest.permission.WRITE_EXTERNAL_STORAGE),
            )
            return
        }
        val appSettings = Intent(
            Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            Uri.parse("package:$packageName"),
        )
        if (runCatching { startActivity(appSettings) }.isFailure) {
            val generalSettings = runCatching {
                startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
            }
            if (generalSettings.isFailure) {
                runCatching {
                    startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
                }
            }
        }
    }
}
