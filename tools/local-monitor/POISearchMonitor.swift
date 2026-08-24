import AppKit
import Foundation
import MapKit

private struct Config {
    var host = "haoxi@10.192.132.3"
    var root = "/data2/shared/haoxi/CLI_scraper/output"
    var interval: TimeInterval = 1
    let cities = ["warsaw", "vienna", "madrid", "stockholm", "taipei", "tokyo", "new_york"]

    static func parse(_ args: [String]) -> Config {
        var value = Config(); var i = 1
        while i < args.count {
            guard i + 1 < args.count else { exit(64) }
            switch args[i] {
            case "--host": value.host = args[i + 1]
            case "--root": value.root = args[i + 1]
            case "--interval": value.interval = max(0.5, Double(args[i + 1]) ?? 1)
            default: fputs("Unknown option: \(args[i])\n", stderr); exit(64)
            }
            i += 2
        }
        return value
    }
}

private struct CellBox: Decodable {
    let minLat: Double, maxLat: Double, minLng: Double, maxLng: Double
    let centerLat: Double, centerLng: Double, sizeKm: Double
}

private struct POIStatus: Decodable {
    let city: String?
    let phase: String?
    let category: String?
    let categoryIndex: Int?
    let categoryTotal: Int?
    let depth: Int?
    let zoom: Int?
    let bbox: CellBox?
    let children: [CellBox]?
    let newPlaceIds: Int?
    let totalPlaceIds: Int?
    let requests: Int?
    let reason: String?
    let updatedAt: String?
}

private struct Sample {
    let date: Date
    let status: POIStatus
    let active: Int
}

private final class Sampler {
    private let config: Config
    private var timer: Timer?
    private var process: Process?
    var onSample: ((Sample) -> Void)?
    var onError: ((String) -> Void)?

    init(_ config: Config) { self.config = config }

    func start() {
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: config.interval, repeats: true) { [weak self] _ in self?.poll() }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }

    func stop() { timer?.invalidate(); process?.terminate(); timer = nil; process = nil }

    private func quote(_ s: String) -> String { "'" + s.replacingOccurrences(of: "'", with: "'\\''") + "'" }

    private func command() -> String {
        let files = config.cities.map { quote("\(config.root)/\($0)/poi_search.live.json") }.joined(separator: " ")
        let workerChecks = config.cities.map { city in
            let worker = quote("\(config.root)/\(city)/poi_search.pipeline.json")
            let live = quote("\(config.root)/\(city)/poi_search.live.json")
            return "if [ -r \(worker) ] && grep -Eq '\"phase\":\"(running|retrying)\"' \(worker); then active=$((active+1)); [ -n \"$selected\" ] || selected=\(live); fi"
        }.joined(separator: "\n")
        return """
        selected=''; active=0
        \(workerChecks)
        best="$selected"; newest=0
        if [ -n "$best" ]; then newest=$(stat -c %Y -- "$best" 2>/dev/null || echo 0); fi
        for f in \(files); do
          [ -r "$f" ] || continue
          [ -n "$selected" ] && continue
          t=$(stat -c %Y -- "$f" 2>/dev/null || echo 0)
          if [ "$t" -ge "$newest" ]; then newest=$t; best=$f; fi
        done
        [ -n "$best" ] || { printf 'MISSING\n'; exit 3; }
        live=$(base64 -w 0 -- "$best")
        printf '%s %s\n' "$active" "$live"
        """
    }

    private func poll() {
        guard process == nil else { return }
        let out = Pipe(), err = Pipe(), task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        task.arguments = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
                          "-o", "ControlMaster=auto", "-o", "ControlPersist=60",
                          "-o", "ControlPath=/tmp/poi-search-monitor-%C", config.host, command()]
        task.standardOutput = out; task.standardError = err; process = task
        task.terminationHandler = { [weak self] finished in
            let data = out.fileHandleForReading.readDataToEndOfFile()
            let error = err.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                guard let self else { return }; self.process = nil
                let text = String(data: data, encoding: .utf8) ?? ""
                let fields = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)
                guard finished.terminationStatus == 0, fields.count == 2,
                      let active = Int(fields[0]), let json = Data(base64Encoded: fields[1]),
                      let status = try? JSONDecoder().decode(POIStatus.self, from: json) else {
                    let detail = String(data: error, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines)
                    self.onError?(detail?.isEmpty == false ? detail! : "waiting for POI live status")
                    return
                }
                self.onSample?(Sample(date: Date(), status: status, active: active))
            }
        }
        do { try task.run() } catch { process = nil; onError?(error.localizedDescription) }
    }
}

