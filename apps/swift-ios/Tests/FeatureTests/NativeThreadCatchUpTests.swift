import Foundation
import XCTest
@testable import T3Code

@MainActor
@available(iOS 18.0, *)
final class NativeThreadCatchUpTests: XCTestCase {
    func testWarmNavigationResumesAfterAppliedMessagesWithoutAnotherHTTPRead() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        XCTAssertEqual(first.payload["afterSequence"], .number(2))
        try await first.sendMessage(text: "Finished on the computer", sequence: 3)
        try await first.synchronize()
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertTrue(messages.contains("Finished on the computer"))

        fixture.client.releaseThread(id: fixture.firstID)
        _ = try await fixture.client.loadThread(id: fixture.secondID)
        _ = try await nextThreadRequest(&requests)
        fixture.client.releaseThread(id: fixture.secondID)
        let restored = try await fixture.client.loadThread(id: fixture.firstID)
        XCTAssertTrue(restored.messages.contains { $0.text == "Finished on the computer" })
        let resumed = try await nextThreadRequest(&requests)
        XCTAssertEqual(resumed.payload["afterSequence"], .number(3))
        XCTAssertEqual(resumed.payload["turnLimit"], .number(10))
        XCTAssertEqual(resumed.payload["requestCompletionMarker"], .bool(true))
        let reads = await fixture.http.threadRequests
        XCTAssertEqual(reads.count, 2, "Only the two cold opens should fetch HTTP snapshots.")
        await fixture.client.disconnect()
    }

    func testForegroundReplacesSuspendedConnectionAndUsesLatestCursor() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        try await first.sendMessage(text: "Before background", sequence: 7)
        try await first.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)

        await fixture.client.resumeAfterBackground(reconnect: true)
        let resumed = try await nextThreadRequest(&requests)
        XCTAssertFalse(resumed.socket === first.socket)
        XCTAssertEqual(resumed.payload["afterSequence"], .number(7))
        try await resumed.sendMessage(text: "Completed while away", sequence: 8)
        try await resumed.synchronize()
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertTrue(messages.contains("Completed while away"))
        let reads = await fixture.http.threadRequests
        XCTAssertEqual(reads.count, 1)
        await fixture.client.disconnect()
    }

    func testSocketLossResubscribesFromAppliedCursor() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        try await first.sendMessage(text: "Last applied message", sequence: 12)
        try await first.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await first.socket.close()
        let resumed = try await nextThreadRequest(&requests)
        XCTAssertEqual(resumed.payload["afterSequence"], .number(12))
        XCTAssertFalse(resumed.socket === first.socket)
        await fixture.client.disconnect()
    }

    func testStalledResumeFetchesBoundedHTTPFallbackWithoutWaitingForHeartbeat() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let first = try await nextThreadRequest(&requests)
        try await first.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        fixture.client.releaseThread(id: fixture.firstID)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let resumed = try await nextThreadRequest(&requests)
        await fixture.http.setResponse(text: "HTTP caught up", sequence: 20)
        await fixture.delay.release()
        var sawUpdatedMessage = false
        while let event = await events.next(isolation: #isolation) {
            if case let .detail(detail) = event {
                sawUpdatedMessage = detail.messages.contains { $0.text == "HTTP caught up" }
            }
            if case .threadSync(fixture.firstID, .reconnecting) = event { break }
        }
        XCTAssertTrue(sawUpdatedMessage)
        let reads = await fixture.http.threadRequests
        XCTAssertEqual(reads.count, 2)
        XCTAssertEqual(reads.last?.timeoutInterval, 8)
        try await resumed.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.client.disconnect()
    }

    func testLegacyServerStillRevalidatesWarmThreadOverHTTP() async throws {
        let fixture = try await CatchUpFixture.make(completionMarker: false)
        defer { fixture.cleanUp() }
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        fixture.client.releaseThread(id: fixture.firstID)
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let reads = await fixture.http.threadRequests
        XCTAssertEqual(reads.count, 2)
        await fixture.client.disconnect()
    }

    func testCompletionMarkerWaitsForRequiredSnapshotReplacement() async throws {
        let fixture = try await CatchUpFixture.make()
        defer { fixture.cleanUp() }
        var requests = fixture.requests.makeAsyncIterator()
        var events = fixture.client.events().makeAsyncIterator()
        _ = try await fixture.client.loadThread(id: fixture.firstID)
        let request = try await nextThreadRequest(&requests)
        try await request.synchronize()
        _ = await messagesBeforeLive(&events, threadID: fixture.firstID)
        await fixture.http.setResponse(text: "Authoritative replacement", sequence: 20)
        try await request.socket.chunk(id: request.id, values: [
            .object(["kind": .string("event"), "event": .object([
                "type": .string("thread.reverted"), "sequence": .number(19),
                "occurredAt": .string("2026-09-02T12:00:00Z"),
                "payload": .object(["threadId": .string("first")]),
            ])]),
            .object(["kind": .string("synchronized")]),
        ])
        let messages = await messagesBeforeLive(&events, threadID: fixture.firstID)
        XCTAssertTrue(messages.contains("Authoritative replacement"))
        await fixture.client.disconnect()
    }

    private func nextThreadRequest(
        _ iterator: inout AsyncStream<CatchUpRequest>.Iterator
    ) async throws -> CatchUpRequest {
        while let request = await iterator.next(isolation: #isolation) {
            if request.tag == RPCMethod.subscribeThread.rawValue { return request }
        }
        throw CancellationError()
    }

    private func messagesBeforeLive(
        _ iterator: inout AsyncStream<FeatureEvent>.Iterator, threadID: String
    ) async -> [String] {
        var messages: [String] = []
        while let event = await iterator.next(isolation: #isolation) {
            switch event {
            case let .detail(detail), let .detailDelta(detail, _):
                if detail.thread.id == threadID { messages = detail.messages.map(\.text) }
            case .threadSync(threadID, .live): return messages
            default: break
            }
        }
        XCTFail("The thread did not finish synchronization.")
        return messages
    }
}

