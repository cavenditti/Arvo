import WidgetKit
import SwiftUI

// MARK: - Data contract
//
// The host app writes a JSON snapshot to the shared app group; the widget only
// reads it. Contract (see docs/IOS-WIDGET.md):
//
//   UserDefaults(suiteName: "group.farm.arvo.app"), key "widget.snapshot"
//   {
//     "updatedAt": "2026-08-01T12:30:00.000Z",
//     "fields": [
//       { "name": "Vigneto Nord", "score": 48, "level": "attention" }
//     ]
//   }
//
// `score` is the Arvo score (0–100, from arvoScoreDetail); `level` is the
// canonical StatusLevel from app/src/features/insights/status.ts —
// "ok" | "watch" | "attention". Decoding is defensive: unknown levels fall
// back to "watch", missing pieces degrade to the empty state, never crash.

/// Canonical field status, mirroring `StatusLevel` in
/// `app/src/features/insights/status.ts`. Colors are the Terra palette
/// (docs/DESIGN.md §2); labels mirror the `status.chip_*` copy.
enum StatusLevel: String {
    case ok
    case watch
    case attention

    var color: Color {
        switch self {
        case .ok: return Terra.leaf
        case .watch: return Terra.straw
        case .attention: return Terra.clay
        }
    }

    /// Spoken/accessibility label — plain Italian, mirrors status.chip_* copy.
    var voiceLabel: String {
        switch self {
        case .ok: return "tutto bene"
        case .watch: return "da tenere d'occhio"
        case .attention: return "da controllare"
        }
    }
}

struct FieldSnapshot: Decodable {
    let name: String
    let score: Double?
    let level: StatusLevel

    private enum CodingKeys: String, CodingKey {
        case name, score, level
    }

    init(name: String, score: Double?, level: StatusLevel) {
        self.name = name
        self.score = score
        self.level = level
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = (try? container.decodeIfPresent(String.self, forKey: .name)) ?? "Campo"
        score = try? container.decodeIfPresent(Double.self, forKey: .score)
        let rawLevel = (try? container.decodeIfPresent(String.self, forKey: .level)) ?? nil
        level = StatusLevel(rawValue: rawLevel ?? "") ?? .watch
    }
}

struct WidgetSnapshot: Decodable {
    let updatedAt: String?
    let fields: [FieldSnapshot]

    private enum CodingKeys: String, CodingKey {
        case updatedAt, fields
    }

    init(updatedAt: String?, fields: [FieldSnapshot]) {
        self.updatedAt = updatedAt
        self.fields = fields
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        updatedAt = try? container.decodeIfPresent(String.self, forKey: .updatedAt)
        fields = (try? container.decodeIfPresent([FieldSnapshot].self, forKey: .fields)) ?? []
    }

    /// Sample data for the widget gallery and Xcode previews (mirrors the
    /// demo seed: Vigneto Nord carries the NDVI dip → attention).
    static let preview = WidgetSnapshot(
        updatedAt: ISO8601DateFormatter().string(from: Date()),
        fields: [
            FieldSnapshot(name: "Vigneto Nord", score: 48, level: .attention),
            FieldSnapshot(name: "Uliveto Vecchio", score: 71, level: .watch),
            FieldSnapshot(name: "Orto 3", score: 86, level: .ok),
        ]
    )
}

enum SnapshotStore {
    static let appGroup = "group.farm.arvo.app"
    static let key = "widget.snapshot"

    /// Reads the snapshot from the shared app group. Tolerates the value being
    /// stored either as a String (the JS bridge writes a string) or as Data.
    /// Any failure — missing suite, missing key, malformed JSON — returns nil
    /// and the widget shows its empty state.
    static func load() -> WidgetSnapshot? {
        guard let defaults = UserDefaults(suiteName: appGroup) else { return nil }
        let data: Data?
        if let raw = defaults.string(forKey: key) {
            data = raw.data(using: .utf8)
        } else {
            data = defaults.data(forKey: key)
        }
        guard let data else { return nil }
        return try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    }
}

// MARK: - Terra palette (docs/DESIGN.md §2)

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255.0,
            green: Double((hex >> 8) & 0xFF) / 255.0,
            blue: Double(hex & 0xFF) / 255.0,
            opacity: 1.0
        )
    }
}

enum Terra {
    static let paper = Color(hex: 0xF2F1EC)        // bg — app paper
    static let inkOnPaper = Color(hex: 0x1B1E1A)   // text
    static let mutedOnPaper = Color(hex: 0x5C625C) // textMuted
    static let paperDark = Color(hex: 0x1B1E1A)    // dark-mode paper (ink inverted)
    static let inkOnDark = Color(hex: 0xF2F1EC)
    static let mutedOnDark = Color(hex: 0x8A8F86)  // textFaint
    static let leaf = Color(hex: 0x3F7D45)         // success — ok
    static let straw = Color(hex: 0x9A6A1E)        // warning — watch
    static let clay = Color(hex: 0xA5432B)         // accent — attention