private struct RatePoint { let date: Date; let value: Double }
private struct ViewState {
    var status: POIStatus?
    var active = 0
    var rate: Double?
    var points: [RatePoint] = []
    var online = false
}

private final class Store {
    private var readings: [String: [(Date, Int)]] = [:]
    private var charts: [String: [RatePoint]] = [:]

    func add(_ sample: Sample) -> ViewState {
        let city = sample.status.city ?? "unknown", total = sample.status.totalPlaceIds ?? 0
        var cityReadings = readings[city] ?? []
        if let last = cityReadings.last, total < last.1 { cityReadings.removeAll() }
        cityReadings.append((sample.date, total))
        cityReadings.removeAll { $0.0 < sample.date.addingTimeInterval(-1860) }
        readings[city] = cityReadings
        let cutoff = sample.date.addingTimeInterval(-60)
        let start = cityReadings.last(where: { $0.0 <= cutoff }) ?? cityReadings.first
        var rate: Double?
        if let start, let end = cityReadings.last, end.0 > start.0 {
            rate = Double(end.1 - start.1) / end.0.timeIntervalSince(start.0) * 60
        }
        var chart = charts[city] ?? []
        chart.append(RatePoint(date: sample.date, value: max(0, rate ?? 0)))
        chart.removeAll { $0.date < sample.date.addingTimeInterval(-1800) }
        charts[city] = chart
        return ViewState(status: sample.status, active: sample.active, rate: rate, points: chart, online: true)
    }
}

private final class DashboardView: NSView, MKMapViewDelegate {
    private(set) var state = ViewState()
    private var map: MKMapView?
    private var mapReleaseTimer: Timer?
    private var previousCenter: CLLocationCoordinate2D?
    private var lastEventKey = ""
    private var lastMapUpdate = Date.distantPast
    private let red = NSColor(calibratedRed: 1, green: 0.12, blue: 0.16, alpha: 1)
    private let gray = NSColor(calibratedWhite: 0.65, alpha: 1)
    override var isOpaque: Bool { true }

    func update(_ state: ViewState) {
        self.state = state
        if bounds.width >= 600 && bounds.height >= 360 { ensureMap(); updateMap() }
        needsDisplay = true
    }

    override func layout() {
        super.layout()
        let enhanced = bounds.width >= 600 && bounds.height >= 360
        if enhanced {
            mapReleaseTimer?.invalidate(); mapReleaseTimer = nil; ensureMap()
            let header: CGFloat = 72, chart = max(110, bounds.height * 0.25), strip: CGFloat = 42
            let right = max(250, bounds.width * 0.28)
            map?.frame = NSRect(x: 0, y: chart + strip, width: bounds.width - right,
                                height: bounds.height - header - chart - strip)
            map?.isHidden = false
        } else {
            map?.isHidden = true
            if map != nil && mapReleaseTimer == nil {
                mapReleaseTimer = Timer.scheduledTimer(withTimeInterval: 15, repeats: false) { [weak self] _ in
                    self?.map?.removeFromSuperview(); self?.map = nil; self?.mapReleaseTimer = nil
                }
            }
        }
    }

