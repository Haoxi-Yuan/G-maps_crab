import AppKit
import Foundation

enum ResourceStation: String, CaseIterable {
    case chark = "UAL CHARK"
    case strix = "UAL STRIX"
    case atlas = "ATLAS · PBS"
}

struct ResourceTask {
    let station: ResourceStation
    let owner: String
    let identifier: String
    let name: String
    let cpuText: String
    let gpuText: String
    let memoryText: String
    let elapsedSeconds: Int
    let state: String
    let project: Bool
    let cpuValue: Double
    let completed: Int
    let total: Int
    let timeLimitSeconds: Int
}

struct TaskProgressSeed {
    let station: ResourceStation
    let owner: String
    let identifier: String
    let name: String
    let completed: Int
    let total: Int
    let elapsedSeconds: Int
    let state: String
}

struct WorkstationSnapshot {
    let station: ResourceStation
    let date: Date
    var online: Bool
    let cpuLoad: Double
    let cpuDetail: String
    let memoryLoad: Double
    let memoryDetail: String
    let thirdLoad: Double
    let thirdDetail: String
    let thirdLabel: String
    let deviceName: String
    let note: String
    let tasks: [ResourceTask]
}

private func resourceShellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

private final class ResourceDataBox { var value = Data() }

private final class ResourceSSHControlMaster {
    let host: String, path: String
    private var process: Process?
    private var stopped = false

    init(host: String, path: String) { self.host = host; self.path = path }
    func start() {
        guard process == nil else { return }
        stopped = false
        try? FileManager.default.removeItem(atPath: path)
        let task = Process()
        let appPID = ProcessInfo.processInfo.processIdentifier
        let command = """
        child=0
        cleanup() {
          if [ "$child" -gt 0 ] 2>/dev/null; then kill "$child" 2>/dev/null || true; wait "$child" 2>/dev/null || true; fi
          rm -f \(resourceShellQuote(path))
        }
        trap cleanup EXIT TERM INT
        /usr/bin/ssh -MN -o BatchMode=yes -o ConnectTimeout=5 \
          -o ServerAliveInterval=30 -o ServerAliveCountMax=2 -o ControlMaster=yes \
          -S \(resourceShellQuote(path)) \(resourceShellQuote(host)) &
        child=$!
        while kill -0 \(appPID) 2>/dev/null && kill -0 "$child" 2>/dev/null; do sleep 5; done
        """
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = ["-c", command]
        task.standardInput = FileHandle.nullDevice
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        task.terminationHandler = { [weak self] _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.process = nil
                if !self.stopped {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.start() }
                }
            }
        }
        process = task
        do { try task.run() } catch { process = nil }
    }
    func stop() {
        stopped = true
        process?.terminate(); process = nil
        try? FileManager.default.removeItem(atPath: path)
    }
}

private final class WorkstationResourceProbe {
    let station: ResourceStation
    private let host: String, root: String, controlPath: String, interval: TimeInterval
    private var timer: Timer?, process: Process?
    var onSnapshot: ((WorkstationSnapshot) -> Void)?
    var onError: ((ResourceStation, String) -> Void)?

    init(station: ResourceStation, host: String, root: String = "", controlPath: String, interval: TimeInterval) {
        self.station = station; self.host = host; self.root = root
        self.controlPath = controlPath; self.interval = interval
    }

    func start() {
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in self?.poll() }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    func stop() { timer?.invalidate(); process?.terminate(); timer = nil; process = nil }

