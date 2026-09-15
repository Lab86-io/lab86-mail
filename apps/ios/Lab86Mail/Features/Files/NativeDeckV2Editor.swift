import SwiftUI

// The native editor for a version 2 presentation. The parent owns the model:
// every edit goes out through `onChange`, and the editor keeps only selection,
// inline editing and an undo history. The chrome uses the application's
// Surface tokens; the slide itself uses only the deck theme.

/// A bounded undo and redo stack over whole deck snapshots.
struct DeckHistory: Equatable {
    static let limit = 100
    private(set) var undoStack: [AlbatrossDeckV2] = []
    private(set) var redoStack: [AlbatrossDeckV2] = []

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }

    mutating func record(_ snapshot: AlbatrossDeckV2) {
        undoStack.append(snapshot)
        if undoStack.count > Self.limit { undoStack.removeFirst(undoStack.count - Self.limit) }
        redoStack.removeAll()
    }

    mutating func undo(current: AlbatrossDeckV2) -> AlbatrossDeckV2? {
        guard let previous = undoStack.popLast() else { return nil }
        redoStack.append(current)
        return previous
    }

    mutating func redo(current: AlbatrossDeckV2) -> AlbatrossDeckV2? {
        guard let next = redoStack.popLast() else { return nil }
        undoStack.append(current)
        return next
    }
}