    private func ensureMap() {
        guard map == nil else { return }
        let value = MKMapView(frame: .zero)
        value.delegate = self; value.mapType = .mutedStandard
        value.showsBuildings = false; value.showsCompass = false
        value.isPitchEnabled = false; value.isRotateEnabled = false
        value.pointOfInterestFilter = .excludingAll
        addSubview(value, positioned: .below, relativeTo: nil); map = value
        lastEventKey = ""; lastMapUpdate = .distantPast
    }

    private func polygon(_ box: CellBox, title: String) -> MKPolygon {
        var coords = [
            CLLocationCoordinate2D(latitude: box.minLat, longitude: box.minLng),
            CLLocationCoordinate2D(latitude: box.minLat, longitude: box.maxLng),
            CLLocationCoordinate2D(latitude: box.maxLat, longitude: box.maxLng),
            CLLocationCoordinate2D(latitude: box.maxLat, longitude: box.minLng),
        ]
        let value = MKPolygon(coordinates: &coords, count: coords.count); value.title = title; return value
    }

    private func updateMap() {
        guard let map, let status = state.status, let box = status.bbox else { return }
        let childrenKey = (status.children ?? []).map { "\($0.centerLat),\($0.centerLng)" }.joined(separator: ";")
        let key = "\(status.city ?? "")|\(box.minLat)|\(box.maxLat)|\(box.minLng)|\(box.maxLng)|\(childrenKey)"
        guard key != lastEventKey else { return }
        let now = Date()
        guard now.timeIntervalSince(lastMapUpdate) >= 1.5 else { return }
        lastEventKey = key; lastMapUpdate = now
        map.removeOverlays(map.overlays)
        if let children = status.children {
            for child in children { map.addOverlay(polygon(child, title: "child")) }
        }
        map.addOverlay(polygon(box, title: "current"))
        let center = CLLocationCoordinate2D(latitude: box.centerLat, longitude: box.centerLng)
        if let previousCenter, abs(previousCenter.latitude - center.latitude) + abs(previousCenter.longitude - center.longitude) > 0.000001 {
            var line = [previousCenter, center]
            let flight = MKPolyline(coordinates: &line, count: 2); flight.title = "flight"; map.addOverlay(flight)
        }
        self.previousCenter = center
        let lat = max(0.001, (box.maxLat - box.minLat) * 1.35)
        let lng = max(0.001, (box.maxLng - box.minLng) * 1.35)
        map.setRegion(MKCoordinateRegion(center: center, span: MKCoordinateSpan(latitudeDelta: lat, longitudeDelta: lng)), animated: true)
    }

