import SwiftUI
import UIKit

struct DocumentEditorView: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @State private var draft: AlbatrossDocument?
    @State private var persisted: AlbatrossDocument?
    @State private var saveTask: Task<Void, Never>?
    @State private var isSaving = false
    @State private var saveQueued = false
    @State private var isPublishing = false
    @State private var showsAI = false
    @State private var shareURL: URL?
    @State private var errorMessage: String?

    let documentID: String

    var body: some View {
        Group {
            if let draft {
                editor(draft)
            } else {
                ProgressView("Opening file…")
            }
        }
        .navigationBarBackButtonHidden(true)
        .navigationTitle(draft?.kind.title ?? "File")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button {
                    Task {
                        await saveNow()
                        environment.navigation.documentRoute = nil
                    }
                } label: {
                    Label("Files", systemImage: "chevron.left")
                }
            }
            ToolbarItemGroup(placement: .topBarTrailing) {
                if isSaving {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel("Saving")
                }
                Menu {
                    Button {
                        Task { await publish() }
                    } label: {
                        Label(
                            draft?.google == nil ? "Publish to Google" : "Sync to Google",
                            systemImage: "arrow.up.circle"
                        )
                    }
                    if draft?.google != nil {
                        Button {
                            Task { await pullGoogle() }
                        } label: {
                            Label("Import latest Google changes", systemImage: "arrow.down.circle")
                        }
                    }
                } label: {
                    Label("Google", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                }
                .disabled(isPublishing || isSaving)
                Button {
                    showsAI = true
                } label: {
                    Label("Albatross", systemImage: "sparkles")
                }
                Button {
                    Task { await export() }
                } label: {
                    Label("Export", systemImage: "square.and.arrow.up")
                }
            }
        }
        .task(id: documentID) {
            await load()
        }
        .onChange(of: draft) { oldValue, newValue in
            guard oldValue != nil, newValue != nil, newValue != persisted else { return }
            scheduleSave()
        }
        .sheet(isPresented: $showsAI) {
            if let draft {
                DocumentAISheet(document: draft) { updated in
                    self.draft = updated
                    persisted = updated
                }
            }
        }
        .sheet(isPresented: Binding(
            get: { shareURL != nil },
            set: { if !$0 { shareURL = nil } }
        )) {
            if let shareURL {
                ActivityShareSheet(items: [shareURL])
                    .presentationDetents([.medium])
            }
        }
        .alert("File", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "Try again.")
        }
    }

    @ViewBuilder
    private func editor(_ document: AlbatrossDocument) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: document.kind.symbol)
                    .foregroundStyle(kindTint(document.kind))
                TextField("File name", text: titleBinding)
                    .font(.headline)
                    .textInputAutocapitalization(.sentences)
                Spacer(minLength: 0)
                Text(isSaving ? "Saving" : "Revision \(document.revision)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal)
            .frame(minHeight: 48)
            .background(.bar)

            switch document.model {
            case .doc(let blocks):
                NativeDocEditor(blocks: blocks) { next in
                    updateModel(.doc(blocks: next))
                }
            case .sheet(let activeSheetID, let sheets):
                NativeSheetEditor(activeSheetID: activeSheetID, sheets: sheets) { active, next in
                    updateModel(.sheet(activeSheetID: active, sheets: next))
                }
            case .deck(let activeSlideID, let slides):
                NativeDeckEditor(activeSlideID: activeSlideID, slides: slides) { active, next in
                    updateModel(.deck(activeSlideID: active, slides: next))
                }
            }
        }
    }

    private var titleBinding: Binding<String> {
        Binding {
            draft?.title ?? ""
        } set: { value in
            draft?.title = value
        }
    }

    private func updateModel(_ model: AlbatrossDocumentModel) {
        draft?.model = model
    }

    private func load() async {
        do {
            let document = try await environment.documents.fetchDocument(id: documentID)
            draft = document
            persisted = document
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: .milliseconds(900))
            guard !Task.isCancelled else { return }
            saveTask = nil
            await saveNow()
        }
    }

    private func saveNow() async {
        saveTask?.cancel()
        guard let draft, draft != persisted else { return }
        if isSaving {
            saveQueued = true
            return
        }
        let savingDraft = draft
        isSaving = true
        defer {
            isSaving = false
            if saveQueued {
                saveQueued = false
                scheduleSave()
            }
        }
        do {
            let saved = try await environment.documents.save(savingDraft)
            persisted = saved
            if self.draft == savingDraft {
                self.draft = saved
            } else if var latest = self.draft {
                latest.revision = saved.revision
                latest.google = saved.google
                latest.suggestions = saved.suggestions
                latest.updatedAt = saved.updatedAt
                self.draft = latest
                saveQueued = true
            }
        } catch {
            errorMessage = error.localizedDescription
            if let fresh = try? await environment.documents.fetchDocument(id: documentID) {
                persisted = fresh
                if self.draft == savingDraft {
                    self.draft = fresh
                } else if var latest = self.draft {
                    latest.revision = fresh.revision
                    latest.google = fresh.google
                    latest.suggestions = fresh.suggestions
                    latest.updatedAt = fresh.updatedAt
                    self.draft = latest
                    saveQueued = true
                }
            }
        }
    }

    private func publish() async {
        await saveNow()
        isPublishing = true
        defer { isPublishing = false }
        do {
            _ = try await environment.documents.publishToGoogle(documentID: documentID)
            let refreshed = try await environment.documents.fetchDocument(id: documentID)
            draft = refreshed
            persisted = refreshed
        } catch {
            if environment.documents.connections.contains(where: { $0.provider == "google_drive" }) {
                errorMessage = error.localizedDescription
            } else {
                do {
                    try await environment.webAuthentication.connectCloudFiles(provider: "google_drive")
                    await environment.documents.loadFiles()
                    _ = try await environment.documents.publishToGoogle(documentID: documentID)
                    let refreshed = try await environment.documents.fetchDocument(id: documentID)
                    draft = refreshed
                    persisted = refreshed
                } catch {
                    errorMessage = error.localizedDescription
                }
            }
        }
    }

    private func export() async {
        await saveNow()
        guard let draft else { return }
        do {
            shareURL = try await environment.documents.export(document: draft)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func pullGoogle() async {
        await saveNow()
        guard let draft else { return }
        isPublishing = true
        defer { isPublishing = false }
        do {
            let refreshed = try await environment.documents.refreshFromGoogle(draft)
            self.draft = refreshed
            persisted = refreshed
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func kindTint(_ kind: AlbatrossDocumentKind) -> Color {
        switch kind {
        case .doc: .blue
        case .sheet: .green
        case .deck: .orange
        }
    }
}

private struct NativeDocEditor: View {
    let blocks: [AlbatrossDocBlock]
    let onChange: ([AlbatrossDocBlock]) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(Array(blocks.enumerated()), id: \.element.id) { index, block in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack {
                            Menu {
                                ForEach(["paragraph", "heading", "bullet", "numbered", "quote"], id: \.self) { type in
                                    Button(type.capitalized) {
                                        update(index) { $0.type = type }
                                    }
                                }
                                if blocks.count > 1 {
                                    Button("Delete block", role: .destructive) {
                                        var next = blocks
                                        next.remove(at: index)
                                        onChange(next)
                                    }
                                }
                            } label: {
                                Label(block.type.capitalized, systemImage: "textformat")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            Spacer()
                        }
                        TextEditor(text: Binding(
                            get: { block.text },
                            set: { value in update(index) { $0.text = value } }
                        ))
                        .font(blockFont(block))
                        .frame(minHeight: block.type == "heading" ? 54 : 82)
                        .scrollContentBackground(.hidden)
                        .padding(.horizontal, block.type == "quote" ? 10 : 0)
                        .overlay(alignment: .leading) {
                            if block.type == "quote" {
                                Rectangle().fill(.secondary).frame(width: 2)
                            }
                        }
                    }
                }
                Button("Add block", systemImage: "plus") {
                    onChange(blocks + [AlbatrossDocBlock()])
                }
                .buttonStyle(.bordered)
            }
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, 28)
            .frame(maxWidth: 760)
            .background(Color(uiColor: .systemBackground))
            .shadow(color: .black.opacity(0.06), radius: 8, y: 2)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 12)
        }
        .background(Color(uiColor: .secondarySystemBackground))
    }

    private var horizontalPadding: CGFloat {
        UIDevice.current.userInterfaceIdiom == .pad ? 56 : 20
    }

    private func update(_ index: Int, mutation: (inout AlbatrossDocBlock) -> Void) {
        guard blocks.indices.contains(index) else { return }
        var next = blocks
        mutation(&next[index])
        onChange(next)
    }

    private func blockFont(_ block: AlbatrossDocBlock) -> Font {
        if block.type == "heading" {
            switch block.level ?? 2 {
            case 1: return .largeTitle.bold()
            case 3: return .title3.bold()
            default: return .title.bold()
            }
        }
        return block.type == "quote" ? .body.italic() : .body
    }
}