    private func command() -> String {
        if station == .atlas {
            let script = "\(root)/scripts/hpc/atlas-resource-snapshot.sh"
            return "\(resourceShellQuote(script)) \(resourceShellQuote(root))"
        }
        let projectRoot = station == .strix ? "/data2/shared/haoxi/CLI_scraper" : "/data/haoxi"
        return """
        set +e
        b64text() { printf '%s' "$1" | base64 | tr -d '\\r\\n'; }
        arg_value() { local flag=$1 text=$2; printf '%s\\n' "$text" | sed -n "s/.*${flag}[= ]\\([^ ]*\\).*/\\1/p" | tail -n 1; }
        read -r _ u1 n1 s1 i1 w1 irq1 sirq1 st1 _ < /proc/stat
        total1=$((u1+n1+s1+i1+w1+irq1+sirq1+st1)); idle1=$((i1+w1))
        sleep 0.12
        read -r _ u2 n2 s2 i2 w2 irq2 sirq2 st2 _ < /proc/stat
        total2=$((u2+n2+s2+i2+w2+irq2+sirq2+st2)); idle2=$((i2+w2))
        cpu_pct=$(awk -v t=$((total2-total1)) -v i=$((idle2-idle1)) 'BEGIN{if(t>0)printf "%.2f",(t-i)/t*100;else print 0}')
        cores=$(getconf _NPROCESSORS_ONLN 2>/dev/null || printf 0)
        read -r mem_total mem_available < <(awk '/MemTotal:/{t=$2}/MemAvailable:/{a=$2}END{print t,a}' /proc/meminfo)
        mem_used=$((mem_total-mem_available))
        mem_pct=$(awk -v u="$mem_used" -v t="$mem_total" 'BEGIN{if(t>0)printf "%.2f",u/t*100;else print 0}')
        mem_detail=$(awk -v u="$mem_used" -v t="$mem_total" 'BEGIN{printf "%.1f / %.1f GB",u/1048576,t/1048576}')
        gpu_util=0; gpu_used=0; gpu_total=0; gpu_temp=0; gpu_name='NO GPU'
        if command -v nvidia-smi >/dev/null 2>&1; then
          gpu_line=$(nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name --format=csv,noheader,nounits 2>/dev/null | head -n 1)
          IFS=',' read -r gpu_util gpu_used gpu_total gpu_temp gpu_name <<< "$gpu_line"
          gpu_util=$(printf '%s' "$gpu_util" | xargs); gpu_used=$(printf '%s' "$gpu_used" | xargs)
          gpu_total=$(printf '%s' "$gpu_total" | xargs); gpu_temp=$(printf '%s' "$gpu_temp" | xargs)
          gpu_name=$(printf '%s' "$gpu_name" | xargs)
        fi
        case "$gpu_util" in ''|*[!0-9.]*) gpu_util=0 ;; esac
        case "$gpu_used" in ''|*[!0-9.]*) gpu_used=0 ;; esac
        case "$gpu_total" in ''|*[!0-9.]*) gpu_total=0 ;; esac
        gpu_detail=$(awk -v u="$gpu_used" -v t="$gpu_total" 'BEGIN{printf "%.1f / %.1f GB",u/1024,t/1024}')
        cpu_detail="${cpu_pct}% · ${cores} cores"
        note="GPU ${gpu_temp}°C · process sample top 24"
        printf 'S\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \\
          "$cpu_pct" "$(b64text "$cpu_detail")" "$mem_pct" "$(b64text "$mem_detail")" \\
          "$gpu_util" "$(b64text "$gpu_detail")" "$(b64text GPU)" "$(b64text "$gpu_name")" \\
          "$(b64text "$note")" "$(date +%s)"

        declare -A gpu_memory
        if command -v nvidia-smi >/dev/null 2>&1; then
          while IFS=',' read -r gpupid gpumem; do
            gpupid=$(printf '%s' "$gpupid" | xargs); gpumem=$(printf '%s' "$gpumem" | xargs)
            case "$gpupid" in ''|*[!0-9]*) continue ;; esac
            gpu_memory[$gpupid]=${gpumem:-0}
          done < <(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null)
        fi
        ps -eo user=,pid=,etimes=,pcpu=,pmem=,rss=,comm=,args= --sort=-pcpu 2>/dev/null | head -n 24 | \
        while read -r owner pid elapsed pcpu pmem rss comm args; do
          [ -n "$pid" ] || continue
          case "$pid" in ''|*[!0-9]*) continue ;; esac
          case "$args" in *'b64text()'*|*'ps -eo user='*|*'nvidia-smi --query-gpu='*|*scraper-monitor*) continue ;; esac
          cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
          project=0
          case "$cwd $args" in *\(projectRoot)*|*CLI_scraper*|*gmaps-crab*|*review-scraper*|*poi-search*|*multi-boundary*|*.playwright-browsers*) project=1 ;; esac
          task_name=$comm
          case "$args" in
            *review-scraper*) task_name='review scraper' ;;
            *poi-searcher*|*poi-search*) task_name='POI search' ;;
            *chrome-headless*|*chromium*) task_name='Chromium worker' ;;
            *sqlite*|*database*) task_name='database builder' ;;
            *image*download*) task_name='image downloader' ;;
          esac
          completed=0; total=0; live=''
          live=$(arg_value --live-status "$args"); [ -n "$live" ] || live=$(arg_value --status "$args")
          if [ -z "$live" ]; then
            case "$args" in
              *review-scraper*) output_arg=$(arg_value --output "$args"); [ -n "$output_arg" ] && live="${output_arg%/*}/reviews.live.json" ;;
              *poi-searcher*) checkpoint_arg=$(arg_value --output "$args"); [ -n "$checkpoint_arg" ] && live="${checkpoint_arg%.json}.live.json" ;;
            esac
          fi
          case "$live" in '') ;; /*) ;; *) live="${cwd:-\(projectRoot)}/$live" ;; esac
          if [ -r "$live" ] && command -v jq >/dev/null 2>&1; then
            completed=$(jq -r '.completed // .index // .categoryIndex // 0' "$live" 2>/dev/null)
            total=$(jq -r '.total // .categoryTotal // 0' "$live" 2>/dev/null)
          fi
          case "$completed" in ''|*[!0-9]*) completed=0 ;; esac
          case "$total" in ''|*[!0-9]*) total=0 ;; esac
          gpu_mb=${gpu_memory[$pid]:-0}
          gpu_text='—'; [ "$gpu_mb" = 0 ] || gpu_text="${gpu_mb} MB"
          ram_text=$(awk -v r="$rss" 'BEGIN{if(r>=1048576)printf "%.1f GB",r/1048576;else printf "%.0f MB",r/1024}')
          cpu_text=$(awk -v c="$pcpu" 'BEGIN{printf "%.1f%%",c}')
          printf 'P\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \\
            "$(b64text "$owner")" "$pid" "$(b64text "$task_name")" "$(b64text "$cpu_text")" \\
            "$(b64text "$gpu_text")" "$(b64text "$ram_text")" "$elapsed" RUNNING "$project" "$pcpu" "$completed" "$total" 0
        done
        """
    }

    private func poll() {
        guard process == nil, FileManager.default.fileExists(atPath: controlPath) else { return }
        let task = Process(), out = Pipe(), err = Pipe(), output = ResourceDataBox(), errors = ResourceDataBox()
        let reads = DispatchGroup()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        task.arguments = ["-S", controlPath, "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
                          "-o", "ControlMaster=no", host, "bash -lc \(resourceShellQuote(command()))"]
        task.standardOutput = out; task.standardError = err; process = task
        reads.enter(); DispatchQueue.global(qos: .utility).async {
            output.value = out.fileHandleForReading.readDataToEndOfFile(); reads.leave()
        }
        reads.enter(); DispatchQueue.global(qos: .utility).async {
            errors.value = err.fileHandleForReading.readDataToEndOfFile(); reads.leave()
        }
        task.terminationHandler = { [weak self] finished in
            reads.notify(queue: .main) {
                guard let self else { return }; self.process = nil
                guard finished.terminationStatus == 0, let snapshot = self.parse(output.value) else {
                    let message = String(data: errors.value, encoding: .utf8) ?? "resource probe failed"
                    self.onError?(self.station, message); return
                }
                self.onSnapshot?(snapshot)
            }
        }
        do { try task.run() } catch {
            out.fileHandleForWriting.closeFile(); err.fileHandleForWriting.closeFile(); process = nil
            onError?(station, error.localizedDescription)
        }
    }

