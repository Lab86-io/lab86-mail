import Kingfisher
import SwiftUI

/// A To, Cc, or Bcc row with chips and live recipient search. It binds to the
/// same comma-separated string the composer always sent (`Name <email>,
/// email`), so drafts, reply prefill, and the send path do not change.
///
/// Focus: the parent owns the focus state. It passes the binding (to focus
/// the text field) and `isFocused` as a plain value, so this view updates
/// every time the focus moves.
struct RecipientField<FocusValue: Hashable, Accessory: View>: View {
    let title: String
    @Binding var value: String
    let focus: FocusState<FocusValue?>.Binding
    let focusValue: FocusValue
    let isFocused: Bool
    let theme: ThemeStore
    let searcher: (any RecipientSearching)?
    var fromAccountID: String?
    /// Addresses in the other recipient fields; they do not come back as suggestions.
    var excluding: [String] = []
    var isEnabled: Bool = true
    var suggestionLimit: Int = 8
    var horizontalPadding: CGFloat = 20
    var verticalPadding: CGFloat = 8
    /// Return on an empty field: the parent moves focus to the next field.
    var onSubmitEmpty: (() -> Void)?
    /// A fixed state for rendering tests and previews. No search runs.
    var presentation: RecipientFieldPresentation?
    let accessory: () -> Accessory

    @State private var state: RecipientFieldState
    @State private var fieldText: String
    @State private var lastPublished: String
    @State private var search = RecipientSearchModel()
    @State private var listDismissed = false
    @State private var detailTokenID: UUID? = nil
    @State private var isSubmitting = false

