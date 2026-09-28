import Kingfisher
import SwiftUI

/// A To, Cc, or Bcc row with chips and live recipient search. It binds to the
/// same comma-separated string the composer always sent (`Name <email>,
/// email`), so drafts, reply prefill, and the send path do not change.
///
/// Focus: the parent owns the focus state. It passes the binding (to focus
/// the text field) and `isFocused` as a plain value, so this view updates
/// every time the focus moves.
///
/// Mac: the list floats under the text line (`RecipientListPlacement.dropdown`),
/// the pointer and the arrow keys move one highlight, a key monitor reads
/// Return, Tab, Esc, Delete, and the arrows before the field editor and the
/// sheet's buttons (`RecipientKeyInterceptor`), and chips have a context menu.
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
    var listPlacement: RecipientListPlacement = .platformDefault
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
    /// The pointer is over the suggestion list.
    @State private var pointerInList = false
    /// The field lost focus while the mouse button was down on the list: the
    /// list stays until the click lands (or the pointer leaves the list).
    @State private var holdsListForClick = false
    /// The space from the row to the bottom of the scroll view (dropdown only).
    @State private var dropdownSpace: CGFloat = .infinity

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
        listPlacement: RecipientListPlacement = .platformDefault,
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
        self.listPlacement = listPlacement
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
                    .font(RecipientFieldMetrics.font)
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
                .overlay(alignment: .topLeading) {
                    if listVisible, placement == .dropdown {
                        // The reader has the size of the chip area; the list
                        // hangs under its last line and draws past its bottom.
                        GeometryReader { proxy in
                            dropdownList(width: proxy.size.width)
                                .offset(y: proxy.size.height + RecipientDropdownMetrics.gap)
                        }
                    }
                }
                accessory()
            }
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .modifier(RecipientDropdownSpaceReader(isActive: placement == .dropdown, space: $dropdownSpace))
            if listVisible, placement == .inline {
                RecipientSuggestionList(
                    suggestions: displayedSuggestions,
                    highlightedIndex: displayedHighlight,
                    caption: listCaption,
                    theme: theme,
                    horizontalPadding: horizontalPadding,
                    onPick: pickFromList,
                    onHoverRow: rowHoverHandler,
                    onPointerInside: pointerInsideList
                )
                .transition(.opacity)
            }
        }
        // The floating list draws over the rows that follow this field.
        .zIndex(listVisible && placement == .dropdown ? 1 : 0)
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
                holdsListForClick = false
                listDismissed = false
                refreshSearch()
            } else if shouldHoldListForClick {
                // The mouse button is down on a row; the click picks it.
                holdsListForClick = true
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
            .font(RecipientFieldMetrics.font)
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
            // The key monitor sees the keys first; the handlers above stay as
            // a fallback when the field editor is not an NSTextView.
            .background(
                RecipientKeyInterceptor(isActive: isFocused && isEnabled && presentation == nil) { key, text in
                    handleMacKey(key, editorText: text)
                }
            )
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
        let isPresented = Binding(
            get: { detailTokenID == token.id },
            set: { if !$0, detailTokenID == token.id { detailTokenID = nil } }
        )
        return RecipientChip(
            token: token,
            isSelected: state.selectedTokenID == token.id,
            theme: theme
        ) {
            detailTokenID = token.id
        }
        #if os(macOS)
        // Under the chip: above it are the From row and the sheet's toolbar.
        .popover(isPresented: isPresented, arrowEdge: .bottom) { tokenDetail(token) }
        .contextMenu { chipMenu(token) }
        #else
        .popover(isPresented: isPresented) { tokenDetail(token) }
        #endif
        .accessibilityAction(named: "Remove") {
            guard isEnabled else { return }
            state.remove(token.id)
            publish()
        }
    }

    private func tokenDetail(_ token: RecipientToken) -> some View {
        RecipientTokenDetail(
            token: token,
            theme: theme,
            isEnabled: isEnabled,
            onRemove: {
                detailTokenID = nil
                remove(token.id)
            },
            onEdit: {
                detailTokenID = nil
                edit(token.id)
            },
            onUseAlternate: { email in
                detailTokenID = nil
                useAlternate(email, for: token.id)
            }
        )
        .presentationCompactAdaptation(.popover)
    }

    #if os(macOS)
    /// Right-click on a chip: the same actions as the chip popover.
    @ViewBuilder private func chipMenu(_ token: RecipientToken) -> some View {
        if token.isValid {
            Button("Copy address") { RecipientPasteboard.copy(token.email) }
        } else {
            Button("Copy text") { RecipientPasteboard.copy(token.email) }
        }
        if isEnabled {
            if token.isValid {
                ForEach(token.alternateEmails, id: \.self) { email in
                    Button("Use \(email)") { useAlternate(email, for: token.id) }
                }
            }
            Button("Edit") { edit(token.id) }
            Divider()
            Button("Remove", role: .destructive) { remove(token.id) }
        }
    }
    #endif

    private func dropdownList(width: CGFloat) -> some View {
        RecipientSuggestionDropdown(
            suggestions: displayedSuggestions,
            highlightedIndex: displayedHighlight,
            caption: listCaption,
            theme: theme,
            maxHeight: RecipientDropdownMetrics.maxHeight(
                spaceBelow: dropdownSpace + verticalPadding - RecipientDropdownMetrics.gap
            ),
            onPick: pickFromList,
            onHoverRow: rowHoverHandler,
            onPointerInside: pointerInsideList
        )
        .frame(width: min(width, RecipientDropdownMetrics.maxWidth), alignment: .leading)
        .transition(.opacity)
    }

    // MARK: - Derived state

    private var placement: RecipientListPlacement {
        presentation?.placement ?? listPlacement
    }

    private var displayedSuggestions: [RecipientSuggestion] {
        presentation?.suggestions ?? search.suggestions
    }

    private var displayedHighlight: Int? {
        presentation != nil ? presentation?.highlightedIndex : search.highlightedIndex
    }

    /// Rows to show, apart from focus.
    private var hasListContent: Bool {
        isEnabled && !listDismissed && !search.suggestions.isEmpty
    }

    private var listVisible: Bool {
        if let presentation { return presentation.showsList && !presentation.suggestions.isEmpty }
        return (isFocused || holdsListForClick) && hasListContent
    }

    private var listCaption: String? {
        let query = presentation?.draft ?? search.resultQuery ?? state.draft
        return query.nilIfBlank == nil ? "Suggested" : nil
    }

    /// The field lost focus during a click on the list (macOS).
    private var shouldHoldListForClick: Bool {
        #if os(macOS)
        return presentation == nil && pointerInList && hasListContent && RecipientMouse.primaryButtonIsDown
        #else
        return false
        #endif
    }

    /// The pointer moves the highlight on the Mac; iOS rows have no hover.
    private var rowHoverHandler: ((Int) -> Void)? {
        #if os(macOS)
        return hoverRow
        #else
        return nil
        #endif
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
        // A complete address commits as typed; it does not wait for rows.
        guard !listDismissed, search.isSearching,
              !RecipientAddressParser.isCompleteAddress(query) else {
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

    /// A click or tap on a row. The field takes focus back for the next person.
    private func pickFromList(_ suggestion: RecipientSuggestion) {
        holdsListForClick = false
        pick(suggestion)
        focus.wrappedValue = focusValue
    }

    /// The pointer moved over a row: it becomes the highlighted row, the same
    /// highlight that the arrow keys move and that Return picks.
    private func hoverRow(_ index: Int) {
        guard presentation == nil, search.suggestions.indices.contains(index),
              search.highlightedIndex != index else { return }
        search.chooseHighlight(index)
    }

    private func pointerInsideList(_ inside: Bool) {
        pointerInList = inside
        // A press on the list that did not end in a pick: close it now.
        guard !inside, holdsListForClick else { return }
        holdsListForClick = false
        if !isFocused { handleBlur() }
    }

    private func remove(_ id: UUID) {
        state.remove(id)
        publish()
        refreshSearch()
    }

    private func edit(_ id: UUID) {
        state.beginEditing(id)
        syncFieldText()
        publish()
        focus.wrappedValue = focusValue
    }

    private func useAlternate(_ email: String, for id: UUID) {
        state.useAlternate(email, for: id)
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

    #if os(macOS)
    /// A key from the Mac key monitor. Returns true when the field used it,
    /// so the field editor, the default button, and the cancel button do not
    /// see it.
    private func handleMacKey(_ key: RecipientKey, editorText: String) -> Bool {
        // The field editor can be one keystroke ahead of the state.
        if RecipientFieldText.strip(editorText) != state.draft {
            handleFieldText(editorText)
        }
        let context = RecipientKeyContext(
            listVisible: listVisible,
            canPick: listVisible && search.pickable(for: state.draft) != nil,
            fieldIsEmpty: state.draft.isEmpty,
            hasChips: !state.tokens.isEmpty,
            hasSelectedChip: state.selectedToken != nil
        )
        guard let action = RecipientKeyAction.resolve(key, in: context) else { return false }
        perform(action)
        return true
    }

    private func perform(_ action: RecipientKeyAction) {
        switch action {
        case .moveHighlight(let offset):
            search.moveHighlight(by: offset)
        case .submit:
            submit()
        case .pickOrCommit:
            _ = commitFromTab()
        case .closeList:
            listDismissed = true
        case .clearChipSelection:
            state.selectedTokenID = nil
        case .selectPreviousChip:
            state.selectPreviousToken()
        case .selectNextChip:
            state.selectNextToken()
        case .deleteBackwardOverChips:
            guard isEnabled else { return }
            if state.backspaceOnEmptyDraft() { publish(); refreshSearch() }
        case .removeSelectedChip:
            guard isEnabled else { return }
            if state.removeSelectedToken() { publish(); refreshSearch() }
        case .copySelectedChip:
            if let token = state.selectedToken { RecipientPasteboard.copy(token.pasteboardText) }
        case .cutSelectedChip:
            guard let token = state.selectedToken else { return }
            RecipientPasteboard.copy(token.pasteboardText)
            guard isEnabled else { return }
            if state.removeSelectedToken() { publish(); refreshSearch() }
        }
    }
    #endif
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
        listPlacement: RecipientListPlacement = .platformDefault,
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
            listPlacement: listPlacement,
            onSubmitEmpty: onSubmitEmpty,
            presentation: presentation,
            accessory: { EmptyView() }
        )
    }
}

