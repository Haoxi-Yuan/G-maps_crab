import AppKit
import Foundation

private struct AppConfig {
    var host = "haoxi@10.192.132.3"
    var remoteOutput = "/data2/shared/haoxi/CLI_scraper/output/singapore/reviews.ndjson"
    var remoteLog = "/data2/shared/haoxi/CLI_scraper/output/singapore/reviews.log"
    var remoteStatus = "/data2/shared/haoxi/CLI_scraper/output/singapore/reviews.live.json"
    var interval: TimeInterval = 5
    var chartMinutes: TimeInterval = 30

    static func parse(_ arguments: [String]) -> AppConfig {
        var config = AppConfig()
        var index = 1
        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--host", "--output", "--log", "--status", "--interval", "--chart-minutes":
                guard index + 1 < arguments.count else {
                    fputs("Missing value for \(argument)\n", stderr)
                    exit(64)
                }
                let value = arguments[index + 1]
                switch argument {
                case "--host": config.host = value
                case "--output": config.remoteOutput = value
                case "--log": config.remoteLog = value
                case "--status": config.remoteStatus = value
                case "--interval":
                    guard let seconds = Double(value), seconds >= 2 else {
                        fputs("--interval must be at least 2 seconds\n", stderr)
                        exit(64)
                    }
                    config.interval = seconds
                case "--chart-minutes":
                    guard let minutes = Double(value), minutes >= 1 else {
                        fputs("--chart-minutes must be at least 1\n", stderr)
                        exit(64)
                    }
                    config.chartMinutes = minutes
                default: break
                }
                index += 2
            case "--help", "-h":
                print("""
                Review Rate Monitor

                  --host USER@HOST       SSH destination
                  --output REMOTE_PATH   reviews.ndjson path
                  --log REMOTE_PATH      reviews.log path
                  --status REMOTE_PATH   transient live status JSON
                  --interval SECONDS     poll interval, default 5
                  --chart-minutes N      visible rate history, default 30
                """)
                exit(0)
            default:
                fputs("Unknown option: \(argument)\n", stderr)
                exit(64)
            }
        }
        return config
    }
}

private struct LiveReview: Decodable {
    let rating: Double?
    let text: String?
    let reviewer: String?
    let publishedAt: String?
}

private struct LiveStatus: Decodable {
    let city: String?
    let phase: String?
    let updatedAt: String?
    let index: Int?
    let total: Int?
    let placeId: String?
    let name: String?
    let categories: [String]?
    let latitude: Double?
    let longitude: Double?
    let expectedReviews: Int?
    let fetchedReviews: Int?
    let latestReview: LiveReview?
    let message: String?
}

private struct RemoteReading {
    let timestamp: Date
    let completed: Int
    let total: Int
    let liveStatus: LiveStatus?
}

private func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

/// Counts the output once, then scans only bytes appended since the previous
/// poll. The live context is a single atomically replaced JSON object.
private final class RemoteCounterSampler {
    private let config: AppConfig
    private var timer: Timer?
    private var process: Process?
    private var remoteSize: Int64?
    private var completed = 0
    private var total = 0

    var onReading: ((RemoteReading) -> Void)?
    var onError: ((String) -> Void)?

    init(config: AppConfig) {
        self.config = config
    }