    init(
        title: String,
        value: Binding<String>,
        focus: FocusState<FocusValue?>.Binding,
        focusValue: FocusValue,
        isFocused: Bool,
        theme: ThemeStore,
        searcher: (any RecipientSearching)?,
        fromAccountID: String? = nil,
        excluding: [String] = [],
        isEnabled: Bool = true,
        suggestionLimit: Int = 8,
        horizontalPadding: CGFloat = 20,
        verticalPadding: CGFloat = 8,
        onSubmitEmpty: (() -> Void)? = nil,
        presentation: RecipientFieldPresentation? = nil,
        @ViewBuilder accessory: @escaping () -> Accessory
    ) {
        self.title = title
        _value = value
        self.focus = focus
        self.focusValue = focusValue
        self.isFocused = isFocused
        self.theme = theme
        self.searcher = searcher
        self.fromAccountID = fromAccountID
        self.excluding = excluding
        self.isEnabled = isEnabled
        self.suggestionLimit = suggestionLimit
        self.horizontalPadding = horizontalPadding
        self.verticalPadding = verticalPadding
        self.onSubmitEmpty = onSubmitEmpty
        self.presentation = presentation
        self.accessory = accessory
        var initial = RecipientFieldState(value: value.wrappedValue)
        if let presentation {
            initial.draft = presentation.draft
            if let index = presentation.selectedTokenIndex, initial.tokens.indices.contains(index) {
                initial.selectedTokenID = initial.tokens[index].id
            }
        }
        _state = State(initialValue: initial)
        _fieldText = State(initialValue: RecipientFieldText.display(initial.draft))
        _lastPublished = State(initialValue: value.wrappedValue)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                Text(title)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .padding(.vertical, RecipientChipMetrics.verticalInset)
                    .fixedSize()
                    .accessibilityHidden(true)
                RecipientFlowLayout(spacing: 6, lineSpacing: 6) {
                    ForEach(state.tokens) { token in
                        chip(token)
                    }
                    textField
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                accessory()
            }
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            if listVisible {
                RecipientSuggestionList(
                    suggestions: displayedSuggestions,
                    highlightedIndex: displayedHighlight,
                    caption: listCaption,
                    theme: theme,
                    horizontalPadding: horizontalPadding,
                    onPick: { suggestion in
                        pick(suggestion)
                        focus.wrappedValue = focusValue
                    }
                )
                .transition(.opacity)
            }
        }
        .accessibilityElement(children: .contain)
        .onChange(of: fieldText) { _, raw in handleFieldText(raw) }
        .onChange(of: value) { _, newValue in
            guard newValue != lastPublished else { return }
            state = RecipientFieldState(value: newValue)
            lastPublished = newValue
            syncFieldText()
        }
        .onChange(of: isFocused) { _, focused in
            if focused {
                listDismissed = false
                refreshSearch()
            } else {
                handleBlur()
            }
        }
        .onChange(of: fromAccountID) { _, _ in refreshSearch() }
        .onChange(of: excluding) { _, _ in refreshSearch() }
        .onAppear { if isFocused { refreshSearch() } }
    }

    // MARK: - Pieces

    private var textField: some View {
        TextField("", text: $fieldText)
            .textFieldStyle(.plain)
            .font(.subheadline)
            .textContentType(.emailAddress)
            .textInputAutocapitalization(.never)
            .keyboardType(.emailAddress)
            .autocorrectionDisabled()
            .focused(focus, equals: focusValue)
            .disabled(!isEnabled)
            .padding(.vertical, RecipientChipMetrics.verticalInset)
            .onSubmit(submit)
            .onKeyPress(.downArrow) { moveHighlight(by: 1) }
            .onKeyPress(.upArrow) { moveHighlight(by: -1) }
            .onKeyPress(.escape) {
                guard listVisible else { return .ignored }
                listDismissed = true
                return .handled
            }
            .onKeyPress(.tab) { commitFromTab() ? .handled : .ignored }
            #if os(macOS)
            .onKeyPress(.delete) {
                guard state.draft.isEmpty, !state.tokens.isEmpty else { return .ignored }
                if state.backspaceOnEmptyDraft() { publish(); refreshSearch() }
                return .handled
            }
            #endif
            .accessibilityLabel(title)
            .accessibilityValue(state.draft)
            .accessibilityHint(fieldHint)
    }

    /// VoiceOver on the text field says how many chips come before it.
    private var fieldHint: String {
        switch state.tokens.count {
        case 0: ""
        case 1: "1 recipient"
        default: "\(state.tokens.count) recipients"
        }
    }

    private func chip(_ token: RecipientToken) -> some View {
        RecipientChip(
            token: token,
            isSelected: state.selectedTokenID == token.id,
            theme: theme
        ) {
            detailTokenID = token.id
        }
        .popover(isPresented: Binding(
            get: { detailTokenID == token.id },
            set: { if !$0, detailTokenID == token.id { detailTokenID = nil } }
        )) {
            RecipientTokenDetail(
                token: token,
                theme: theme,
                isEnabled: isEnabled,
                onRemove: {
                    detailTokenID = nil
                    state.remove(token.id)
                    publish()
                    refreshSearch()
                },
                onEdit: {
                    detailTokenID = nil
                    state.beginEditing(token.id)
                    syncFieldText()
                    publish()
                    focus.wrappedValue = focusValue
                },
                onUseAlternate: { email in
                    detailTokenID = nil
                    state.useAlternate(email, for: token.id)
                    publish()
                    refreshSearch()
                }
            )
            .presentationCompactAdaptation(.popover)
        }
        .accessibilityAction(named: "Remove") {
            guard isEnabled else { return }
            state.remove(token.id)
            publish()
        }
    }

    // MARK: - Derived state

    private var displayedSuggestions: [RecipientSuggestion] {
        presentation?.suggestions ?? search.suggestions
    }

    private var displayedHighlight: Int? {
        presentation != nil ? presentation?.highlightedIndex : search.highlightedIndex
    }

    private var listVisible: Bool {
        if let presentation { return presentation.showsList && !presentation.suggestions.isEmpty }
        return isFocused && isEnabled && !listDismissed && !search.suggestions.isEmpty
    }

    private var listCaption: String? {
        let query = presentation?.draft ?? search.resultQuery ?? state.draft
        return query.nilIfBlank == nil ? "Suggested" : nil
    }

    // MARK: - Actions

    private func handleFieldText(_ raw: String) {
        let stripped = RecipientFieldText.strip(raw)
        if RecipientFieldText.deletedMarker(in: raw), stripped.isEmpty, state.draft.isEmpty {
            // Backspace with nothing typed: select, then remove, the last chip.
            if state.backspaceOnEmptyDraft() {
                publish()
                refreshSearch()
            }
        } else if stripped != state.draft {
            // A separator after partial text picks the highlighted person,
            // unless Esc closed the list.
            let separatorPick = listDismissed ? nil : search.pickable(for: state.draft)
            listDismissed = false
            if state.edit(stripped, pick: separatorPick) {
                search.clearVisible()
            }
            publish()
            refreshSearch()
        }
        syncFieldText()
    }

    /// Return: pick the highlighted person, or make a chip of the typed text.
    /// On an empty field it moves on to the next field.
    ///
    /// On iOS a submitted text field gives up focus right after this call, and
    /// leaving the field clears the list. So the pick happens here, at once,
    /// when the answer is on screen; an answer still in flight holds the list
    /// open (`isSubmitting`) for a short wait.
    private func submit() {
        let query = state.draft
        guard query.nilIfBlank != nil else {
            if !listDismissed, let suggestion = search.pickable(for: "") {
                pick(suggestion)
                refocus()
            } else if let onSubmitEmpty {
                onSubmitEmpty()
            } else {
                refocus()
            }
            return
        }
        if !listDismissed, let suggestion = search.pickable(for: query) {
            pick(suggestion)
            refocus()
            return
        }
        guard !listDismissed, search.isSearching else {
            commitTypedText()
            refocus()
            return
        }
        isSubmitting = true
        Task {
            let suggestion = await search.settledPickable(for: query)
            isSubmitting = false
            // The person typed on while the answer was in flight.
            guard state.draft == query else { return }
            if let suggestion {
                pick(suggestion)
            } else {
                commitTypedText()
            }
            refocus()
        }
    }

    private func commitTypedText() {
        state.commitDraft()
        syncFieldText()
        publish()
        refreshSearch()
    }

    /// Keeps the keyboard up after Return, so the person can add more people.
    private func refocus() {
        focus.wrappedValue = focusValue
        Task {
            await Task.yield()
            focus.wrappedValue = focusValue
        }
    }

    /// Tab picks or commits like Return; with nothing to do it moves focus on.
    private func commitFromTab() -> Bool {
        if listVisible, let suggestion = search.pickable(for: state.draft) {
            pick(suggestion)
            return true
        }
        guard state.draft.nilIfBlank != nil else { return false }
        commitTypedText()
        return true
    }

    private func moveHighlight(by offset: Int) -> KeyPress.Result {
        guard listVisible, search.moveHighlight(by: offset) else { return .ignored }
        return .handled
    }

    private func pick(_ suggestion: RecipientSuggestion) {
        state.pick(suggestion)
        search.clearVisible()
        syncFieldText()
        publish()
        refreshSearch()
    }

    private func handleBlur() {
        // Return is waiting for an answer; it finishes the pick itself.
        guard !isSubmitting else { return }
        // Leaving the field keeps a complete address as a chip; partial text
        // stays as text, and the send check names it.
        if state.commitDraft(onlyValid: true) {
            syncFieldText()
            publish()
        }
        state.selectedTokenID = nil
        search.reset()
    }

    private func refreshSearch() {
        guard presentation == nil, isFocused, isEnabled else { return }
        // The top people for an empty field are a short list; typed text gets the full limit.
        let limit = state.draft.nilIfBlank == nil ? min(suggestionLimit, 5) : suggestionLimit
        search.search(
            RecipientSearchRequest(
                query: state.draft,
                fromAccountID: fromAccountID,
                limit: limit,
                exclude: state.addresses + excluding
            ),
            using: searcher
        )
    }

    private func syncFieldText() {
        let display = RecipientFieldText.display(state.draft)
        if fieldText != display { fieldText = display }
    }

    private func publish() {
        let newValue = state.value
        lastPublished = newValue
        if value != newValue { value = newValue }
    }
}