/// Where the suggestion list shows.
enum RecipientListPlacement: Hashable, Sendable {
    /// Under the row, in the layout: the rows below move down (iOS, and the
    /// draft card in the chat, which sits in a scrolling transcript).
    case inline
    /// A floating list under the text line, over the rows below (Mac compose).
    case dropdown

    static var platformDefault: RecipientListPlacement {
        #if os(macOS)
        .dropdown
        #else
        .inline
        #endif
    }
}

/// A fixed field state for rendering tests and previews.
struct RecipientFieldPresentation {
    var draft: String = ""
    var suggestions: [RecipientSuggestion] = []
    var highlightedIndex: Int?
    var showsList = true
    var selectedTokenIndex: Int?
    /// Nil keeps the field's own placement.
    var placement: RecipientListPlacement?
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

/// Text sizes and row sizes. The Mac sets text at 13 pt (`.body`), the size
/// of the Mac's own text fields; iOS uses the phone's smaller compose size.
enum RecipientFieldMetrics {
    #if os(macOS)
    static var font: Font { .body }
    static var rowNameFont: Font { .body }
    static var rowDetailFont: Font { .subheadline }
    static var captionFont: Font { .subheadline }
    static let rowAvatarSize: CGFloat = 26
    static let rowMinHeight: CGFloat = 36
    static let rowVerticalPadding: CGFloat = 4
    #else
    static var font: Font { .subheadline }
    static var rowNameFont: Font { .subheadline }
    static var rowDetailFont: Font { .footnote }
    static var captionFont: Font { .footnote }
    static let rowAvatarSize: CGFloat = 32
    static let rowMinHeight: CGFloat = 44
    static let rowVerticalPadding: CGFloat = 7
    #endif
}

enum RecipientChipMetrics {
    #if os(macOS)
    static let verticalInset: CGFloat = 3
    static let horizontalInset: CGFloat = 8
    #else
    static let verticalInset: CGFloat = 4
    static let horizontalInset: CGFloat = 9
    #endif
}

// MARK: - Chip

struct RecipientChip: View {
    let token: RecipientToken
    let isSelected: Bool
    let theme: ThemeStore
    let onTap: () -> Void
    @State private var isHovered = false

