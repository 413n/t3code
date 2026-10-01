import Testing
@testable import T3Code

struct ProviderSetupTests {
    @Test func updateDiscoveryPreservesTheEnvironmentReleaseChannel() {
        let releases = [
            EnvironmentReleaseIndex.Release(tag_name: "v0.0.44-nightly.20260930.10", draft: false),
            EnvironmentReleaseIndex.Release(tag_name: "v0.0.44-preview.20260930.9", draft: false),
            EnvironmentReleaseIndex.Release(tag_name: "v0.0.45", draft: true),
            EnvironmentReleaseIndex.Release(tag_name: "v0.0.44", draft: false),
        ]
        #expect(EnvironmentReleaseIndex.newest(releases, for: "0.0.43") == "0.0.44")
        #expect(EnvironmentReleaseIndex.newest(releases, for: "0.0.43-preview.20260920.1") == "0.0.44-preview.20260930.9")
        #expect(EnvironmentReleaseIndex.newest(releases, for: "0.0.43-nightly.20260920.1") == "0.0.44-nightly.20260930.10")
    }

    @Test func deviceCodeAndManagedCredentialFieldsDecode() throws {
        let state = try JSONValue.object([
            "instanceId": .string("work"), "phase": .string("waiting"), "flowId": .string("flow"),
            "credentialOwner": .string("t3"),
            "methods": .array([.object(["id": .string("device"), "name": .string("Device code"), "type": .string("agent")])]),
            "interaction": .object(["type": .string("deviceCode"), "id": .string("step"),
                "url": .string("https://example.test/activate"), "userCode": .string("ABCD")]),
        ]).decode(ProviderAuthState.self)
        #expect(state.methods?.first?.id == "device")
        #expect(state.interaction?.userCode == "ABCD")
        #expect(state.credentialOwner == "t3")
        let response = ProviderSetupAction.respond(flowID: "flow", interactionID: "step",
            response: .object(["type": .string("browser"), "action": .string("accept")]))
        #expect(response.method == "provider.auth.respond")
        #expect(response.payload(instanceID: "work")["interactionId"] == .string("step"))
        #expect(ProviderSetupAction.signInMethod("device").payload(instanceID: "work")["methodId"] == .string("device"))
    }

    @Test func enabledPatchPreservesOtherInstancesAndConfiguration() {
        let settings: JSONValue = .object([
            "providerInstances": .object([
                "other": .object(["driver": .string("codex")]),
                "google-work": .object([
                    "driver": .string("antigravity"), "displayName": .string("Work"),
                    "config": .object(["enabled": .bool(false), "gcpProject": .string("work")]),
                ]),
            ]),
        ])
        let patch = ProviderSettingsPatch.enabled(settings: settings, instanceID: "google-work", driver: "antigravity", enabled: true)
        #expect(patch["providerInstances"]?["other"] == settings["providerInstances"]?["other"])
        #expect(patch["providerInstances"]?["google-work"]?["displayName"] == .string("Work"))
        #expect(patch["providerInstances"]?["google-work"]?["enabled"] == .bool(true))
        #expect(patch["providerInstances"]?["google-work"]?["config"]?["enabled"] == nil)
        #expect(patch["providerInstances"]?["google-work"]?["config"]?["gcpProject"] == .string("work"))
    }

    @Test func callbackIsSentOnlyWithTheMatchingFlow() {
        let action = ProviderSetupAction.completeSignIn(flowID: "flow", callbackURL: "https://example.test/callback?code=test")
        #expect(action.method == "provider.auth.complete")
        #expect(action.payload(instanceID: "work")["flowId"] == .string("flow"))
        #expect(action.payload(instanceID: "work")["instanceId"] == .string("work"))
        #expect(ProviderSetupAction.signIn.payload(instanceID: "work")["callbackUrl"] == nil)
    }
}