private struct NativeSheetEditor: View {
    let activeSheetID: String
    let sheets: [AlbatrossSheetTab]
    let onChange: (String, [AlbatrossSheetTab]) -> Void
    @State private var selectedAddress = "A1"

    private var activeIndex: Int {
        sheets.firstIndex(where: { $0.id == activeSheetID }) ?? 0
    }

    private var active: AlbatrossSheetTab {
        sheets[activeIndex]
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Text(selectedAddress)
                    .font(.caption.monospaced().weight(.semibold))
                    .frame(width: 44)
                TextField("Value or =formula", text: cellBinding(selectedAddress))
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
            }
            .padding(10)
            .background(.bar)

            ScrollView([.horizontal, .vertical]) {
                LazyVStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 0) {
                        gridCell("", header: true, width: 42)
                        ForEach(1...min(active.columnCount, 20), id: \.self) { column in
                            gridCell(Self.columnName(column), header: true)
                        }
                    }
                    ForEach(1...min(active.rowCount, 60), id: \.self) { row in
                        HStack(spacing: 0) {
                            gridCell(String(row), header: true, width: 42)
                            ForEach(1...min(active.columnCount, 20), id: \.self) { column in
                                let address = "\(Self.columnName(column))\(row)"
                                TextField("", text: cellBinding(address))
                                    .font(.caption.monospaced())
                                    .padding(.horizontal, 6)
                                    .frame(width: 110, height: 34)
                                    .background(selectedAddress == address ? Color.accentColor.opacity(0.12) : .clear)
                                    .overlay { Rectangle().stroke(.quaternary, lineWidth: 0.5) }
                                    .onTapGesture { selectedAddress = address }
                                    .accessibilityLabel("Cell \(address)")
                            }
                        }
                    }
                }
            }

            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(sheets) { sheet in
                        Button(sheet.name) {
                            onChange(sheet.id, sheets)
                        }
                        .buttonStyle(.bordered)
                        .tint(sheet.id == activeSheetID ? Color.accentColor : Color.secondary)
                        .controlSize(.small)
                    }
                    Button {
                        let sheet = AlbatrossSheetTab(name: "Sheet \(sheets.count + 1)")
                        onChange(sheet.id, sheets + [sheet])
                    } label: {
                        Image(systemName: "plus")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
                .padding(8)
            }
            .background(.bar)
            .scrollIndicators(.hidden)
        }
    }

    private func gridCell(_ value: String, header: Bool, width: CGFloat = 110) -> some View {
        Text(value)
            .font(.caption2.monospaced().weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(width: width, height: 30)
            .background(Color(uiColor: .secondarySystemBackground))
            .overlay { Rectangle().stroke(.quaternary, lineWidth: 0.5) }
    }

    private func cellBinding(_ address: String) -> Binding<String> {
        Binding {
            active.cells[address]?.display ?? ""
        } set: { raw in
            var next = sheets
            var cells = next[activeIndex].cells
            if raw.isEmpty {
                cells.removeValue(forKey: address)
            } else if raw.hasPrefix("=") {
                cells[address] = AlbatrossSheetCell(formula: String(raw.dropFirst()))
            } else if let number = Double(raw) {
                cells[address] = AlbatrossSheetCell(value: .number(number))
            } else {
                cells[address] = AlbatrossSheetCell(value: .text(raw))
            }
            next[activeIndex].cells = cells
            onChange(activeSheetID, next)
        }
    }

    private static func columnName(_ index: Int) -> String {
        var value = index
        var result = ""
        while value > 0 {
            value -= 1
            result = String(UnicodeScalar(65 + value % 26)!) + result
            value /= 26
        }
        return result
    }
}

