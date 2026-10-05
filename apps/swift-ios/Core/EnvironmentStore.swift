import Foundation

public enum SavedConnectionEditError: LocalizedError, Equatable {
    case unsupportedConnection
    case emptyLabel
    case identityMismatch
    case changedConnection

    public var errorDescription: String? {
        switch self {
        case .unsupportedConnection: "Only saved direct bearer connections can be edited."
        case .emptyLabel: "Enter a connection name."
        case .identityMismatch: "That address belongs to a different environment. Add it as a new connection."
        case .changedConnection: "This connection changed while saving. Open it again and retry."
        }
    }
}

extension EnvironmentStore {
    /// A label is local metadata. Keep the saved endpoints and descriptor unchanged.
    @discardableResult
    public func renameSavedConnection(expected: Environment, label: String) throws -> Environment {
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { throw SavedConnectionEditError.emptyLabel }
        var current = try savedConnection(matching: expected)
        current.label = label
        try upsert(current)
        return current
    }

    /// Changes only editable fields after the new host identity has been checked.
    /// Keep concurrent enable/protocol changes and never restore a removed record.
    @discardableResult
    public func editSavedConnection(
        expected: Environment, label: String, httpBaseURL: URL,
        webSocketBaseURL: URL, descriptor: EnvironmentDescriptor
    ) throws -> Environment {
        guard expected.kind == .bearer else { throw SavedConnectionEditError.unsupportedConnection }
        guard descriptor.environmentId == expected.id else { throw SavedConnectionEditError.identityMismatch }
        let label = label.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !label.isEmpty else { throw SavedConnectionEditError.emptyLabel }
        var current = try savedConnection(matching: expected)
        current.label = label
        current.httpBaseURL = httpBaseURL
        current.webSocketBaseURL = webSocketBaseURL
        current.descriptor = descriptor
        try upsert(current)
        return current
    }

    private func savedConnection(matching expected: Environment) throws -> Environment {
        guard expected.kind == .bearer else { throw SavedConnectionEditError.unsupportedConnection }
        guard let current = try load().first(where: { $0.id == expected.id }),
              current.kind == expected.kind, current.httpBaseURL == expected.httpBaseURL,
              current.webSocketBaseURL == expected.webSocketBaseURL, current.label == expected.label else {
            throw SavedConnectionEditError.changedConnection
        }
        return current
    }
}

extension Environment {
    func hasSameConnectionEndpoint(httpBaseURL: URL, webSocketBaseURL: URL) -> Bool {
        Self.normalizedConnectionURL(self.httpBaseURL) == Self.normalizedConnectionURL(httpBaseURL)
            && Self.normalizedConnectionURL(self.webSocketBaseURL) == Self.normalizedConnectionURL(webSocketBaseURL)
    }

    private static func normalizedConnectionURL(_ url: URL) -> URL? {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        components.scheme = components.scheme?.lowercased()
        components.host = components.host?.lowercased()
        if components.path.isEmpty { components.path = "/" }
        if ((components.scheme == "https" || components.scheme == "wss") && components.port == 443)
            || ((components.scheme == "http" || components.scheme == "ws") && components.port == 80) {
            components.port = nil
        }
        return components.url
    }
}
