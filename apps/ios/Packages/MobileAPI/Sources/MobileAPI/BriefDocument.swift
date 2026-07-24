import Foundation

public struct BriefDocumentV2: Codable, Hashable, Sendable {
    public let version: Int
    public let title: String
    public let summary: String
    public let generatedAt: Double
    public let regions: [BriefRegion]

    public init(
        version: Int,
        title: String,
        summary: String,
        generatedAt: Double,
        regions: [BriefRegion]
    ) {
        self.version = version
        self.title = title
        self.summary = summary
        self.generatedAt = generatedAt
        self.regions = regions
    }

    public static func decode(_ data: Data) -> BriefDocumentV2? {
        struct Envelope: Decodable {
            let version: Int
            let title: String
            let summary: String
            let generatedAt: Double
        }
        guard let envelope = try? JSONDecoder().decode(Envelope.self, from: data) else { return nil }
        if envelope.version != 2 {
            let title = envelope.title.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
                ?? "Daily Brief"
            let summary = envelope.summary.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
                ?? "This brief was created by a newer version of Albatross."
            return BriefDocumentV2(
                version: 2,
                title: title,
                summary: summary,
                generatedAt: envelope.generatedAt,
                regions: [
                    BriefRegion(
                        id: "document-fallback",
                        intent: nil,
                        summary: summary,
                        tree: .fallback(title: title, summary: summary)
                    ),
                ]
            )
        }
        guard let decoded = try? JSONDecoder().decode(Self.self, from: data) else { return nil }
        return decoded.normalized()
    }

    public func normalized() -> BriefDocumentV2 {
        let fallbackTitle = title.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank ?? "Daily Brief"
        let fallbackSummary = summary.trimmingCharacters(in: .whitespacesAndNewlines).nilIfBlank
            ?? "This brief was created by a newer version of Albatross."
        guard version == 2 else {
            return BriefDocumentV2(
                version: 2,
                title: fallbackTitle,
                summary: fallbackSummary,
                generatedAt: generatedAt,
                regions: [
                    BriefRegion(
                        id: "document-fallback",
                        intent: nil,
                        summary: fallbackSummary,
                        tree: .fallback(title: fallbackTitle, summary: fallbackSummary)
                    ),
                ]
            )
        }
        var normalizedRegions: [BriefRegion] = []
        for region in regions.prefix(12) {
            let regionSummary = region.summary.nilIfBlank ?? fallbackSummary
            var nodeCount = 0
            normalizedRegions.append(
                BriefRegion(
                    id: region.id.nilIfBlank ?? UUID().uuidString,
                    intent: region.intent,
                    summary: regionSummary,
                    tree: region.tree.normalized(summary: regionSummary, depth: 1, nodeCount: &nodeCount)
                )
            )
        }
        return BriefDocumentV2(
            version: 2,
            title: fallbackTitle,
            summary: fallbackSummary,
            generatedAt: generatedAt,
            regions: normalizedRegions.isEmpty
                ? [
                    BriefRegion(
                        id: "brief-fallback",
                        intent: nil,
                        summary: fallbackSummary,
                        tree: .fallback(title: fallbackTitle, summary: fallbackSummary)
                    ),
                ]
                : normalizedRegions
        )
    }
}

public struct BriefRegion: Codable, Hashable, Sendable {
    public let id: String
    public let intent: String?
    public let summary: String
    public let tree: BriefNode

    public init(id: String, intent: String?, summary: String, tree: BriefNode) {
        self.id = id
        self.intent = intent
        self.summary = summary
        self.tree = tree
    }
}

public struct BriefNode: Codable, Hashable, Sendable {
    public let kind: String
    public let id: String?
    public let emphasis: String?
    public let tone: String?
    public let density: String?
    public let columns: Int?
    public let ratio: String?
    public let surface: String?
    public let title: String?
    public let kicker: String?
    public let collapsible: Bool?
    public let children: [BriefNode]?

    public let role: String?
    public let text: String?
    public let actions: [BriefDocumentAction]?
    public let variant: String?
    public let placeholder: String?
    public let questionId: String?
    public let canvasId: String?
    public let html: String?
    public let fallbackText: String?
    public let allowedActions: [String]?
    public let height: String?

