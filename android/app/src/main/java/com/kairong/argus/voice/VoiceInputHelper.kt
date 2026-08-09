package com.kairong.argus.voice

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.ComponentActivity
import androidx.core.content.ContextCompat
import java.util.Locale

class VoiceInputHelper(private val activity: ComponentActivity) {
    /** Which activity this helper is bound to — recreate on activity change. */
    val host: ComponentActivity get() = activity

    private var speechRecognizer: SpeechRecognizer? = null
    private var onResult: ((String) -> Unit)? = null
    private var onPartial: ((String) -> Unit)? = null
    private var onError: (() -> Unit)? = null

    var isListening = false
        private set

    // Lazily registered via activityResultRegistry (the lifecycle-free API):
    // this helper is created on first entry into a session screen, long after
    // the activity is RESUMED, and registerForActivityResult() throws there
    // ("must call register before they are STARTED" - crash on tapping a session).
    private var permissionLauncher: ActivityResultLauncher<String>? = null

    private fun launcher(): ActivityResultLauncher<String> {
        permissionLauncher?.let { return it }
        val l = activity.activityResultRegistry.register(
            "argus-voice-permission", ActivityResultContracts.RequestPermission()
        ) { granted -> if (granted) startListening() else onError?.invoke() }
        permissionLauncher = l
        return l
    }

    fun isAvailable(): Boolean =
        SpeechRecognizer.isRecognitionAvailable(activity) &&
        activity.packageManager.hasSystemFeature(PackageManager.FEATURE_MICROPHONE)

    fun start(onResult: (String) -> Unit, onPartial: (String) -> Unit, onError: () -> Unit) {
        this.onResult = onResult
        this.onPartial = onPartial
        this.onError = onError

        if (ContextCompat.checkSelfPermission(activity, android.Manifest.permission.RECORD_AUDIO)
            != PackageManager.PERMISSION_GRANTED) {
            launcher().launch(android.Manifest.permission.RECORD_AUDIO)
            return
        }
        startListening()
    }

    private fun startListening() {
        if (speechRecognizer == null) {
            speechRecognizer = SpeechRecognizer.createSpeechRecognizer(activity)
        }
        isListening = true
        val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, "zh-CN")
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
        }
        speechRecognizer?.setRecognitionListener(object : android.speech.RecognitionListener {
            override fun onReadyForSpeech(params: android.os.Bundle?) {}
            override fun onBeginningOfSpeech() {}
            override fun onRmsChanged(rmsdB: Float) {}
            override fun onBufferReceived(buffer: ByteArray?) {}
            override fun onEndOfSpeech() {}
            override fun onError(error: Int) {
                isListening = false
                onError?.invoke()
            }
            override fun onResults(results: android.os.Bundle?) {
                isListening = false
                val matches = results?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                if (!matches.isNullOrEmpty()) onResult?.invoke(matches[0])
                else onError?.invoke()
            }
            override fun onPartialResults(partialResults: android.os.Bundle?) {
                val matches = partialResults?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)
                if (!matches.isNullOrEmpty()) onPartial?.invoke(matches[0])
            }
            override fun onEvent(eventType: Int, params: android.os.Bundle?) {}
        })
        speechRecognizer?.startListening(intent)
    }

    fun stop() {
        isListening = false
        speechRecognizer?.stopListening()
    }

    fun destroy() {
        permissionLauncher?.unregister()
        permissionLauncher = null
        speechRecognizer?.destroy()
        speechRecognizer = null
    }
}
