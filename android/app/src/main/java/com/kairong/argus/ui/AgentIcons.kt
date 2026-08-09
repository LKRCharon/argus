package com.kairong.argus.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathNode
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * Agent marks for the switcher. Material Icons deliberately ships no
 * third-party brand logos, so these are drawn here.
 *
 * Codex uses OpenAI's blossom mark, taken from simple-icons (CC0 1.0, public
 * domain). Qoder has no published vector, and copying the mark out of
 * Qoder.app would pull a third-party brand asset into this repo — so its icon
 * is an original simplified stand-in built from the brand's visual signature
 * (rounded square, notched inner shape, brand green).
 */
object AgentIcons {

    /** OpenAI blossom (simple-icons `openai`, CC0 1.0). */
    val Codex: ImageVector by lazy {
        ImageVector.Builder(
            name = "Codex",
            defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 24f, viewportHeight = 24f,
        ).apply {
            addPath(svg(OPENAI_BLOSSOM), fill = SolidColor(Color.Black))
        }.build()
    }

    /**
     * Qoder stand-in: a rounded square with a notch cut out of a filled disc —
     * echoes the speech-bubble "Q" without reproducing the official artwork.
     */
    val Qoder: ImageVector by lazy {
        ImageVector.Builder(
            name = "Qoder",
            defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 24f, viewportHeight = 24f,
        ).apply {
            addPath(svg(QODER_MARK), fill = SolidColor(Color.Black))
        }.build()
    }

    /** Fallback for agents we have no mark for. */
    val Generic: ImageVector by lazy {
        ImageVector.Builder(
            name = "AgentGeneric",
            defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 24f, viewportHeight = 24f,
        ).apply {
            addPath(svg(GENERIC_MARK), fill = SolidColor(Color.Black))
        }.build()
    }

    /** "All agents": three stacked bars, deliberately not a brand mark. */
    val All: ImageVector by lazy {
        ImageVector.Builder(
            name = "AgentAll",
            defaultWidth = 24.dp, defaultHeight = 24.dp,
            viewportWidth = 24f, viewportHeight = 24f,
        ).apply {
            addPath(svg(ALL_MARK), fill = SolidColor(Color.Black))
        }.build()
    }
}

/** Parse an SVG path string into vector nodes. */
private fun svg(d: String): List<PathNode> = addPathNodes(d)

private const val OPENAI_BLOSSOM =
    "M22.282 9.821a6 6 0 0 0-.516-4.91a6.05 6.05 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18" +
    "a6 6 0 0 0-3.998 2.9a6.05 6.05 0 0 0 .743 7.097a5.98 5.98 0 0 0 .51 4.911a6.05 6.05 0 0 0 6.515 2.9" +
    "A6 6 0 0 0 13.26 24a6.06 6.06 0 0 0 5.772-4.206a6 6 0 0 0 3.997-2.9a6.06 6.06 0 0 0-.747-7.073" +
    "M13.26 22.43a4.48 4.48 0 0 1-2.876-1.04l.141-.081l4.779-2.758a.8.8 0 0 0 .392-.681v-6.737" +
    "l2.02 1.168a.07.07 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494" +
    "M3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085l4.783 2.759a.77.77 0 0 0 .78 0l5.843-3.369v2.332" +
    "a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646" +
    "M2.34 7.896a4.5 4.5 0 0 1 2.366-1.973V11.6a.77.77 0 0 0 .388.677l5.815 3.354l-2.02 1.168" +
    "a.08.08 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872z" +
    "m16.597 3.855l-5.833-3.387L15.119 7.2a.08.08 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105" +
    "v-5.678a.79.79 0 0 0-.407-.667" +
    "m2.01-3.023l-.141-.085l-4.774-2.782a.78.78 0 0 0-.785 0L9.409 9.23V6.897a.07.07 0 0 1 .028-.061" +
    "l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66z" +
    "m-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08" +
    "L8.704 5.46a.8.8 0 0 0-.393.681z" +
    "m1.097-2.365l2.602-1.5l2.607 1.5v2.999l-2.597 1.5l-2.607-1.5Z"

// Rounded square outline + inner disc with a wedge removed (bubble tail side).
private const val QODER_MARK =
    "M6.2 2h11.6A4.2 4.2 0 0 1 22 6.2v11.6A4.2 4.2 0 0 1 17.8 22H6.2A4.2 4.2 0 0 1 2 17.8V6.2" +
    "A4.2 4.2 0 0 1 6.2 2Zm0 1.8A2.4 2.4 0 0 0 3.8 6.2v11.6a2.4 2.4 0 0 0 2.4 2.4h11.6" +
    "a2.4 2.4 0 0 0 2.4-2.4V6.2a2.4 2.4 0 0 0-2.4-2.4Z" +
    "M12 6.4a5.6 5.6 0 1 1 0 11.2a5.6 5.6 0 0 1 0-11.2Zm0 1.8a3.8 3.8 0 1 0 0 7.6" +
    "a3.8 3.8 0 0 0 0-7.6Z" +
    "M13.6 13.2h3.8v3.8h-2.2a1.6 1.6 0 0 1-1.6-1.6Z"

// Neutral robot-ish head: rounded body, two eyes, antenna.
private const val GENERIC_MARK =
    "M11 2h2v2.1a4 4 0 0 1 3.9 4V9h1.6A2.5 2.5 0 0 1 21 11.5v5A2.5 2.5 0 0 1 18.5 19h-13" +
    "A2.5 2.5 0 0 1 3 16.5v-5A2.5 2.5 0 0 1 5.5 9h1.6V8.1A4 4 0 0 1 11 4.1Z" +
    "M8.6 12.2a1.3 1.3 0 1 0 0 2.6a1.3 1.3 0 0 0 0-2.6Zm6.8 0a1.3 1.3 0 1 0 0 2.6" +
    "a1.3 1.3 0 0 0 0-2.6Z"

// Three stacked rounded bars.
private const val ALL_MARK =
    "M4.6 5h14.8a1.1 1.1 0 0 1 0 2.2H4.6a1.1 1.1 0 0 1 0-2.2Z" +
    "M4.6 10.9h14.8a1.1 1.1 0 0 1 0 2.2H4.6a1.1 1.1 0 0 1 0-2.2Z" +
    "M4.6 16.8h14.8a1.1 1.1 0 0 1 0 2.2H4.6a1.1 1.1 0 0 1 0-2.2Z"