    public let items: [BriefEntityItem]?
    public let query: BriefQuery?
    public let limit: Int?
    public let emptyText: String?
    public let label: String?
    public let value: BriefJSONValue?
    public let queryValue: BriefQuery?
    public let delta: String?
    public let unit: String?
    public let description: String?
    public let data: [BriefChartPoint]?
    public let sourceRefs: [BriefSourceRef]?
    public let timelineItems: [BriefTimelineItem]?
    public let checklistItems: [BriefChecklistItem]?
    public let collectionItems: [BriefCollectionItem]?

    enum CodingKeys: String, CodingKey {
        case kind, id, emphasis, tone, density, columns, ratio, surface, title, kicker, collapsible, children
        case role, text, actions, variant, placeholder, questionId, canvasId, html, fallbackText
        case allowedActions, height, items, query, limit, emptyText, label, value, queryValue, delta
        case unit, description, data, sourceRefs
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        kind = try values.decodeIfPresent(String.self, forKey: .kind) ?? "text"
        id = try values.decodeIfPresent(String.self, forKey: .id)
        emphasis = try values.decodeIfPresent(String.self, forKey: .emphasis)
        tone = try values.decodeIfPresent(String.self, forKey: .tone)
        density = try values.decodeIfPresent(String.self, forKey: .density)
        columns = try values.decodeIfPresent(Int.self, forKey: .columns)
        ratio = try values.decodeIfPresent(String.self, forKey: .ratio)
        surface = try values.decodeIfPresent(String.self, forKey: .surface)
        title = try values.decodeIfPresent(String.self, forKey: .title)
        kicker = try values.decodeIfPresent(String.self, forKey: .kicker)
        collapsible = try values.decodeIfPresent(Bool.self, forKey: .collapsible)
        children = try values.decodeIfPresent([BriefNode].self, forKey: .children)
        role = try values.decodeIfPresent(String.self, forKey: .role)
        text = try values.decodeIfPresent(String.self, forKey: .text)
        actions = try values.decodeIfPresent([BriefDocumentAction].self, forKey: .actions)
        variant = try values.decodeIfPresent(String.self, forKey: .variant)
        placeholder = try values.decodeIfPresent(String.self, forKey: .placeholder)
        questionId = try values.decodeIfPresent(String.self, forKey: .questionId)
        canvasId = try values.decodeIfPresent(String.self, forKey: .canvasId)
        html = try values.decodeIfPresent(String.self, forKey: .html)
        fallbackText = try values.decodeIfPresent(String.self, forKey: .fallbackText)
        allowedActions = try values.decodeIfPresent([String].self, forKey: .allowedActions)
        height = try values.decodeIfPresent(String.self, forKey: .height)
        query = try values.decodeIfPresent(BriefQuery.self, forKey: .query)
        limit = try values.decodeIfPresent(Int.self, forKey: .limit)
        emptyText = try values.decodeIfPresent(String.self, forKey: .emptyText)
        label = try values.decodeIfPresent(String.self, forKey: .label)
        value = try values.decodeIfPresent(BriefJSONValue.self, forKey: .value)
        queryValue = try values.decodeIfPresent(BriefQuery.self, forKey: .queryValue)
        delta = try values.decodeIfPresent(String.self, forKey: .delta)
        unit = try values.decodeIfPresent(String.self, forKey: .unit)
        description = try values.decodeIfPresent(String.self, forKey: .description)
        data = try values.decodeIfPresent([BriefChartPoint].self, forKey: .data)
        sourceRefs = try values.decodeIfPresent([BriefSourceRef].self, forKey: .sourceRefs)