    func start() {
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: config.interval, repeats: true) { [weak self] _ in
            self?.poll()
        }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        process?.terminate()
        process = nil
    }

    private func remoteCommand() -> String {
        let output = shellQuote(config.remoteOutput)
        let log = shellQuote(config.remoteLog)
        let status = shellQuote(config.remoteStatus)
        let sedExpression = shellQuote(#"s/^\[\([0-9][0-9]*\)\/\([0-9][0-9]*\)\].*/\1 \2/p"#)
        let common = """
        if [ ! -f \(output) ]; then printf 'MISSING\\n'; exit 3; fi
        size=$(stat -c %s -- \(output))
        latest=$(tail -c 524288 -- \(log) 2>/dev/null | sed -n \(sedExpression) | tail -n 1)
        set -- $latest
        current=${1:-0}
        total=${2:-0}
        live='-'
        if [ -r \(status) ]; then live=$(base64 -w 0 -- \(status) 2>/dev/null || printf '-'); fi
        """

        guard let previousSize = remoteSize else {
            return common + "\ncount=$(wc -l < \(output)); printf 'B %s %s %s %s %s\\n' \"$size\" \"$count\" \"$current\" \"$total\" \"$live\""
        }
        let nextByte = previousSize + 1
        return common + """

        if [ "$size" -lt \(previousSize) ]; then
          count=$(wc -l < \(output))
          printf 'B %s %s %s %s %s\\n' "$size" "$count" "$current" "$total" "$live"
        else
          delta=$(tail -c +\(nextByte) -- \(output) | wc -l)
          printf 'D %s %s %s %s %s\\n' "$size" "$delta" "$current" "$total" "$live"
        fi
        """
    }

    private func poll() {
        guard process == nil else { return }
        let stdout = Pipe()
        let stderrPipe = Pipe()
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        task.arguments = [
            "-o", "BatchMode=yes",
            "-o", "ConnectTimeout=8",
            "-o", "ControlMaster=auto",
            "-o", "ControlPersist=60",
            "-o", "ControlPath=/tmp/review-rate-monitor-%C",
            config.host,
            remoteCommand()
        ]
        task.standardOutput = stdout
        task.standardError = stderrPipe
        process = task
        task.terminationHandler = { [weak self] finished in
            let outputData = stdout.fileHandleForReading.readDataToEndOfFile()
            let errorData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
            let outputText = String(data: outputData, encoding: .utf8) ?? ""
            let errorText = String(data: errorData, encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                guard let self else { return }
                self.process = nil
                self.consume(output: outputText, error: errorText, status: finished.terminationStatus)
            }
        }
        do { try task.run() }
        catch {
            process = nil
            onError?(error.localizedDescription)
        }
    }

    private func consume(output: String, error: String, status: Int32) {
        guard status == 0 else {
            let detail = error.trimmingCharacters(in: .whitespacesAndNewlines)
            onError?(detail.isEmpty ? "ssh exited with status \(status)" : detail)
            return
        }
        let fields = output.split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard fields.count >= 6,
              fields[0] == "B" || fields[0] == "D",
              let size = Int64(fields[1]),
              let value = Int(fields[2]),
              let reportedTotal = Int(fields[4]) else {
            onError?("unexpected remote response")
            return
        }

        completed = fields[0] == "B" ? value : completed + value
        remoteSize = size
        if reportedTotal > 0 { total = reportedTotal }

        var liveStatus: LiveStatus?
        // Treat the final token as status. Some remote wc implementations pad
        // numeric fields with whitespace, so fixed-position parsing would be
        // needlessly brittle while base64 itself never contains whitespace.
        if let encodedStatus = fields.last, encodedStatus != "-",
           let data = Data(base64Encoded: encodedStatus) {
            liveStatus = try? JSONDecoder().decode(LiveStatus.self, from: data)
            if let liveTotal = liveStatus?.total, liveTotal > 0 { total = liveTotal }
        }
        onReading?(RemoteReading(timestamp: Date(), completed: completed, total: total, liveStatus: liveStatus))
    }
}

private struct RatePoint {
    let timestamp: Date
    let value: Double
}

private struct DashboardState {
    var currentRate: Double?
    var averageRate: Double?
    var completed = 0
    var total = 0
    var online = false
    var points: [RatePoint] = []
    var liveStatus: LiveStatus?
}

private final class RateStore {
    private let chartWindow: TimeInterval
    private var readings: [RemoteReading] = []
    private(set) var ratePoints: [RatePoint] = []

    init(chartWindow: TimeInterval) {
        self.chartWindow = chartWindow
    }

