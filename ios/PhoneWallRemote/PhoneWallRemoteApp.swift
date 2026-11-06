import SwiftUI
import Security

@main
struct PhoneWallRemoteApp: App {
    var body: some Scene {
        WindowGroup { RemoteView() }
    }
}

private enum RemoteError: LocalizedError {
    case invalidURL, missingKey, invalidResponse, server(String)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Enter the Mac mini's .local name or a private HTTPS address."
        case .missingKey: return "Enter the Phone Wall operator key."
        case .invalidResponse: return "The controller returned an unexpected response."
        case .server(let message): return message
        }
    }
}

private enum OperatorKey {
    private static let account = "phone-wall-remote-operator"
    private static let service = "org.museum.phonewall.remote"

    static func load() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecAttrService as String: service,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
              let data = result as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ key: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: account,
            kSecAttrService as String: service
        ]
        let value: [String: Any] = [kSecValueData as String: Data(key.utf8)]
        let status = SecItemUpdate(query as CFDictionary, value as CFDictionary)
        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = Data(key.utf8)
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            guard SecItemAdd(item as CFDictionary, nil) == errSecSuccess else {
                throw RemoteError.server("Could not save the operator key on this iPhone.")
            }
        } else if status != errSecSuccess {
            throw RemoteError.server("Could not update the operator key on this iPhone.")
        }
    }
}

private struct APIError: Decodable { let error: String }
private struct Action: Encodable { let action: String }
private struct RemoteSnapshot: Decodable {
    struct Slot: Decodable { let deviceId: String; let slotIndex: Int }
    struct Layout: Decodable { let rows: Int; let columns: Int; let slots: [Slot] }
    struct State: Decodable { let layout: Layout }
    struct System: Decodable { let controllerCpuPercent: Double? }
    struct Device: Decodable {
        let id: String
        let connected: Bool
        let lastError: String?
        private enum CodingKeys: String, CodingKey { case id = "_id", connected, lastError }
    }
    let state: State
    let system: System
    let devices: [Device]
    func device(at index: Int) -> Device? {
        guard let slot = state.layout.slots.first(where: { $0.slotIndex == index }) else { return nil }
        return devices.first(where: { $0.id == slot.deviceId })
    }
    var unplugged: [(Int, Device)] {
        state.layout.slots.compactMap { slot in
            guard let device = devices.first(where: { $0.id == slot.deviceId }), !device.connected else { return nil }
            return (slot.slotIndex, device)
        }.sorted { $0.0 < $1.0 }
    }
}

@MainActor
private final class RemoteModel: ObservableObject {
    @Published var controllerURL = UserDefaults.standard.string(forKey: "controllerURL")
        ?? "http://sms-ingestor.local:3100"
    @Published var connection = "Waiting for controller"
    @Published var snapshot: RemoteSnapshot?
    @Published var isBusy = false
    @Published var shuttingDown = false
    private var shutdownStartedAt: Date?

    var hasKey: Bool { !(OperatorKey.load() ?? "").isEmpty }

    private func localHost(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".local") { return true }
        let parts = host.split(separator: ".").compactMap { UInt8($0) }
        guard parts.count == 4 else { return false }
        return parts[0] == 10 || parts[0] == 172 && (16...31).contains(parts[1]) ||
            parts[0] == 192 && parts[1] == 168 || parts[0] == 169 && parts[1] == 254
    }

    private func normalizedAddress(_ address: String) throws -> URL {
        let cleaned = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let supplied = cleaned.contains("://") ? cleaned : "http://\(cleaned)"
        guard var parts = URLComponents(string: supplied),
              let host = parts.host?.lowercased(), !host.isEmpty,
              parts.user == nil, parts.password == nil else { throw RemoteError.invalidURL }
        if !host.contains(".") && host != "localhost" {
            parts.host = host + ".local"
        }
        guard parts.scheme == "https" || parts.scheme == "http" && localHost(parts.host ?? "") else {
            throw RemoteError.invalidURL
        }
        if parts.scheme == "http" && parts.port == nil { parts.port = 3100 }
        parts.path = ""
        parts.query = nil
        parts.fragment = nil
        guard let base = parts.url else { throw RemoteError.invalidURL }
        return base
    }

    func saveConfiguration(address: String, key: String) throws {
        let base = try normalizedAddress(address)
        let trimmedKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedKey.isEmpty else { throw RemoteError.missingKey }
        try OperatorKey.save(trimmedKey)
        controllerURL = base.absoluteString
        UserDefaults.standard.set(controllerURL, forKey: "controllerURL")
    }

    private func request(action: String? = nil) async throws -> Data {
        guard let key = OperatorKey.load(), !key.isEmpty else { throw RemoteError.missingKey }
        let base = try normalizedAddress(controllerURL)
        var request = URLRequest(url: base.appendingPathComponent(action == nil ? "phone-wall/remote/status" : "phone-wall/api"))
        request.timeoutInterval = 12
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        if let action {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(Action(action: action))
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw RemoteError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(APIError.self, from: data))?.error
            throw RemoteError.server(message ?? "Controller error \(response.statusCode).")
        }
        return data
    }

    func refresh() async {
        if shuttingDown {
            if let shutdownStartedAt, Date().timeIntervalSince(shutdownStartedAt) < 15 { return }
            shuttingDown = false
            shutdownStartedAt = nil
            connection = "Waiting for Mac mini to come back online…"
        }
        guard hasKey else {
            connection = "Set up the controller connection"
            return
        }
        do {
            snapshot = try JSONDecoder().decode(RemoteSnapshot.self, from: await request())
            connection = "Connected · updated \(Date().formatted(date: .omitted, time: .shortened))"
        } catch {
            snapshot = nil
            connection = "Cannot reach controller: \(error.localizedDescription)"
        }
    }

    func activate(_ action: String) async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await request(action: action)
            if action == "remote.shutdown" {
                shuttingDown = true
                shutdownStartedAt = Date()
                connection = "Mac mini shutting down. Wait until its power light is off before unplugging."
            } else {
                await refresh()
            }
        } catch {
            connection = "Action failed: \(error.localizedDescription)"
        }
    }

    func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: 5_000_000_000)
        }
    }
}

