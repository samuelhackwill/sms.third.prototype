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
        case .invalidURL: return "Saisissez le nom .local du Mac mini ou une adresse HTTPS privée."
        case .missingKey: return "Saisissez le code opérateur du mur."
        case .invalidResponse: return "Le contrôleur a renvoyé une réponse inattendue."
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
                throw RemoteError.server("Impossible d’enregistrer le code opérateur sur cet iPhone.")
            }
        } else if status != errSecSuccess {
            throw RemoteError.server("Impossible de modifier le code opérateur sur cet iPhone.")
        }
    }
}

private struct APIError: Decodable { let error: String }
private struct Action: Encodable { let action: String }
private struct CuratedToggleAction: Encodable { let action = "curated.toggle"; let id: String }
private struct CuratedResponse: Decodable { let messages: [CuratedMessage] }
private struct CuratedToggleResponse: Decodable { let selected: Bool }
private struct CuratedMessage: Decodable, Identifiable {
    let id: String
    let text: String
    let selected: Int
    let source: String
    let sender: String?
}
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
    @Published var connection = "En attente du contrôleur"
    @Published var snapshot: RemoteSnapshot?
    @Published var curatedMessages: [CuratedMessage] = []
    @Published var curatedStatus = "Chargement des messages…"
    @Published var curatedBusyId: String?
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

    private func request(path: String, body: Data? = nil) async throws -> Data {
        guard let key = OperatorKey.load(), !key.isEmpty else { throw RemoteError.missingKey }
        let base = try normalizedAddress(controllerURL)
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.timeoutInterval = 12
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = body
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let response = response as? HTTPURLResponse else { throw RemoteError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let message = (try? JSONDecoder().decode(APIError.self, from: data))?.error
            throw RemoteError.server(message.map { "Le contrôleur a refusé la demande (\($0))." } ?? "Erreur du contrôleur \(response.statusCode).")
        }
        return data
    }

    private func request(action: String? = nil) async throws -> Data {
        if let action { return try await request(path: "phone-wall/api", body: JSONEncoder().encode(Action(action: action))) }
        return try await request(path: "phone-wall/remote/status")
    }

    func loadCurated() async {
        guard hasKey else { curatedStatus = "Configurez d’abord la connexion."; return }
        curatedStatus = "Chargement des messages…"
        do {
            let response = try JSONDecoder().decode(CuratedResponse.self, from: await request(path: "phone-wall/curated"))
            curatedMessages = response.messages
            curatedStatus = "\(response.messages.filter { $0.selected == 1 }.count) message(s) retenu(s) sur \(response.messages.count)"
        } catch {
            curatedStatus = "Chargement impossible : \(error.localizedDescription)"
        }
    }

    func toggleCurated(_ id: String) async {
        guard curatedBusyId == nil else { return }
        curatedBusyId = id
        defer { curatedBusyId = nil }
        do {
            let body = try JSONEncoder().encode(CuratedToggleAction(id: id))
            let result = try JSONDecoder().decode(CuratedToggleResponse.self, from: await request(path: "phone-wall/api", body: body))
            if let index = curatedMessages.firstIndex(where: { $0.id == id }) {
                let previous = curatedMessages[index]
                curatedMessages[index] = CuratedMessage(id: previous.id, text: previous.text, selected: result.selected ? 1 : 0, source: previous.source, sender: previous.sender)
            }
            curatedStatus = "\(curatedMessages.filter { $0.selected == 1 }.count) message(s) retenu(s) sur \(curatedMessages.count)"
        } catch {
            curatedStatus = "Modification impossible : \(error.localizedDescription)"
        }
    }

    func refresh() async {
        if shuttingDown {
            if let shutdownStartedAt, Date().timeIntervalSince(shutdownStartedAt) < 15 { return }
            shuttingDown = false
            shutdownStartedAt = nil
            connection = "En attente du redémarrage du Mac mini…"
        }
        guard hasKey else {
            connection = "Configurez la connexion au contrôleur"
            return
        }
        do {
            snapshot = try JSONDecoder().decode(RemoteSnapshot.self, from: await request())
            connection = "Connecté · mis à jour à \(Date().formatted(date: .omitted, time: .shortened))"
        } catch {
            snapshot = nil
            connection = "Contrôleur inaccessible : \(error.localizedDescription)"
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
                connection = "Arrêt du Mac mini en cours. Attendez l’extinction du voyant avant de débrancher."
            } else {
                await refresh()
            }
        } catch {
            connection = "Action impossible : \(error.localizedDescription)"
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
        TabView {
        ScrollView {
        VStack(alignment: .leading, spacing: 22) {
                HStack {
                    Text("Processeur \(model.snapshot?.system.controllerCpuPercent.map { "\(Int($0.rounded())) %" } ?? "—")")
                        .font(.footnote.monospacedDigit())
                    Spacer()
                    Button { showingSettings = true } label: {
                        Image(systemName: "gearshape").accessibilityLabel("Connexion")
                    }
                }
                Button {
                    Task { await model.activate("remote.night") }
                } label: {
                    Label("Mode nuit", systemImage: "moon.fill")
                        .frame(maxWidth: .infinity, minHeight: 58)
                }
                .buttonStyle(.borderedProminent)
                .tint(.indigo)
                .disabled(model.isBusy || model.shuttingDown || !model.hasKey)

                Button {
                    Task { await model.activate("remote.day") }
                } label: {
                    Label("Mode jour", systemImage: "sun.max.fill")
                        .frame(maxWidth: .infinity, minHeight: 58)
                }
                .buttonStyle(.borderedProminent)
                .tint(.orange)
                .disabled(model.isBusy || model.shuttingDown || !model.hasKey)

                Button(role: .destructive) {
                    showingShutdownConfirmation = true
                } label: {
                    Label("Éteindre l’installation", systemImage: "power")
                        .frame(maxWidth: .infinity, minHeight: 58)
                }
                .buttonStyle(.bordered)
                .disabled(model.isBusy || model.shuttingDown || !model.hasKey)

                Text(model.connection)
                    .font(.footnote)
                    .foregroundStyle(.secondary)

                if let snapshot = model.snapshot {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Matrice des téléphones")
                            .font(.headline)
                        Text(snapshot.unplugged.isEmpty ? "Tous les téléphones appairés sont connectés" : "\(snapshot.unplugged.count) téléphone\(snapshot.unplugged.count == 1 ? "" : "s") hors ligne")
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
                                    .accessibilityLabel("Ligne \(row), colonne \(column) : \(device == nil ? "vide" : device!.connected ? "connecté" : "hors ligne")")
                            }
                        }
                        ForEach(snapshot.unplugged.map { $0.0 }, id: \.self) { index in
                            let row = index / max(1, snapshot.state.layout.columns) + 1
                            let column = index % max(1, snapshot.state.layout.columns) + 1
                            Text("L\(row) C\(column) · hors ligne\(snapshot.device(at: index)?.lastError.map { " · \($0)" } ?? "")")
                                .font(.footnote)
                                .foregroundStyle(.red)
                        }
                    }
                }

                Spacer(minLength: 0)
            }
            .padding()
        }
        .tabItem { Label("Contrôles", systemImage: "switch.2") }
        CuratedMessagesView(model: model)
            .tabItem { Label("Messages", systemImage: "text.bubble") }
        }
            .sheet(isPresented: $showingSettings) {
                SettingsView(model: model)
            }
            .alert("Éteindre le Mac mini ?", isPresented: $showingShutdownConfirmation) {
                Button("Annuler", role: .cancel) {}
                Button("Passer en mode nuit et éteindre", role: .destructive) {
                    Task { await model.activate("remote.shutdown") }
                }
            } message: {
                Text("Les téléphones passeront d’abord en mode nuit. Attendez l’extinction du voyant du Mac mini avant de le débrancher. Appuyez sur son bouton d’alimentation après l’avoir rebranché.")
            }
            .task {
                if !model.hasKey { showingSettings = true }
                await model.poll()
            }
    }
}