@MainActor
private struct CatchUpFixture {
    let client: NativeFeatureClient
    let http: CatchUpHTTPTransport
    let requests: AsyncStream<CatchUpRequest>
    let delay: CatchUpDelay
    let directory: URL
    var firstID: String { FeatureScopedID.thread(environmentID: "one", wireID: "first") }
    var secondID: String { FeatureScopedID.thread(environmentID: "one", wireID: "second") }

    static func make(completionMarker: Bool = true) async throws -> Self {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let store = EnvironmentStore(fileURL: directory.appendingPathComponent("environments.json"))
        try await store.save([Environment(
            id: "one", label: "Computer", httpBaseURL: URL(string: "https://one.example")!,
            webSocketBaseURL: URL(string: "wss://one.example/ws")!
        )])
        try await store.setActiveEnvironment(id: "one")
        let http = CatchUpHTTPTransport()
        let requests = AsyncStream<CatchUpRequest>.makeStream()
        let delay = CatchUpDelay()
        let runtime = EnvironmentRuntime(
            environmentStore: store,
            credentialStore: InMemoryCredentialStore(credentials: ["one": .init(accessToken: "test")]),
            httpTransport: http,
            webSocketConnector: CatchUpConnector(
                requests: requests.continuation, completionMarker: completionMarker
            )
        )
        let client = NativeFeatureClient(
            runtime: runtime, settingsStore: UserDefaults(suiteName: UUID().uuidString)!,
            fallbackPollingInitialDelay: .seconds(3_600),
            aggregateRefreshInterval: .seconds(3_600),
            catchUpDelay: { try await delay.wait() }
        )
        _ = try await client.initialSnapshot()
        return Self(client: client, http: http, requests: requests.stream, delay: delay, directory: directory)
    }

    func cleanUp() { try? FileManager.default.removeItem(at: directory) }
}

private actor CatchUpHTTPTransport: HTTPTransport {
    private(set) var threadRequests: [URLRequest] = []
    private var message: String?
    private var sequence = 2

    func setResponse(text: String, sequence: Int) {
        message = text
        self.sequence = sequence
    }

    func data(for request: URLRequest) throws -> (Data, HTTPURLResponse) {
        let value: JSONValue
        switch request.url!.path {
        case "/api/auth/websocket-ticket":
            value = .object(["ticket": .string("test"), "expiresAt": .string("2027-01-01T00:00:00Z")])
        case "/api/orchestration/shell":
            let first = multiEnvironmentShell(projectID: "project", threadID: "first", title: "First")
            let second = multiEnvironmentShell(projectID: "project", threadID: "second", title: "Second")
            value = try .encode(OrchestrationShellSnapshot(
                snapshotSequence: 1, projects: first.projects,
                threads: first.threads + second.threads, updatedAt: first.updatedAt
            ))
        default:
            guard request.url!.path.hasPrefix("/api/orchestration/threads/") else {
                throw URLError(.unsupportedURL)
            }
            threadRequests.append(request)
            let messages = message.map { text in
                [OrchestrationMessage(
                    id: "answer", role: "assistant", text: text, attachments: [],
                    turnId: nil, streaming: false, createdAt: "2026-09-02T12:00:00Z",
                    updatedAt: "2026-09-02T12:00:00Z"
                )]
            } ?? []
            value = try .encode(multiEnvironmentDetail(
                projectID: "project", threadID: request.url!.lastPathComponent,
                snapshotSequence: sequence, messages: messages
            ))
        }
        return (try JSONEncoder.t3.encode(value), HTTPURLResponse(
            url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: nil
        )!)
    }
}

