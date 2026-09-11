import Foundation
import MobileAPI

/// Adapt display payload names to the existing native Brief views.
enum AssistantDisplayNode {
    static func decode(toolName: String, payload: JSONValue) -> BriefNode? {
        guard case .object(var fields) = payload else { return nil }
        switch toolName {
        case "show_weather":
            fields["kind"] = .string("weather")
            fields["location"] = payload["location"]?["name"] ?? payload["locationName"]
            fields["daily"] = payload["forecast"]
            fields["unit"] = payload["units"]?["temperature"]
        case "show_map": fields["kind"] = .string("geo_map")
        case "show_code_diff": fields["kind"] = .string("code_diff")
        case "show_terminal": fields["kind"] = .string("terminal")
        default: return nil
        }
        guard let data = try? JSONEncoder().encode(JSONValue.object(fields)) else { return nil }
        return try? JSONDecoder().decode(BriefNode.self, from: data)
    }
}