    func add(_ reading: RemoteReading) -> DashboardState {
        if let last = readings.last, reading.completed < last.completed {
            readings.removeAll()
            ratePoints.removeAll()
        }
        readings.append(reading)
        let current = rate(over: 60)
        ratePoints.append(RatePoint(timestamp: reading.timestamp, value: current ?? 0))
        let cutoff = reading.timestamp.addingTimeInterval(-max(chartWindow, 900) - 60)
        readings.removeAll { $0.timestamp < cutoff }
        ratePoints.removeAll { $0.timestamp < reading.timestamp.addingTimeInterval(-chartWindow) }
        return DashboardState(
            currentRate: current,
            averageRate: rate(over: 900),
            completed: reading.completed,
            total: reading.total,
            online: true,
            points: ratePoints,
            liveStatus: reading.liveStatus
        )
    }

    private func rate(over window: TimeInterval) -> Double? {
        guard let end = readings.last, readings.count >= 2 else { return nil }
        let target = end.timestamp.addingTimeInterval(-window)
        let start = readings.last(where: { $0.timestamp <= target }) ?? readings[0]
        let elapsed = end.timestamp.timeIntervalSince(start.timestamp)
        guard elapsed >= 1 else { return nil }
        return max(0, Double(end.completed - start.completed) / elapsed * 60)
    }
}

private struct GeoPoint: Equatable {
    let latitude: Double
    let longitude: Double
}

private final class BoundaryModel {
    let rings: [[GeoPoint]]
    let minLatitude: Double
    let maxLatitude: Double
    let minLongitude: Double
    let maxLongitude: Double

    init?(url: URL) {
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        var parsed: [[GeoPoint]] = []

        func addCoordinates(_ coordinates: Any) {
            guard let array = coordinates as? [Any], !array.isEmpty else { return }
            if let pair = array.first as? [Double], pair.count >= 2 {
                let ring = array.compactMap { value -> GeoPoint? in
                    guard let item = value as? [Double], item.count >= 2 else { return nil }
                    return GeoPoint(latitude: item[1], longitude: item[0])
                }
                if ring.count >= 3 { parsed.append(ring) }
            } else {
                for item in array { addCoordinates(item) }
            }
        }

        func addGeometry(_ geometry: [String: Any]) {
            if let coordinates = geometry["coordinates"] { addCoordinates(coordinates) }
            if let geometries = geometry["geometries"] as? [[String: Any]] {
                for child in geometries { addGeometry(child) }
            }
        }

        if let geometry = json["geometry"] as? [String: Any] { addGeometry(geometry) }
        if let features = json["features"] as? [[String: Any]] {
            for feature in features {
                if let geometry = feature["geometry"] as? [String: Any] { addGeometry(geometry) }
            }
        }
        if json["coordinates"] != nil { addGeometry(json) }
        guard !parsed.isEmpty else { return nil }
        let points = parsed.flatMap { $0 }
        rings = parsed
        minLatitude = points.map(\.latitude).min()!
        maxLatitude = points.map(\.latitude).max()!
        minLongitude = points.map(\.longitude).min()!
        maxLongitude = points.map(\.longitude).max()!
    }

    func project(_ point: GeoPoint, into rect: NSRect) -> NSPoint {
        let width = max(0.000001, maxLongitude - minLongitude)
        let height = max(0.000001, maxLatitude - minLatitude)
        let sourceAspect = width / height
        let targetAspect = Double(rect.width / max(rect.height, 1))
        var drawRect = rect.insetBy(dx: 12, dy: 12)
        if sourceAspect > targetAspect {
            let fittedHeight = Double(drawRect.width) / sourceAspect
            drawRect.origin.y += (drawRect.height - fittedHeight) / 2
            drawRect.size.height = fittedHeight
        } else {
            let fittedWidth = Double(drawRect.height) * sourceAspect
            drawRect.origin.x += (drawRect.width - fittedWidth) / 2
            drawRect.size.width = fittedWidth
        }
        let x = (point.longitude - minLongitude) / width
        let y = (point.latitude - minLatitude) / height
        return NSPoint(x: drawRect.minX + CGFloat(x) * drawRect.width,
                       y: drawRect.minY + CGFloat(y) * drawRect.height)
    }
}