    private func parse(_ data: Data) -> WorkstationSnapshot? {
        let text = String(data: data, encoding: .utf8) ?? ""
        var header: [String]?, tasks: [ResourceTask] = []
        func decoded(_ value: String) -> String {
            guard let data = Data(base64Encoded: value), let string = String(data: data, encoding: .utf8) else { return value }
            return string
        }
        for raw in text.split(separator: "\n") {
            let f = raw.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard let type = f.first else { continue }
            if type == "S", f.count >= 11 { header = f }
            if type == "P", f.count >= 11 {
                tasks.append(ResourceTask(station: station, owner: decoded(f[1]), identifier: f[2], name: decoded(f[3]),
                    cpuText: decoded(f[4]), gpuText: decoded(f[5]), memoryText: decoded(f[6]),
                    elapsedSeconds: Int(f[7]) ?? 0, state: f[8], project: f[9] == "1", cpuValue: Double(f[10]) ?? 0,
                    completed: f.count > 11 ? Int(f[11]) ?? 0 : 0,
                    total: f.count > 12 ? Int(f[12]) ?? 0 : 0,
                    timeLimitSeconds: f.count > 13 ? Int(f[13]) ?? 0 : 0))
            }
        }
        guard let f = header else { return nil }
        let stamp = TimeInterval(f[10]).map { Date(timeIntervalSince1970: $0) } ?? Date()
        return WorkstationSnapshot(station: station, date: stamp, online: true,
            cpuLoad: Double(f[1]) ?? 0, cpuDetail: decoded(f[2]),
            memoryLoad: Double(f[3]) ?? 0, memoryDetail: decoded(f[4]),
            thirdLoad: Double(f[5]) ?? 0, thirdDetail: decoded(f[6]), thirdLabel: decoded(f[7]),
            deviceName: station == .atlas ? "PBS SCHEDULER" : decoded(f[8]), note: decoded(f[9]), tasks: tasks)
    }
}

final class ResourceCoordinator {
    private var masters: [ResourceSSHControlMaster] = [], probes: [WorkstationResourceProbe] = []
    private var snapshots: [ResourceStation: WorkstationSnapshot] = [:], lastSuccess: [ResourceStation: Date] = [:]
    var onUpdate: (([WorkstationSnapshot]) -> Void)?

    init(charkHost: String, strixHost: String, atlasHost: String, atlasRoot: String,
         interval: TimeInterval, atlasInterval: TimeInterval) {
        let pid = ProcessInfo.processInfo.processIdentifier
        let entries: [(ResourceStation, String, String, TimeInterval, String, Bool)] = [
            // DiscoveryCoordinator owns all three remote transports. Reusing its
            // sockets avoids duplicate SSH masters fighting over one control
            // path and another set of VPN keepalive streams.
            (.chark, charkHost, "", max(2, interval), "/tmp/scraper-monitor-\(pid)-chark.sock", false),
            (.strix, strixHost, "", max(2, interval), "/tmp/scraper-monitor-\(pid)-strix.sock", false),
            (.atlas, atlasHost, atlasRoot, max(8, atlasInterval), "/tmp/scraper-monitor-\(pid)-atlas.sock", false)
        ]
        for (station, host, root, cadence, path, ownsMaster) in entries {
            if ownsMaster { masters.append(ResourceSSHControlMaster(host: host, path: path)) }
            let probe = WorkstationResourceProbe(station: station, host: host, root: root, controlPath: path, interval: cadence)
            probe.onSnapshot = { [weak self] value in
                self?.snapshots[value.station] = value; self?.lastSuccess[value.station] = Date(); self?.publish()
            }
            probe.onError = { [weak self] station, message in
                let detail = message.trimmingCharacters(in: .whitespacesAndNewlines)
                NSLog("Scraper Monitor %@ resource probe failed: %@", station.rawValue, detail.isEmpty ? "unknown" : detail)
                self?.publish()
            }
            probes.append(probe)
        }
    }
    func start() { masters.forEach { $0.start() }; probes.forEach { $0.start() } }
    func stop() { probes.forEach { $0.stop() }; masters.forEach { $0.stop() } }
    private func publish() {
        let now = Date()
        let values = ResourceStation.allCases.compactMap { station -> WorkstationSnapshot? in
            guard var value = snapshots[station] else { return nil }
            let freshness: TimeInterval = station == .atlas ? 150 : 12
            value.online = lastSuccess[station].map { now.timeIntervalSince($0) < freshness } ?? false
            return value
        }
        onUpdate?(values)
    }
}

private enum ResourceWorkload: String, CaseIterable { case cpu = "CPU"; case gpu = "GPU"; case scrape = "SCRAPE" }
private struct TaskProgressPoint { let date: Date, completed: Int }
private struct TaskETARow {
    let station: ResourceStation, owner: String, identifier: String, name: String, state: String
    let completed: Int, total: Int, elapsedSeconds: Int, timeLimitSeconds: Int
}

final class ResourceDashboard: NSView {
    private var snapshots: [WorkstationSnapshot] = []
    private var progressSeeds: [TaskProgressSeed] = [], progress: [String: [TaskProgressPoint]] = [:]
    private var workload: ResourceWorkload = .scrape, allProcesses = false, revealOwners = false
    private var workloadRects: [ResourceWorkload: NSRect] = [:], toggleRect = NSRect.zero, eyeRect = NSRect.zero