private struct CuratedMessagesView: View {
    @ObservedObject var model: RemoteModel
    @State private var search = ""
    @State private var selectedOnly = false

    private var visibleMessages: [CuratedMessage] {
        model.curatedMessages.filter { message in
            (!selectedOnly || message.selected == 1) &&
            (search.isEmpty || message.text.localizedStandardContains(search) || (message.sender?.localizedStandardContains(search) ?? false))
        }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Touchez un message pour l’inclure dans la sélection du mode Curated. Touchez-le de nouveau pour l’en retirer.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    TextField("Rechercher un message", text: $search)
                        .textFieldStyle(.roundedBorder)
                    Picker("Afficher", selection: $selectedOnly) {
                        Text("Tous").tag(false)
                        Text("Retenus").tag(true)
                    }
                    .pickerStyle(.segmented)
                    Text(model.curatedStatus)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if visibleMessages.isEmpty && model.curatedStatus != "Chargement des messages…" {
                        Text(model.curatedMessages.isEmpty ? "Aucun message disponible." : "Aucun message ne correspond à ce filtre.")
                            .foregroundStyle(.secondary)
                    }
                    LazyVStack(spacing: 8) {
                        ForEach(visibleMessages) { message in
                            Button {
                                Task { await model.toggleCurated(message.id) }
                            } label: {
                                HStack(alignment: .top, spacing: 10) {
                                    Image(systemName: message.selected == 1 ? "checkmark.circle.fill" : "circle")
                                        .foregroundColor(message.selected == 1 ? .green : .secondary)
                                    VStack(alignment: .leading, spacing: 5) {
                                        Text(message.source == "sms" ? "SMS\(message.sender.map { " · \($0)" } ?? "")" : "Archive Messages")
                                            .font(.caption)
                                            .foregroundStyle(.secondary)
                                        Text(message.text)
                                            .foregroundColor(.primary)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                    }
                                }
                                .padding(12)
                                .background(message.selected == 1 ? Color.green.opacity(0.12) : Color.gray.opacity(0.1))
                                .clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)
                            .disabled(model.curatedBusyId != nil)
                            .accessibilityLabel("\(message.selected == 1 ? "Retenu" : "Non retenu") : \(message.text)")
                        }
                    }
                }
                .padding()
            }
            .refreshable { await model.loadCurated() }
            .navigationTitle("Messages Curated")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Actualiser") { Task { await model.loadCurated() } }
                }
            }
            .task { await model.loadCurated() }
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
                Section("Contrôleur") {
                    TextField("Nom ou adresse du Mac mini", text: $address)
                        .textInputAutocapitalization(.never)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                    SecureField("Code opérateur", text: $key)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
                Section {
                    Text("Sur le Wi-Fi de l’installation, utilisez sms-ingestor.local ou sms-ingestor. Le code opérateur est conservé dans le trousseau de cet iPhone. Une adresse HTTPS privée fonctionne aussi à distance.")
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
            }
            .navigationTitle("Connexion")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Enregistrer") {
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