private struct NativeDeckEditor: View {
    let activeSlideID: String
    let slides: [AlbatrossDeckSlide]
    let onChange: (String, [AlbatrossDeckSlide]) -> Void

    private var activeIndex: Int {
        slides.firstIndex(where: { $0.id == activeSlideID }) ?? 0
    }

    private var active: AlbatrossDeckSlide { slides[activeIndex] }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal) {
                HStack(spacing: 10) {
                    ForEach(Array(slides.enumerated()), id: \.element.id) { index, slide in
                        Button {
                            onChange(slide.id, slides)
                        } label: {
                            VStack(spacing: 4) {
                                SlideThumbnail(slide: slide)
                                    .frame(width: 112, height: 63)
                                    .overlay {
                                        RoundedRectangle(cornerRadius: 5)
                                            .stroke(
                                                slide.id == activeSlideID ? Color.accentColor : .quaternary,
                                                lineWidth: slide.id == activeSlideID ? 2 : 1
                                            )
                                    }
                                Text("\(index + 1)")
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .buttonStyle(.plain)
                    }
                    Button {
                        let next = AlbatrossDeckSlide(
                            title: "Slide \(slides.count + 1)",
                            elements: [
                                AlbatrossDeckElement(text: "New slide", role: "title", fontSize: 30),
                            ]
                        )
                        onChange(next.id, slides + [next])
                    } label: {
                        Label("Add slide", systemImage: "plus")
                            .frame(width: 100, height: 60)
                    }
                    .buttonStyle(.bordered)
                }
                .padding(10)
            }
            .background(.bar)
            .scrollIndicators(.hidden)

            ScrollView {
                VStack(spacing: 16) {
                    GeometryReader { proxy in
                        ZStack {
                            Color.white
                            ForEach(Array(active.elements.enumerated()), id: \.element.id) { elementIndex, element in
                                TextField(
                                    element.role == "title" ? "Slide title" : "Text",
                                    text: elementBinding(elementIndex)
                                )
                                .font(.system(size: scaledFont(element, width: proxy.size.width), weight: element.role == "title" ? .bold : .regular))
                                .foregroundStyle(.black)
                                .padding(4)
                                .frame(
                                    width: proxy.size.width * element.width / 100,
                                    height: proxy.size.height * element.height / 100
                                )
                                .position(
                                    x: proxy.size.width * (element.x + element.width / 2) / 100,
                                    y: proxy.size.height * (element.y + element.height / 2) / 100
                                )
                            }
                        }
                        .clipShape(.rect(cornerRadius: 8))
                        .shadow(color: .black.opacity(0.12), radius: 10, y: 3)
                    }
                    .aspectRatio(16 / 9, contentMode: .fit)
                    .frame(maxWidth: 900)

                    HStack {
                        Button("Add text", systemImage: "text.badge.plus") {
                            var next = slides
                            next[activeIndex].elements.append(AlbatrossDeckElement(text: "Text"))
                            onChange(activeSlideID, next)
                        }
                        .buttonStyle(.bordered)
                        Spacer()
                        if slides.count > 1 {
                            Button("Delete slide", systemImage: "trash", role: .destructive) {
                                var next = slides
                                next.remove(at: activeIndex)
                                onChange(next[min(activeIndex, next.count - 1)].id, next)
                            }
                            .buttonStyle(.bordered)
                        }
                    }
                    .frame(maxWidth: 900)

                    VStack(alignment: .leading, spacing: 6) {
                        Text("Speaker notes")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        TextEditor(text: notesBinding)
                            .frame(minHeight: 100)
                            .padding(8)
                            .background(Color(uiColor: .systemBackground), in: .rect(cornerRadius: 10))
                    }
                    .frame(maxWidth: 900)
                }
                .padding()
            }
            .background(Color(uiColor: .secondarySystemBackground))
        }
    }

    private func elementBinding(_ index: Int) -> Binding<String> {
        Binding {
            active.elements[index].text
        } set: { value in
            var next = slides
            next[activeIndex].elements[index].text = value
            if next[activeIndex].elements[index].role == "title" {
                next[activeIndex].title = value
            }
            onChange(activeSlideID, next)
        }
    }

    private var notesBinding: Binding<String> {
        Binding {
            active.notes
        } set: { value in
            var next = slides
            next[activeIndex].notes = value
            onChange(activeSlideID, next)
        }
    }

    private func scaledFont(_ element: AlbatrossDeckElement, width: CGFloat) -> CGFloat {
        max(10, CGFloat(element.fontSize ?? 18) * width / 720)
    }
}