    override var isOpaque: Bool { true }
    func update(_ values: [WorkstationSnapshot]) {
        snapshots = values
        for value in values {
            for task in value.tasks where task.total > 0 {
                addProgress(key: taskKey(task.station, task.identifier), date: value.date, completed: task.completed)
            }
        }
        needsDisplay = true
    }
    func updateProgress(_ values: [TaskProgressSeed]) {
        progressSeeds = values
        let now = Date()
        for value in values { addProgress(key: taskKey(value.station, value.identifier), date: now, completed: value.completed) }
        needsDisplay = true
    }
    private func taskKey(_ station: ResourceStation, _ identifier: String) -> String { "\(station.rawValue):\(identifier)" }
    private func addProgress(key: String, date: Date, completed: Int) {
        var values = progress[key] ?? []
        if values.last.map({ $0.completed != completed || date.timeIntervalSince($0.date) >= 10 }) ?? true {
            values.append(TaskProgressPoint(date: date, completed: completed))
        }
        let cutoff = date.addingTimeInterval(-1200)
        values.removeAll { $0.date < cutoff }; progress[key] = values
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if toggleRect.contains(point) { allProcesses.toggle(); needsDisplay = true; return }
        if eyeRect.contains(point) { revealOwners.toggle(); needsDisplay = true; return }
        for (kind, rect) in workloadRects where rect.contains(point) { workload = kind; needsDisplay = true; return }
    }

    private func snapshot(_ station: ResourceStation) -> WorkstationSnapshot? { snapshots.first { $0.station == station } }
    private func loadColor(_ value: Double) -> NSColor {
        if value < 50 { return NSColor(calibratedRed: 0.28, green: 0.88, blue: 0.22, alpha: 1) }
        if value < 75 { return NSColor(calibratedRed: 1.0, green: 0.52, blue: 0.06, alpha: 1) }
        return NSColor(calibratedRed: 1.0, green: 0.12, blue: 0.13, alpha: 1)
    }
    private func recommendation() -> (ResourceStation?, String) {
        let online = snapshots.filter(\.online)
        guard !online.isEmpty else { return (nil, "Waiting for resource telemetry") }
        switch workload {
        case .gpu:
            let gpuHosts = online.filter { $0.station != .atlas }
            guard let best = gpuHosts.min(by: { max($0.thirdLoad, $0.memoryLoad) < max($1.thirdLoad, $1.memoryLoad) }) else {
                return (nil, "No GPU workstation online")
            }
            return (best.station, String(format: "GPU %.0f%% · memory %.0f%%", best.thirdLoad, best.memoryLoad))
        case .cpu:
            if let atlas = online.first(where: { $0.station == .atlas }), atlas.cpuLoad < 75, atlas.thirdLoad < 100 {
                return (.atlas, "PBS capacity available · queue-aware")
            }
            let best = online.min { max($0.cpuLoad, $0.memoryLoad) < max($1.cpuLoad, $1.memoryLoad) }!
            return (best.station, String(format: "CPU %.0f%% · memory %.0f%%", best.cpuLoad, best.memoryLoad))
        case .scrape:
            if let strix = online.first(where: { $0.station == .strix }), max(strix.cpuLoad, strix.memoryLoad) < 85 {
                return (.strix, String(format: "Singapore egress · CPU %.0f%% · memory %.0f%%", strix.cpuLoad, strix.memoryLoad))
            }
            if let atlas = online.first(where: { $0.station == .atlas }), atlas.thirdLoad < 100 {
                return (.atlas, "PBS job slot available · shardable workload")
            }
            let best = online.min { max($0.cpuLoad, $0.memoryLoad) < max($1.cpuLoad, $1.memoryLoad) }!
            return (best.station, "Lowest current CPU / memory pressure")
        }
    }

