import Charts
import SwiftUI

/// The practice shape: the current value large, a trend line with the target
/// as a dashed rule, twelve week pills, one review sentence written on
/// device, and one button: "Log". No steps to verify.
///
/// Mac branch likely: `MetricLogSheet` as a popover from "Log".
struct PracticeBody: View {
    @Environment(AppEnvironment.self) private var environment
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .largeTitle) private var valueSize: CGFloat = 44
    let workID: String
    let metric: WorkMetric?
    /// Newest first, as the server sends them.
    let entries: [WorkMetricEntry]

    @State private var showsLog = false
    @State private var logs = 0
    private let now = Date.now

    private var unit: String { metric?.unit ?? "" }
    private var ascending: [WorkMetricEntry] { entries.sorted { $0.at < $1.at } }
    private var latest: WorkMetricEntry? { ascending.last }
    private var reviewLine: String { PracticeReview.reviewLine(entries, metric: metric, now: now) }
    private var strip: [Bool] { PracticeReview.weekStrip(entries, now: now) }
    private var loggedWeeks: Int { strip.filter { $0 }.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            header
            chart
                .frame(height: 140)
            weekStrip
            Text(reviewLine)
                .font(.body)
                .fixedSize(horizontal: false, vertical: true)
                .contentTransition(.opacity)
                .animation(WorkMotion.cross, value: reviewLine)
            Button("Log") { showsLog = true }
                .buttonStyle(.borderedProminent)
                .frame(minHeight: 44)
            if !entries.isEmpty { entryList }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 18)
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: $showsLog) {
            MetricLogSheet(metric: metric, lastValue: latest?.value) { value, note in
                let ok = await WorkShapeWriter.logMetric(value, note: note, for: workID, environment: environment)
                if ok { logs += 1 }
                return ok
            }
        }
        .modifier(PracticeHaptics(logs: logs))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let latest {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(PracticeReview.formatValue(latest.value))
                        .font(environment.theme.displayType.displayFont(size: valueSize))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .animation(WorkMotion.cross, value: latest.value)
                    if !unit.isEmpty {
                        Text(unit)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Current value \(PracticeReview.formatValue(latest.value, unit: unit))")
                if let change = PracticeReview.changeLine(entries, unit: unit, now: now) {
                    Text(change)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            } else {
                Text("No logs yet")
                    .font(environment.theme.displayType.displayFont(size: valueSize * 0.6))
                if let metric {
                    Text(metric.name)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var chart: some View {
        Chart {
            ForEach(ascending) { entry in
                LineMark(x: .value("Date", entry.at), y: .value(metric?.name ?? "Value", entry.value))
                    .foregroundStyle(environment.theme.accentColor)
                    .interpolationMethod(.monotone)
                    .lineStyle(StrokeStyle(lineWidth: 2, lineCap: .round))
            }
            if let latest {
                PointMark(x: .value("Date", latest.at), y: .value(metric?.name ?? "Value", latest.value))
                    .foregroundStyle(environment.theme.accentColor)
                    .symbolSize(48)
            }
            if let target = metric?.target {
                RuleMark(y: .value("Target", target))
                    .foregroundStyle(environment.theme.accent2Color)
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .annotation(position: .top, alignment: .trailing) {
                        Text("Target \(PracticeReview.formatValue(target))")
                            .font(.caption2)
                            .foregroundStyle(environment.theme.accent2Color)
                    }
            }
        }
        .chartXAxis {
            AxisMarks(values: .stride(by: .weekOfYear)) { _ in
                AxisValueLabel(format: .dateTime.day().month(.abbreviated))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .chartYAxis {
            AxisMarks(position: .leading, values: .automatic(desiredCount: 3)) { _ in
                AxisValueLabel()
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .accessibilityChartDescriptor(
            PracticeChartDescriptor(entries: ascending, metric: metric)
        )
    }

    private var weekStrip: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 5) {
                ForEach(Array(strip.enumerated()), id: \.offset) { _, logged in
                    Capsule()
                        .fill(logged ? environment.theme.accentColor : environment.theme.hairlineColor)
                        .frame(height: 8)
                }
            }
            if let line = PracticeReview.stripLine(entries, now: now) {
                Text(line)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(loggedWeeks) of \(strip.count) weeks logged")
    }

    private var entryList: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(entries.prefix(30).enumerated()), id: \.element.id) { offset, entry in
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(PracticeReview.formatValue(entry.value, unit: unit))
                        .font(.body.monospacedDigit())
                    Text(entry.at, format: .dateTime.day().month(.abbreviated))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    if let note = entry.note {
                        Text(note)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.vertical, 8)
                .accessibilityElement(children: .combine)
                if offset < min(entries.count, 30) - 1 { Divider() }
            }
        }
    }
}

/// One field for the number, prefilled with the last value, an optional
/// note, and "Save".
struct MetricLogSheet: View {
    @Environment(\.dismiss) private var dismiss
    let metric: WorkMetric?
    let lastValue: Double?
    let onSave: (Double, String?) async -> Bool

    @State private var value: String
    @State private var note = ""
    @State private var isSaving = false
    @State private var failed = false
    @FocusState private var valueFocused: Bool

    init(metric: WorkMetric?, lastValue: Double?, onSave: @escaping (Double, String?) async -> Bool) {
        self.metric = metric
        self.lastValue = lastValue
        self.onSave = onSave
        _value = State(initialValue: lastValue.map { PracticeReview.formatValue($0) } ?? "")
    }

    static func parse(_ text: String) -> Double? {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: ",", with: ".")
        guard let number = Double(clean), number.isFinite else { return nil }
        return number
    }

    private var parsed: Double? { Self.parse(value) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        TextField(metric?.name ?? "Value", text: $value)
                            .font(.title2.monospacedDigit())
                            .focused($valueFocused)
                            #if os(iOS)
                            .keyboardType(.decimalPad)
                            #endif
                            .accessibilityLabel(metric?.name ?? "Value")
                        if let unit = metric?.unit, !unit.isEmpty {
                            Text(unit)
                                .foregroundStyle(.secondary)
                        }
                    }
                    TextField("Note", text: $note)
                        .accessibilityLabel("Note")
                } footer: {
                    if failed {
                        Text("Could not save. Try again.")
                    }
                }
            }
            .navigationTitle("Log")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isSaving ? "Saving…" : "Save") { Task { await save() } }
                        .disabled(isSaving || parsed == nil)
                }
            }
            .onAppear { valueFocused = true }
        }
        .presentationDetents([.height(280), .medium])
    }

    private func save() async {
        guard let parsed else { return }
        isSaving = true
        failed = false
        let ok = await onSave(parsed, note.nilIfBlank)
        isSaving = false
        if ok {
            dismiss()
        } else {
            failed = true
        }
    }
}