        switch kind {
        case "timeline":
            timelineItems = try values.decodeIfPresent([BriefTimelineItem].self, forKey: .items)
            checklistItems = nil
            collectionItems = nil
            items = nil
        case "checklist":
            checklistItems = try values.decodeIfPresent([BriefChecklistItem].self, forKey: .items)
            timelineItems = nil
            collectionItems = nil
            items = nil
        case "collection":
            collectionItems = try values.decodeIfPresent([BriefCollectionItem].self, forKey: .items)
            timelineItems = nil
            checklistItems = nil
            items = nil
        case "entity_list":
            items = try values.decodeIfPresent([BriefEntityItem].self, forKey: .items)
            timelineItems = nil
            checklistItems = nil
            collectionItems = nil
        default:
            items = nil
            timelineItems = nil
            checklistItems = nil
            collectionItems = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(kind, forKey: .kind)
        try values.encodeIfPresent(id, forKey: .id)
        try values.encodeIfPresent(emphasis, forKey: .emphasis)
        try values.encodeIfPresent(tone, forKey: .tone)
        try values.encodeIfPresent(density, forKey: .density)
        try values.encodeIfPresent(columns, forKey: .columns)
        try values.encodeIfPresent(ratio, forKey: .ratio)
        try values.encodeIfPresent(surface, forKey: .surface)
        try values.encodeIfPresent(title, forKey: .title)
        try values.encodeIfPresent(kicker, forKey: .kicker)
        try values.encodeIfPresent(collapsible, forKey: .collapsible)
        try values.encodeIfPresent(children, forKey: .children)
        try values.encodeIfPresent(role, forKey: .role)
        try values.encodeIfPresent(text, forKey: .text)
        try values.encodeIfPresent(actions, forKey: .actions)
        try values.encodeIfPresent(variant, forKey: .variant)
        try values.encodeIfPresent(placeholder, forKey: .placeholder)
        try values.encodeIfPresent(questionId, forKey: .questionId)
        try values.encodeIfPresent(canvasId, forKey: .canvasId)
        try values.encodeIfPresent(html, forKey: .html)
        try values.encodeIfPresent(fallbackText, forKey: .fallbackText)
        try values.encodeIfPresent(allowedActions, forKey: .allowedActions)
        try values.encodeIfPresent(height, forKey: .height)
        try values.encodeIfPresent(query, forKey: .query)
        try values.encodeIfPresent(limit, forKey: .limit)
        try values.encodeIfPresent(emptyText, forKey: .emptyText)
        try values.encodeIfPresent(label, forKey: .label)
        try values.encodeIfPresent(value, forKey: .value)
        try values.encodeIfPresent(queryValue, forKey: .queryValue)
        try values.encodeIfPresent(delta, forKey: .delta)
        try values.encodeIfPresent(unit, forKey: .unit)
        try values.encodeIfPresent(description, forKey: .description)
        try values.encodeIfPresent(data, forKey: .data)
        try values.encodeIfPresent(sourceRefs, forKey: .sourceRefs)
        if let timelineItems { try values.encode(timelineItems, forKey: .items) }
        if let checklistItems { try values.encode(checklistItems, forKey: .items) }
        if let collectionItems { try values.encode(collectionItems, forKey: .items) }
        if let items { try values.encode(items, forKey: .items) }
    }

    public static func fallback(title: String, summary: String) -> BriefNode {
        BriefNode(
            kind: "group",
            surface: "elevated",
            title: title,
            children: [BriefNode(kind: "text", role: "body", text: summary)]
        )
    }

    public init(
        kind: String,
        id: String? = nil,
        emphasis: String? = nil,
        tone: String? = nil,
        density: String? = nil,
        columns: Int? = nil,
        ratio: String? = nil,
        surface: String? = nil,
        title: String? = nil,
        kicker: String? = nil,
        collapsible: Bool? = nil,
        children: [BriefNode]? = nil,
        role: String? = nil,
        text: String? = nil,
        actions: [BriefDocumentAction]? = nil,
        variant: String? = nil,
        placeholder: String? = nil,
        questionId: String? = nil,
        canvasId: String? = nil,
        html: String? = nil,
        fallbackText: String? = nil,
        allowedActions: [String]? = nil,
        height: String? = nil,
        items: [BriefEntityItem]? = nil,
        query: BriefQuery? = nil,
        limit: Int? = nil,
        emptyText: String? = nil,
        label: String? = nil,
        value: BriefJSONValue? = nil,
        queryValue: BriefQuery? = nil,
        delta: String? = nil,
        unit: String? = nil,
        description: String? = nil,
        data: [BriefChartPoint]? = nil,
        sourceRefs: [BriefSourceRef]? = nil,
        timelineItems: [BriefTimelineItem]? = nil,
        checklistItems: [BriefChecklistItem]? = nil,
        collectionItems: [BriefCollectionItem]? = nil
    ) {
        self.kind = kind
        self.id = id
        self.emphasis = emphasis
        self.tone = tone
        self.density = density
        self.columns = columns
        self.ratio = ratio
        self.surface = surface
        self.title = title
        self.kicker = kicker
        self.collapsible = collapsible
        self.children = children
        self.role = role
        self.text = text
        self.actions = actions
        self.variant = variant
        self.placeholder = placeholder
        self.questionId = questionId
        self.canvasId = canvasId
        self.html = html
        self.fallbackText = fallbackText
        self.allowedActions = allowedActions
        self.height = height
        self.items = items
        self.query = query
        self.limit = limit
        self.emptyText = emptyText
        self.label = label
        self.value = value
        self.queryValue = queryValue
        self.delta = delta
        self.unit = unit
        self.description = description
        self.data = data
        self.sourceRefs = sourceRefs
        self.timelineItems = timelineItems
        self.checklistItems = checklistItems
        self.collectionItems = collectionItems
    }

