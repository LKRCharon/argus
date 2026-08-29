package com.kairong.argus

import android.Manifest
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.SmartToy
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.kairong.argus.ui.PhoneAgentScreen
import com.kairong.argus.ui.PhoneAgentViewModel
import com.kairong.argus.ui.theme.ArgusAppTheme
import com.kairong.argus.ui.theme.ArgusRadius
import com.kairong.argus.ui.theme.ArgusTheme

class PhoneAgentActivity : ComponentActivity() {
    private val phoneAgentViewModel: PhoneAgentViewModel by viewModels()
    private val legacyStoragePermissions: ActivityResultLauncher<Array<String>> =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
            phoneAgentViewModel.refreshPhoneAgentStorageAccess()
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            ArgusAppTheme {
                val colors = ArgusTheme.colors
                Column(
                    Modifier.fillMaxSize().background(colors.canvas).statusBarsPadding(),
                ) {
                    Row(
                        Modifier.fillMaxWidth().padding(horizontal = 18.dp, vertical = 14.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(Icons.Default.SmartToy, null, tint = colors.accent, modifier = Modifier.size(22.dp))
                        Spacer(Modifier.width(9.dp))
                        Text("手机 Agent", fontSize = 18.sp, fontWeight = FontWeight.SemiBold, color = colors.textPrimary)
                    }
                    Surface(
                        color = colors.sheet,
                        shape = RoundedCornerShape(
                            topStart = ArgusRadius.SHEET.dp,
                            topEnd = ArgusRadius.SHEET.dp,
                        ),
                        modifier = Modifier.fillMaxWidth().weight(1f),
                    ) {
                        Column(Modifier.navigationBarsPadding().padding(top = 14.dp)) {
                            PhoneAgentScreen(phoneAgentViewModel, onGrantAccess = ::requestStorageAccess)
                        }
                    }
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        phoneAgentViewModel.refreshPhoneAgentStorageAccess()
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