extension RecipientField where Accessory == EmptyView {
    init(
        title: String,
        value: Binding<String>,
        focus: FocusState<FocusValue?>.Binding,
        focusValue: FocusValue,
        isFocused: Bool,
        theme: ThemeStore,
        searcher: (any RecipientSearching)?,
        fromAccountID: String? = nil,
        excluding: [String] = [],
        isEnabled: Bool = true,
        suggestionLimit: Int = 8,
        horizontalPadding: CGFloat = 20,
        verticalPadding: CGFloat = 8,
        onSubmitEmpty: (() -> Void)? = nil,
        presentation: RecipientFieldPresentation? = nil
    ) {
        self.init(
            title: title,
            value: value,
            focus: focus,
            focusValue: focusValue,
            isFocused: isFocused,
            theme: theme,
            searcher: searcher,
            fromAccountID: fromAccountID,
            excluding: excluding,
            isEnabled: isEnabled,
            suggestionLimit: suggestionLimit,
            horizontalPadding: horizontalPadding,
            verticalPadding: verticalPadding,
            onSubmitEmpty: onSubmitEmpty,
            presentation: presentation,
            accessory: { EmptyView() }
        )
    }
}

/// A fixed field state for rendering tests and previews.
struct RecipientFieldPresentation {
    var draft: String = ""
    var suggestions: [RecipientSuggestion] = []
    var highlightedIndex: Int?
    var showsList = true
    var selectedTokenIndex: Int?
}