    var body: some View {
        Button(action: onTap) {
            Text(token.displayName)
                .font(RecipientFieldMetrics.font)
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
        #if os(macOS)
        .onHover { isHovered = $0 }
        .help(token.isValid ? token.email : "Not a valid address")
        #endif
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
        if isSelected { return theme.accentColor }
        // Mac hover: a firmer hairline says the chip is a control.
        return isHovered ? Color.primary.opacity(0.22) : theme.hairlineColor
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
                    Text(verbatim: token.email)
                        .font(token.name == nil ? .headline : RecipientFieldMetrics.font)
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
                            .font(RecipientFieldMetrics.font)
                            .buttonStyle(.plain)
                            .foregroundStyle(theme.accentColor)
                            .modifier(RecipientLinkPointer())
                    }
                }
            }
            if isEnabled {
                HStack(spacing: 16) {
                    Button("Edit", action: onEdit)
                        .buttonStyle(.plain)
                        .foregroundStyle(theme.accentColor)
                        .modifier(RecipientLinkPointer())
                    Button("Remove", role: .destructive, action: onRemove)
                        .buttonStyle(.plain)
                        .foregroundStyle(.red)
                        .modifier(RecipientLinkPointer())
                }
                .font(RecipientFieldMetrics.font.weight(.medium))
            }
        }
        .padding(16)
        .frame(minWidth: 240, idealWidth: 300, maxWidth: 360, alignment: .leading)
    }
}

