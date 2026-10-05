import XCTest
@testable import T3Code

final class ServerSettingsParityTests: XCTestCase {
    func testWorkspaceInheritanceSurvivesMissingNullAndExplicitValues() throws {
        let inheritedValues: [[String: JSONValue]] = [[:], ["defaultThreadEnvMode": .null]]
        for fields in inheritedValues {
            let inherited = try JSONValue.object(fields).decode(ServerSettingsSnapshot.self)
            XCTAssertNil(inherited.defaultThreadEnvMode)
            XCTAssertNil(try JSONValue.encode(inherited).decode(ServerSettingsSnapshot.self).defaultThreadEnvMode)
            XCTAssertEqual(inherited.sharedPatch["defaultThreadEnvMode"], .null)
        }
        let clear = ServerSettingsChange.defaultThreadEnvMode(nil).jsonValue
        XCTAssertEqual(clear, .object(["defaultThreadEnvMode": .null]))
        for mode in [ServerThreadEnvironmentMode.local, .worktree] {
            let explicit = try ServerSettingsChange.defaultThreadEnvMode(mode).jsonValue.decode(ServerSettingsSnapshot.self)
            XCTAssertEqual(explicit.defaultThreadEnvMode, mode)
        }
    }

    func testProjectResetRestoresInheritanceInsteadOfWritingANullOverride() throws {
        var settings = try JSONValue.object([
            "projectSettingsFolded": .bool(true),
            "projectSettingsOverrides": .object([
                "project": .object([
                    "defaultThreadEnvMode": .string("local"),
                    "branchNameInstructions": .string("Keep issue IDs"),
                ]),
            ]),
        ]).decode(ServerSettingsSnapshot.self)
        XCTAssertEqual(settings.resolvingProject(id: "project").defaultThreadEnvMode, .local)
        let patch = ServerProjectSettingChange(key: .defaultThreadEnvMode, value: nil)
            .patch(projectID: "project", settings: settings).jsonValue
        let entry = try XCTUnwrap(patch["projectSettingsOverrides"]?["project"])
            .decode([String: JSONValue].self)
        XCTAssertNil(entry["defaultThreadEnvMode"])
        XCTAssertEqual(entry["branchNameInstructions"], .string("Keep issue IDs"))
        settings.projectSettingsOverrides["project"] = entry
        XCTAssertNil(settings.resolvingProject(id: "project", legacyWorkspaceMode: .worktree).defaultThreadEnvMode)
    }

    func testRuntimeDefaultsAndModelCapabilitiesDecodeAcrossServerVersions() throws {
        let legacy = try JSONValue.object([:]).decode(ServerSettingsSnapshot.self)
        XCTAssertEqual(legacy.defaultRuntimeMode, .fullAccess)
        XCTAssertFalse(legacy.supportsDefaultRuntimeMode)
        XCTAssertNil(try JSONValue.object([:]).decode(ServerModelCapabilities.self).supportedRuntimeModes)
        for mode in RuntimeMode.allCases {
            var settings = try ServerSettingsChange.defaultRuntimeMode(mode).jsonValue.decode(ServerSettingsSnapshot.self)
            XCTAssertTrue(settings.supportsDefaultRuntimeMode)
            XCTAssertEqual(settings.defaultRuntimeMode, mode)
            XCTAssertEqual(settings.resolvingProject(id: "other").defaultRuntimeMode, mode)
            settings.projectSettingsOverrides = ["project": ["defaultRuntimeMode": .string("approval-required")]]
            XCTAssertEqual(settings.resolvingProject(id: "project").defaultRuntimeMode, .approvalRequired)
        }
        let capabilities = try JSONValue.object([
            "supportedRuntimeModes": .array([.string("auto-accept-edits"), .string("full-access")]),
        ]).decode(ServerModelCapabilities.self)
        XCTAssertEqual(capabilities.supportedRuntimeModes, [.autoAcceptEdits, .fullAccess])
    }

    func testBranchAndBrowserOverridesPreserveEmptyStringsAndFalse() throws {
        var settings = try JSONValue.object([
            "branchNamingMode": .string("static"),
            "branchNamePrefix": .string("t3code"),
            "branchNameInstructions": .string("Environment instructions"),
            "enableAgentBrowserAccess": .bool(true),
            "defaultAutoPull": .bool(false),
            "projectSettingsOverrides": .object([
                "project": .object([
                    "branchNamingMode": .string("custom"),
                    "branchNamePrefix": .string(""),
                    "branchNameInstructions": .string(""),
                    "enableAgentBrowserAccess": .bool(false),
                    "defaultAutoPull": .bool(true),
                    "futureSetting": .object(["keep": .bool(true)]),
                ]),
            ]),
        ]).decode(ServerSettingsSnapshot.self)
        let effective = settings.resolvingProject(id: "project")
        XCTAssertEqual(effective.branchNamingMode, .custom)
        XCTAssertEqual(effective.branchNamePrefix, "")
        XCTAssertEqual(effective.branchNameInstructions, "")
        XCTAssertEqual(effective.enableAgentBrowserAccess, false)
        XCTAssertTrue(effective.defaultAutoPull)
        XCTAssertEqual(settings.resolvingProject(id: "other").branchNamePrefix, "t3code")
        let patch = ServerProjectSettingChange(key: .branchNamingMode, value: nil)
            .patch(projectID: "project", settings: settings).jsonValue
        settings.projectSettingsOverrides["project"] = try XCTUnwrap(patch["projectSettingsOverrides"]?["project"])
            .decode([String: JSONValue].self)
        XCTAssertEqual(settings.resolvingProject(id: "project").branchNamingMode, .static)
        XCTAssertEqual(settings.projectSettingsOverrides["project"]?["futureSetting"], .object(["keep": .bool(true)]))
    }

    func testProjectScriptSettingsKeepLegacyNullAndExplicitEmptyOverrides() throws {
        let script: JSONValue = .object([
            "id": .string("dev"), "name": .string("Dev"), "command": .string("vp run dev"),
            "icon": .string("play"), "runOnWorktreeCreate": .bool(false),
        ])
        let settings = try JSONValue.object([
            "defaultProjectScripts": .array([script]),
            "projectScriptOverrides": .object(["inherit": .null, "empty": .array([])]),
        ]).decode(ServerSettingsSnapshot.self)
        XCTAssertEqual(settings.defaultProjectScripts.map(\.command), ["vp run dev"])
        XCTAssertEqual(settings.projectScriptOverrides["inherit"], .null)
        XCTAssertEqual(settings.projectScriptOverrides["empty"], .array([]))
        let legacy = try JSONValue.object([:]).decode(ServerSettingsSnapshot.self)
        XCTAssertTrue(legacy.defaultProjectScripts.isEmpty)
        XCTAssertTrue(legacy.projectScriptOverrides.isEmpty)
    }
}