    private func text(_ value: String, _ rect: NSRect, _ size: CGFloat, _ color: NSColor = .white,
                      _ alignment: NSTextAlignment = .left, bold: Bool = false) {
        let style = NSMutableParagraphStyle(); style.alignment = alignment; style.lineBreakMode = .byTruncatingTail
        let font = bold ? NSFont.monospacedSystemFont(ofSize: size, weight: .semibold) : NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
        (value as NSString).draw(in: rect, withAttributes: [.font: font, .foregroundColor: color, .paragraphStyle: style])
    }
    private func displayOwner(_ owner: String) -> String {
        if owner.lowercased().hasPrefix("haoxi") { return "haoxi" }
        return revealOwners ? owner : "***"
    }
    private func drawEye(_ rect: NSRect) {
        let oval = NSBezierPath(ovalIn: rect.insetBy(dx: 2, dy: 6))
        NSColor(calibratedWhite: 0.72, alpha: 1).setStroke(); oval.lineWidth = 1; oval.stroke()
        NSColor(calibratedWhite: 0.72, alpha: 1).setFill()
        NSBezierPath(ovalIn: NSRect(x: rect.midX - 2.5, y: rect.midY - 2.5, width: 5, height: 5)).fill()
        if !revealOwners {
            let slash = NSBezierPath(); slash.move(to: NSPoint(x: rect.minX + 2, y: rect.minY + 3)); slash.line(to: NSPoint(x: rect.maxX - 2, y: rect.maxY - 3));
            NSColor(calibratedRed: 1, green: 0.28, blue: 0.22, alpha: 1).setStroke(); slash.lineWidth = 1.4; slash.stroke()
        }
    }
    private func card(_ rect: NSRect, selected: Bool = false) {
        let path = NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9)
        NSColor(calibratedWhite: selected ? 0.075 : 0.055, alpha: 0.98).setFill(); path.fill()
        (selected ? NSColor(calibratedRed: 0.3, green: 0.75, blue: 0.3, alpha: 0.8) : NSColor(calibratedWhite: 0.22, alpha: 1)).setStroke()
        path.lineWidth = selected ? 1.3 : 0.8; path.stroke()
    }
    private func cup(_ rect: NSRect, value: Double, title: String, detail: String) {
        let color = loadColor(value), verticalInset = min(24, max(8, rect.height * 0.23))
        let glass = NSRect(x: rect.minX + 7, y: rect.minY + verticalInset, width: max(8, rect.width - 14), height: max(7, rect.height - verticalInset * 2))
        let labelSize: CGFloat = rect.height < 70 ? 7.2 : 9.2
        text(title, NSRect(x: rect.minX, y: rect.maxY - verticalInset + 3, width: rect.width, height: max(10, verticalInset - 4)), labelSize, NSColor(calibratedWhite: 0.78, alpha: 1), .center)
        let outer = NSBezierPath(roundedRect: glass, xRadius: glass.width * 0.24, yRadius: 8)
        NSGraphicsContext.saveGraphicsState(); outer.addClip()
        let level = max(0, min(100, value)), liquidHeight = glass.height * CGFloat(level / 100)
        if liquidHeight > 0.5 {
            let liquid = NSRect(x: glass.minX + 2, y: glass.minY + 2, width: glass.width - 4,
                                height: max(2, liquidHeight - 2))
            NSGradient(starting: color.withAlphaComponent(0.9), ending: color.withAlphaComponent(0.48))?.draw(in: liquid, angle: 90)
            color.withAlphaComponent(0.92).setFill()
            NSBezierPath(ovalIn: NSRect(x: liquid.minX, y: liquid.maxY - 4, width: liquid.width, height: 8)).fill()
        }
        NSGraphicsContext.restoreGraphicsState()
        NSColor(calibratedWhite: 0.82, alpha: 0.72).setStroke(); outer.lineWidth = 1.2; outer.stroke()
        NSColor(calibratedWhite: 1, alpha: 0.20).setStroke()
        let highlight = NSBezierPath(); highlight.move(to: NSPoint(x: glass.minX + 5, y: glass.minY + 10)); highlight.line(to: NSPoint(x: glass.minX + 5, y: glass.maxY - 10)); highlight.lineWidth = 1.5; highlight.stroke()
        for tick in 1...(glass.height < 24 ? 1 : 3) {
            let y = glass.minY + glass.height * CGFloat(tick) / 4
            let path = NSBezierPath(); path.move(to: NSPoint(x: glass.minX + 2, y: y)); path.line(to: NSPoint(x: glass.minX + 7, y: y)); path.lineWidth = 0.7; path.stroke()
        }
        text(detail, NSRect(x: rect.minX - 4, y: rect.minY + 1, width: rect.width + 8, height: max(10, verticalInset - 3)), rect.height < 70 ? 7.5 : 9.6, .white, .center, bold: true)
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.018, alpha: 1).setFill(); bounds.fill()
        if bounds.width < 760 || bounds.height < 520 { drawCompact() } else { drawEnhanced() }
    }

    private func drawEnhanced() {
        let margin: CGFloat = 14, gap: CGFloat = 10
        let recommendationY = bounds.maxY - 72, recommendationRect = NSRect(x: margin, y: recommendationY, width: bounds.width - margin * 2, height: 60)
        card(recommendationRect)
        let recommendation = recommendation()
        text("BEST FIT", NSRect(x: margin + 18, y: recommendationY + 33, width: 76, height: 17), 10, NSColor(calibratedWhite: 0.7, alpha: 1))
        text(recommendation.0?.rawValue ?? "—", NSRect(x: margin + 92, y: recommendationY + 30, width: 175, height: 21), 13,
             recommendation.0 == nil ? NSColor(calibratedWhite: 0.5, alpha: 1) : loadColor(20), .left, bold: true)
        text(recommendation.1, NSRect(x: margin + 18, y: recommendationY + 11, width: 360, height: 17), 10.5, NSColor(calibratedWhite: 0.76, alpha: 1))
        workloadRects.removeAll()
        let chipWidth: CGFloat = 64, chipY = recommendationY + 17
        for (index, kind) in ResourceWorkload.allCases.enumerated() {
            let rect = NSRect(x: bounds.maxX - margin - 218 + CGFloat(index) * (chipWidth + 5), y: chipY, width: chipWidth, height: 27)
            workloadRects[kind] = rect
            let path = NSBezierPath(roundedRect: rect, xRadius: 5, yRadius: 5)
            (kind == workload ? NSColor(calibratedRed: 0.72, green: 0.08, blue: 0.08, alpha: 1) : NSColor(calibratedWhite: 0.10, alpha: 1)).setFill(); path.fill()
            NSColor(calibratedWhite: 0.25, alpha: 1).setStroke(); path.stroke()
            text(kind.rawValue, NSRect(x: rect.minX, y: rect.minY + 6, width: rect.width, height: 16), 9.5, .white, .center)
        }
        let legendX = max(margin + 390, bounds.maxX - 520)
        text("● LOW <50", NSRect(x: legendX, y: recommendationY + 39, width: 90, height: 15), 8.5, loadColor(20))
        text("● MED 50–74", NSRect(x: legendX + 92, y: recommendationY + 39, width: 108, height: 15), 8.5, loadColor(60))
        text("● HIGH ≥75", NSRect(x: legendX + 202, y: recommendationY + 39, width: 100, height: 15), 8.5, loadColor(90))

        let cardsTop = recommendationY - gap, cardsHeight: CGFloat = min(205, max(174, bounds.height * 0.31))
        let cardsY = cardsTop - cardsHeight, cardWidth = (bounds.width - margin * 2 - gap * 2) / 3
        let recommendedStation = recommendation.0
        for (index, station) in ResourceStation.allCases.enumerated() {
            let rect = NSRect(x: margin + CGFloat(index) * (cardWidth + gap), y: cardsY, width: cardWidth, height: cardsHeight)
            drawServerCard(snapshot(station), station: station, rect: rect, recommended: station == recommendedStation)
        }

        let etaHeight: CGFloat = max(92, min(128, bounds.height * 0.19)), etaY: CGFloat = 10
        let tableY = etaY + etaHeight + 8, tableHeight = max(112, cardsY - tableY - 10)
        drawTaskTable(NSRect(x: margin, y: tableY, width: bounds.width - margin * 2, height: tableHeight))
        drawETA(NSRect(x: margin, y: etaY, width: bounds.width - margin * 2, height: etaHeight))
    }

    private func drawServerCard(_ value: WorkstationSnapshot?, station: ResourceStation, rect: NSRect, recommended: Bool) {
        card(rect, selected: recommended && value?.online == true)
        let statusColor = value?.online == true ? loadColor(20) : NSColor(calibratedWhite: 0.45, alpha: 1)
        text("●", NSRect(x: rect.minX + 14, y: rect.maxY - 30, width: 14, height: 18), 12, statusColor)
        text(station.rawValue, NSRect(x: rect.minX + 30, y: rect.maxY - 31, width: rect.width - 44, height: 20), 12, .white, .left, bold: true)
        if recommended { text("RECOMMENDED", NSRect(x: rect.maxX - 108, y: rect.maxY - 29, width: 94, height: 16), 8.2, loadColor(20), .right) }
        guard let value, value.online else {
            text("OFFLINE", NSRect(x: rect.minX, y: rect.midY - 8, width: rect.width, height: 22), 12, NSColor(calibratedWhite: 0.48, alpha: 1), .center)
            return
        }
        let cupHeight = rect.height - 68, cupWidth = (rect.width - 28) / 3
        let cpuDetail = String(format: "%.0f%%", value.cpuLoad)
        let memDetail = String(format: "%.0f%%", value.memoryLoad)
        let thirdDetail = station == .atlas ? value.thirdDetail.replacingOccurrences(of: " running", with: "") : String(format: "%.0f%%", value.thirdLoad)
        cup(NSRect(x: rect.minX + 9, y: rect.minY + 19, width: cupWidth, height: cupHeight), value: value.cpuLoad,
            title: station == .atlas ? "CPU SLOTS" : "CPU", detail: cpuDetail)
        cup(NSRect(x: rect.minX + 9 + cupWidth, y: rect.minY + 19, width: cupWidth, height: cupHeight), value: value.memoryLoad,
            title: station == .atlas ? "MEM ALLOC" : "MEMORY", detail: memDetail)
        cup(NSRect(x: rect.minX + 9 + cupWidth * 2, y: rect.minY + 19, width: cupWidth, height: cupHeight), value: value.thirdLoad,
            title: station == .atlas ? "JOB SLOTS" : value.thirdLabel, detail: thirdDetail)
        text(station == .atlas ? value.note : "\(value.deviceName) · VRAM \(value.thirdDetail)",
             NSRect(x: rect.minX + 12, y: rect.minY + 5, width: rect.width - 24, height: 14), 7.8, NSColor(calibratedWhite: 0.60, alpha: 1), .center)
    }

    private func tasks() -> [ResourceTask] {
        let eligible = snapshots.flatMap(\.tasks).filter { allProcesses || $0.project }
        let groups = Dictionary(grouping: eligible, by: \.station).mapValues { $0.sorted { $0.cpuValue > $1.cpuValue } }
        var result: [ResourceTask] = [], index = 0
        while ResourceStation.allCases.contains(where: { index < (groups[$0]?.count ?? 0) }) {
            for station in ResourceStation.allCases {
                if let values = groups[station], index < values.count { result.append(values[index]) }
            }
            index += 1
        }
        return result
    }
    private func duration(_ seconds: Int) -> String {
        if seconds >= 86400 { return String(format: "%dd %02d:%02d", seconds / 86400, seconds / 3600 % 24, seconds / 60 % 60) }
        return String(format: "%02d:%02d:%02d", seconds / 3600, seconds / 60 % 60, seconds % 60)
    }
    private func drawTaskTable(_ rect: NSRect) {
        card(rect); let header: CGFloat = 31, rowHeight: CGFloat = 23
        text("TASK OWNERSHIP", NSRect(x: rect.minX + 12, y: rect.maxY - 23, width: 180, height: 17), 10, .white, .left, bold: true)
        eyeRect = NSRect(x: rect.maxX - 218, y: rect.maxY - 28, width: 25, height: 23); drawEye(eyeRect)
        toggleRect = NSRect(x: rect.maxX - 185, y: rect.maxY - 27, width: 171, height: 21)
        let togglePath = NSBezierPath(roundedRect: toggleRect, xRadius: 4, yRadius: 4); NSColor(calibratedWhite: 0.09, alpha: 1).setFill(); togglePath.fill()
        text(allProcesses ? "ALL PROCESSES" : "PROJECT TASKS", toggleRect.insetBy(dx: 6, dy: 3), 8.5, allProcesses ? NSColor(calibratedWhite: 0.75, alpha: 1) : NSColor(calibratedRed: 1, green: 0.25, blue: 0.22, alpha: 1), .center)
        NSColor(calibratedWhite: 0.20, alpha: 1).setStroke(); let divider = NSBezierPath(); divider.move(to: NSPoint(x: rect.minX, y: rect.maxY - header)); divider.line(to: NSPoint(x: rect.maxX, y: rect.maxY - header)); divider.stroke()
        let widths: [CGFloat] = [0.10,0.08,0.18,0.12,0.09,0.09,0.10,0.11,0.13]
        let names = ["STATION","OWNER","TASK","PID / JOB","CPU","GPU","RAM","ELAPSED","STATE"]
        var x = rect.minX + 10
        for i in names.indices { let w = (rect.width - 20) * widths[i]; text(names[i], NSRect(x: x, y: rect.maxY - header - 19, width: w - 4, height: 15), 7.8, NSColor(calibratedWhite: 0.58, alpha: 1)); x += w }
        let availableRows = max(1, Int((rect.height - header - 22) / rowHeight)), values = Array(tasks().prefix(availableRows))
        if values.isEmpty {
            text(allProcesses ? "No process telemetry" : "No project process in the top resource sample · click to show all processes",
                 NSRect(x: rect.minX + 12, y: rect.minY + 15, width: rect.width - 24, height: 18), 9, NSColor(calibratedWhite: 0.48, alpha: 1), .center)
            return
        }
        for (row, task) in values.enumerated() {
            let y = rect.maxY - header - 22 - CGFloat(row + 1) * rowHeight + 4
            if row % 2 == 1 { NSColor(calibratedWhite: 0.075, alpha: 0.55).setFill(); NSRect(x: rect.minX + 1, y: y - 3, width: rect.width - 2, height: rowHeight).fill() }
            let stateColor = task.state == "RUNNING" ? loadColor(20) : (task.state == "QUEUED" || task.state == "HOLD" ? loadColor(60) : NSColor(calibratedWhite: 0.7, alpha: 1))
            let fields = [task.station == .atlas ? "ATLAS" : task.station.rawValue.replacingOccurrences(of: "UAL ", with: ""), displayOwner(task.owner), task.name, task.identifier, task.cpuText, task.gpuText, task.memoryText, duration(task.elapsedSeconds), task.state]
            x = rect.minX + 10
            for i in fields.indices {
                let w = (rect.width - 20) * widths[i]
                let color: NSColor = i == 8 ? stateColor : (i == 4 && task.cpuValue >= 75 ? loadColor(90) : NSColor(calibratedWhite: 0.84, alpha: 1))
                text(fields[i], NSRect(x: x, y: y, width: w - 5, height: 16), 8.5, color); x += w
            }
        }
    }

    private func etaRows() -> [TaskETARow] {
        let resourceTasks = snapshots.flatMap(\.tasks)
        let byKey = Dictionary(uniqueKeysWithValues: resourceTasks.map { (taskKey($0.station, $0.identifier), $0) })
        var rows: [TaskETARow] = [], used = Set<String>()
        for seed in progressSeeds {
            let key = taskKey(seed.station, seed.identifier), task = byKey[key]
            rows.append(TaskETARow(station: seed.station, owner: seed.owner, identifier: seed.identifier,
                name: seed.name, state: seed.state, completed: seed.completed, total: seed.total,
                elapsedSeconds: max(seed.elapsedSeconds, task?.elapsedSeconds ?? 0), timeLimitSeconds: task?.timeLimitSeconds ?? 0))
            used.insert(key)
        }
        let logicalOwners = Set(resourceTasks.filter { $0.name != "Chromium worker" }.map { "\($0.station.rawValue):\($0.owner)" })
        let candidates = resourceTasks.filter {
            !used.contains(taskKey($0.station, $0.identifier)) &&
            ($0.state == "RUNNING" || $0.state == "LIVE" || $0.state == "QUEUED" || $0.state == "HOLD") &&
            $0.owner != "root" &&
            !($0.name == "Chromium worker" && logicalOwners.contains("\($0.station.rawValue):\($0.owner)"))
        }
        let grouped = Dictionary(grouping: candidates) { "\($0.station.rawValue):\($0.owner):\($0.name)" }
        for values in grouped.values {
            guard let task = values.max(by: { $0.cpuValue < $1.cpuValue }) else { continue }
            rows.append(TaskETARow(station: task.station, owner: task.owner, identifier: task.identifier,
                name: task.name, state: task.state, completed: task.completed, total: task.total,
                elapsedSeconds: task.elapsedSeconds, timeLimitSeconds: task.timeLimitSeconds))
        }
        let sorted = rows.sorted {
            if ($0.total > 0) != ($1.total > 0) { return $0.total > 0 }
            let aOther = !$0.owner.lowercased().hasPrefix("haoxi"), bOther = !$1.owner.lowercased().hasPrefix("haoxi")
            if aOther != bOther { return aOther }
            return $0.name < $1.name
        }
        let stationGroups = Dictionary(grouping: sorted, by: \.station)
        var interleaved: [TaskETARow] = [], index = 0
        while ResourceStation.allCases.contains(where: { index < (stationGroups[$0]?.count ?? 0) }) {
            for station in ResourceStation.allCases {
                if let values = stationGroups[station], index < values.count { interleaved.append(values[index]) }
            }
            index += 1
        }
        return interleaved
    }
    private func remainingText(_ seconds: TimeInterval) -> String {
        let value = max(0, Int(seconds))
        if value >= 86400 { return "\(value / 86400)d \(value / 3600 % 24)h" }
        if value >= 3600 { return "\(value / 3600)h \(value / 60 % 60)m" }
        return "\(max(1, value / 60))m"
    }
    private func finishText(after seconds: TimeInterval, prefix: String = "~") -> String {
        let finish = Date().addingTimeInterval(seconds), formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = seconds < 86400 ? "HH:mm" : "MMM d HH:mm"
        return "\(prefix) \(formatter.string(from: finish)) · \(remainingText(seconds))"
    }
    private func estimate(_ row: TaskETARow) -> (progress: String, finish: String, color: NSColor) {
        if row.state == "QUEUED" || row.state == "HOLD" { return ("—", "WAITING FOR SLOT", loadColor(60)) }
        if row.total > 0 {
            let completed = max(0, min(row.total, row.completed)), ratio = Double(completed) / Double(row.total)
            let progressText = "\(completed) / \(row.total) · \(Int(ratio * 100))%"
            if completed >= row.total { return (progressText, "FINISHING", loadColor(20)) }
            let values = progress[taskKey(row.station, row.identifier)] ?? []
            var rate: Double = 0, prefix = "~"
            if let end = values.last, let start = values.first(where: { end.date.timeIntervalSince($0.date) >= 15 }), end.completed > start.completed {
                rate = Double(end.completed - start.completed) / end.date.timeIntervalSince(start.date)
            } else if completed > 0 && row.elapsedSeconds >= 60 {
                rate = Double(completed) / Double(row.elapsedSeconds); prefix = "≈"
            }
            if rate > 0 {
                let remaining = Double(row.total - completed) / rate
                if remaining <= 365 * 86400 { return (progressText, finishText(after: remaining, prefix: prefix), loadColor(20)) }
            }
            return (progressText, "CALCULATING RATE", loadColor(60))
        }
        if row.timeLimitSeconds > row.elapsedSeconds {
            return ("—", finishText(after: Double(row.timeLimitSeconds - row.elapsedSeconds), prefix: "≤") + " WALLTIME", loadColor(60))
        }
        return ("—", "NO PROGRESS TELEMETRY", NSColor(calibratedWhite: 0.48, alpha: 1))
    }
    private func drawETA(_ rect: NSRect) {
        card(rect); let header: CGFloat = 29, rowHeight: CGFloat = 22
        text("RUNNING TASK ETA", NSRect(x: rect.minX + 12, y: rect.maxY - 22, width: 180, height: 16), 9.5, .white, .left, bold: true)
        text("LIVE RATE WHEN AVAILABLE · WALLTIME IS ONLY AN UPPER BOUND", NSRect(x: rect.minX + 190, y: rect.maxY - 21, width: rect.width - 204, height: 15), 7.6, NSColor(calibratedWhite: 0.52, alpha: 1), .right)
        let widths: [CGFloat] = [0.11, 0.10, 0.29, 0.15, 0.35], names = ["STATION", "OWNER", "TASK", "PROGRESS", "ESTIMATED FINISH"]
        var x = rect.minX + 10
        for i in names.indices { let w = (rect.width - 20) * widths[i]; text(names[i], NSRect(x: x, y: rect.maxY - header - 16, width: w - 4, height: 14), 7.5, NSColor(calibratedWhite: 0.56, alpha: 1)); x += w }
        let available = max(1, Int((rect.height - header - 18) / rowHeight)), rows = Array(etaRows().prefix(available))
        if rows.isEmpty { text("No running task telemetry", NSRect(x: rect.minX, y: rect.midY - 8, width: rect.width, height: 16), 9, NSColor(calibratedWhite: 0.45, alpha: 1), .center); return }
        for (index, row) in rows.enumerated() {
            let y = rect.maxY - header - 19 - CGFloat(index + 1) * rowHeight + 4
            if index % 2 == 1 { NSColor(calibratedWhite: 0.075, alpha: 0.55).setFill(); NSRect(x: rect.minX + 1, y: y - 3, width: rect.width - 2, height: rowHeight).fill() }
            let estimate = estimate(row), station = row.station == .atlas ? "ATLAS" : row.station.rawValue.replacingOccurrences(of: "UAL ", with: "")
            let fields = [station, displayOwner(row.owner), row.name, estimate.progress, estimate.finish]
            x = rect.minX + 10
            for i in fields.indices { let w = (rect.width - 20) * widths[i]; text(fields[i], NSRect(x: x, y: y, width: w - 5, height: 15), 8.2, i == 4 ? estimate.color : NSColor(calibratedWhite: 0.83, alpha: 1)); x += w }
        }
    }

    private func drawCompact() {
        let recommendation = recommendation(), margin: CGFloat = 10
        text("BEST FIT  \(recommendation.0?.rawValue ?? "—")", NSRect(x: margin, y: bounds.maxY - 32, width: bounds.width - 20, height: 21), 12, loadColor(20), .left, bold: true)
        text(recommendation.1, NSRect(x: margin, y: bounds.maxY - 52, width: bounds.width - 20, height: 17), 8.5, NSColor(calibratedWhite: 0.66, alpha: 1))
        let rowHeight = max(46, (bounds.height - 58) / 3)
        for (index, station) in ResourceStation.allCases.enumerated() {
            let y = bounds.maxY - 62 - CGFloat(index + 1) * rowHeight
            let rect = NSRect(x: margin, y: y + 4, width: bounds.width - margin * 2, height: rowHeight - 8); card(rect, selected: recommendation.0 == station)
            let value = snapshot(station), color = value?.online == true ? loadColor(20) : NSColor(calibratedWhite: 0.4, alpha: 1)
            text("● \(station.rawValue)", NSRect(x: rect.minX + 10, y: rect.maxY - 24, width: rect.width * 0.42, height: 17), 10, color, .left, bold: true)
            guard let value, value.online else { text("OFFLINE", NSRect(x: rect.midX, y: rect.midY - 7, width: rect.width * 0.45, height: 16), 9, color, .center); continue }
            let labels = ["CPU", "MEM", station == .atlas ? "JOBS" : "GPU"], loads = [value.cpuLoad, value.memoryLoad, value.thirdLoad]
            for i in 0..<3 {
                let x = rect.minX + rect.width * 0.44 + CGFloat(i) * rect.width * 0.18
                let cupRect = NSRect(x: x, y: rect.minY + 8, width: rect.width * 0.15, height: rect.height - 14)
                cup(cupRect, value: loads[i], title: labels[i], detail: String(format: "%.0f%%", loads[i]))
            }
        }
    }
}