/// Text buttons that read as links show the Mac's link pointer.
struct RecipientLinkPointer: ViewModifier {
    func body(content: Content) -> some View {
        #if os(macOS)
        content.pointerStyle(.link)
        #else
        content
        #endif
    }
}

// MARK: - Suggestions

/// The list inside the layout (iOS, and the chat draft card).
struct RecipientSuggestionList: View {
    let suggestions: [RecipientSuggestion]
    let highlightedIndex: Int?
    let caption: String?
    let theme: ThemeStore
    var horizontalPadding: CGFloat = 20
    let onPick: (RecipientSuggestion) -> Void
    var onHoverRow: ((Int) -> Void)? = nil
    var onPointerInside: ((Bool) -> Void)? = nil
    @State private var hover = RecipientHoverTracker()

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Divider()
                .overlay(theme.hairlineColor)
            if let caption {
                Text(caption)
                    .font(RecipientFieldMetrics.captionFont)
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
                .modifier(RecipientRowPointer(index: index, tracker: hover, onHoverRow: onHoverRow))
            }
        }
        .padding(.bottom, 4)
        .modifier(RecipientListPointer(tracker: hover, onPointerInside: onPointerInside))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggested recipients")
    }
}

/// The floating Mac list: an elevated surface under the text line, about
/// eight rows high, that scrolls when it has more rows or less room.
struct RecipientSuggestionDropdown: View {
    @Environment(\.colorScheme) private var colorScheme
    let suggestions: [RecipientSuggestion]
    let highlightedIndex: Int?
    let caption: String?
    let theme: ThemeStore
    var maxHeight: CGFloat = RecipientDropdownMetrics.preferredMaxHeight
    let onPick: (RecipientSuggestion) -> Void
    var onHoverRow: ((Int) -> Void)? = nil
    var onPointerInside: ((Bool) -> Void)? = nil
    @State private var hover = RecipientHoverTracker()

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: RecipientDropdownMetrics.cornerRadius, style: .continuous)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if let caption {
                        Text(caption)
                            .font(RecipientFieldMetrics.captionFont)
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                            .padding(.top, 4)
                            .padding(.bottom, 3)
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
                                isMenuRow: true
                            )
                        }
                        .buttonStyle(.plain)
                        .modifier(RecipientRowPointer(index: index, tracker: hover, onHoverRow: onHoverRow))
                        .id(suggestion.id)
                    }
                }
                .padding(RecipientDropdownMetrics.inset)
            }
            .scrollBounceBehavior(.basedOnSize)
            // The system edge blur made the first row unreadable; the list's
            // rounded edge and inset already mark where it ends.
            .scrollEdgeEffectHidden()
            .frame(maxHeight: maxHeight)
            .onChange(of: highlightedIndex) { _, index in
                // Arrow keys past the visible rows scroll the list.
                guard let index, suggestions.indices.contains(index) else { return }
                proxy.scrollTo(suggestions[index].id)
            }
        }
        // As tall as the rows, up to `maxHeight`.
        .fixedSize(horizontal: false, vertical: true)
        .background(theme.elevatedColor, in: shape)
        .clipShape(shape)
        .overlay {
            shape.strokeBorder(Color.primary.opacity(colorScheme == .dark ? 0.14 : 0.10), lineWidth: 1)
        }
        // One raised layer: the layered soft shadow in light mode; dark mode
        // raises by lightness and the hairline (Surface.swift).
        .shadow(color: .black.opacity(colorScheme == .dark ? 0 : 0.06), radius: 1, y: 1)
        .shadow(color: .black.opacity(colorScheme == .dark ? 0 : 0.12), radius: 16, y: 8)
        .modifier(RecipientListPointer(tracker: hover, onPointerInside: onPointerInside))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Suggested recipients")
    }
}