private final class MonitorView: NSView {
    private(set) var state = DashboardState()
    private let boundary: BoundaryModel?
    private var displayedPoint: GeoPoint?
    private var animationFrom: GeoPoint?
    private var animationTo: GeoPoint?
    private var animationStart: Date?
    private var animationTimer: Timer?
    private var animationProgress: Double = 0
    private let animationDuration: TimeInterval = 2.8
    private let red = NSColor(calibratedRed: 1, green: 0.12, blue: 0.16, alpha: 1)
    private let secondary = NSColor(calibratedWhite: 0.60, alpha: 1)

    override var isOpaque: Bool { true }

    init(frame: NSRect, boundary: BoundaryModel?) {
        self.boundary = boundary
        super.init(frame: frame)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(_ next: DashboardState) {
        if let latitude = next.liveStatus?.latitude,
           let longitude = next.liveStatus?.longitude {
            let destination = GeoPoint(latitude: latitude, longitude: longitude)
            if displayedPoint == nil {
                displayedPoint = destination
            } else if destination != animationTo && destination != displayedPoint {
                animationFrom = displayedPoint
                animationTo = destination
                animationStart = Date()
                animationProgress = 0
                startAnimation()
            }
        }
        state = next
        needsDisplay = true
    }

    private func startAnimation() {
        animationTimer?.invalidate()
        animationTimer = Timer.scheduledTimer(withTimeInterval: 1.0 / 30.0, repeats: true) { [weak self] timer in
            guard let self, let start = self.animationStart,
                  let from = self.animationFrom, let to = self.animationTo else {
                timer.invalidate()
                return
            }
            let t = min(1, Date().timeIntervalSince(start) / self.animationDuration)
            // Spend the final 28% of the transition pulsing at the destination.
            // This makes short, nearby POI changes visible on a city-wide map.
            let travel = min(1, t / 0.72)
            let eased = travel * travel * (3 - 2 * travel)
            self.animationProgress = t
            self.displayedPoint = GeoPoint(
                latitude: from.latitude + (to.latitude - from.latitude) * eased,
                longitude: from.longitude + (to.longitude - from.longitude) * eased
            )
            self.needsDisplay = true
            if t >= 1 {
                self.displayedPoint = to
                self.animationProgress = 1
                timer.invalidate()
                self.animationTimer = nil
            }
        }
        if let animationTimer { RunLoop.main.add(animationTimer, forMode: .common) }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        NSColor(calibratedWhite: 0.018, alpha: 1).setFill()
        bounds.fill()
        if bounds.width >= 600 && bounds.height >= 360 { drawEnhanced() }
        else { drawCompact() }
    }

    private func drawCompact() {
        let headerY = bounds.maxY - 42
        drawRateHeader(y: headerY)
        let status = state.liveStatus
        let metadata = [
            (status?.city ?? "singapore").uppercased(),
            status?.categories?.first,
            status?.name,
        ].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "  ·  ")
        drawText(metadata.isEmpty ? "SINGAPORE" : metadata,
                 in: NSRect(x: 12, y: bounds.maxY - 68, width: bounds.width - 24, height: 18),
                 font: .monospacedSystemFont(ofSize: 9.5, weight: .regular), color: secondary)
        drawChart(in: NSRect(x: 9, y: 9, width: bounds.width - 18, height: max(36, bounds.height - 82)))
    }