    static func background(_ scheme: ColorScheme) -> Color { scheme == .dark ? paperDark : paper }
    static func ink(_ scheme: ColorScheme) -> Color { scheme == .dark ? inkOnDark : inkOnPaper }
    static func muted(_ scheme: ColorScheme) -> Color { scheme == .dark ? mutedOnDark : mutedOnPaper }
}

// MARK: - Timeline

struct ArvoEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> ArvoEntry {
        ArvoEntry(date: Date(), snapshot: .preview)
    }

    func getSnapshot(in context: Context, completion: @escaping (ArvoEntry) -> Void) {
        // Widget gallery: always show something meaningful.
        let snapshot = context.isPreview ? (SnapshotStore.load() ?? .preview) : SnapshotStore.load()
        completion(ArvoEntry(date: Date(), snapshot: snapshot))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ArvoEntry>) -> Void) {
        let entry = ArvoEntry(date: Date(), snapshot: SnapshotStore.load())
        // The app pushes fresh data (WidgetCenter.reloadAllTimelines) whenever
        // it writes a snapshot; this is just a lazy fallback re-read.
        let next = Calendar.current.date(byAdding: .minute, value: 30, to: entry.date)
            ?? entry.date.addingTimeInterval(1800)
        completion(Timeline(entries: [entry], policy: .after(next)))
    }
}

// MARK: - Views

struct ArvoWidgetEntryView: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.widgetFamily) private var family

    var entry: ArvoEntry

    /// Task contract: up to 3 fields. The small family fits 2 comfortably at
    /// legible-in-sunlight sizes; medium shows the full 3.
    private var maxFields: Int { family == .systemSmall ? 2 : 3 }

    var body: some View {
        Group {
            if let snapshot = entry.snapshot, !snapshot.fields.isEmpty {
                fieldsView(snapshot)
            } else {
                emptyView
            }
        }
        .widgetURL(URL(string: "arvo://"))
        .containerBackground(for: .widget) {
            Terra.background(colorScheme)
        }
    }

    private func fieldsView(_ snapshot: WidgetSnapshot) -> some View {
        VStack(alignment: .leading, spacing: family == .systemSmall ? 6 : 8) {
            Text("I tuoi campi")
                .font(.system(size: family == .systemSmall ? 13 : 15, weight: .semibold, design: .serif))
                .foregroundStyle(Terra.ink(colorScheme))
                .accessibilityAddTraits(.isHeader)

            ForEach(Array(snapshot.fields.prefix(maxFields).enumerated()), id: \.offset) { item in
                fieldRow(item.element)
            }

            Spacer(minLength: 0)

            if let iso = snapshot.updatedAt, let time = Self.timeString(fromISO: iso) {
                Text("Aggiornato alle \(time)")
                    .font(.system(size: 10, design: .monospaced))
                    .foregroundStyle(Terra.muted(colorScheme))
                    .lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private func fieldRow(_ field: FieldSnapshot) -> some View {
        HStack(spacing: 8) {
            // Labeled score disc — the number IS the content, so this is not
            // a bare status dot (docs/DESIGN.md §5, No-Dots rule).
            ZStack {
                Circle().fill(field.level.color)
                Text(Self.scoreText(field.score))
                    .font(.system(size: 11, weight: .semibold, design: .monospaced))
                    .foregroundStyle(.white)
                    .minimumScaleFactor(0.7)
                    .lineLimit(1)
            }
            .frame(width: 28, height: 28)
            .accessibilityHidden(true)

            Text(field.name)
                .font(.system(size: family == .systemSmall ? 12 : 13, design: .serif))
                .foregroundStyle(Terra.ink(colorScheme))
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(field.name): \(field.level.voiceLabel), punteggio \(Self.scoreText(field.score))")
    }

    private var emptyView: some View {
        VStack(spacing: 6) {
            Image(systemName: "leaf")
                .font(.system(size: 22))
                .foregroundStyle(Terra.leaf)
                .accessibilityHidden(true)
            Text("Apri Arvo per iniziare")
                .font(.system(size: 13, design: .serif))
                .foregroundStyle(Terra.ink(colorScheme))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: helpers

    static func scoreText(_ score: Double?) -> String {
        guard let score, score.isFinite else { return "–" }
        return String(format: "%.0f", score.rounded())
    }

    static func timeString(fromISO iso: String) -> String? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        guard let date = fractional.date(from: iso) ?? plain.date(from: iso) else { return nil }
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter.string(from: date)
    }
}

// MARK: - Widget & bundle

struct ArvoFieldsWidget: Widget {
    let kind: String = "ArvoFieldsWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            ArvoWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("I tuoi campi")
        .description("Lo stato dei tuoi campi a colpo d'occhio.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct ArvoWidgetBundle: WidgetBundle {
    var body: some Widget {
        ArvoFieldsWidget()
    }
}

// MARK: - Xcode canvas previews

#Preview("Campi", as: .systemMedium) {
    ArvoFieldsWidget()
} timeline: {
    ArvoEntry(date: .now, snapshot: .preview)
    ArvoEntry(date: .now, snapshot: nil)
}

#Preview("Piccolo", as: .systemSmall) {
    ArvoFieldsWidget()
} timeline: {
    ArvoEntry(date: .now, snapshot: .preview)
}