/// The last pointer location over one list, outside SwiftUI state, so a
/// pointer move does not redraw the list.
@MainActor
final class RecipientHoverTracker {
    var filter = RecipientHoverFilter()
}

/// Mac rows: the pointer moves the highlight, and a click does not take
/// keyboard focus from the text field.
private struct RecipientRowPointer: ViewModifier {
    let index: Int
    let tracker: RecipientHoverTracker
    let onHoverRow: ((Int) -> Void)?

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .focusable(false)
            .focusEffectDisabled()
            .onContinuousHover { phase in
                guard let onHoverRow, case .active(let location) = phase,
                      tracker.filter.pointerMoved(to: location) else { return }
                onHoverRow(index)
            }
        #else
        content
        #endif
    }
}

private struct RecipientListPointer: ViewModifier {
    let tracker: RecipientHoverTracker
    let onPointerInside: ((Bool) -> Void)?

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            // Arrow cursor over the list, also where it covers a text field.
            .pointerStyle(.default)
            .onHover { inside in
                if !inside { tracker.filter.reset() }
                onPointerInside?(inside)
            }
            // A list that closes under the pointer sends no hover exit.
            .onDisappear { onPointerInside?(false) }
        #else
        content
        #endif
    }
}

/// Reads the space from the row to the bottom of the scroll view, so the
/// floating list does not run past it.
private struct RecipientDropdownSpaceReader: ViewModifier {
    let isActive: Bool
    @Binding var space: CGFloat

    func body(content: Content) -> some View {
        if isActive {
            content.onGeometryChange(for: CGFloat.self) { proxy in
                RecipientDropdownMetrics.spaceBelow(
                    viewHeight: proxy.size.height,
                    scrollBounds: proxy.bounds(of: .scrollView)
                )
            } action: { newSpace in
                space = newSpace
            }
        } else {
            content
        }
    }
}

struct RecipientSuggestionRow: View {
    let suggestion: RecipientSuggestion
    let isHighlighted: Bool
    let theme: ThemeStore
    var horizontalPadding: CGFloat = 20
    /// A row of the floating list: a rounded highlight inside the list's inset.
    var isMenuRow = false
    @ScaledMetric(relativeTo: .subheadline) private var avatarSize: CGFloat = RecipientFieldMetrics.rowAvatarSize

    var body: some View {
        HStack(spacing: isMenuRow ? 10 : 12) {
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
                        .font(RecipientFieldMetrics.rowNameFont)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    Text(RecipientHighlightText.attributed(suggestion.email, highlights: suggestion.highlights(in: .email)))
                        .font(RecipientFieldMetrics.rowDetailFont)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                } else {
                    Text(RecipientHighlightText.attributed(suggestion.email, highlights: suggestion.highlights(in: .email)))
                        .font(RecipientFieldMetrics.rowNameFont)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, isMenuRow ? 8 : horizontalPadding)
        .padding(.vertical, RecipientFieldMetrics.rowVerticalPadding)
        .frame(minHeight: RecipientFieldMetrics.rowMinHeight)
        .background {
            if isHighlighted {
                if isMenuRow {
                    RoundedRectangle(cornerRadius: 6, style: .continuous).fill(theme.accentSoftColor)
                } else {
                    theme.accentSoftColor
                }
            }
        }
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