private struct RemoteView: View {
    @StateObject private var model = RemoteModel()
    @State private var showingSettings = false
    @State private var showingShutdownConfirmation = false

    var body: some View {
        ScrollView {
        VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text("CPU \(model.snapshot?.system.controllerCpuPercent.map { "\(Int($0.rounded()))%" } ?? "—")")
                        .font(.footnote.monospacedDigit())
                    Spacer()
                    Button { showingSettings = true } label: {
                        Image(systemName: "gearshape").accessibilityLabel("Connection")
                    }
                }
                Button {
                    Task { await model.activate("remote.night") }
                } label: {
                    Label("Night mode", systemImage: "moon.fill")
                        .frame(maxWidth: .infinity, minHeight: 58)
                }
                .buttonStyle(.borderedProminent)
                .tint(.indigo)
                .disabled(model.isBusy || model.shuttingDown || !model.hasKey)

                Button {
                    Task { await model.activate("remote.day") }
                } label: {
                    Label("Day mode", systemImage: "sun.max.fill")
                        .frame(maxWidth: .infinity, minHeight: 58)
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                .disabled(model.isBusy || model.shuttingDown || !model.hasKey)

                Button(role: .destructive) {
                    showingShutdownConfirmation = true
                } label: {
                    Label("Shut down installation", systemImage: "power")
                        .frame(maxWidth: .infinity, minHeight: 58)
                }
                .buttonStyle(.bordered)
                .disabled(model.isBusy || model.shuttingDown || !model.hasKey)

                Text(model.connection)
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                if let snapshot = model.snapshot {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Phone matrix")
                            .font(.headline)
                        Text(snapshot.unplugged.isEmpty ? "All paired phones are connected" : "\(snapshot.unplugged.count) unplugged phone\(snapshot.unplugged.count == 1 ? "" : "s")")
                            .font(.subheadline)
                            .foregroundColor(snapshot.unplugged.isEmpty ? .secondary : .red)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 5), count: max(1, snapshot.state.layout.columns)), spacing: 5) {
                            ForEach(0..<(snapshot.state.layout.rows * snapshot.state.layout.columns), id: \.self) { index in
                                let device = snapshot.device(at: index)
                                let row = index / max(1, snapshot.state.layout.columns) + 1
                                let column = index % max(1, snapshot.state.layout.columns) + 1
                                Text("\(row):\(column)")
                                    .font(.caption2.monospacedDigit())
                                    .frame(maxWidth: .infinity, minHeight: 42)
                                    .background(device == nil ? Color.gray.opacity(0.2) : device!.connected ? Color.green.opacity(0.25) : Color.red.opacity(0.8))
                                    .foregroundColor(device?.connected == false ? .white : .primary)
                                    .clipShape(RoundedRectangle(cornerRadius: 5))
                                    .accessibilityLabel("Row \(row), column \(column): \(device == nil ? "empty" : device!.connected ? "connected" : "unplugged")")
                            }
                        }
                        ForEach(snapshot.unplugged.map { $0.0 }, id: \.self) { index in
                            let row = index / max(1, snapshot.state.layout.columns) + 1
                            let column = index % max(1, snapshot.state.layout.columns) + 1
                            Text("R\(row) C\(column) · unplugged\(snapshot.device(at: index)?.lastError.map { " · \($0)" } ?? "")")
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
                }

                Spacer(minLength: 0)
            }
            .padding()
        }
            .sheet(isPresented: $showingSettings) {
                SettingsView(model: model)
            }
            .alert("Shut down the Mac mini?", isPresented: $showingShutdownConfirmation) {
                Button("Cancel", role: .cancel) {}
                Button("Enter Night mode and shut down", role: .destructive) {
                    Task { await model.activate("remote.shutdown") }
                }
            } message: {
                Text("The phones will enter Night mode first. Wait for the Mac mini's power light to go off before unplugging it. Press its power button after reconnecting power.")
            }
            .task {
                if !model.hasKey { showingSettings = true }
                await model.poll()
            }
    }
}

private struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var model: RemoteModel
    @State private var address = ""
    @State private var key = ""
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Controller") {
                    TextField("Mac mini name or URL", text: $address)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    SecureField("Operator key", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    Text("On the installation Wi-Fi, use sms-ingestor.local or sms-ingestor. The operator key stays in this iPhone's Keychain. Private HTTPS still works away from the installation.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Connection")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        do {
                            try model.saveConfiguration(address: address, key: key)
                            dismiss()
                            Task { await model.refresh() }
                        } catch { self.error = error.localizedDescription }
                    }
                }
            }
            .onAppear {
                address = model.controllerURL
                key = OperatorKey.load() ?? ""
            }
        }
    }
}