    fileprivate func normalized(summary: String, depth: Int, nodeCount: inout Int) -> BriefNode {
        let layouts = Set(["stack", "grid", "split", "hero", "group"])
        let leaves = Set([
            "entity_list", "query_list", "stat", "chart", "timeline", "checklist", "collection",
            "text", "actions", "prompt", "divider", "canvas",
        ])
        guard depth <= 4, nodeCount < 48 else {
            return .fallback(title: title ?? "Brief", summary: summary)
        }
        nodeCount += 1
        if depth == 4, layouts.contains(kind) {
            return .fallback(title: title ?? "Brief", summary: summary)
        }
        if !layouts.contains(kind), !leaves.contains(kind) {
            if let children, !children.isEmpty {
                var normalizedChildren: [BriefNode] = []
                for child in children.prefix(24) where nodeCount < 48 {
                    normalizedChildren.append(
                        child.normalized(summary: summary, depth: depth + 1, nodeCount: &nodeCount)
                    )
                }
                return BriefNode(
                    kind: "stack",
                    emphasis: "standard",
                    tone: "neutral",
                    density: "standard",
                    children: normalizedChildren.isEmpty
                        ? [.fallback(title: title ?? "Brief", summary: summary)]
                        : normalizedChildren
                )
            }
            return .fallback(title: title ?? "Brief", summary: fallbackText ?? summary)
        }
        guard let children else { return self }
        var normalizedChildren: [BriefNode] = []
        for child in children.prefix(24) where nodeCount < 48 {
            normalizedChildren.append(
                child.normalized(summary: summary, depth: depth + 1, nodeCount: &nodeCount)
            )
        }
        return BriefNode(
            kind: kind,
            id: id,
            emphasis: ["primary", "standard", "muted"].contains(emphasis ?? "") ? emphasis : "standard",
            tone: ["neutral", "positive", "warning", "urgent"].contains(tone ?? "") ? tone : "neutral",
            density: ["airy", "standard", "dense"].contains(density ?? "") ? density : "standard",
            columns: columns == 3 ? 3 : 2,
            ratio: ratio == "lead" ? "lead" : "balanced",
            surface: ["plain", "elevated", "glass"].contains(surface ?? "") ? surface : "plain",
            title: title,
            kicker: kicker,
            collapsible: collapsible ?? false,
            children: normalizedChildren.isEmpty
                ? [.fallback(title: title ?? "Brief", summary: summary)]
                : normalizedChildren,
            role: role,
            text: text,
            actions: actions,
            variant: variant,
            placeholder: placeholder,
            questionId: questionId,
            canvasId: canvasId,
            html: html,
            fallbackText: fallbackText,
            allowedActions: allowedActions,
            height: height,
            items: items,
            query: query,
            limit: limit,
            emptyText: emptyText,
            label: label,
            value: value,
            queryValue: queryValue,
            delta: delta,
            unit: unit,
            description: description,
            data: data,
            sourceRefs: sourceRefs,
            timelineItems: timelineItems,
            checklistItems: checklistItems,
            collectionItems: collectionItems
        )
    }
}

public struct BriefSourceRef: Codable, Hashable, Sendable {
    public let kind: String
    public let id: String
    public let account: String?
    public let label: String?

    public init(kind: String, id: String, account: String? = nil, label: String? = nil) {
        self.kind = kind
        self.id = id
        self.account = account
        self.label = label
    }

    public var key: String { "\(kind):\(account ?? ""):\(id)" }
}

public struct BriefDocumentAction: Codable, Hashable, Sendable {
    public let action: String
    public let label: String
    public let payload: [String: BriefJSONValue]
    public let style: String?

    public init(
        action: String,
        label: String,
        payload: [String: BriefJSONValue],
        style: String? = nil
    ) {
        self.action = action
        self.label = label
        self.payload = payload
        self.style = style
    }
}

public struct BriefFraming: Codable, Hashable, Sendable {
    public let reason: String?
    public let lane: String?
    public let prep: String?

