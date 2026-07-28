import AppKit

/// Grouped-card building blocks for the settings panes.
///
/// Cards live in the *content layer*, and the HIG is explicit that Liquid
/// Glass belongs only to the functional layer (toolbars, controls): "Don't
/// use Liquid Glass in the content layer." So the card material is the
/// standard `.contentBackground` visual effect — the same grouped-form look
/// System Settings uses — on every OS version. (The earlier NSGlassEffectView
/// experiment is gone for that reason, not for compatibility.)
enum Glass {

    /// A rounded card that hosts arbitrary content, standard grouped-content
    /// material.
    static func card(cornerRadius: CGFloat = 10) -> NSView {
        let v = NSVisualEffectView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.material = .contentBackground
        v.blendingMode = .withinWindow
        v.state = .active
        v.wantsLayer = true
        v.layer?.cornerRadius = cornerRadius
        v.layer?.cornerCurve = .continuous
        return v
    }

    /// Installs `content` in a padded card and returns the card.
    ///
    /// The backdrop is pinned behind a plain container instead of using any
    /// effect view's own content hosting, so padding constraints stay ours and
    /// layout is predictable on every OS version.
    static func wrap(_ content: NSView, padding: CGFloat = 12, cornerRadius: CGFloat = 10) -> NSView {
        let container = NSView()
        container.translatesAutoresizingMaskIntoConstraints = false
        let backdrop = card(cornerRadius: cornerRadius)
        content.translatesAutoresizingMaskIntoConstraints = false

        container.addSubview(backdrop)
        container.addSubview(content)
        NSLayoutConstraint.activate([
            backdrop.topAnchor.constraint(equalTo: container.topAnchor),
            backdrop.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            backdrop.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            backdrop.bottomAnchor.constraint(equalTo: container.bottomAnchor),

            content.topAnchor.constraint(equalTo: container.topAnchor, constant: padding),
            content.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: padding),
            content.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -padding),
            content.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -padding),
        ])
        return container
    }

    // MARK: - Typography

    /// Pane title — the one large label at the top of a settings pane.
    static func title(_ text: String) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = .systemFont(ofSize: 20, weight: .bold)
        return l
    }

    /// Section heading inside a card.
    static func heading(_ text: String) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = .systemFont(ofSize: 13, weight: .semibold)
        return l
    }

    /// Secondary explanatory copy.
    static func caption(_ text: String) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = .systemFont(ofSize: 11)
        l.textColor = .secondaryLabelColor
        l.lineBreakMode = .byWordWrapping
        l.maximumNumberOfLines = 0
        return l
    }

    /// Monospaced value text (fingerprints, codes, URLs).
    static func mono(_ text: String, size: CGFloat = 11) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = .monospacedSystemFont(ofSize: size, weight: .regular)
        l.textColor = .secondaryLabelColor
        l.lineBreakMode = .byCharWrapping
        l.maximumNumberOfLines = 0
        return l
    }

    /// The oversized, tracked-out pairing code display.
    static func codeDisplay(_ text: String) -> NSTextField {
        let l = NSTextField(labelWithString: text)
        l.font = .monospacedSystemFont(ofSize: 28, weight: .medium)
        l.alignment = .center
        return l
    }

    // MARK: - Controls

    /// Prominent action button (Tahoe capsule style where available).
    static func primaryButton(_ title: String, target: AnyObject, action: Selector) -> NSButton {
        let b = NSButton(title: title, target: target, action: action)
        b.translatesAutoresizingMaskIntoConstraints = false
        b.bezelStyle = .rounded
        b.controlSize = .large
        b.keyEquivalent = "\r"
        return b
    }

    /// Neutral secondary button.
    static func secondaryButton(_ title: String, target: AnyObject, action: Selector) -> NSButton {
        let b = NSButton(title: title, target: target, action: action)
        b.translatesAutoresizingMaskIntoConstraints = false
        b.bezelStyle = .rounded
        b.controlSize = .large
        return b
    }

    /// A colored status dot. `nil` color renders a neutral (idle) dot.
    static func statusDot(diameter: CGFloat = 9) -> NSView {
        let v = NSView()
        v.translatesAutoresizingMaskIntoConstraints = false
        v.wantsLayer = true
        v.layer?.cornerRadius = diameter / 2
        v.layer?.backgroundColor = NSColor.systemGray.cgColor
        NSLayoutConstraint.activate([
            v.widthAnchor.constraint(equalToConstant: diameter),
            v.heightAnchor.constraint(equalToConstant: diameter),
        ])
        return v
    }

    static func tint(_ dot: NSView, _ color: NSColor) {
        dot.layer?.backgroundColor = color.cgColor
    }

    /// Vertical stack with consistent spacing.
    static func vStack(_ views: [NSView], spacing: CGFloat = 10, alignment: NSLayoutConstraint.Attribute = .leading) -> NSStackView {
        let s = NSStackView(views: views)
        s.orientation = .vertical
        s.alignment = alignment
        s.spacing = spacing
        s.translatesAutoresizingMaskIntoConstraints = false
        return s
    }

    /// Horizontal stack with consistent spacing.
    static func hStack(_ views: [NSView], spacing: CGFloat = 8) -> NSStackView {
        let s = NSStackView(views: views)
        s.orientation = .horizontal
        s.alignment = .centerY
        s.spacing = spacing
        s.translatesAutoresizingMaskIntoConstraints = false
        return s
    }

    /// A titled card: heading on top, `rows` beneath, everything inset.
    static func section(_ heading: String, _ rows: [NSView], spacing: CGFloat = 6) -> NSView {
        var children: [NSView] = []
        if !heading.isEmpty { children.append(self.heading(heading)) }
        children.append(contentsOf: rows)
        let stack = vStack(children, spacing: spacing)
        // Widen anything that draws its own area — scrollers, charts, text views,
        // sub-stacks — to the section width. Labels, buttons and checkboxes are
        // left at their intrinsic width so they don't grow click targets or
        // stretch text across the whole card.
        for row in rows where !(row is NSButton) && !(row is NSTextField) && !(row is NSPopUpButton) {
            row.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        return wrap(stack)
    }

    /// A scroll view's document view keeps AppKit's default bottom-left origin,
    /// which stacks content from the bottom and leaves a gap above it. Flipping
    /// it puts the origin top-left, so content starts at the top like every other
    /// settings pane.
    private final class FlippedView: NSView {
        override var isFlipped: Bool { true }
    }

    /// Lays a pane's cards out in a scroll view pinned to `container`, so panes
    /// can grow past the window height. Use `installFixedPage` instead when the
    /// pane already contains a scrolling control — nesting scroll views makes
    /// both of them awkward to drive.
    ///
    /// No page title: the toolbar-style settings window puts the pane name in
    /// the window title (HIG), so repeating it inside the pane wasted a full
    /// heading row.
    static func installPage(_ cards: [NSView], in container: NSView) {
        let stack = pageStack(cards)

        let scroll = NSScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        scroll.autohidesScrollers = true
        let clip = FlippedView()
        clip.translatesAutoresizingMaskIntoConstraints = false
        clip.addSubview(stack)
        scroll.documentView = clip

        container.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: container.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: container.bottomAnchor),
            stack.topAnchor.constraint(equalTo: clip.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: clip.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: clip.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: clip.bottomAnchor, constant: -16),
            clip.widthAnchor.constraint(equalTo: scroll.widthAnchor),
        ])
    }

    /// Same page layout, pinned straight to `container` with no scroll view.
    /// For panes whose own content scrolls (a table, a log view): the inner
    /// control gets the full remaining height instead of fighting an outer
    /// scroller, and `bottom` is pinned so it actually stretches.
    static func installFixedPage(_ cards: [NSView], in container: NSView) {
        let stack = pageStack(cards)
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: container.topAnchor, constant: 16),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 16),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -16),
            stack.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -16),
        ])
    }

    private static func pageStack(_ cards: [NSView]) -> NSStackView {
        // 12pt between cards + 12pt card padding keeps groups distinct without
        // the airy 16/16 rhythm the panes shipped with (user: 紧凑一点).
        let stack = vStack(cards, spacing: 12)
        // A vertical stack with `.leading` alignment sizes each row to its own
        // content, which left the cards (and the tables inside them) narrower
        // than the pane. Pin every card to the stack's width so they fill it.
        for card in cards {
            card.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        return stack
    }
}