    func mapView(_ mapView: MKMapView, rendererFor overlay: MKOverlay) -> MKOverlayRenderer {
        if let shape = overlay as? MKPolygon {
            let renderer = MKPolygonRenderer(polygon: shape)
            let current = shape.title == "current"
            renderer.strokeColor = red.withAlphaComponent(current ? 0.95 : 0.48)
            renderer.fillColor = red.withAlphaComponent(current ? 0.13 : 0.025)
            renderer.lineWidth = current ? 2.2 : 1.0
            return renderer
        }
        if let line = overlay as? MKPolyline {
            let renderer = MKPolylineRenderer(polyline: line)
            renderer.strokeColor = red.withAlphaComponent(0.90); renderer.lineWidth = 2
            renderer.lineDashPattern = [6, 5]
            return renderer
        }
        return MKOverlayRenderer(overlay: overlay)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.018, alpha: 1).setFill(); bounds.fill()
        if bounds.width >= 600 && bounds.height >= 360 { drawEnhanced() } else { drawCompact() }
    }

    private func drawEnhanced() {
        let header: CGFloat = 72, chart = max(110, bounds.height * 0.25), strip: CGFloat = 42
        let right = max(250, bounds.width * 0.28), mapRight = bounds.width - right
        NSColor(calibratedWhite: 0.025, alpha: 0.98).setFill()
        NSRect(x: 0, y: bounds.height - header, width: bounds.width, height: header).fill()
        NSRect(x: mapRight, y: chart + strip, width: right, height: bounds.height - header - chart - strip).fill()
        NSRect(x: 0, y: chart, width: bounds.width, height: strip).fill()
        NSRect(x: 0, y: 0, width: bounds.width, height: chart).fill()
        separator(y: bounds.height - header); separator(y: chart + strip); separator(y: chart)
        let status = state.status
        text((status?.city ?? "WAITING").replacingOccurrences(of: "_", with: " ").uppercased(),
             NSRect(x: 22, y: bounds.height - 49, width: bounds.width * 0.28, height: 28), 17, .white)
        text("POI SEARCH", NSRect(x: bounds.width * 0.36, y: bounds.height - 49, width: bounds.width * 0.28, height: 28), 17, .white, .center)
        let progress = "\(status?.categoryIndex ?? 0) / \(status?.categoryTotal ?? 177)"
        text(progress, NSRect(x: bounds.width * 0.70, y: bounds.height - 49, width: bounds.width * 0.25, height: 28), 17, .white, .right)

        let x = mapRight + 28, w = right - 54, top = bounds.height - header - 48
        text((status?.category ?? "waiting").uppercased(), NSRect(x: x, y: top, width: w, height: 28), 16, .white)
        text("DEPTH", NSRect(x: x, y: top - 66, width: w * 0.6, height: 22), 12, gray)
        text("\(status?.depth ?? 0)", NSRect(x: x, y: top - 66, width: w, height: 22), 14, .white, .right)
        text("ZOOM", NSRect(x: x, y: top - 113, width: w * 0.6, height: 22), 12, gray)
        text("\(status?.zoom ?? 0)", NSRect(x: x, y: top - 113, width: w, height: 22), 14, .white, .right)
        text(String(format: "%.2f KM", status?.bbox?.sizeKm ?? 0), NSRect(x: x, y: top - 160, width: w, height: 22), 13, .white)
        text("+\(status?.newPlaceIds ?? 0) POIs", NSRect(x: x, y: top - 207, width: w, height: 23), 14, red)
        text("\(format(status?.totalPlaceIds ?? 0)) TOTAL", NSRect(x: x, y: top - 254, width: w, height: 23), 13, .white)
        text((status?.phase ?? "offline").uppercased(), NSRect(x: x, y: chart + strip + 20, width: w, height: 24), 13, red)

        text("QUADTREE", NSRect(x: 22, y: chart + 12, width: 105, height: 20), 11, red)
        text("\((status?.phase ?? "WAITING").uppercased())  •  \(state.active) ACTIVE", NSRect(x: 145, y: chart + 12, width: 300, height: 20), 11, .white)
        text(state.online ? "● LIVE" : "● OFF", NSRect(x: bounds.width - 110, y: chart + 12, width: 88, height: 20), 11, state.online ? red : gray, .right)
        drawChart(NSRect(x: 20, y: 18, width: bounds.width - 40, height: chart - 48))
        text("POI yield / min", NSRect(x: 22, y: chart - 28, width: 160, height: 19), 10, red)
    }

    private func drawCompact() {
        let status = state.status
        text(String(format: "%.1f/min", state.rate ?? 0), NSRect(x: 12, y: bounds.height - 42, width: 120, height: 28), 18, .white)
        text("\(status?.categoryIndex ?? 0)/\(status?.categoryTotal ?? 177)  •  \(state.active) ACTIVE",
             NSRect(x: 140, y: bounds.height - 39, width: bounds.width - 152, height: 22), 10, gray, .right)
        let meta = [(status?.city ?? "waiting").uppercased(), status?.category, "D\(status?.depth ?? 0)", "Z\(status?.zoom ?? 0)", "\(format(status?.totalPlaceIds ?? 0)) POIs"].compactMap { $0 }.joined(separator: "  ·  ")
        text(meta, NSRect(x: 12, y: bounds.height - 68, width: bounds.width - 24, height: 19), 9.5, gray)
        drawChart(NSRect(x: 10, y: 10, width: bounds.width - 20, height: max(30, bounds.height - 88)))
    }

    private func drawChart(_ rect: NSRect) {
        let grid = NSColor(calibratedRed: 0.42, green: 0.02, blue: 0.04, alpha: 0.28)
        grid.setStroke(); let g = NSBezierPath(); g.lineWidth = 0.5
        for i in 0...6 { let x = rect.minX + rect.width * CGFloat(i) / 6; g.move(to: NSPoint(x: x, y: rect.minY)); g.line(to: NSPoint(x: x, y: rect.maxY)) }
        for i in 0...3 { let y = rect.minY + rect.height * CGFloat(i) / 3; g.move(to: NSPoint(x: rect.minX, y: y)); g.line(to: NSPoint(x: rect.maxX, y: y)) }; g.stroke()
        let values = state.points.map(\.value); guard values.count > 1 else { return }
        let maxValue = max(1, values.sorted()[Int(Double(values.count - 1) * 0.95)] * 1.2)
        let p = NSBezierPath(); p.lineWidth = 1.8
        for (i, value) in values.enumerated() {
            let point = NSPoint(x: rect.minX + rect.width * CGFloat(i) / CGFloat(values.count - 1), y: rect.minY + rect.height * CGFloat(min(value, maxValue) / maxValue))
            i == 0 ? p.move(to: point) : p.line(to: point)
        }
        red.setStroke(); p.stroke()
    }

    private func separator(y: CGFloat) { let p = NSBezierPath(); p.move(to: NSPoint(x: 0, y: y)); p.line(to: NSPoint(x: bounds.width, y: y)); p.lineWidth = 0.6; NSColor(calibratedWhite: 0.3, alpha: 0.55).setStroke(); p.stroke() }
    private func text(_ value: String, _ rect: NSRect, _ size: CGFloat, _ color: NSColor, _ align: NSTextAlignment = .left) {
        let para = NSMutableParagraphStyle(); para.alignment = align; para.lineBreakMode = .byTruncatingTail
        (value as NSString).draw(in: rect, withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: size, weight: .regular), .foregroundColor: color, .paragraphStyle: para])
    }
    private func format(_ value: Int) -> String { NumberFormatter.localizedString(from: NSNumber(value: value), number: .decimal) }
}

