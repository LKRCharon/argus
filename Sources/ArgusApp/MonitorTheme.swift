import SwiftUI

/// The control-center design language, ported from the Android app's
/// `ui/theme/Theme.kt` so the two clients read as one product: pill-first
/// shapes, neutral surfaces + ONE accent, status colours reserved for status.
///
/// Values are copied (not linked) from the Kotlin palette — same hex, same
/// roles. Dark keeps the Slate/Indigo brand palette; light follows the
/// reference deck with the tertiary gray darkened to #6C6C70 (outdoor legibility).
struct MonitorPalette {
    let sheet: Color          // window surface (the sheet in Android)
    let card: Color           // cards / rows / bubbles
    let textPrimary: Color
    let textSecondary: Color
    let textTertiary: Color
    let accent: Color
    let accentFill: Color     // selected chip fill
    let accentStroke: Color
    let statusGreen: Color
    let statusAmber: Color
    let danger: Color

    /// DarkArgusPalette: Slate-900 sheet / Slate-800 card + Indigo accent
    /// (Tailwind numbering; the Android file calls its own fields 950/900/800).
    static let dark = MonitorPalette(
        sheet: Color(red: 0x1E / 255, green: 0x29 / 255, blue: 0x3B / 255),
        card: Color(red: 0x33 / 255, green: 0x41 / 255, blue: 0x55 / 255),
        textPrimary: Color(red: 0xE2 / 255, green: 0xE8 / 255, blue: 0xF0 / 255),
        textSecondary: Color(red: 0x94 / 255, green: 0xA3 / 255, blue: 0xB8 / 255),
        textTertiary: Color(red: 0x74 / 255, green: 0x8A / 255, blue: 0xA6 / 255),
        accent: Color(red: 0x4F / 255, green: 0x46 / 255, blue: 0xE5 / 255),
        accentFill: Color(red: 0x2A / 255, green: 0x36 / 255, blue: 0x55 / 255),
        accentStroke: Color(red: 0x81 / 255, green: 0x8C / 255, blue: 0xF8 / 255),
        statusGreen: Color(red: 0x34 / 255, green: 0xD3 / 255, blue: 0x99 / 255),
        statusAmber: Color(red: 0xFB / 255, green: 0xBF / 255, blue: 0x24 / 255),
        danger: Color(red: 0xFB / 255, green: 0x71 / 255, blue: 0x85 / 255)
    )

    /// LightArgusPalette: #F2F2F2 sheet / #E9E9EB card / #3478F6 accent.
    static let light = MonitorPalette(
        sheet: Color(red: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF2 / 255),
        card: Color(red: 0xE9 / 255, green: 0xE9 / 255, blue: 0xEB / 255),
        textPrimary: Color(red: 0x1C / 255, green: 0x1C / 255, blue: 0x1E / 255),
        textSecondary: Color(red: 0x8E / 255, green: 0x8E / 255, blue: 0x93 / 255),
        textTertiary: Color(red: 0x6C / 255, green: 0x6C / 255, blue: 0x70 / 255),
        accent: Color(red: 0x34 / 255, green: 0x78 / 255, blue: 0xF6 / 255),
        accentFill: Color(red: 0xD8 / 255, green: 0xE7 / 255, blue: 0xFB / 255),
        accentStroke: Color(red: 0x7F / 255, green: 0xB3 / 255, blue: 0xF0 / 255),
        statusGreen: Color(red: 0x34 / 255, green: 0xC7 / 255, blue: 0x59 / 255),
        statusAmber: Color(red: 0xC8 / 255, green: 0x6A / 255, blue: 0x1E / 255),
        danger: Color(red: 0xFF / 255, green: 0x3B / 255, blue: 0x30 / 255)
    )
}

/// ArgusRadius in Theme.kt — SHEET 28 / CARD 16 / ROW 12. Pills use Capsule().
enum MonitorRadius {
    static let card: CGFloat = 16
    static let row: CGFloat = 12
}

// No EnvironmentKey for the palette: the only consumer is MonitorRootView,
// which selects dark/light from colorScheme directly. An earlier injection
// inside the view's own body resolved from the *parent* environment (empty) and
// silently pinned everything to .dark — if a future child subtree needs the
// palette, inject it ABOVE the NSHostingController's root view, not in-body.

/// Emoji → SF Symbol, mirroring MenuBarController.statusSymbols so a guard row
/// reads identically in the menu and the window (menus attach glyphs inline).
enum MonitorSymbols {
    static func name(for emoji: Character) -> String? {
        switch emoji {
        case "🔋": return "battery.100"
        case "🌡": return "thermometer.medium"
        case "🛰": return "antenna.radiowaves.left.and.right"
        case "⏱": return "timer"
        case "⚠️": return "exclamationmark.triangle.fill"
        default: return nil
        }
    }
}
