package com.kairong.argus.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

// ---------------------------------------------------------------------------
// Semantic token system (control-center design language):
//   pill-first shapes, neutral grays + ONE accent color, sheet-as-main-surface,
//   dot-grid canvas. Status colors (green/amber/red) are reserved for status.
// Light values follow the reference deck; the tertiary gray is darkened to
// #6C6C70 (the reference's #AEAEB2 on #E9E9EB is ~1.6:1, unreadable outdoors).
// Dark keeps the pre-existing Slate/Indigo brand palette, mapped to the same
// semantic roles so every screen defines colors exactly once.
// ---------------------------------------------------------------------------

// Legacy brand palette (dark scheme + status colors)
val Slate950 = Color(0xFF0F172A)
val Slate900 = Color(0xFF1E293B)
val Slate800 = Color(0xFF334155)
val Indigo400 = Color(0xFF818CF8)
val Indigo600 = Color(0xFF4F46E5)
val Emerald400 = Color(0xFF34D399)
val Amber400 = Color(0xFFFBBF24)
val Rose400 = Color(0xFFFB7185)

@Immutable
data class ArgusPalette(
    val canvas: Color,          // desktop wallpaper behind the sheet
    val canvasDot: Color,       // dot-grid dots (~8% brighter than canvas)
    val sheet: Color,           // main working panel
    val card: Color,            // bubbles / activity groups / rows
    val textPrimary: Color,
    val textSecondary: Color,
    val textTertiary: Color,
    val accent: Color,          // the single accent (send button, primary CTA)
    val onAccent: Color,
    val accentFill: Color,      // selected chip fill
    val accentStroke: Color,    // selected chip stroke
    val statusGreen: Color,
    val statusAmberFill: Color,
    val statusAmberText: Color,
    val danger: Color,
    val isDark: Boolean,
)

val LightArgusPalette = ArgusPalette(
    canvas = Color(0xFFA9A9AF),
    canvasDot = Color(0xFFB8B8BE),
    sheet = Color(0xFFF2F2F2),
    card = Color(0xFFE9E9EB),
    textPrimary = Color(0xFF1C1C1E),
    textSecondary = Color(0xFF8E8E93),
    textTertiary = Color(0xFF6C6C70),
    accent = Color(0xFF3478F6),
    onAccent = Color.White,
    accentFill = Color(0xFFD8E7FB),
    accentStroke = Color(0xFF7FB3F0),
    statusGreen = Color(0xFF34C759),
    statusAmberFill = Color(0xFFFDE3C0),
    statusAmberText = Color(0xFFC86A1E),
    danger = Color(0xFFFF3B30),
    isDark = false,
)

val DarkArgusPalette = ArgusPalette(
    canvas = Slate950,
    canvasDot = Color(0xFF1B2740),
    sheet = Slate900,
    card = Slate800,
    textPrimary = Color(0xFFE2E8F0),
    textSecondary = Color(0xFF94A3B8),
    textTertiary = Color(0xFF748AA6),
    accent = Indigo600,
    onAccent = Color.White,
    accentFill = Color(0xFF2A3655),
    accentStroke = Indigo400,
    statusGreen = Emerald400,
    statusAmberFill = Color(0xFF453314),
    statusAmberText = Amber400,
    danger = Rose400,
    isDark = true,
)

val LocalArgusPalette = staticCompositionLocalOf { DarkArgusPalette }

/** Access point: `ArgusTheme.colors.sheet` etc. */
object ArgusTheme {
    val colors: ArgusPalette
        @Composable get() = LocalArgusPalette.current
}

// Corner radii (dp values; pill/circle via shape helpers at use sites)
object ArgusRadius {
    const val SHEET = 28
    const val CARD = 16
    const val ROW = 12
}

@Composable
fun ArgusAppTheme(content: @Composable () -> Unit) {
    val palette = if (isSystemInDarkTheme()) DarkArgusPalette else LightArgusPalette
    val scheme = if (palette.isDark) {
        darkColorScheme(
            primary = palette.accent,
            onPrimary = palette.onAccent,
            background = palette.canvas,
            surface = palette.sheet,
            onSurface = palette.textPrimary,
            secondary = palette.card,
            onSecondary = palette.textSecondary,
        )
    } else {
        lightColorScheme(
            primary = palette.accent,
            onPrimary = palette.onAccent,
            background = palette.canvas,
            surface = palette.sheet,
            onSurface = palette.textPrimary,
            secondary = palette.card,
            onSecondary = palette.textSecondary,
        )
    }
    CompositionLocalProvider(LocalArgusPalette provides palette) {
        MaterialTheme(colorScheme = scheme, content = content)
    }
}