struct NativeDeckV2Editor: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    let deck: AlbatrossDeckV2
    let webEditorURL: URL?
    let onChange: (AlbatrossDeckV2) -> Void

    @State private var selectedElementID: String?
    @State private var editingElementID: String?
    @State private var editingText = ""
    @State private var showsInspector = false
    @State private var isPresenting = false
    @State private var history = DeckHistory()
    @State private var dragOrigin: DeckGeometry.Bounds?
    @State private var resizeOrigin: DeckGeometry.Bounds?
    @State private var notesRecorded = false

    private var isCompact: Bool { horizontalSizeClass == .compact }
    private var slide: AlbatrossDeckSlideV2 { deck.activeSlide }
    private var selectedElement: AlbatrossDeckElementV2? {
        slide.elements.first { $0.id == selectedElementID }
    }

    var body: some View {
        Group {
            if isCompact {
                VStack(spacing: 0) {
                    filmstrip(axis: .horizontal)
                    Divider()
                    workspace
                }
            } else {
                HStack(spacing: 0) {
                    filmstrip(axis: .vertical)
                    Divider()
                    workspace
                    Divider()
                    inspector
                        .frame(width: 300)
                        .background(environment.theme.elevatedColor)
                }
            }
        }
        .background(environment.theme.paperColor)
        .sheet(isPresented: $showsInspector) {
            NavigationStack {
                inspector
                    .navigationTitle(selectedElement?.label ?? "Slide")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button("Done") { showsInspector = false }
                        }
                    }
            }
            #if os(iOS)
            .presentationDetents([.medium, .large])
            #else
            .frame(minWidth: 360, minHeight: 480)
            #endif
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $isPresenting) {
            DeckPresentationView(deck: deck, assetBaseURL: environment.configuration.apiBaseURL)
        }
        #else
        .sheet(isPresented: $isPresenting) {
            DeckPresentationView(deck: deck, assetBaseURL: environment.configuration.apiBaseURL)
                .frame(minWidth: 960, minHeight: 600)
        }
        #endif
        .onChange(of: deck.activeSlideID) { _, _ in
            selectedElementID = nil
            endTextEdit()
            notesRecorded = false
        }
    }

    // MARK: - Filmstrip

    @ViewBuilder
    private func filmstrip(axis: Axis.Set) -> some View {
        let content = ForEach(Array(deck.slides.enumerated()), id: \.element.id) { index, item in
            filmstripItem(item, index: index)
        }
        let addButton = Button("Add slide") { addSlide() }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .accessibilityIdentifier("files.deck.addSlide")
        ScrollView(axis) {
            if axis == .horizontal {
                HStack(spacing: 10) {
                    content
                    addButton.frame(height: 72)
                }
                .padding(10)
            } else {
                VStack(spacing: 12) {
                    content
                    addButton
                }
                .padding(12)
            }
        }
        .scrollIndicators(.hidden)
        .background(environment.theme.railColor)
        .frame(width: axis == .vertical ? 168 : nil)
    }

    private func filmstripItem(_ item: AlbatrossDeckSlideV2, index: Int) -> some View {
        let isActive = item.id == deck.activeSlideID
        return Button {
            selectSlide(item.id)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                DeckSlideView(slide: item, theme: deck.theme, assetBaseURL: environment.configuration.apiBaseURL)
                    .frame(width: 128)
                    .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))
                    .overlay {
                        RoundedRectangle(cornerRadius: 4, style: .continuous)
                            .strokeBorder(
                                isActive ? Color.accentColor : environment.theme.hairlineColor,
                                lineWidth: isActive ? 2 : 1
                            )
                    }
                Text("\(index + 1)  \(item.title)")
                    .font(.caption2)
                    .lineLimit(1)
                    .foregroundStyle(isActive ? .primary : .secondary)
                    .frame(width: 128, alignment: .leading)
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Slide \(index + 1), \(item.title)")
        .contextMenu {
            Button("Duplicate slide") { edit { $0.duplicateSlide(item.id) } }
            Button("Move earlier") { edit { $0.moveSlide(item.id, by: -1) } }
                .disabled(index == 0)
            Button("Move later") { edit { $0.moveSlide(item.id, by: 1) } }
                .disabled(index == deck.slides.count - 1)
            Button("Delete slide", role: .destructive) { edit { $0.deleteSlide(item.id) } }
                .disabled(deck.slides.count == 1)
        }
    }

    // MARK: - Workspace

    private var workspace: some View {
        ScrollView {
            VStack(spacing: 16) {
                canvas
                    .frame(maxWidth: 1100)
                actionRow
                    .frame(maxWidth: 1100)
                notesPanel
                    .frame(maxWidth: 1100)
            }
            .padding(isCompact ? 12 : 20)
        }
        .scrollDisabled(dragOrigin != nil || resizeOrigin != nil)
        #if os(macOS)
        .onDeleteCommand { deleteSelected() }
        .onExitCommand { endTextEdit(); selectedElementID = nil }
        #endif
    }

    private var canvas: some View {
        GeometryReader { proxy in
            let size = proxy.size
            ZStack(alignment: .topLeading) {
                DeckSlideView(
                    slide: slide,
                    theme: deck.theme,
                    assetBaseURL: environment.configuration.apiBaseURL,
                    showsPlaceholders: true,
                    hiddenElementID: editingElementID
                )
                .contentShape(Rectangle())
                .onTapGesture {
                    endTextEdit()
                    selectedElementID = nil
                }
                ForEach(slide.elements) { element in
                    hitArea(for: element, in: size)
                }
                if let element = selectedElement, editingElementID != element.id {
                    selectionOverlay(for: element, in: size)
                }
                if let element = selectedElement, editingElementID == element.id, case .text(let text) = element.content {
                    inlineEditor(for: element, text: text, in: size)
                }
            }
            .frame(width: size.width, height: size.height)
        }
        .aspectRatio(DeckGeometry.aspect, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .shadow(color: .black.opacity(0.12), radius: 12, y: 4)
        .accessibilityIdentifier("files.deck.canvas")
    }

    private func hitArea(for element: AlbatrossDeckElementV2, in size: CGSize) -> some View {
        let rect = DeckGeometry.rect(for: element.bounds, in: size)
        let minimum: CGFloat = 12
        return Rectangle()
            .fill(Color.clear)
            .contentShape(Rectangle())
            .frame(width: max(rect.width, minimum), height: max(rect.height, minimum))
            .rotationEffect(.degrees(element.rotation ?? 0))
            .position(x: rect.midX, y: rect.midY)
            .onTapGesture(count: 2) { beginTextEdit(element) }
            .onTapGesture {
                if editingElementID != element.id { endTextEdit() }
                selectedElementID = element.id
            }
            .gesture(moveGesture(for: element, in: size))
            .accessibilityLabel(element.label)
            .accessibilityAddTraits(.isButton)
    }

    private func moveGesture(for element: AlbatrossDeckElementV2, in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 3)
            .onChanged { value in
                guard !element.isLocked, editingElementID == nil else { return }
                if dragOrigin == nil {
                    dragOrigin = element.bounds
                    selectedElementID = element.id
                    history.record(deck)
                }
                guard let origin = dragOrigin else { return }
                let next = DeckGeometry.moved(
                    origin,
                    by: value.translation,
                    in: size,
                    minimumSize: element.isLine ? 0 : DeckGeometry.minimumSize
                )
                var updated = deck
                updated.updateElement(element.id) { $0.bounds = next }
                onChange(updated)
            }
            .onEnded { _ in dragOrigin = nil }
    }

    private func selectionOverlay(for element: AlbatrossDeckElementV2, in size: CGSize) -> some View {
        let rect = DeckGeometry.rect(for: element.bounds, in: size)
        let handle: CGFloat = 14
        return ZStack {
            Rectangle()
                .strokeBorder(Color.accentColor, lineWidth: 1.5)
                .frame(width: max(rect.width, 1), height: max(rect.height, 1))
                .position(x: rect.midX, y: rect.midY)
                .allowsHitTesting(false)
            if !element.isLocked {
                ForEach(Array(DeckGeometry.Corner.allCases.enumerated()), id: \.offset) { _, corner in
                    let point = Self.cornerPoint(corner, of: rect)
                    Circle()
                        .fill(Color.accentColor)
                        .overlay(Circle().strokeBorder(.white, lineWidth: 1.5))
                        .frame(width: handle, height: handle)
                        .contentShape(Circle().scale(2))
                        .position(point)
                        .gesture(resizeGesture(for: element, corner: corner, in: size))
                        .accessibilityLabel("Resize handle")
                }
            }
        }
        .rotationEffect(.degrees(element.rotation ?? 0), anchor: UnitPoint(x: rect.midX / max(size.width, 1), y: rect.midY / max(size.height, 1)))
    }

    private static func cornerPoint(_ corner: DeckGeometry.Corner, of rect: CGRect) -> CGPoint {
        switch corner {
        case .topLeading: CGPoint(x: rect.minX, y: rect.minY)
        case .topTrailing: CGPoint(x: rect.maxX, y: rect.minY)
        case .bottomLeading: CGPoint(x: rect.minX, y: rect.maxY)
        case .bottomTrailing: CGPoint(x: rect.maxX, y: rect.maxY)
        }
    }

    private func resizeGesture(for element: AlbatrossDeckElementV2, corner: DeckGeometry.Corner, in size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 1)
            .onChanged { value in
                if resizeOrigin == nil {
                    resizeOrigin = element.bounds
                    history.record(deck)
                }
                guard let origin = resizeOrigin else { return }
                let next = DeckGeometry.resized(
                    origin,
                    corner: corner,
                    by: value.translation,
                    in: size,
                    minimumSize: element.isLine ? 0 : DeckGeometry.minimumSize
                )
                var updated = deck
                updated.updateElement(element.id) { $0.bounds = next }
                onChange(updated)
            }
            .onEnded { _ in resizeOrigin = nil }
    }

    private func inlineEditor(for element: AlbatrossDeckElementV2, text: AlbatrossDeckElementContent.Text, in size: CGSize) -> some View {
        let rect = DeckGeometry.rect(for: element.bounds, in: size)
        let scale = DeckGeometry.scale(slideWidth: size.width)
        let font = DeckPalette.font(
            slot: text.resolvedSlot,
            size: text.resolvedSize * scale,
            weight: text.resolvedWeight,
            italic: text.italic ?? false,
            theme: deck.theme
        )
        return TextEditor(text: $editingText)
            .font(font)
            .foregroundStyle(DeckPalette.color(text.color, fallback: deck.theme.colors.ink, theme: deck.theme))
            .scrollContentBackground(.hidden)
            .background(DeckPalette.color(deck.theme.colors.background, fallback: "#FFFFFF", theme: deck.theme).opacity(0.85))
            .overlay(Rectangle().strokeBorder(Color.accentColor, lineWidth: 1.5))
            .frame(width: max(rect.width, 40), height: max(rect.height, 32))
            .position(x: rect.midX, y: rect.midY)
            .onChange(of: editingText) { _, value in
                var updated = deck
                updated.updateElement(element.id) {
                    if case .text(var content) = $0.content {
                        content.text = value
                        $0.content = .text(content)
                    }
                }
                onChange(updated)
            }
            .accessibilityIdentifier("files.deck.textEditor")
    }

    private var actionRow: some View {
        HStack(spacing: 8) {
            Menu("Add") {
                Button("Text") { addElement(.text(.init(text: "Text", role: "body", fontSize: 16)), width: 40, height: 10) }
                Button("Rectangle") { addElement(.shape(.init(shape: "rect")), width: 30, height: 20) }
                Button("Rounded rectangle") { addElement(.shape(.init(shape: "roundRect", radius: 12)), width: 30, height: 20) }
                Button("Ellipse") { addElement(.shape(.init(shape: "ellipse")), width: 20, height: 20 * DeckGeometry.aspect) }
                Button("Line") {
                    addElement(.line(.init(stroke: AlbatrossDeckStroke(color: deck.theme.colors.ink, width: 1.25))), width: 30, height: 0)
                }
            }
            .menuStyle(.button)
            .buttonStyle(.bordered)
            .controlSize(.small)
            if editingElementID != nil {
                Button("Done editing") { endTextEdit() }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            } else if isCompact {
                Button(selectedElement == nil ? "Slide" : "Style") { showsInspector = true }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .accessibilityIdentifier("files.deck.inspector")
            }
            Spacer(minLength: 0)
            Button("Undo") { undo() }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(!history.canUndo)
                .keyboardShortcut("z", modifiers: .command)
            Button("Redo") { redo() }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(!history.canRedo)
                .keyboardShortcut("z", modifiers: [.command, .shift])
            Button("Present") { isPresenting = true }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .accessibilityIdentifier("files.deck.present")
        }
    }

    private var notesPanel: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Speaker notes")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            TextEditor(text: notesBinding)
                .frame(minHeight: 90)
                .padding(8)
                .scrollContentBackground(.hidden)
                .background(environment.theme.elevatedColor, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(environment.theme.hairlineColor, lineWidth: 1)
                }
                .accessibilityIdentifier("files.deck.notes")
        }
    }

    private var notesBinding: Binding<String> {
        Binding {
            slide.notes ?? ""
        } set: { value in
            guard value != (slide.notes ?? "") else { return }
            if !notesRecorded {
                history.record(deck)
                notesRecorded = true
            }
            var updated = deck
            updated.updateActiveSlide { $0.notes = value }
            onChange(updated)
        }
    }

    // MARK: - Inspector

    private var inspector: some View {
        DeckInspector(
            deck: deck,
            selectedElementID: $selectedElementID,
            webEditorURL: webEditorURL,
            edit: { change in edit(change) },
            editLive: { change in
                var updated = deck
                change(&updated)
                onChange(updated)
            },
            recordHistory: { history.record(deck) }
        )
    }

    // MARK: - Edits

    private func edit(_ change: (inout AlbatrossDeckV2) -> Void) {
        var updated = deck
        change(&updated)
        guard updated != deck else { return }
        history.record(deck)
        onChange(updated)
    }

    private func selectSlide(_ id: String) {
        guard id != deck.activeSlideID else { return }
        endTextEdit()
        var updated = deck
        updated.activeSlideID = id
        onChange(updated)
    }

    private func addSlide() {
        edit { _ = $0.addSlide() }
    }

    private func addElement(_ content: AlbatrossDeckElementContent, width: Double, height: Double) {
        let element = AlbatrossDeckElementV2(x: 10, y: 10, width: width, height: height, content: content)
        edit { $0.appendElement(element) }
        selectedElementID = element.id
    }

    private func deleteSelected() {
        guard let id = selectedElementID, editingElementID == nil else { return }
        edit { $0.removeElement(id) }
        selectedElementID = nil
    }

    private func beginTextEdit(_ element: AlbatrossDeckElementV2) {
        guard case .text(let text) = element.content, !element.isLocked else { return }
        if editingElementID != element.id { endTextEdit() }
        selectedElementID = element.id
        editingText = text.text
        history.record(deck)
        editingElementID = element.id
    }

    private func endTextEdit() {
        editingElementID = nil
    }

    private func undo() {
        endTextEdit()
        guard let previous = history.undo(current: deck) else { return }
        onChange(previous)
    }

    private func redo() {
        endTextEdit()
        guard let next = history.redo(current: deck) else { return }
        onChange(next)
    }
}