/// The iOS software keyboard sends no event for Backspace in an empty text
/// field. The field keeps one zero-width marker character before the typed
/// text; when Backspace deletes it, the field knows. The Mac reads the
/// Delete key directly and uses no marker.
enum RecipientFieldText {
    #if os(iOS)
    static let marker = "\u{200B}"
    #else
    static let marker = ""
    #endif

    static func display(_ draft: String) -> String { marker + draft }

    static func strip(_ raw: String) -> String {
        marker.isEmpty ? raw : raw.replacingOccurrences(of: marker, with: "")
    }

    /// True when the marker is gone: Backspace on an empty field.
    static func deletedMarker(in raw: String) -> Bool {
        !marker.isEmpty && !raw.contains(marker)
    }
}

enum RecipientChipMetrics {
    static let verticalInset: CGFloat = 4
    static let horizontalInset: CGFloat = 9
}

// MARK: - Chip

struct RecipientChip: View {
    let token: RecipientToken
    let isSelected: Bool
    let theme: ThemeStore
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text(token.displayName)
                .font(.subheadline)
                .lineLimit(1)
                .truncationMode(.middle)
                .foregroundStyle(token.isValid ? Color.primary : Color.red)
                .padding(.horizontal, RecipientChipMetrics.horizontalInset)
                .padding(.vertical, RecipientChipMetrics.verticalInset)
                .background(fill, in: Capsule())
                .overlay {
                    Capsule().strokeBorder(stroke, lineWidth: isSelected ? 1.5 : 1)
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityHint("Shows the address and a remove action")
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    private var fill: Color {
        if !token.isValid { return Color.red.opacity(0.10) }
        return isSelected ? theme.accentSoftColor : theme.subtleColor
    }

    private var stroke: Color {
        if !token.isValid { return Color.red.opacity(isSelected ? 0.8 : 0.45) }
        return isSelected ? theme.accentColor : theme.hairlineColor
    }

    private var accessibilityText: String {
        guard token.isValid else { return "Not a valid address: \(token.email)" }
        if let name = token.name { return "\(name), \(token.email)" }
        return token.email
    }
}

// MARK: - Chip detail

struct RecipientTokenDetail: View {
    let token: RecipientToken
    let theme: ThemeStore
    let isEnabled: Bool
    let onRemove: () -> Void
    let onEdit: () -> Void
    let onUseAlternate: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                RecipientAvatar(
                    name: token.displayName,
                    seed: token.normalizedEmail,
                    photoURL: token.photoURL,
                    theme: theme,
                    size: 36
                )
                VStack(alignment: .leading, spacing: 2) {
                    if let name = token.name {
                        Text(name)
                            .font(.headline)
                    }
                    Text(token.email)
                        .font(token.name == nil ? .headline : .subheadline)
                        .foregroundStyle(token.name == nil ? .primary : .secondary)
                        .textSelection(.enabled)
                }
            }
            if !token.isValid {
                Text("This is not a complete email address.")
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
            if isEnabled, token.isValid, !token.alternateEmails.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Other addresses")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    ForEach(token.alternateEmails, id: \.self) { email in
                        Button("Use \(email)") { onUseAlternate(email) }
                            .font(.subheadline)
                            .buttonStyle(.plain)
                            .foregroundStyle(theme.accentColor)
                    }
                }
            }
            if isEnabled {
                HStack(spacing: 16) {
                    Button("Edit", action: onEdit)
                        .buttonStyle(.plain)
                        .foregroundStyle(theme.accentColor)
                    Button("Remove", role: .destructive, action: onRemove)
                        .buttonStyle(.plain)
                        .foregroundStyle(.red)
                }
                .font(.subheadline.weight(.medium))
            }
        }
        .padding(16)
        .frame(minWidth: 240, idealWidth: 300, maxWidth: 360, alignment: .leading)
    }
}