    private func drawEnhanced() {
        let headerHeight: CGFloat = 56
        let chartHeight = max(92, min(138, bounds.height * 0.28))
        let reviewHeight: CGFloat = 40
        let contentBottom = chartHeight + reviewHeight
        let contentTop = bounds.height - headerHeight
        let contentHeight = max(40, contentTop - contentBottom)
        let dividerX = bounds.width * 0.56

        drawRateHeader(y: bounds.maxY - 42)
        drawSeparator(from: NSPoint(x: 0, y: contentTop), to: NSPoint(x: bounds.maxX, y: contentTop), alpha: 0.55)
        drawSeparator(from: NSPoint(x: dividerX, y: contentBottom), to: NSPoint(x: dividerX, y: contentTop), alpha: 0.55)

        let mapRect = NSRect(x: 0, y: contentBottom, width: dividerX, height: contentHeight)
        drawMap(in: mapRect.insetBy(dx: 10, dy: 8))
        let detailsRect = NSRect(x: dividerX + 18, y: contentBottom + 12,
                                 width: bounds.width - dividerX - 32, height: contentHeight - 24)
        drawDetails(in: detailsRect)

        drawSeparator(from: NSPoint(x: 0, y: chartHeight + reviewHeight),
                      to: NSPoint(x: bounds.maxX, y: chartHeight + reviewHeight), alpha: 0.55)
        drawReview(in: NSRect(x: 14, y: chartHeight + 7, width: bounds.width - 28, height: reviewHeight - 12))
        drawSeparator(from: NSPoint(x: 0, y: chartHeight), to: NSPoint(x: bounds.maxX, y: chartHeight), alpha: 0.55)
        drawChart(in: NSRect(x: 12, y: 10, width: bounds.width - 24, height: chartHeight - 20))
    }

