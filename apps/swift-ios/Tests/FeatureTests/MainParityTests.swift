import Foundation
import Testing
@testable import T3Code

struct MainParityTests {
    @Test func externalSchemesAreNotWorkspaceFiles() throws {
        for raw in ["mailto:user@example.com", "ftp://example.com/file.txt", "custom://host/file.txt"] {
            #expect(MarkdownWorkspaceFileLink.relativePath(for: try #require(URL(string: raw)), workspaceRoot: "/repo") == nil)
        }
        #expect(MarkdownWorkspaceFileLink.relativePath(for: try #require(URL(string: "C:/repo/file.txt")), workspaceRoot: "C:/repo") == "file.txt")
    }

    @Test func machineIconsHaveASafeFallback() throws {
        var environment = FeatureEnvironment(id: "a", name: "A", endpoint: "https://example.test")
        environment.machineIcon = "mac-mini"
        #expect(environment.systemImage == "macmini")
        let data = try JSONEncoder().encode(environment)
        #expect(try JSONDecoder().decode(FeatureEnvironment.self, from: data).machineIcon == "mac-mini")
        environment.machineIcon = "future-machine"
        #expect(environment.systemImage == "server.rack")
    }

    @Test func projectIconsRetainServerMetadata() throws {
        let icon = try JSONDecoder().decode(ProjectIconOverride.self, from: Data(#"{"kind":"emoji","emoji":"🐈"}"#.utf8))
        var project = FeatureProject(id: "a", environmentID: "b", name: "Project", path: "/repo")
        project.projectIcon = icon
        #expect(try JSONDecoder().decode(FeatureProject.self, from: JSONEncoder().encode(project)).projectIcon == icon)
        #expect(ProjectIconPresentation.symbol("future-icon") == "folder")
    }
}