private struct CatchUpConnector: WebSocketConnecting {
    let requests: AsyncStream<CatchUpRequest>.Continuation
    let completionMarker: Bool
    func connect(to url: URL) async throws -> any WebSocketConnection {
        CatchUpSocket(requests: requests, completionMarker: completionMarker)
    }
}

private struct CatchUpRequest: Sendable {
    let tag: String
    let id: Int
    let payload: JSONValue
    let socket: CatchUpSocket

    func synchronize() async throws {
        try await socket.chunk(id: id, values: [.object(["kind": .string("synchronized")])])
    }

    func sendMessage(text: String, sequence: Int) async throws {
        try await socket.chunk(id: id, values: [.object([
            "kind": .string("event"), "event": .object([
                "type": .string("thread.message-sent"), "sequence": .number(Double(sequence)),
                "occurredAt": .string("2026-09-02T12:00:00Z"), "payload": .object([
                    "threadId": payload["threadId"]!, "messageId": .string("message-\(sequence)"),
                    "role": .string("assistant"), "text": .string(text), "streaming": .bool(false),
                    "createdAt": .string("2026-09-02T12:00:00Z"),
                    "updatedAt": .string("2026-09-02T12:00:00Z"),
                ]),
            ]),
        ])])
    }
}

private actor CatchUpSocket: WebSocketConnection {
    let requests: AsyncStream<CatchUpRequest>.Continuation
    let completionMarker: Bool
    private var pending: [Data] = []
    private var receiver: CheckedContinuation<Data, any Error>?
    private var closed = false

    init(requests: AsyncStream<CatchUpRequest>.Continuation, completionMarker: Bool) {
        self.requests = requests
        self.completionMarker = completionMarker
    }

    func send(_ data: Data) throws {
        guard !closed else { throw URLError(.networkConnectionLost) }
        let request = try JSONDecoder.t3.decode(JSONValue.self, from: data)
        if request["_tag"]?.stringValue == "Ping" {
            try enqueue(.object(["_tag": .string("Pong")]))
        }
        guard let tag = request["tag"]?.stringValue, case let .number(id) = request["id"] else { return }
        if tag == RPCMethod.subscribeServerConfig.rawValue {
            try chunk(id: Int(id), values: [.object([
                "type": .string("snapshot"), "config": .object([
                    "providers": .array([]), "threadSnapshotPagination": .bool(true),
                    "threadResumeCompletionMarker": .bool(completionMarker),
                ]),
            ])])
        }
        requests.yield(.init(tag: tag, id: Int(id), payload: request["payload"]!, socket: self))
    }

    func receive() async throws -> Data {
        guard !closed else { throw URLError(.networkConnectionLost) }
        if !pending.isEmpty { return pending.removeFirst() }
        return try await withCheckedThrowingContinuation { receiver = $0 }
    }

    func close() {
        closed = true
        receiver?.resume(throwing: URLError(.networkConnectionLost))
        receiver = nil
    }

    func chunk(id: Int, values: [JSONValue]) throws {
        try enqueue(.object([
            "_tag": .string("Chunk"), "requestId": .number(Double(id)), "values": .array(values),
        ]))
    }

    private func enqueue(_ value: JSONValue) throws {
        let data = try JSONEncoder.t3.encode(value)
        if let receiver {
            self.receiver = nil
            receiver.resume(returning: data)
        } else { pending.append(data) }
    }
}

private actor CatchUpDelay {
    private var opened = false
    private var waiters: [UUID: CheckedContinuation<Void, any Error>] = [:]
    func wait() async throws {
        if opened { return }
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
                if Task.isCancelled { continuation.resume(throwing: CancellationError()) }
                else { waiters[id] = continuation }
            }
        } onCancel: { Task { await self.cancel(id) } }
    }
    func release() {
        opened = true
        let waiting = waiters.values
        waiters.removeAll()
        waiting.forEach { $0.resume() }
    }
    private func cancel(_ id: UUID) {
        waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}
