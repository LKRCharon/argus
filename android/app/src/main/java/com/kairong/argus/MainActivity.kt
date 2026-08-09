package com.kairong.argus

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.mutableStateOf
import com.kairong.argus.ui.ArgusApp

class MainActivity : ComponentActivity() {
    /** argus://pair deep link — set on cold start and warm re-entry (singleTask). */
    private val pairLink = mutableStateOf<Uri?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        pairLink.value = intent?.data
        setContent { ArgusApp(this, pairLink) }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        pairLink.value = intent.data
    }
}