    private func drawRateHeader(y: CGFloat) {
        let primary = state.currentRate.map { String(format: "%.2f/min", $0) } ?? "—/min"
        let average = state.averageRate.map { String(format: "15m %.2f", $0) } ?? "15m —"
        let progress = state.total > 0
            ? "\(formatInteger(state.completed)) / \(formatInteger(state.total))"
            : "— / —"
        let wide = bounds.width >= 600
        if wide {
            drawText((state.liveStatus?.city ?? "singapore").uppercased(),
                     in: NSRect(x: 18, y: y + 2, width: bounds.width * 0.25, height: 24),
                     font: .monospacedSystemFont(ofSize: 13, weight: .medium), color: .white)
            drawText(primary, in: NSRect(x: bounds.width * 0.30, y: y - 1, width: bounds.width * 0.24, height: 29),
                     font: .monospacedDigitSystemFont(ofSize: 19, weight: .medium), color: red, alignment: .center)
            drawText(progress, in: NSRect(x: bounds.width * 0.57, y: y + 3, width: bounds.width * 0.30, height: 22),
                     font: .monospacedDigitSystemFont(ofSize: 12, weight: .regular), color: .white, alignment: .right)
        } else {
            drawText(primary, in: NSRect(x: 12, y: y, width: 108, height: 28),
                     font: .monospacedDigitSystemFont(ofSize: 18, weight: .medium), color: .white)
            drawText(average, in: NSRect(x: 120, y: y + 3, width: 72, height: 20),
                     font: .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular), color: secondary, alignment: .center)
            drawText(progress, in: NSRect(x: 194, y: y + 3, width: max(80, bounds.width - 252), height: 20),
                     font: .monospacedDigitSystemFont(ofSize: 9.5, weight: .regular), color: secondary, alignment: .right)
        }
        let dotX = bounds.maxX - 42
        (state.online ? red : NSColor(calibratedWhite: 0.30, alpha: 1)).setFill()
        NSBezierPath(ovalIn: NSRect(x: dotX, y: y + 8, width: 6, height: 6)).fill()
        drawText(state.online ? "LIVE" : "OFF", in: NSRect(x: dotX + 9, y: y + 3, width: 30, height: 20),
                 font: .monospacedSystemFont(ofSize: 9, weight: .medium), color: state.online ? red : secondary)
    }

    private func drawMap(in rect: NSRect) {
        guard let boundary else {
            drawText("MAP UNAVAILABLE", in: rect, font: .monospacedSystemFont(ofSize: 10, weight: .regular), color: secondary, alignment: .center)
            return
        }
        NSColor(calibratedWhite: 0.38, alpha: 0.72).setStroke()
        for ring in boundary.rings {
            let path = NSBezierPath()
            for (index, geo) in ring.enumerated() {
                let point = boundary.project(geo, into: rect)
                index == 0 ? path.move(to: point) : path.line(to: point)
            }
            path.close()
            path.lineWidth = 0.7
            path.stroke()
        }

        var markerPoint = displayedPoint.map { boundary.project($0, into: rect) }
        if let from = animationFrom, let to = animationTo, animationTimer != nil {
            let a = boundary.project(from, into: rect)
            let b = boundary.project(to, into: rect)
            let distance = hypot(b.x - a.x, b.y - a.y)
            let lift = max(44, min(82, distance * 0.48))
            let direction: CGFloat = ((a.y + b.y) / 2 < rect.midY) ? 1 : -1
            let c1 = NSPoint(x: a.x + (b.x - a.x) * 0.30,
                             y: a.y + (b.y - a.y) * 0.30 + lift * direction)
            let c2 = NSPoint(x: a.x + (b.x - a.x) * 0.70,
                             y: a.y + (b.y - a.y) * 0.70 + lift * direction)
            let arc = NSBezierPath()
            arc.move(to: a)
            arc.curve(to: b, controlPoint1: c1, controlPoint2: c2)
            let dash: [CGFloat] = [5, 4]
            arc.setLineDash(dash, count: dash.count, phase: 0)
            arc.lineWidth = 1.2
            red.withAlphaComponent(0.34).setStroke()
            arc.stroke()

            let travel = min(1, animationProgress / 0.72)
            let eased = travel * travel * (3 - 2 * travel)
            let moving = cubicPoint(eased, a, c1, c2, b)
            markerPoint = moving

            // Draw the traversed part as a bright solid trail.
            let trail = NSBezierPath()
            trail.move(to: a)
            for step in 1...24 {
                let t = eased * Double(step) / 24
                trail.line(to: cubicPoint(t, a, c1, c2, b))
            }
            trail.lineWidth = 2.0
            trail.lineCapStyle = .round
            red.withAlphaComponent(0.92).setStroke()
            trail.stroke()

            // Keep both endpoints visible. The destination target continues to
            // pulse after the moving point lands so the transition is obvious.
            red.withAlphaComponent(0.42).setStroke()
            let source = NSBezierPath(ovalIn: NSRect(x: a.x - 4, y: a.y - 4, width: 8, height: 8))
            source.lineWidth = 1
            source.stroke()
            let pulse = CGFloat(10 + 5 * abs(sin(animationProgress * .pi * 4)))
            red.withAlphaComponent(0.20).setFill()
            NSBezierPath(ovalIn: NSRect(x: b.x - pulse, y: b.y - pulse,
                                        width: pulse * 2, height: pulse * 2)).fill()
            red.withAlphaComponent(0.75).setStroke()
            let target = NSBezierPath(ovalIn: NSRect(x: b.x - 7, y: b.y - 7, width: 14, height: 14))
            target.lineWidth = 1.3
            target.stroke()

            drawText(animationProgress < 0.72 ? "POI JUMP" : "ARRIVED",
                     in: NSRect(x: rect.minX + 5, y: rect.maxY - 21, width: 90, height: 16),
                     font: .monospacedSystemFont(ofSize: 9, weight: .medium), color: red)
        }

        if let point = markerPoint {
            red.withAlphaComponent(0.16).setFill()
            NSBezierPath(ovalIn: NSRect(x: point.x - 12, y: point.y - 12, width: 24, height: 24)).fill()
            red.withAlphaComponent(0.42).setStroke()
            let ring = NSBezierPath(ovalIn: NSRect(x: point.x - 7, y: point.y - 7, width: 14, height: 14))
            ring.lineWidth = 1.2
            ring.stroke()
            red.setFill()
            NSBezierPath(ovalIn: NSRect(x: point.x - 3.5, y: point.y - 3.5, width: 7, height: 7)).fill()
        }
    }

    private func cubicPoint(_ t: Double, _ a: NSPoint, _ c1: NSPoint,
                            _ c2: NSPoint, _ b: NSPoint) -> NSPoint {
        let u = 1 - t
        let x = u * u * u * Double(a.x)
            + 3 * u * u * t * Double(c1.x)
            + 3 * u * t * t * Double(c2.x)
            + t * t * t * Double(b.x)
        let y = u * u * u * Double(a.y)
            + 3 * u * u * t * Double(c1.y)
            + 3 * u * t * t * Double(c2.y)
            + t * t * t * Double(b.y)
        return NSPoint(x: x, y: y)
    }

    private func drawDetails(in rect: NSRect) {
        let status = state.liveStatus
        let name = status?.name ?? "Waiting for live POI status"
        let categories = status?.categories?.joined(separator: " · ") ?? "—"
        let coordinates: String
        if let latitude = status?.latitude, let longitude = status?.longitude {
            coordinates = String(format: "%.5f, %.5f", latitude, longitude)
        } else { coordinates = "—" }
        let phase = (status?.phase ?? "legacy").uppercased()
        let reviewProgress: String
        if let fetched = status?.fetchedReviews, let expected = status?.expectedReviews {
            reviewProgress = "\(formatInteger(fetched)) / \(formatInteger(expected)) reviews"
        } else { reviewProgress = "review stream pending" }

        drawText(name, in: NSRect(x: rect.minX, y: rect.maxY - 34, width: rect.width, height: 30),
                 font: .systemFont(ofSize: 15, weight: .medium), color: .white)
        drawText(categories, in: NSRect(x: rect.minX, y: rect.maxY - 61, width: rect.width, height: 22),
                 font: .systemFont(ofSize: 11.5, weight: .regular), color: secondary)
        drawSeparator(from: NSPoint(x: rect.minX, y: rect.maxY - 72), to: NSPoint(x: rect.maxX, y: rect.maxY - 72), alpha: 0.28)
        drawText(coordinates, in: NSRect(x: rect.minX, y: rect.maxY - 105, width: rect.width, height: 22),
                 font: .monospacedDigitSystemFont(ofSize: 11, weight: .regular), color: secondary)
        drawText("\(phase)  ·  \(reviewProgress)", in: NSRect(x: rect.minX, y: rect.maxY - 132, width: rect.width, height: 22),
                 font: .monospacedSystemFont(ofSize: 9.5, weight: .regular), color: red.withAlphaComponent(0.88))
    }

    private func drawReview(in rect: NSRect) {
        let review = state.liveStatus?.latestReview
        var prefix = "LIVE REVIEW"
        if let rating = review?.rating { prefix += String(format: "  %.0f/5", rating) }
        drawText(prefix, in: NSRect(x: rect.minX, y: rect.minY, width: 112, height: rect.height),
                 font: .monospacedSystemFont(ofSize: 9.5, weight: .medium), color: red)
        let text = review?.text?.isEmpty == false ? review!.text! : "Waiting for the next review…"
        drawText(text, in: NSRect(x: rect.minX + 122, y: rect.minY, width: rect.width - 122, height: rect.height),
                 font: .systemFont(ofSize: 11, weight: .regular), color: .white)
    }

    private func drawChart(in rect: NSRect) {
        let grid = NSColor(calibratedRed: 0.42, green: 0.02, blue: 0.04, alpha: 0.30)
        grid.setStroke()
        let gridPath = NSBezierPath()
        gridPath.lineWidth = 0.5
        for column in 0...6 {
            let x = rect.minX + rect.width * CGFloat(column) / 6
            gridPath.move(to: NSPoint(x: x, y: rect.minY)); gridPath.line(to: NSPoint(x: x, y: rect.maxY))
        }
        for row in 0...3 {
            let y = rect.minY + rect.height * CGFloat(row) / 3
            gridPath.move(to: NSPoint(x: rect.minX, y: y)); gridPath.line(to: NSPoint(x: rect.maxX, y: y))
        }
        gridPath.stroke()

        let values = state.points.map(\.value)
        guard values.count >= 2 else { return }
        let sorted = values.sorted()
        let scaleMax = max(1, sorted[Int(Double(sorted.count - 1) * 0.95)] * 1.20)
        let path = NSBezierPath()
        path.lineWidth = 1.7
        path.lineJoinStyle = .round
        path.lineCapStyle = .round
        for (index, value) in values.enumerated() {
            let x = rect.minX + rect.width * CGFloat(index) / CGFloat(values.count - 1)
            let y = rect.minY + rect.height * CGFloat(min(max(0, value), scaleMax) / scaleMax)
            index == 0 ? path.move(to: NSPoint(x: x, y: y)) : path.line(to: NSPoint(x: x, y: y))
        }
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: rect).addClip()
        red.setStroke(); path.stroke()
        NSGraphicsContext.restoreGraphicsState()
    }

    private func drawSeparator(from: NSPoint, to: NSPoint, alpha: CGFloat) {
        let path = NSBezierPath(); path.move(to: from); path.line(to: to); path.lineWidth = 0.6
        NSColor(calibratedWhite: 0.28, alpha: alpha).setStroke(); path.stroke()
    }

    private func drawText(_ text: String, in rect: NSRect, font: NSFont, color: NSColor,
                          alignment: NSTextAlignment = .left) {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = alignment
        paragraph.lineBreakMode = .byTruncatingTail
        (text as NSString).draw(in: rect, withAttributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph])
    }

    private func formatInteger(_ value: Int) -> String {
        NumberFormatter.localizedString(from: NSNumber(value: value), number: .decimal)
    }
}