private struct SlideThumbnail: View {
    let slide: AlbatrossDeckSlide

    var body: some View {
        ZStack {
            Color.white
            VStack(alignment: .leading, spacing: 2) {
                ForEach(slide.elements.filter { !$0.text.isEmpty }.prefix(3)) { element in
                    Text(element.text)
                        .font(element.role == "title" ? .caption2.bold() : .system(size: 5))
                        .foregroundStyle(.black)
                        .lineLimit(1)
                }
                Spacer()
            }
            .padding(7)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .clipShape(.rect(cornerRadius: 5))
    }
}

private struct DocumentAISheet: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.dismiss) private var dismiss
    @State private var current: AlbatrossDocument
    @State private var instruction = ""
    @State private var isWorking = false
    @State private var errorMessage: String?
    let onChanged: (AlbatrossDocument) -> Void

    init(document: AlbatrossDocument, onChanged: @escaping (AlbatrossDocument) -> Void) {
        _current = State(initialValue: document)
        self.onChanged = onChanged
    }

    var body: some View {
        NavigationStack {
            List {
                Section("Ask Albatross") {
                    TextEditor(text: $instruction)
                        .frame(minHeight: 110)
                    Button("Suggest changes", systemImage: "sparkles") {
                        Task { await suggest() }
                    }
                    .disabled(instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || isWorking)
                }

                Section("Suggestions") {
                    if current.suggestions.isEmpty {
                        ContentUnavailableView(
                            "No suggestions",
                            systemImage: "checkmark.circle",
                            description: Text("Ask for a rewrite, analysis, new formulas, or a stronger deck.")
                        )
                    } else {
                        ForEach(current.suggestions) { suggestion in
                            VStack(alignment: .leading, spacing: 10) {
                                Text(suggestion.title)
                                    .font(.headline)
                                Text(suggestion.description)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                HStack {
                                    Button("Apply") {
                                        Task { await resolve(suggestion, apply: true) }
                                    }
                                    .buttonStyle(.borderedProminent)
                                    Button("Dismiss") {
                                        Task { await resolve(suggestion, apply: false) }
                                    }
                                    .buttonStyle(.bordered)
                                }
                            }
                            .padding(.vertical, 6)
                        }
                    }
                }
            }
            .navigationTitle("Albatross")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .overlay {
                if isWorking {
                    ProgressView("Working…")
                        .padding(18)
                        .background(.regularMaterial, in: .rect(cornerRadius: 16))
                }
            }
            .alert("Albatross", isPresented: Binding(
                get: { errorMessage != nil },
                set: { if !$0 { errorMessage = nil } }
            )) {
                Button("OK") { errorMessage = nil }
            } message: {
                Text(errorMessage ?? "Try again.")
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func suggest() async {
        isWorking = true
        defer { isWorking = false }
        do {
            _ = try await environment.documents.suggest(
                documentID: current.id,
                instruction: instruction
            )
            current = try await environment.documents.fetchDocument(id: current.id)
            instruction = ""
            onChanged(current)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    private func resolve(_ suggestion: AlbatrossDocumentSuggestion, apply: Bool) async {
        isWorking = true
        defer { isWorking = false }
        do {
            current = try await environment.documents.resolveSuggestion(
                documentID: current.id,
                suggestionID: suggestion.id,
                apply: apply
            )
            onChanged(current)
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

private struct ActivityShareSheet: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