// MARK: - Inspector

private struct DeckInspector: View {
    let deck: AlbatrossDeckV2
    @Binding var selectedElementID: String?
    let webEditorURL: URL?
    /// An undoable change.
    let edit: ((inout AlbatrossDeckV2) -> Void) -> Void
    /// A change during a continuous control; `recordHistory` runs once at its start.
    let editLive: ((inout AlbatrossDeckV2) -> Void) -> Void
    let recordHistory: () -> Void

    private var slide: AlbatrossDeckSlideV2 { deck.activeSlide }
    private var element: AlbatrossDeckElementV2? { slide.elements.first { $0.id == selectedElementID } }

    var body: some View {
        Form {
            if let element {
                elementSections(element)
            } else {
                slideSections
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
    }

    // MARK: Element

    @ViewBuilder
    private func elementSections(_ element: AlbatrossDeckElementV2) -> some View {
        Section(element.label) {
            switch element.content {
            case .text(let text): textFields(element, text)
            case .shape(let shape): shapeFields(element, shape)
            case .line(let line): lineFields(element, line)
            case .image(let image): imageFields(element, image)
            case .chart(let chart): chartFields(element, chart)
            case .unknown(let type):
                Text("This build cannot edit a \(type) element. It is kept as is.")
                    .foregroundStyle(.secondary)
            }
        }
        Section("Position and size") {
            numberField("Left", value: binding(element, \.x))
            numberField("Top", value: binding(element, \.y))
            numberField("Width", value: binding(element, \.width))
            numberField("Height", value: binding(element, \.height))
            Slider(value: opacityBinding(element), in: 0 ... 1) {
                Text("Opacity")
            } onEditingChanged: { began in
                if began { recordHistory() }
            }
            Toggle("Locked", isOn: Binding(
                get: { element.isLocked },
                set: { value in update(element) { $0.locked = value ? true : nil } }
            ))
        }
        Section("Layer") {
            Button("Bring forward") { edit { $0.moveElement(element.id, by: 1) } }
                .disabled(slide.elements.last?.id == element.id)
            Button("Send backward") { edit { $0.moveElement(element.id, by: -1) } }
                .disabled(slide.elements.first?.id == element.id)
            Button("Delete element", role: .destructive) {
                edit { $0.removeElement(element.id) }
                selectedElementID = nil
            }
        }
        Section {
            Button("Back to slide") { selectedElementID = nil }
        }
    }

    @ViewBuilder
    private func textFields(_ element: AlbatrossDeckElementV2, _ text: AlbatrossDeckElementContent.Text) -> some View {
        Stepper(value: Binding(
            get: { text.resolvedSize },
            set: { value in updateText(element) { $0.fontSize = DeckGeometry.clampFontSize(value) } }
        ), in: 8 ... 240, step: 1) {
            LabeledContent("Size", value: text.resolvedSize.formatted())
        }
        Picker("Weight", selection: Binding(
            get: { Self.nearestWeight(text.resolvedWeight) },
            set: { value in updateText(element) { $0.fontWeight = value } }
        )) {
            Text("Light").tag(300)
            Text("Regular").tag(400)
            Text("Medium").tag(500)
            Text("Semibold").tag(600)
            Text("Bold").tag(700)
        }
        Picker("Font", selection: Binding(
            get: { text.resolvedSlot },
            set: { value in updateText(element) { $0.font = value } }
        )) {
            Text(deck.theme.fonts.display.family).tag("display")
            Text(deck.theme.fonts.body.family).tag("body")
            if let mono = deck.theme.fonts.mono { Text(mono.family).tag("mono") }
        }
        Picker("Align", selection: Binding(
            get: { text.align ?? "left" },
            set: { value in updateText(element) { $0.align = value == "left" ? nil : value } }
        )) {
            Text("Left").tag("left")
            Text("Center").tag("center")
            Text("Right").tag("right")
        }
        .pickerStyle(.segmented)
        Picker("Vertical", selection: Binding(
            get: { text.valign ?? "middle" },
            set: { value in updateText(element) { $0.valign = value == "middle" ? nil : value } }
        )) {
            Text("Top").tag("top")
            Text("Middle").tag("middle")
            Text("Bottom").tag("bottom")
        }
        .pickerStyle(.segmented)
        Toggle("Italic", isOn: Binding(
            get: { text.italic ?? false },
            set: { value in updateText(element) { $0.italic = value ? true : nil } }
        ))
        colorRow("Color", value: Binding(
            get: { text.color },
            set: { value in updateText(element) { $0.color = value } }
        ), defaultLabel: "Ink")
        colorRow("Fill", value: Binding(
            get: { text.fill },
            set: { value in updateText(element) { $0.fill = value } }
        ), defaultLabel: "None")
    }

    @ViewBuilder
    private func shapeFields(_ element: AlbatrossDeckElementV2, _ shape: AlbatrossDeckElementContent.Shape) -> some View {
        Picker("Shape", selection: Binding(
            get: { shape.shape ?? "rect" },
            set: { value in updateShape(element) { $0.shape = value } }
        )) {
            Text("Rectangle").tag("rect")
            Text("Rounded").tag("roundRect")
            Text("Ellipse").tag("ellipse")
        }
        .pickerStyle(.segmented)
        colorRow("Fill", value: Binding(
            get: { shape.fill },
            set: { value in updateShape(element) { $0.fill = value } }
        ), defaultLabel: "Surface")
        colorRow("Stroke", value: Binding(
            get: { shape.stroke?.color },
            set: { value in
                updateShape(element) { content in
                    if let value {
                        content.stroke = AlbatrossDeckStroke(color: value, width: content.stroke?.width ?? 1, dash: content.stroke?.dash)
                    } else {
                        content.stroke = nil
                    }
                }
            }
        ), defaultLabel: "None")
        if let stroke = shape.stroke {
            strokeWidthStepper(stroke.width) { value in
                updateShape(element) { $0.stroke?.width = value }
            }
        }
    }

    @ViewBuilder
    private func lineFields(_ element: AlbatrossDeckElementV2, _ line: AlbatrossDeckElementContent.Line) -> some View {
        let stroke = line.stroke ?? AlbatrossDeckStroke(color: deck.theme.colors.ink, width: 1)
        colorRow("Stroke", value: Binding(
            get: { line.stroke?.color },
            set: { value in
                updateLine(element) { content in
                    content.stroke = AlbatrossDeckStroke(color: value ?? deck.theme.colors.ink, width: stroke.width, dash: stroke.dash)
                }
            }
        ), defaultLabel: "Ink")
        strokeWidthStepper(stroke.width) { value in
            updateLine(element) { content in
                content.stroke = AlbatrossDeckStroke(color: stroke.color, width: value, dash: stroke.dash)
            }
        }
        Picker("Dash", selection: Binding(
            get: { line.stroke?.dash ?? "solid" },
            set: { value in
                updateLine(element) { content in
                    content.stroke = AlbatrossDeckStroke(color: stroke.color, width: stroke.width, dash: value == "solid" ? nil : value)
                }
            }
        )) {
            Text("Solid").tag("solid")
            Text("Dash").tag("dash")
            Text("Dot").tag("dot")
        }
        .pickerStyle(.segmented)
        if element.width > 0, element.height > 0 {
            Toggle("Rises to the right", isOn: Binding(
                get: { line.flip ?? false },
                set: { value in updateLine(element) { $0.flip = value ? true : nil } }
            ))
        }
    }

    @ViewBuilder
    private func imageFields(_ element: AlbatrossDeckElementV2, _ image: AlbatrossDeckElementContent.Image) -> some View {
        Picker("Fit", selection: Binding(
            get: { image.fit ?? "cover" },
            set: { value in updateImage(element) { $0.fit = value == "cover" ? nil : value } }
        )) {
            Text("Cover").tag("cover")
            Text("Contain").tag("contain")
        }
        .pickerStyle(.segmented)
        TextField("Alt text", text: Binding(
            get: { image.alt },
            set: { value in updateImage(element) { $0.alt = value } }
        ), axis: .vertical)
        Stepper(value: Binding(
            get: { image.radius ?? 0 },
            set: { value in updateImage(element) { $0.radius = value > 0 ? value : nil } }
        ), in: 0 ... 120, step: 2) {
            LabeledContent("Corner radius", value: (image.radius ?? 0).formatted())
        }
        if let webEditorURL {
            Link("Open full editor to replace the picture", destination: webEditorURL)
        }
    }

    @ViewBuilder
    private func chartFields(_ element: AlbatrossDeckElementV2, _ chart: AlbatrossDeckElementContent.Chart) -> some View {
        Picker("Kind", selection: Binding(
            get: { chart.chart },
            set: { value in updateChart(element) { $0.chart = value } }
        )) {
            Text("Bar").tag("bar")
            Text("Column").tag("column")
            Text("Line").tag("line")
            Text("Pie").tag("pie")
            Text("Doughnut").tag("doughnut")
        }
        Toggle("Legend", isOn: Binding(
            get: { chart.showsLegend },
            set: { value in updateChart(element) { $0.legend = value } }
        ))
        Toggle("Values", isOn: Binding(
            get: { chart.values ?? false },
            set: { value in updateChart(element) { $0.values = value ? true : nil } }
        ))
        TextField("Unit", text: Binding(
            get: { chart.unit ?? "" },
            set: { value in updateChart(element) { $0.unit = value.isEmpty ? nil : value } }
        ))
        if let webEditorURL {
            Link("Open full editor to change the data", destination: webEditorURL)
        }
    }

    // MARK: Slide

    @ViewBuilder
    private var slideSections: some View {
        Section("Slide") {
            TextField("Title", text: Binding(
                get: { slide.title },
                set: { value in edit { $0.updateActiveSlide { $0.title = value } } }
            ))
            colorRow("Background", value: Binding(
                get: { slide.background },
                set: { value in edit { $0.updateActiveSlide { $0.background = value } } }
            ), defaultLabel: "Theme")
        }
        Section("Theme") {
            LabeledContent("Current", value: deck.theme.name ?? "Custom")
            ForEach(AlbatrossDeckTheme.presets, id: \.name) { preset in
                Button(preset.name ?? "Preset") {
                    edit { $0.theme.apply(preset: preset) }
                }
                .disabled(deck.theme.colors == preset.colors && deck.theme.fonts == preset.fonts)
            }
        }
        if !slide.elements.isEmpty {
            Section("Elements") {
                ForEach(slide.elements.reversed()) { item in
                    Button {
                        selectedElementID = item.id
                    } label: {
                        HStack {
                            Text(item.label)
                            Spacer()
                            Text(item.readableText)
                                .lineLimit(1)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        if let webEditorURL {
            Section {
                Link("Open full editor", destination: webEditorURL)
            } footer: {
                Text("Pictures and chart data change in the full editor. Everything else changes here.")
            }
        }
    }

    // MARK: Rows

    private func numberField(_ label: String, value: Binding<Double>) -> some View {
        LabeledContent(label) {
            TextField(label, value: value, format: .number.precision(.fractionLength(0 ... 2)))
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 96)
                #if os(iOS)
                .keyboardType(.decimalPad)
                #endif
        }
    }

    private func strokeWidthStepper(_ width: Double, set: @escaping (Double) -> Void) -> some View {
        Stepper(value: Binding(
            get: { width },
            set: { set(min(24, max(0.25, $0))) }
        ), in: 0.25 ... 24, step: 0.25) {
            LabeledContent("Stroke width", value: width.formatted(.number.precision(.fractionLength(0 ... 2))))
        }
    }

    /// Theme swatches plus a hex field. `nil` means the theme default.
    private func colorRow(_ label: String, value: Binding<String?>, defaultLabel: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
            HStack(spacing: 8) {
                Button(defaultLabel) { value.wrappedValue = nil }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                ForEach(Self.swatches(deck.theme), id: \.name) { swatch in
                    Button {
                        value.wrappedValue = swatch.hex
                    } label: {
                        Circle()
                            .fill(DeckPalette.color(swatch.hex, fallback: "#FFFFFF", theme: deck.theme))
                            .overlay {
                                Circle().strokeBorder(
                                    DeckColor.normalized(value.wrappedValue) == DeckColor.normalized(swatch.hex) ? Color.accentColor : Color.primary.opacity(0.15),
                                    lineWidth: 2
                                )
                            }
                            .frame(width: 24, height: 24)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(label) \(swatch.name)")
                }
            }
            TextField("Hex", text: Binding(
                get: { value.wrappedValue ?? "" },
                set: { text in
                    if text.isEmpty {
                        value.wrappedValue = nil
                    } else if let hex = DeckColor.normalized(text) {
                        value.wrappedValue = hex
                    }
                }
            ))
            .font(.callout.monospaced())
            .textInputAutocapitalization(.characters)
        }
    }

    private static func swatches(_ theme: AlbatrossDeckTheme) -> [(name: String, hex: String)] {
        [
            ("ink", theme.colors.ink),
            ("muted", theme.colors.muted),
            ("accent", theme.colors.accent),
            ("accent ink", theme.colors.accentInk),
            ("surface", theme.colors.surface),
            ("background", theme.colors.background),
        ]
    }

    private static func nearestWeight(_ weight: Int) -> Int {
        [300, 400, 500, 600, 700].min { abs($0 - weight) < abs($1 - weight) } ?? 400
    }

    // MARK: Bindings

    private func binding(_ element: AlbatrossDeckElementV2, _ keyPath: WritableKeyPath<AlbatrossDeckElementV2, Double>) -> Binding<Double> {
        Binding {
            element[keyPath: keyPath]
        } set: { value in
            update(element) { item in
                item[keyPath: keyPath] = value
                item.bounds = DeckGeometry.clamp(item.bounds, minimumSize: item.isLine ? 0 : DeckGeometry.minimumSize)
            }
        }
    }

    private func opacityBinding(_ element: AlbatrossDeckElementV2) -> Binding<Double> {
        Binding {
            element.opacity ?? 1
        } set: { value in
            editLive { deck in
                deck.updateElement(element.id) { $0.opacity = value >= 1 ? nil : value }
            }
        }
    }

    private func update(_ element: AlbatrossDeckElementV2, _ change: @escaping (inout AlbatrossDeckElementV2) -> Void) {
        edit { deck in deck.updateElement(element.id, change) }
    }

    private func updateText(_ element: AlbatrossDeckElementV2, _ change: @escaping (inout AlbatrossDeckElementContent.Text) -> Void) {
        update(element) { item in
            guard case .text(var content) = item.content else { return }
            change(&content)
            item.content = .text(content)
        }
    }

    private func updateShape(_ element: AlbatrossDeckElementV2, _ change: @escaping (inout AlbatrossDeckElementContent.Shape) -> Void) {
        update(element) { item in
            guard case .shape(var content) = item.content else { return }
            change(&content)
            item.content = .shape(content)
        }
    }

    private func updateLine(_ element: AlbatrossDeckElementV2, _ change: @escaping (inout AlbatrossDeckElementContent.Line) -> Void) {
        update(element) { item in
            guard case .line(var content) = item.content else { return }
            change(&content)
            item.content = .line(content)
        }
    }

    private func updateImage(_ element: AlbatrossDeckElementV2, _ change: @escaping (inout AlbatrossDeckElementContent.Image) -> Void) {
        update(element) { item in
            guard case .image(var content) = item.content else { return }
            change(&content)
            item.content = .image(content)
        }
    }

    private func updateChart(_ element: AlbatrossDeckElementV2, _ change: @escaping (inout AlbatrossDeckElementContent.Chart) -> Void) {
        update(element) { item in
            guard case .chart(var content) = item.content else { return }
            change(&content)
            item.content = .chart(content)
        }
    }
}

// MARK: - Presentation

/// Full-screen playback. Swipe, tap the right or left third, or use the arrow keys.
struct DeckPresentationView: View {
    @Environment(\.dismiss) private var dismiss
    let deck: AlbatrossDeckV2
    let assetBaseURL: URL?
    @State private var index: Int = 0
    @FocusState private var focused: Bool

    init(deck: AlbatrossDeckV2, assetBaseURL: URL?) {
        self.deck = deck
        self.assetBaseURL = assetBaseURL
        _index = State(initialValue: deck.activeIndex)
    }

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                Color.black.ignoresSafeArea()
                DeckSlideView(slide: deck.slides[index], theme: deck.theme, assetBaseURL: assetBaseURL)
                    .frame(maxWidth: proxy.size.width, maxHeight: proxy.size.height)
                    .id(deck.slides[index].id)
                    .transition(.opacity)
            }
            .contentShape(Rectangle())
            .onTapGesture { location in
                if location.x < proxy.size.width / 3 { previous() } else { next() }
            }
            .gesture(
                DragGesture(minimumDistance: 30).onEnded { value in
                    if value.translation.width < -30 { next() } else if value.translation.width > 30 { previous() }
                }
            )
        }
        .overlay(alignment: .topTrailing) {
            Button("Done") { dismiss() }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .padding()
                .keyboardShortcut(.cancelAction)
        }
        .overlay(alignment: .bottom) {
            Text("\(index + 1) of \(deck.slides.count)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(.white.opacity(0.7))
                .padding(.bottom, 12)
        }
        .focusable()
        .focused($focused)
        .onAppear { focused = true }
        .onKeyPress(.rightArrow) { next(); return .handled }
        .onKeyPress(.leftArrow) { previous(); return .handled }
        .onKeyPress(.space) { next(); return .handled }
        .onKeyPress(.escape) { dismiss(); return .handled }
        .accessibilityIdentifier("files.deck.presentation")
    }

    private func next() {
        guard index < deck.slides.count - 1 else { return }
        withAnimation(.easeInOut(duration: 0.2)) { index += 1 }
    }

    private func previous() {
        guard index > 0 else { return }
        withAnimation(.easeInOut(duration: 0.2)) { index -= 1 }
    }
}