private final class Delegate: NSObject, NSApplicationDelegate {
    let config: Config, store = Store(); var sampler: Sampler?; var view: DashboardView?; var window: NSWindow?
    init(_ config: Config) { self.config = config }
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        if let iconURL = Bundle.main.url(forResource: "app-icon", withExtension: "png"),
           let icon = NSImage(contentsOf: iconURL) { NSApp.applicationIconImage = icon }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 620), styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "POI Search Monitor"; window.minSize = NSSize(width: 400, height: 190)
        window.level = .floating; window.isMovableByWindowBackground = true; window.setFrameAutosaveName("POISearchMonitorV1")
        let view = DashboardView(frame: window.contentView?.bounds ?? .zero); view.autoresizingMask = [.width, .height]
        window.contentView = view; if !window.setFrameUsingName("POISearchMonitorV1") { window.center() }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true); self.view = view; self.window = window
        let sampler = Sampler(config); sampler.onSample = { [weak self] in self?.view?.update(self?.store.add($0) ?? ViewState()) }
        sampler.onError = { [weak self] message in var state = self?.view?.state ?? ViewState(); state.online = false; self?.view?.update(state); fputs("[poi-monitor] \(message)\n", stderr) }
        self.sampler = sampler; sampler.start()
    }
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }
    func applicationWillTerminate(_ notification: Notification) { sampler?.stop() }
}

private let config = Config.parse(CommandLine.arguments)
private let app = NSApplication.shared
private let delegate = Delegate(config)
app.delegate = delegate
app.run()