private final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private let config: AppConfig
    private let store: RateStore
    private var sampler: RemoteCounterSampler?
    private var window: NSWindow?
    private var monitorView: MonitorView?

    init(config: AppConfig) {
        self.config = config
        self.store = RateStore(chartWindow: config.chartMinutes * 60)
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.appearance = NSAppearance(named: .darkAqua)
        if let iconURL = Bundle.main.url(forResource: "app-icon", withExtension: "png"),
           let icon = NSImage(contentsOf: iconURL) {
            NSApp.applicationIconImage = icon
            _ = NSWorkspace.shared.setIcon(icon, forFile: Bundle.main.bundlePath, options: [])
        }
        let boundaryURL = Bundle.main.url(forResource: "singapore_boundary", withExtension: "geojson")
        let boundary = boundaryURL.flatMap(BoundaryModel.init(url:))
        let frame = NSRect(x: 0, y: 0, width: 720, height: 430)
        let window = NSWindow(contentRect: frame,
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.title = "Review Rate Monitor"
        window.titleVisibility = .visible
        window.titlebarAppearsTransparent = false
        window.backgroundColor = NSColor(calibratedWhite: 0.018, alpha: 1)
        window.minSize = NSSize(width: 380, height: 180)
        window.isMovableByWindowBackground = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        window.delegate = self
        let frameName = "ReviewRateMonitorWindowV2"
        window.setFrameAutosaveName(frameName)

        let view = MonitorView(frame: frame, boundary: boundary)
        view.autoresizingMask = [.width, .height]
        window.contentView = view
        if !window.setFrameUsingName(frameName) { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
        self.monitorView = view

        let sampler = RemoteCounterSampler(config: config)
        sampler.onReading = { [weak self] reading in
            guard let self else { return }
            self.monitorView?.update(self.store.add(reading))
        }
        sampler.onError = { [weak self] message in
            guard let self else { return }
            var state = self.monitorView?.state ?? DashboardState()
            state.online = false
            self.monitorView?.update(state)
            fputs("[review-rate-monitor] \(message)\n", stderr)
        }
        self.sampler = sampler
        sampler.start()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window?.makeKeyAndOrderFront(nil) }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) { sampler?.stop() }
}

private let config = AppConfig.parse(CommandLine.arguments)
private let application = NSApplication.shared
private let delegate = AppDelegate(config: config)
application.delegate = delegate
application.run()