/// `.success` on each saved log. Silent on the Mac.
private struct PracticeHaptics: ViewModifier {
    let logs: Int

    func body(content: Content) -> some View {
        #if os(iOS)
        content.sensoryFeedback(.success, trigger: logs)
        #else
        content
        #endif
    }
}

/// The chart as VoiceOver reads it: one series of values by date, and the
/// target when there is one.
struct PracticeChartDescriptor: AXChartDescriptorRepresentable {
    let entries: [WorkMetricEntry]
    let metric: WorkMetric?

    func makeChartDescriptor() -> AXChartDescriptor {
        let unit = metric?.unit ?? ""
        let dates = entries.map(\.at)
        let values = entries.map(\.value)
        let xAxis = AXNumericDataAxisDescriptor(
            title: "Date",
            range: (dates.first?.timeIntervalSince1970 ?? 0)...(dates.last?.timeIntervalSince1970 ?? 1),
            gridlinePositions: []
        ) { seconds in
            Date(timeIntervalSince1970: seconds).formatted(.dateTime.day().month(.abbreviated))
        }
        let low = values.min() ?? 0
        let high = values.max() ?? 1
        let yAxis = AXNumericDataAxisDescriptor(
            title: metric?.name ?? "Value",
            range: low...(high > low ? high : low + 1),
            gridlinePositions: []
        ) { PracticeReview.formatValue($0, unit: unit) }
        let series = AXDataSeriesDescriptor(
            name: metric?.name ?? "Value",
            isContinuous: true,
            dataPoints: entries.map { entry in
                AXDataPoint(x: entry.at.timeIntervalSince1970, y: entry.value)
            }
        )
        var summary = "\(entries.count) logs"
        if let target = metric?.target {
            summary += ", target \(PracticeReview.formatValue(target, unit: unit))"
        }
        return AXChartDescriptor(
            title: metric?.name ?? "Trend",
            summary: summary,
            xAxis: xAxis,
            yAxis: yAxis,
            series: [series]
        )
    }
}
