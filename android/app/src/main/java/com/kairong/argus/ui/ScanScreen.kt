package com.kairong.argus.ui

import android.Manifest
import android.content.pm.PackageManager
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.OptIn
import androidx.camera.core.CameraSelector
import androidx.camera.core.ExperimentalGetImage
import androidx.camera.core.ImageAnalysis
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.camera.view.PreviewView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalLifecycleOwner
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.content.ContextCompat
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage

/** argus://pair?code=…&relay=… or a bare pairing code -> (code, relay?). */
fun parsePairLink(raw: String): Pair<String, String?>? {
    val t = raw.trim()
    if (t.startsWith("argus://")) {
        val uri = Uri.parse(t)
        val code = uri.getQueryParameter("code") ?: return null
        return code to uri.getQueryParameter("relay")
    }
    val m = Regex("^\\d{4}-?[0-9A-Za-z]{6}$").find(t) ?: return null
    return m.value to null
}

@OptIn(ExperimentalGetImage::class)
@Composable
fun ScanScreen(onResult: (String) -> Boolean, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val lifecycleOwner = LocalLifecycleOwner.current
    var granted by remember {
        mutableStateOf(ContextCompat.checkSelfPermission(ctx, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED)
    }
    val ask = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted = it }
    LaunchedEffect(Unit) { if (!granted) ask.launch(Manifest.permission.CAMERA) }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onClose) { Text("取消") }
            Text("扫描主机上的二维码", fontSize = 14.sp, modifier = Modifier.padding(start = 8.dp))
        }
        if (!granted) {
            Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                Text("需要相机权限才能扫码", fontSize = 13.sp)
            }
            return@Column
        }
        var provider by remember { mutableStateOf<ProcessCameraProvider?>(null) }
        DisposableEffect(Unit) { onDispose { provider?.unbindAll() } }
        // One-shot gate: frames keep arriving after a hit; without this the
        // caller would receive onResult more than once.
        var delivered by remember { mutableStateOf(false) }
        AndroidView(modifier = Modifier.weight(1f).fillMaxWidth(), factory = { context ->
            val previewView = PreviewView(context)
            val future = ProcessCameraProvider.getInstance(context)
            future.addListener({
                val p = future.get()
                provider = p
                val preview = Preview.Builder().build().also { it.setSurfaceProvider(previewView.surfaceProvider) }
                val scanner = BarcodeScanning.getClient(
                    BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build())
                val analysis = ImageAnalysis.Builder()
                    .setBackpressureStrategy(ImageAnalysis.STRATEGY_KEEP_ONLY_LATEST).build()
                analysis.setAnalyzer(ContextCompat.getMainExecutor(context)) { proxy ->
                    val media = proxy.image
                    if (media == null || delivered) { proxy.close(); return@setAnalyzer }
                    scanner.process(InputImage.fromMediaImage(media, proxy.imageInfo.rotationDegrees))
                        .addOnSuccessListener { codes ->
                            val raw = codes.firstOrNull()?.rawValue
                            // Latch only when the caller consumed it — an
                            // unrelated QR must not freeze the scanner.
                            if (raw != null && !delivered && onResult(raw)) delivered = true
                        }
                        .addOnCompleteListener { proxy.close() }
                }
                p.unbindAll()
                p.bindToLifecycle(lifecycleOwner, CameraSelector.DEFAULT_BACK_CAMERA, preview, analysis)
            }, ContextCompat.getMainExecutor(context))
            previewView
        })
    }
}