// MARK: - Suggestions

struct RecipientSuggestionList: View {
    let suggestions: [RecipientSuggestion]
    let highlightedIndex: Int?
    let caption: String?
    let theme: ThemeStore
    var horizontalPadding: CGFloat = 20
    let onPick: (RecipientSuggestion) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider()
                .overlay(theme.hairlineColor)
            if let caption {
                Text(caption)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, horizontalPadding)
                    .padding(.top, 10)
                    .padding(.bottom, 2)
                    .accessibilityAddTraits(.isHeader)
            }
            ForEach(Array(suggestions.enumerated()), id: \.element.id) { index, suggestion in
                Button {
                    onPick(suggestion)
                } label: {
                    RecipientSuggestionRow(
                        suggestion: suggestion,
                        isHighlighted: index == highlightedIndex,
                        theme: theme,
                        horizontalPadding: horizontalPadding
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.bottom, 4)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggested recipients")
    }
}

struct RecipientSuggestionRow: View {
    let suggestion: RecipientSuggestion
    let isHighlighted: Bool
    let theme: ThemeStore
    var horizontalPadding: CGFloat = 20
    @ScaledMetric(relativeTo: .subheadline) private var avatarSize: CGFloat = 32

    var body: some View {
        HStack(spacing: 12) {
            RecipientAvatar(
                name: suggestion.displayName,
                seed: suggestion.email.lowercased(),
                photoURL: suggestion.photoURL,
                theme: theme,
                size: avatarSize
            )
            VStack(alignment: .leading, spacing: 1) {
                if let name = suggestion.name {
                    Text(RecipientHighlightText.attributed(name, highlights: suggestion.highlights(in: .name)))
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(RecipientHighlightText.attributed(suggestion.email, highlights: suggestion.highlights(in: .email)))
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    Text(RecipientHighlightText.attributed(suggestion.email, highlights: suggestion.highlights(in: .email)))
                        .font(.subheadline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, horizontalPadding)
        .padding(.vertical, 7)
        .frame(minHeight: 44)
        .background(isHighlighted ? theme.accentSoftColor : Color.clear)
        .contentShape(.rect)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(isHighlighted ? [.isButton, .isSelected] : .isButton)
    }

    private var accessibilityText: String {
        var parts = [suggestion.displayName]
        if suggestion.name != nil { parts.append(suggestion.email) }
        if let company = suggestion.company { parts.append(company) }
        return parts.joined(separator: ", ")
    }
}

/// Initials in the accent family, or the photo when the server sends one.
struct RecipientAvatar: View {
    let name: String
    let seed: String
    let photoURL: URL?
    let theme: ThemeStore
    let size: CGFloat

    var body: some View {
        if let photoURL {
            KFImage(photoURL)
                .placeholder { ThemedInitialsAvatar(theme: theme, name: name, seed: seed, size: size) }
                .fade(duration: 0.15)
                .resizable()
                .aspectRatio(contentMode: .fill)
                .frame(width: size, height: size)
                .clipShape(Circle())
                .accessibilityHidden(true)
        } else {
            ThemedInitialsAvatar(theme: theme, name: name, seed: seed, size: size)
        }
    }
}

// MARK: - Layout

/// Chips from left to right, wrapping at the row width. The last subview is
/// the text field: it takes the rest of the line, or a new line when less
/// than `minimumTrailingWidth` is left.
struct RecipientFlowLayout: Layout {
    var spacing: CGFloat = 6
    var lineSpacing: CGFloat = 6
    var minimumTrailingWidth: CGFloat = 80

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = Self.finiteWidth(proposal.width)
        let arrangement = arrange(width: width ?? 10_000, subviews: subviews)
        return CGSize(width: width ?? arrangement.naturalWidth, height: arrangement.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let arrangement = arrange(width: bounds.width, subviews: subviews)
        for (index, frame) in arrangement.frames.enumerated() {
            subviews[index].place(
                at: CGPoint(x: bounds.minX + frame.minX, y: bounds.minY + frame.minY),
                anchor: .topLeading,
                proposal: ProposedViewSize(frame.size)
            )
        }
    }

    private static func finiteWidth(_ width: CGFloat?) -> CGFloat? {
        guard let width, width.isFinite else { return nil }
        return max(width, 0)
    }

    private func arrange(width: CGFloat, subviews: Subviews) -> (frames: [CGRect], height: CGFloat, naturalWidth: CGFloat) {
        var frames: [CGRect] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var lineHeight: CGFloat = 0
        var naturalWidth: CGFloat = 0
        for (index, subview) in subviews.enumerated() {
            if index == subviews.count - 1 {
                if x > 0, width - x < minimumTrailingWidth {
                    x = 0
                    y += lineHeight + lineSpacing
                    lineHeight = 0
                }
                let fieldWidth = max(width - x, minimumTrailingWidth)
                let size = subview.sizeThatFits(ProposedViewSize(width: fieldWidth, height: nil))
                frames.append(CGRect(x: x, y: y, width: fieldWidth, height: size.height))
                lineHeight = max(lineHeight, size.height)
                naturalWidth = max(naturalWidth, x + minimumTrailingWidth)
            } else {
                let ideal = subview.sizeThatFits(.unspecified)
                let chipWidth = min(ideal.width, width)
                let size = chipWidth < ideal.width
                    ? subview.sizeThatFits(ProposedViewSize(width: chipWidth, height: nil))
                    : ideal
                if x > 0, x + chipWidth > width {
                    x = 0
                    y += lineHeight + lineSpacing
                    lineHeight = 0
                }
                frames.append(CGRect(x: x, y: y, width: chipWidth, height: size.height))
                x += chipWidth + spacing
                lineHeight = max(lineHeight, size.height)
                naturalWidth = max(naturalWidth, x - spacing)
            }
        }
        return (frames, subviews.isEmpty ? 0 : y + lineHeight, naturalWidth)
    }
}