    public init(reason: String? = nil, lane: String? = nil, prep: String? = nil) {
        self.reason = reason
        self.lane = lane
        self.prep = prep
    }
}

public struct BriefHandoffEvidence: Codable, Hashable, Sendable {
    public let label: String
    public let ref: BriefSourceRef?

    public init(label: String, ref: BriefSourceRef? = nil) {
        self.label = label
        self.ref = ref
    }
}

public struct BriefHandoffRecommendation: Codable, Hashable, Sendable {
    public let label: String
    public let ref: BriefSourceRef?

    public init(label: String, ref: BriefSourceRef? = nil) {
        self.label = label
        self.ref = ref
    }
}

public struct BriefEntityHandoff: Codable, Hashable, Sendable {
    public let handoffId: String?
    public let itemCount: Int?
    public let situation: String
    public let background: [String]
    public let assessment: String
    public let recommendation: String
    public let recommendations: [BriefHandoffRecommendation]?
    public let evidence: [BriefHandoffEvidence]

    public init(
        handoffId: String? = nil,
        itemCount: Int? = nil,
        situation: String,
        background: [String] = [],
        assessment: String,
        recommendation: String,
        recommendations: [BriefHandoffRecommendation] = [],
        evidence: [BriefHandoffEvidence] = []
    ) {
        self.handoffId = handoffId
        self.itemCount = itemCount
        self.situation = situation
        self.background = Array(background.prefix(3))
        self.assessment = assessment
        self.recommendation = recommendation
        self.recommendations = Array(recommendations.prefix(4))
        self.evidence = Array(evidence.prefix(4))
    }
}

public struct BriefEntityItem: Codable, Hashable, Sendable {
    public let ref: BriefSourceRef
    public let framing: BriefFraming?
    public let handoff: BriefEntityHandoff?
    public let actions: [BriefDocumentAction]?

    public init(
        ref: BriefSourceRef,
        framing: BriefFraming? = nil,
        handoff: BriefEntityHandoff? = nil,
        actions: [BriefDocumentAction]? = nil
    ) {
        self.ref = ref
        self.framing = framing
        self.handoff = handoff
        self.actions = actions
    }
}

public struct BriefQuery: Codable, Hashable, Sendable {
    public let name: String
    public let areaId: String?

    public init(name: String, areaId: String? = nil) {
        self.name = name
        self.areaId = areaId
    }
}

public struct BriefChartPoint: Codable, Hashable, Sendable {
    public let label: String
    public let value: Double
    public let group: String?
}

public struct BriefTimelineItem: Codable, Hashable, Sendable {
    public let label: String
    public let at: Double?
    public let detail: String?
    public let ref: BriefSourceRef?
    public let actions: [BriefDocumentAction]?
}

public struct BriefChecklistItem: Codable, Hashable, Sendable {
    public let label: String
    public let detail: String?
    public let checked: Bool?
    public let ref: BriefSourceRef?
    public let action: BriefDocumentAction?
}

public struct BriefCollectionItem: Codable, Hashable, Sendable {
    public let image: URL?
    public let title: String
    public let meta: String?
    public let badge: String?
    public let ref: BriefSourceRef?
    public let actions: [BriefDocumentAction]?
}

public enum BriefJSONValue: Codable, Hashable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: BriefJSONValue])
    case array([BriefJSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let bool = try? value.decode(Bool.self) { self = .bool(bool) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let object = try? value.decode([String: BriefJSONValue].self) { self = .object(object) }
        else if let array = try? value.decode([BriefJSONValue].self) { self = .array(array) }
        else { self = .null }
    }

    public func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .string(let string): try value.encode(string)
        case .number(let number): try value.encode(number)
        case .bool(let bool): try value.encode(bool)
        case .object(let object): try value.encode(object)
        case .array(let array): try value.encode(array)
        case .null: try value.encodeNil()
        }
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var doubleValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }
}

public struct BriefHydratedEntity: Codable, Hashable, Sendable {
    public let kind: String
    public let id: String
    public let account: String?
    public let title: String
    public let subtitle: String?
    public let status: String?
    public let updatedAt: Double?
    public let startAt: Double?
    public let endAt: Double?
    public let dueAt: Double?
    public let completed: Bool?
    public let unread: Bool?
    public let gone: Bool

    public var key: String { "\(kind):\(account ?? ""):\(id)" }
}

private extension String {
    var nilIfBlank: String? { isEmpty ? nil : self }
}
