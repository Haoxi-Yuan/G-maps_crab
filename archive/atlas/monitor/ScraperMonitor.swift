import AppKit
import Foundation
import MapKit

private enum Stage: String, CaseIterable {
    case all = "ALL TASKS"
    case poi = "POI SEARCH"
    case reviews = "REVIEWS"
    case resources = "RESOURCES"
    case other = "OTHER"

    var isRecordStage: Bool { self != .all && self != .resources }
}
private let navigationStages: [Stage] = [.all, .poi, .reviews, .resources]
private enum Location: String, CaseIterable { case local = "LOCAL"; case chark = "CHARK"; case remote = "STRIX"; case atlas = "ATLAS" }
private enum ProbeKind { case processes, atlasPBS, atlasRefresh }

private struct Config {
    var charkHost = "haoxi@10.192.132.2"
    var charkRoot = "/data/haoxi/CLI_scraper"
    var host = "haoxi@10.192.132.3"
    var remoteRoot = "/data2/shared/haoxi/CLI_scraper"
    var atlasHost = "nus-atlas9"
    var atlasRoot = "/hpctmp/haoxi.yuan/gmaps_atlas/CLI_scraper"
    var localRoot = "/Volumes/Data/CLI_scraper"
    var interval: TimeInterval = 2
    var resourceInterval: TimeInterval = 3
    var atlasInterval: TimeInterval = 8
    var atlasQstatInterval: TimeInterval = 60
    var chartMinutes: TimeInterval = 30

    static func parse(_ args: [String]) -> Config {
        var value = Config(); var i = 1
        while i < args.count {
            let flag = args[i]
            guard i + 1 < args.count else { fputs("Missing value for \(flag)\n", stderr); exit(64) }
            let next = args[i + 1]
            switch flag {
            case "--chark-host": value.charkHost = next
            case "--chark-root": value.charkRoot = next
            case "--host": value.host = next
            case "--remote-root", "--root": value.remoteRoot = next
            case "--atlas-host": value.atlasHost = next
            case "--atlas-root": value.atlasRoot = next
            case "--local-root": value.localRoot = next
            case "--interval": value.interval = max(1, Double(next) ?? 2)
            case "--resource-interval": value.resourceInterval = max(2, Double(next) ?? 3)
            case "--atlas-interval": value.atlasInterval = max(5, Double(next) ?? 8)
            case "--atlas-qstat-interval": value.atlasQstatInterval = max(30, Double(next) ?? 60)
            case "--chart-minutes": value.chartMinutes = max(1, Double(next) ?? 30)
            // Accepted so the two legacy launchers can forward old invocations.
            case "--output", "--log", "--status": break
            default: fputs("Unknown option: \(flag)\n", stderr); exit(64)
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
    let city: String?, phase: String?, category: String?, updatedAt: String?
    let categoryIndex: Int?, categoryTotal: Int?, depth: Int?, zoom: Int?
    let bbox: CellBox?, children: [CellBox]?
    let newPlaceIds: Int?, totalPlaceIds: Int?, requests: Int?
    // Added by the monitor probe for multi-boundary orchestrators. The
    // scraper's per-area sidecar stays unchanged, so old and remote versions
    // remain wire-compatible.
    let batch: String?, areaIndex: Int?, areaTotal: Int?, areaCompleted: Int?
}

private struct LiveReview: Decodable {
    let rating: Double?, text: String?, reviewer: String?, publishedAt: String?
}

private struct ReviewStatus: Decodable {
    let city: String?, phase: String?, updatedAt: String?
    let index: Int?, total: Int?, placeId: String?, name: String?
    let categories: [String]?, latitude: Double?, longitude: Double?
    let expectedReviews: Int?, fetchedReviews: Int?, latestReview: LiveReview?, message: String?
}

/// Common, deliberately small status contract for task types that do not have
/// a dedicated POI or Review visualization. Existing sidecars remain valid;
/// every field is optional so new project tasks can opt in incrementally.
private struct TaskStatus: Decodable {
    let pipeline: String?, taskType: String?, phase: String?, city: String?, updatedAt: String?
    let completed: Int?, total: Int?, unit: String?, message: String?, currentItem: String?
    let runtimeSeconds: Int?
}

private struct SourceKey: Hashable {
    let location: Location, stage: Stage, pid: Int
    var id: String { "\(location.rawValue):\(stage.rawValue):\(pid)" }
}

private enum ActivityState: String {
    case running = "LIVE"
    case held = "HOLD"
    case queued = "QUEUED"
    case stale = "TELEMETRY STALE"
    case error = "ERROR"
    case complete = "COMPLETE"
    case offline = "OFFLINE"
}

private func liveDate(_ value: String?) -> Date? {
    guard let value else { return nil }
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: value) { return date }
    return ISO8601DateFormatter().date(from: value)
}

private struct ProbeRecord {
    let key: SourceKey, city: String, path: String, date: Date
    let bytes: Int64, amount: Int, poi: POIStatus?, review: ReviewStatus?, task: TaskStatus?
    let jobID: String?, jobState: String?, unit: String?
    let taskType: String, command: String?, elapsedSeconds: Int, progressTotal: Int, measureUnit: String
    var label: String {
        let cityLabel = city.replacingOccurrences(of: "_", with: " ").uppercased()
        let taskLabel = taskType.replacingOccurrences(of: "_", with: " ").uppercased()
        if key.location == .atlas {
            return [key.location.rawValue, taskLabel, cityLabel, unit, jobState, jobID].compactMap { $0 }.joined(separator: " · ")
        }
        return "\(key.location.rawValue) · \(taskLabel) · \(cityLabel) · PID \(key.pid)"
    }
    var sourceSummary: String {
        [key.location.rawValue, unit, jobState].compactMap { $0 }.joined(separator: " · ")
    }
    var processSummary: String { key.location == .atlas ? (unit ?? "PBS") : "PID \(key.pid)" }
    var updatedAt: Date? { liveDate(poi?.updatedAt ?? review?.updatedAt ?? task?.updatedAt) }
    var telemetryAge: TimeInterval? { updatedAt.map { max(0, date.timeIntervalSince($0)) } }
    var activity: ActivityState {
        let phase = (task?.phase ?? poi?.phase ?? review?.phase ?? "").lowercased()
        if phase.contains("error") || phase.contains("failed") || phase.contains("quarantined") { return .error }
        if jobState == "H" || phase.contains("hold") { return .held }
        if jobState == "Q" || jobState == "W" || phase.contains("queued") { return .queued }
        if phase == "done" || phase == "complete" || phase.contains("completed") { return .complete }
        if key.stage == .poi || key.stage == .reviews {
            guard let age = telemetryAge, age <= 120 else { return .stale }
        }
        return .running
    }
    var hasFreshTelemetry: Bool { activity == .running }
    var freshnessText: String {
        guard let age = telemetryAge else { return "NO LIVE TELEMETRY" }
        if age < 5 { return "UPDATED NOW" }
        if age < 60 { return "UPDATED \(Int(age))S AGO" }
        return "UPDATED \(Int(age / 60))M AGO"
    }
    var commandSummary: String {
        guard let command, !command.isEmpty else { return path }
        let tokens = command.split(whereSeparator: { $0.isWhitespace }).map {
            String($0).trimmingCharacters(in: CharacterSet(charactersIn: "'\";,"))
        }
        if let entry = tokens.first(where: {
            $0.hasSuffix(".js") || $0.hasSuffix(".mjs") || $0.hasSuffix(".cjs") ||
            $0.hasSuffix(".py") || $0.hasSuffix(".sh") || $0.contains("bin/gmaps-crab")
        }) {
            if let marker = entry.range(of: "/CLI_scraper/") { return String(entry[marker.upperBound...]) }
            return entry
        }
        return taskType.replacingOccurrences(of: "_", with: " ")
    }
}

private func shellQuote(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

/// Owns one long-lived SSH transport. Probe commands use short-lived channels
/// over this socket, so ControlPersist never keeps a probe's stdout pipe open.
private final class SSHControlMaster {
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
          rm -f \(shellQuote(path))
        }
        trap cleanup EXIT TERM INT
        /usr/bin/ssh -MN -o BatchMode=yes -o ConnectTimeout=5 \
          -o ServerAliveInterval=30 -o ServerAliveCountMax=2 -o ControlMaster=yes \
          -S \(shellQuote(path)) \(shellQuote(host)) &
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
                if !self.stopped { DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in self?.start() } }
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

private final class ProbeDataBox { var value = Data() }

/// Discovers active scraper processes and samples their sidecars. Review
/// outputs are counted once and then only appended bytes are scanned.
private final class EndpointProbe {
    private let location: Location, root: String, host: String?, controlPath: String?, interval: TimeInterval, kind: ProbeKind
    private var timer: Timer?, process: Process?
    private var counters: [Int: (size: Int64, completed: Int)] = [:]
    var onRecords: ((Location, [ProbeRecord]) -> Void)?
    var onError: ((Location, String) -> Void)?

    init(location: Location, root: String, host: String?, controlPath: String? = nil,
         interval: TimeInterval, kind: ProbeKind = .processes) {
        self.location = location; self.root = root; self.host = host; self.controlPath = controlPath
        self.interval = interval; self.kind = kind
    }

    func start() {
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in self?.poll() }
        if let timer { RunLoop.main.add(timer, forMode: .common) }
    }
    func stop() { timer?.invalidate(); process?.terminate(); timer = nil; process = nil }

    private func command() -> String {
        if kind == .atlasPBS || kind == .atlasRefresh {
            let script = "\(root)/scripts/hpc/atlas-monitor-snapshot.sh"
            let mode = kind == .atlasRefresh ? " --refresh-qstat" : ""
            return "\(shellQuote(script)) \(shellQuote(root))\(mode)"
        }
        let counterCases = counters.map { pid, value in
            "\(pid)) previous=\(value.size); baseline=\(value.completed) ;;"
        }.joined(separator: "\n")
        return """
        root=\(shellQuote(root))
        b64text() { printf '%s' "$1" | base64 | tr -d '\\r\\n'; }
        b64file() { if [ -r "$1" ]; then base64 < "$1" | tr -d '\\r\\n'; else printf '-'; fi; }
        filesize() { stat -c %s -- "$1" 2>/dev/null || stat -f %z -- "$1" 2>/dev/null || printf '0'; }
        elapsed_seconds() {
          printf '%s\\n' "$1" | awk -F '[-:]' '{
            if (NF==4) print $1*86400+$2*3600+$3*60+$4;
            else if (NF==3) print $1*3600+$2*60+$3;
            else if (NF==2) print $1*60+$2;
            else print 0
          }'
        }
        absolute_path() {
          local value=$1
          value=$(printf '%s' "$value" | sed "s/^[\\\"']//;s/[\\\"']$//")
          case "$value" in /*) printf '%s' "$value" ;; '') printf '' ;; *) printf '%s/%s' "$root" "$value" ;; esac
        }
        arg_value() {
          local flag=$1 text=$2
          printf '%s\\n' "$text" | sed -n "s/.*${flag}[= ]\\([^ ]*\\).*/\\1/p" | tail -n 1
        }
        mtime() { stat -c %Y -- "$1" 2>/dev/null || stat -f %m -- "$1" 2>/dev/null || printf '0'; }
        sanitize_slug() {
          printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g;s/^_+//;s/_+$//'
        }
        emit_row() {
          local stage=$1 pid=$2 city=$3 record_path=$4 bytes=$5 mode=$6 amount=$7 status_payload=$8
          local task_type=$9 command_text=${10} elapsed=${11} total=${12} measure=${13}
          printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t-\\t-\\t-\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \
            "$stage" "$pid" "$city" "$(b64text "$record_path")" "$bytes" "$mode" "$amount" "$status_payload" \
            "$(b64text "$task_type")" "$(b64text "$command_text")" "$elapsed" "$total" "$(b64text "$measure")"
        }
        emit_review() {
          local pid=$1 output=$2 live=$3 city=$4 args=$5 elapsed=$6
          local size previous='' baseline=0 mode delta amount
          size=$(filesize "$output")
          case "$pid" in
        \(counterCases)
          esac
          mode=B
          if [ -n "$previous" ] && [ "$size" -ge "$previous" ]; then
            delta=$(tail -c +$((previous+1)) -- "$output" 2>/dev/null | wc -l | tr -d ' ')
            amount=$((baseline+delta)); mode=D
          else
            amount=$(wc -l < "$output" 2>/dev/null | tr -d ' '); amount=${amount:-0}
          fi
          emit_row reviews "$pid" "$city" "$output" "$size" "$mode" "$amount" "$(b64file "$live")" reviews "$args" "$elapsed" 0 reviews
        }
        emit_poi() {
          local pid=$1 checkpoint=$2 live=$3 city=$4 args=$5 elapsed=$6 dir places
          dir=${checkpoint%/*}; places="$dir/places.ndjson"
          emit_row poi "$pid" "$city" "$places" "$(filesize "$places")" P 0 "$(b64file "$live")" poi-search "$args" "$elapsed" 0 POIs
        }
        emit_generic() {
          local stage=$1 pid=$2 city=$3 output=$4 live=$5 task_type=$6 args=$7 elapsed=$8 size
          [ -n "$output" ] || output="$root"
          size=$(filesize "$output")
          emit_row "$stage" "$pid" "$city" "$output" "$size" F "$size" "$(b64file "$live")" "$task_type" "$args" "$elapsed" 0 bytes
        }
        ps -eo pid=,etime=,args= | while read -r pid etime args; do
          case "$args" in *scraper-monitor*|*ScraperMonitor*|*atlas-monitor-snapshot*|*'b64text()'*|*'ps -eo pid='*) continue ;; esac
          case "$args" in *'Code Helper'*|*'Visual Studio Code'*|*Electron*|*language-server*) continue ;; esac
          case "$args" in *node*|*npm*|*npx*|*python*|*bash*|*zsh*|*'/sh '*) ;; *) continue ;; esac
          cwd=''
          if [ -e "/proc/$pid/cwd" ]; then
            cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
          elif command -v lsof >/dev/null 2>&1; then
            cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n 1)
          fi
          project=0; relative_project=0
          # An absolute repository path counts only when it is an executable
          # project entrypoint. Sandboxes and IDE helpers often mention the
          # repository merely in permission/working-directory arguments.
          case "$args" in
            *"$root/src/"*.js*|*"$root/src/"*.mjs*|*"$root/scripts/"*.js*|*"$root/scripts/"*.mjs*|*"$root/scripts/"*.py*|*"$root/scripts/"*.sh*|*"$root/tools/"*.js*|*"$root/tools/"*.py*|*"$root/tools/"*.sh*|*"$root/TEST/"*.js*|*"$root/TEST/"*.py*|*"$root/bin/gmaps-crab"*|*"$root/poi-search.sh"*|*"$root/review-scrape.sh"*|*"$root/multi-boundary.sh"*) project=1 ;;
          esac
          # Relative entrypoints count only when both the command and cwd point
          # at this repository. Merely inheriting the cwd is insufficient:
          # editors and language servers commonly do that.
          case "$args" in
            *' src/'*.js*|*' scripts/'*.js*|*' tools/'*.js*|*' tools/'*.sh*|*' TEST/'*.js*|*' TEST/'*.py*|*' bin/gmaps-crab'*|*' poi-search.sh'*|*' review-scrape.sh'*|*' multi-boundary.sh'*) relative_project=1 ;;
            *"src/poi-searcher-api"*|*"src/review-scraper"*) relative_project=1 ;;
            npm\\ run*|*/npm\\ run*|npx\\ *|*/npx\\ *) relative_project=1 ;;
          esac
          case "$cwd" in "$root"|"$root"/*) [ "$relative_project" -eq 1 ] && project=1 ;; esac
          [ "$project" -eq 1 ] || continue
          elapsed=$(elapsed_seconds "$etime")
          case "$args" in
            *review-scraper.js*)
              output=$(printf '%s\\n' "$args" | sed -n 's/.*--output \\([^ ]*\\).*/\\1/p')
              live=$(printf '%s\\n' "$args" | sed -n 's/.*--live-status \\([^ ]*\\).*/\\1/p')
              output=$(absolute_path "$output"); [ -n "$output" ] || continue
              [ -n "$live" ] || live="${output%/*}/reviews.live.json"; live=$(absolute_path "$live")
              [ -r "$output" ] || continue; city=$(basename "${output%/*}")
              emit_review "$pid" "$output" "$live" "$city" "$args" "$elapsed"
              ;;
            *multi-boundary-orchestrator*)
              # The orchestrator has no --output/--live-status flag. It writes
              # one sidecar per active area under output/_batches/<name>/, so
              # discover the freshest sidecar belonging to this process.
              batch=$(arg_value --name "$args"); batch_slug=$(sanitize_slug "$batch")
              boundaries=$(absolute_path "$(arg_value --boundaries "$args")")
              areas_filter=$(arg_value --areas "$args"); shard=$(arg_value --shard "$args")
              shard_i=0; shard_n=0
              case "$shard" in
                */*) shard_i=${shard%/*}; shard_n=${shard#*/} ;;
              esac
              case "$shard_i:$shard_n" in
                *[!0-9:]*|0:*|*:0) shard_i=0; shard_n=0 ;;
              esac
              flat=0; case " $args " in *' --flat '*) flat=1 ;; esac
              if [ "$flat" -eq 1 ]; then batch_dir="$root/output"; else batch_dir="$root/output/_batches/$batch_slug"; fi
              live=''; latest=0
              consider_live() {
                local candidate=$1 dir area_dir area_slug rel data_dir boundary_meta meta source_index stamp
                [ -r "$candidate" ] || return
                dir=${candidate%/*}; area_dir=${dir##*/}; area_slug=${area_dir#"${batch_slug}__"}
                if [ -n "$areas_filter" ]; then
                  case ",$areas_filter," in *",$area_slug,"*) ;; *) return ;; esac
                fi
                if [ "$shard_n" -gt 0 ]; then
                  rel=${dir#"$root/output/"}; data_dir="$root/data/$rel"; boundary_meta=''
                  for meta in "$data_dir"/*_boundary.geojson; do [ -r "$meta" ] && { boundary_meta=$meta; break; }; done
                  source_index=''
                  if [ -n "$boundary_meta" ] && command -v jq >/dev/null 2>&1; then
                    source_index=$(jq -r '.features[0].properties.multi_boundary_index // empty' "$boundary_meta" 2>/dev/null)
                  fi
                  case "$source_index" in ''|*[!0-9]*) ;; *) [ $((source_index % shard_n + 1)) -eq "$shard_i" ] || return ;; esac
                fi
                stamp=$(mtime "$candidate")
                if [ "$stamp" -ge "$latest" ]; then live=$candidate; latest=$stamp; fi
              }
              if [ "$flat" -eq 1 ]; then
                while IFS= read -r candidate; do consider_live "$candidate"; done < <(
                  find "$root/output" -mindepth 2 -maxdepth 2 -type f -name poi_search.live.json \
                    -path "$root/output/${batch_slug}__*/poi_search.live.json" 2>/dev/null
                )
              else
                while IFS= read -r candidate; do consider_live "$candidate"; done < <(
                  find "$batch_dir" -mindepth 2 -maxdepth 2 -type f -name poi_search.live.json 2>/dev/null
                )
              fi
              if [ -z "$live" ]; then
                [ -n "$batch_slug" ] || batch_slug=multi_boundary
                emit_generic poi "$pid" "$batch_slug" "$batch_dir" '' poi-search "$args" "$elapsed"
                continue
              fi
              dir=${live%/*}; city=${dir##*/}; places="$dir/places.ndjson"
              area_total=0
              if [ -r "$boundaries" ] && command -v jq >/dev/null 2>&1; then
                area_total=$(jq -r '
                  def polygonal:
                    .type == "Polygon" or .type == "MultiPolygon" or
                    (.type == "GeometryCollection" and any(.geometries[]?; .type == "Polygon" or .type == "MultiPolygon"));
                  if .type == "FeatureCollection" then [.features[] | select(.geometry | polygonal)] | length
                  elif .type == "Feature" then (if (.geometry | polygonal) then 1 else 0 end)
                  else (if polygonal then 1 else 0 end) end
                ' "$boundaries" 2>/dev/null)
              fi
              case "$area_total" in ''|*[!0-9]*) area_total=0 ;; esac
              if [ -n "$areas_filter" ]; then
                area_total=$(printf '%s' "$areas_filter" | awk -F, '{print NF}')
              fi
              if [ "$shard_n" -gt 0 ] && [ "$area_total" -gt 0 ]; then
                if [ "$area_total" -ge "$shard_i" ]; then area_total=$(( (area_total - shard_i) / shard_n + 1 )); else area_total=0; fi
              fi
              area_completed=0
              count_marker() {
                local marker=$1 marker_dir marker_name marker_slug marker_rel marker_data marker_meta meta marker_index
                [ -r "$marker" ] || return
                marker_dir=${marker%/*}; marker_name=${marker_dir##*/}; marker_slug=${marker_name#"${batch_slug}__"}
                if [ -n "$areas_filter" ]; then case ",$areas_filter," in *",$marker_slug,"*) ;; *) return ;; esac; fi
                if [ "$shard_n" -gt 0 ]; then
                  marker_rel=${marker_dir#"$root/output/"}; marker_data="$root/data/$marker_rel"; marker_meta=''
                  for meta in "$marker_data"/*_boundary.geojson; do [ -r "$meta" ] && { marker_meta=$meta; break; }; done
                  marker_index=''
                  if [ -n "$marker_meta" ] && command -v jq >/dev/null 2>&1; then marker_index=$(jq -r '.features[0].properties.multi_boundary_index // empty' "$marker_meta" 2>/dev/null); fi
                  case "$marker_index" in ''|*[!0-9]*) ;; *) [ $((marker_index % shard_n + 1)) -eq "$shard_i" ] || return ;; esac
                fi
                area_completed=$((area_completed + 1))
              }
              if [ "$flat" -eq 1 ]; then
                while IFS= read -r marker; do count_marker "$marker"; done < <(
                  find "$root/output" -mindepth 2 -maxdepth 2 -type f -name _area_complete.json \
                    -path "$root/output/${batch_slug}__*/_area_complete.json" 2>/dev/null
                )
              else
                while IFS= read -r marker; do count_marker "$marker"; done < <(
                  find "$batch_dir" -mindepth 2 -maxdepth 2 -type f -name _area_complete.json 2>/dev/null
                )
              fi
              area_index=$((area_completed + 1)); [ "$area_total" -eq 0 ] || [ "$area_index" -le "$area_total" ] || area_index=$area_total
              payload=''
              if command -v jq >/dev/null 2>&1; then
                payload=$(jq -c --arg batch "$batch_slug" --argjson areaIndex "$area_index" \
                  --argjson areaTotal "$area_total" --argjson areaCompleted "$area_completed" \
                  '. + {batch:$batch,areaIndex:$areaIndex,areaTotal:$areaTotal,areaCompleted:$areaCompleted}' "$live" 2>/dev/null)
              fi
              if [ -n "$payload" ]; then status_payload=$(b64text "$payload"); else status_payload=$(b64file "$live"); fi
              emit_row poi "$pid" "$city" "$places" "$(filesize "$places")" P 0 "$status_payload" poi-search "$args" "$elapsed" "$area_total" POIs
              ;;
            *src/poi-searcher-api*)
              checkpoint=$(printf '%s\\n' "$args" | grep -Eo '([^ ]*/)?output/[^ ]+/poi_search\\.json' | head -n 1)
              [ -n "$checkpoint" ] || checkpoint=$(arg_value --output "$args")
              checkpoint=$(absolute_path "$checkpoint"); [ -n "$checkpoint" ] || continue
              city=$(basename "${checkpoint%/*}"); live="${checkpoint%.json}.live.json"
              emit_poi "$pid" "$checkpoint" "$live" "$city" "$args" "$elapsed"
              ;;
            *)
              stage=other; task_type=task
              case "$args" in
                *multi-boundary-orchestrator*|*adaptive-poi*|*filter-by-boundary*|*poi-search*) stage=poi; task_type=poi-search ;;
                *image*|*photo-category*|*photo_categories*) task_type=images ;;
                *sqlite*|*database*|*backfill*) task_type=database ;;
                *city-generator*|*boundary*) task_type=boundary ;;
                *test*|*check*|*verify*|*validate*|*probe*) task_type=validation ;;
                *scheduler*) task_type=scheduler ;;
                *review*|*merge-review-shards*|*shard-review-input*) stage=reviews; task_type=reviews ;;
              esac
              output=$(arg_value --output "$args"); [ -n "$output" ] || output=$(arg_value --manifest "$args")
              [ -n "$output" ] || output=$(arg_value --db "$args"); output=$(absolute_path "$output")
              live=$(arg_value --live-status "$args"); [ -n "$live" ] || live=$(arg_value --status "$args")
              live=$(absolute_path "$live")
              city=$(arg_value --city "$args")
              if [ -z "$city" ] && [ -n "$output" ]; then city=$(basename "${output%/*}"); fi
              [ -n "$city" ] || city=project
              emit_generic "$stage" "$pid" "$city" "$output" "$live" "$task_type" "$args" "$elapsed"
              ;;
          esac
        done
        """
    }

    private func poll() {
        guard process == nil else { return }
        if host != nil, let controlPath, !FileManager.default.fileExists(atPath: controlPath) { return }
        let task = Process(), out = Pipe(), err = Pipe()
        let outputBox = ProbeDataBox(), errorBox = ProbeDataBox(), reads = DispatchGroup()
        if let host {
            task.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
            task.arguments = ["-S", controlPath ?? "none", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
                              "-o", "ControlMaster=no", host, command()]
        } else {
            task.executableURL = URL(fileURLWithPath: "/bin/bash"); task.arguments = ["-lc", command()]
        }
        task.standardOutput = out; task.standardError = err; process = task
        reads.enter()
        DispatchQueue.global(qos: .utility).async {
            outputBox.value = out.fileHandleForReading.readDataToEndOfFile(); reads.leave()
        }
        reads.enter()
        DispatchQueue.global(qos: .utility).async {
            errorBox.value = err.fileHandleForReading.readDataToEndOfFile(); reads.leave()
        }
        task.terminationHandler = { [weak self] finished in
            reads.notify(queue: .main) {
                guard let self else { return }; self.process = nil
                guard finished.terminationStatus == 0 else {
                    if self.kind != .atlasRefresh {
                        self.onError?(self.location, String(data: errorBox.value, encoding: .utf8) ?? "probe failed")
                    }
                    return
                }
                if self.kind == .atlasRefresh { return }
                let records = self.parse(outputBox.value); self.onRecords?(self.location, records)
            }
        }
        do { try task.run() } catch {
            out.fileHandleForWriting.closeFile(); err.fileHandleForWriting.closeFile()
            process = nil; onError?(location, error.localizedDescription)
        }
    }

    private func parse(_ data: Data) -> [ProbeRecord] {
        let text = String(data: data, encoding: .utf8) ?? ""
        var records: [ProbeRecord] = []
        for line in text.split(separator: "\n") {
            let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            let stage: Stage = f.first == "poi" ? .poi : (f.first == "reviews" ? .reviews : .other)
            guard f.count >= 8,
                  let pid = Int(f[1]), let bytes = Int64(f[4]), let amount = Int(f[6]),
                  let pathData = Data(base64Encoded: f[3]), let path = String(data: pathData, encoding: .utf8) else { continue }
            let statusData = f[7] == "-" ? nil : Data(base64Encoded: f[7])
            let poi = statusData.flatMap { try? JSONDecoder().decode(POIStatus.self, from: $0) }
            let review = statusData.flatMap { try? JSONDecoder().decode(ReviewStatus.self, from: $0) }
            let task = statusData.flatMap { try? JSONDecoder().decode(TaskStatus.self, from: $0) }
            let key = SourceKey(location: location, stage: stage, pid: pid)
            let jobID = f.count > 8 && f[8] != "-" ? f[8] : nil
            let jobState = f.count > 9 && f[9] != "-" ? f[9] : nil
            let unit: String? = {
                guard f.count > 10, f[10] != "-", let value = Data(base64Encoded: f[10]) else { return nil }
                return String(data: value, encoding: .utf8)
            }()
            func decoded(_ index: Int) -> String? {
                guard f.count > index, f[index] != "-", let value = Data(base64Encoded: f[index]) else { return nil }
                return String(data: value, encoding: .utf8)
            }
            let defaultType = stage == .poi ? "poi-search" : (stage == .reviews ? "reviews" : "task")
            let taskType = decoded(11) ?? task?.taskType ?? task?.pipeline ?? defaultType
            let command = decoded(12)
            let elapsed = f.count > 13 ? (Int(f[13]) ?? task?.runtimeSeconds ?? 0) : (task?.runtimeSeconds ?? 0)
            let progressTotal = f.count > 14 ? (Int(f[14]) ?? task?.total ?? 0) : (task?.total ?? 0)
            let measureUnit = decoded(15) ?? task?.unit ?? (stage == .reviews ? "reviews" : (stage == .poi ? "POIs" : "items"))
            let measuredAmount: Int = {
                if stage == .poi { return poi?.totalPlaceIds ?? task?.completed ?? amount }
                if stage == .other { return task?.completed ?? amount }
                return amount
            }()
            let record = ProbeRecord(key: key, city: f[2], path: path, date: Date(), bytes: bytes,
                                     amount: measuredAmount, poi: poi, review: review, task: task,
                                     jobID: jobID, jobState: jobState, unit: unit,
                                     taskType: taskType, command: command, elapsedSeconds: elapsed,
                                     progressTotal: progressTotal, measureUnit: measureUnit)
            records.append(record)
            if stage == .reviews { counters[pid] = (bytes, amount) }
        }
        let active = Set(records.filter { $0.key.stage == .reviews }.map { $0.key.pid })
        counters = counters.filter { active.contains($0.key) }
        return records
    }
}

private final class DiscoveryCoordinator {
    private var masters: [SSHControlMaster] = [], probes: [EndpointProbe] = [], records: [Location: [ProbeRecord]] = [:]
    private var lastSuccess: [Location: Date] = [:]
    var onUpdate: (([ProbeRecord], [Location: Bool]) -> Void)?

    init(_ config: Config) {
        let pid = ProcessInfo.processInfo.processIdentifier
        let charkPath = "/tmp/scraper-monitor-\(pid)-chark.sock"
        let strixPath = "/tmp/scraper-monitor-\(pid)-strix.sock"
        let atlasPath = "/tmp/scraper-monitor-\(pid)-atlas.sock"
        masters = [SSHControlMaster(host: config.charkHost, path: charkPath),
                   SSHControlMaster(host: config.host, path: strixPath),
                   SSHControlMaster(host: config.atlasHost, path: atlasPath)]
        probes = [
            EndpointProbe(location: .local, root: config.localRoot, host: nil, interval: config.interval),
            EndpointProbe(location: .chark, root: config.charkRoot, host: config.charkHost,
                          controlPath: charkPath, interval: config.interval),
            EndpointProbe(location: .remote, root: config.remoteRoot, host: config.host,
                          controlPath: strixPath, interval: config.interval),
            EndpointProbe(location: .atlas, root: config.atlasRoot, host: config.atlasHost, controlPath: atlasPath,
                          interval: config.atlasInterval, kind: .atlasPBS),
            EndpointProbe(location: .atlas, root: config.atlasRoot, host: config.atlasHost, controlPath: atlasPath,
                          interval: config.atlasQstatInterval, kind: .atlasRefresh),
        ]
        for probe in probes {
            probe.onRecords = { [weak self] location, values in
                self?.records[location] = values; self?.lastSuccess[location] = Date(); self?.publish()
            }
            probe.onError = { [weak self] location, message in
                let detail = message.trimmingCharacters(in: .whitespacesAndNewlines)
                NSLog("Scraper Monitor %@ probe failed: %@", location.rawValue,
                      detail.isEmpty ? "unknown error" : detail)
                self?.publish(errorAt: location)
            }
        }
    }
    func start() { masters.forEach { $0.start() }; probes.forEach { $0.start() } }
    func stop() { probes.forEach { $0.stop() }; masters.forEach { $0.stop() } }
    private func publish(errorAt: Location? = nil) {
        let now = Date(); var online: [Location: Bool] = [:]
        for location in Location.allCases {
            let freshness: TimeInterval = location == .atlas ? 40 : 12
            online[location] = lastSuccess[location].map { now.timeIntervalSince($0) < freshness } ?? false
        }
        if let errorAt, online[errorAt] != true { records[errorAt] = [] }
        onUpdate?(records.values.flatMap { $0 }, online)
    }
}

private struct RatePoint { let date: Date, value: Double }
private struct MetricState { let rate: Double?, points: [RatePoint] }
private final class MetricStore {
    private let window: TimeInterval
    private var readings: [SourceKey: [(Date, Int)]] = [:], charts: [SourceKey: [RatePoint]] = [:]
    init(minutes: TimeInterval) { window = minutes * 60 }
    func add(_ record: ProbeRecord) -> MetricState {
        var values = readings[record.key] ?? []
        if let last = values.last, record.amount < last.1 { values.removeAll() }
        if values.last?.1 != record.amount || values.last.map({ record.date.timeIntervalSince($0.0) >= 1 }) == true {
            values.append((record.date, record.amount))
        }
        values.removeAll { $0.0 < record.date.addingTimeInterval(-max(window, 60) - 60) }; readings[record.key] = values
        let cutoff = record.date.addingTimeInterval(-60)
        let start = values.last(where: { $0.0 <= cutoff }) ?? values.first
        var rate: Double?
        if let start, let end = values.last, end.0 > start.0 { rate = max(0, Double(end.1 - start.1) / end.0.timeIntervalSince(start.0) * 60) }
        var chart = charts[record.key] ?? []
        chart.append(RatePoint(date: record.date, value: rate ?? 0)); chart.removeAll { $0.date < record.date.addingTimeInterval(-window) }
        charts[record.key] = chart
        return MetricState(rate: rate, points: chart)
    }
}

private let monitorRed = NSColor(calibratedRed: 1, green: 0.12, blue: 0.16, alpha: 1)
private let monitorGray = NSColor(calibratedWhite: 0.64, alpha: 1)
private let monitorAmber = NSColor(calibratedRed: 1, green: 0.66, blue: 0.18, alpha: 1)
private let monitorGreen = NSColor(calibratedRed: 0.26, green: 0.86, blue: 0.50, alpha: 1)
private func formatNumber(_ value: Int) -> String { NumberFormatter.localizedString(from: NSNumber(value: value), number: .decimal) }
private func activityColor(_ value: ActivityState) -> NSColor {
    switch value {
    case .running: return monitorRed
    case .held, .queued, .stale: return monitorAmber
    case .error: return monitorRed
    case .complete: return monitorGreen
    case .offline: return monitorGray
    }
}
private func displayCity(_ value: String?) -> String {
    (value ?? "WAITING").replacingOccurrences(of: "_", with: " ").uppercased()
}

private func areaProgress(_ status: POIStatus?) -> String? {
    guard let status, let index = status.areaIndex, let total = status.areaTotal, total > 0 else { return nil }
    return "AREA \(index)/\(total)"
}

private func overallPOIProgress(_ status: POIStatus?) -> (completed: Int, total: Int)? {
    guard let status, let areaTotal = status.areaTotal, areaTotal > 0,
          let categoryTotal = status.categoryTotal, categoryTotal > 0 else { return nil }
    let finishedAreas = min(areaTotal, max(0, status.areaCompleted ?? 0))
    let currentCategory = min(categoryTotal, max(0, status.categoryIndex ?? 0))
    return (finishedAreas * categoryTotal + currentCategory, areaTotal * categoryTotal)
}

private extension NSView {
    func monitorText(_ value: String, _ rect: NSRect, _ size: CGFloat, _ color: NSColor,
                     _ alignment: NSTextAlignment = .left, system: Bool = false) {
        let paragraph = NSMutableParagraphStyle(); paragraph.alignment = alignment; paragraph.lineBreakMode = .byTruncatingTail
        let scale: CGFloat = bounds.width >= 1_100 && bounds.height >= 650 ? min(1.38, max(1.25, bounds.width / 950)) : 1
        let adjusted = size * scale
        let font = system ? NSFont.systemFont(ofSize: adjusted) : NSFont.monospacedSystemFont(ofSize: adjusted, weight: .regular)
        (value as NSString).draw(in: rect, withAttributes: [.font: font, .foregroundColor: color, .paragraphStyle: paragraph])
    }
    func monitorChart(_ points: [RatePoint], _ rect: NSRect) {
        let grid = NSColor(calibratedRed: 0.42, green: 0.02, blue: 0.04, alpha: 0.28)
        let g = NSBezierPath(); g.lineWidth = 0.5; grid.setStroke()
        for i in 0...6 { let x = rect.minX + rect.width * CGFloat(i) / 6; g.move(to: NSPoint(x:x,y:rect.minY)); g.line(to:NSPoint(x:x,y:rect.maxY)) }
        for i in 0...3 { let y = rect.minY + rect.height * CGFloat(i) / 3; g.move(to:NSPoint(x:rect.minX,y:y)); g.line(to:NSPoint(x:rect.maxX,y:y)) }; g.stroke()
        let values = points.map(\.value); guard values.count > 1 else { return }
        let top = max(1, values.sorted()[Int(Double(values.count - 1) * 0.95)] * 1.2), p = NSBezierPath(); p.lineWidth = 1.8
        for (i,v) in values.enumerated() { let q=NSPoint(x:rect.minX+rect.width*CGFloat(i)/CGFloat(values.count-1),y:rect.minY+rect.height*CGFloat(min(v,top)/top)); i == 0 ? p.move(to:q) : p.line(to:q) }
        monitorRed.setStroke(); p.stroke()
    }
    func monitorSeparator(_ y: CGFloat) { let p=NSBezierPath();p.move(to:NSPoint(x:0,y:y));p.line(to:NSPoint(x:bounds.width,y:y));p.lineWidth=0.6;NSColor(calibratedWhite:0.3,alpha:0.5).setStroke();p.stroke() }
}

private final class POIDashboard: NSView, MKMapViewDelegate {
    private var record: ProbeRecord?, metric = MetricState(rate: nil, points: []), sourceCount = 0
    private var map: MKMapView?, releaseTimer: Timer?, previousCenter: CLLocationCoordinate2D?
    private var lastMapKey = "", lastMapUpdate = Date.distantPast
    override var isOpaque: Bool { true }
    private var canShowMap: Bool { record?.hasFreshTelemetry == true && record?.poi?.bbox != nil }

    func update(_ record: ProbeRecord?, metric: MetricState?, sourceCount: Int) {
        self.record = record; self.metric = metric ?? MetricState(rate:nil,points:[]); self.sourceCount = sourceCount
        if bounds.width >= 600 && bounds.height >= 560 && canShowMap { ensureMap(); updateMap() }
        needsLayout = true; needsDisplay = true
    }
    func deactivate() { releaseTimer?.invalidate(); releaseTimer=nil; map?.removeFromSuperview(); map=nil; lastMapKey="" }

    override func layout() {
        super.layout(); let enhanced = bounds.width >= 600 && bounds.height >= 560
        if enhanced && canShowMap {
            releaseTimer?.invalidate(); releaseTimer=nil; ensureMap()
            let chart=max(110,bounds.height*0.25),strip:CGFloat=42,right=max(250,bounds.width*0.28)
            map?.frame=NSRect(x:0,y:chart+strip,width:bounds.width-right,height:bounds.height-72-chart-strip);map?.isHidden=false;updateMap()
        } else {
            map?.isHidden=true
            if map != nil && releaseTimer == nil { releaseTimer=Timer.scheduledTimer(withTimeInterval:15,repeats:false){[weak self]_ in self?.deactivate()} }
        }
    }
    private func ensureMap() {
        guard map == nil else { return }; let value=MKMapView(frame:.zero);value.delegate=self;value.mapType = .mutedStandard
        value.showsBuildings=false;value.showsCompass=false;value.isPitchEnabled=false;value.isRotateEnabled=false;value.pointOfInterestFilter = .excludingAll
        addSubview(value,positioned:.below,relativeTo:nil);map=value;lastMapKey="";lastMapUpdate = .distantPast
    }
    private func polygon(_ box:CellBox,_ title:String)->MKPolygon { var c=[CLLocationCoordinate2D(latitude:box.minLat,longitude:box.minLng),CLLocationCoordinate2D(latitude:box.minLat,longitude:box.maxLng),CLLocationCoordinate2D(latitude:box.maxLat,longitude:box.maxLng),CLLocationCoordinate2D(latitude:box.maxLat,longitude:box.minLng)];let p=MKPolygon(coordinates:&c,count:c.count);p.title=title;return p }
    private func updateMap() {
        guard canShowMap,let map,map.bounds.width > 10,map.bounds.height > 10,let status=record?.poi,let box=status.bbox else{return}
        let children=(status.children ?? []).map{"\($0.centerLat),\($0.centerLng)"}.joined(separator:";")
        let key="\(record?.key.id ?? "")|\(box.minLat)|\(box.maxLat)|\(box.minLng)|\(box.maxLng)|\(children)"
        guard key != lastMapKey,Date().timeIntervalSince(lastMapUpdate)>=1.5 else{return};lastMapKey=key;lastMapUpdate=Date();map.removeOverlays(map.overlays)
        for child in status.children ?? [] {map.addOverlay(polygon(child,"child"))};map.addOverlay(polygon(box,"current"))
        let center=CLLocationCoordinate2D(latitude:box.centerLat,longitude:box.centerLng)
        if let old=previousCenter,abs(old.latitude-center.latitude)+abs(old.longitude-center.longitude)>0.000001 {var line=[old,center];let flight=MKPolyline(coordinates:&line,count:2);flight.title="flight";map.addOverlay(flight)}
        previousCenter=center;let lat=max(0.001,(box.maxLat-box.minLat)*1.35),lng=max(0.001,(box.maxLng-box.minLng)*1.35)
        map.setRegion(MKCoordinateRegion(center:center,span:MKCoordinateSpan(latitudeDelta:lat,longitudeDelta:lng)),animated:true)
    }
    func mapView(_ mapView:MKMapView,rendererFor overlay:MKOverlay)->MKOverlayRenderer {
        if let shape=overlay as? MKPolygon {let r=MKPolygonRenderer(polygon:shape),current=shape.title=="current";r.strokeColor=monitorRed.withAlphaComponent(current ? 0.95:0.48);r.fillColor=monitorRed.withAlphaComponent(current ? 0.13:0.025);r.lineWidth=current ? 2.2:1;return r}
        if let line=overlay as? MKPolyline {let r=MKPolylineRenderer(polyline:line);r.strokeColor=monitorRed.withAlphaComponent(0.9);r.lineWidth=2;r.lineDashPattern=[6,5];return r}
        return MKOverlayRenderer(overlay:overlay)
    }
    override func draw(_ dirtyRect:NSRect) {NSColor(calibratedWhite:0.018,alpha:1).setFill();bounds.fill();bounds.width>=600&&bounds.height>=560 ? drawEnhanced():drawCompact()}
    private func drawEnhanced() {
        let chart=max(110,bounds.height*0.25),strip:CGFloat=42,right=max(250,bounds.width*0.28),mapRight=bounds.width-right,status=record?.poi
        let activity = record?.activity ?? .offline, stateColor = activityColor(activity)
        NSColor(calibratedWhite:0.025,alpha:0.98).setFill();NSRect(x:0,y:bounds.height-72,width:bounds.width,height:72).fill();NSRect(x:mapRight,y:chart+strip,width:right,height:bounds.height-72-chart-strip).fill();NSRect(x:0,y:chart,width:bounds.width,height:strip).fill();NSRect(x:0,y:0,width:bounds.width,height:chart).fill();monitorSeparator(bounds.height-72);monitorSeparator(chart+strip);monitorSeparator(chart)
        monitorText(displayCity(record?.city),NSRect(x:22,y:bounds.height-49,width:bounds.width*0.28,height:28),17,.white)
        let sourceText = [record?.sourceSummary, areaProgress(status)].compactMap { $0 }.joined(separator:" · ")
        monitorText(sourceText.isEmpty ? "AUTO" : sourceText,NSRect(x:bounds.width*0.31,y:bounds.height-49,width:bounds.width*0.38,height:28),12,monitorGray,.center)
        let categoryProgress = status?.categoryIndex.map { "\($0) / \(status?.categoryTotal ?? 177)" } ?? "— / \(status?.categoryTotal ?? 177)"
        monitorText(categoryProgress,NSRect(x:bounds.width*0.70,y:bounds.height-49,width:bounds.width*0.25,height:28),17,.white,.right)
        if !canShowMap {
            let title: String
            switch activity {
            case .held: title = "WAITING FOR UPSTREAM TASK"
            case .queued: title = "WAITING IN PBS QUEUE"
            case .stale: title = "JOB RUNNING · MAP TELEMETRY UNAVAILABLE"
            case .error: title = "TASK ERROR"
            case .complete: title = "TASK COMPLETE"
            case .offline: title = "NO ACTIVE POI TASK"
            case .running: title = "WAITING FOR MAP TELEMETRY"
            }
            let area=NSRect(x:0,y:chart+strip,width:mapRight,height:bounds.height-72-chart-strip)
            monitorText(title,NSRect(x:area.minX+30,y:area.midY+4,width:area.width-60,height:28),15,stateColor,.center)
            monitorText(record?.freshnessText ?? "AUTO DISCOVERY",NSRect(x:area.minX+30,y:area.midY-30,width:area.width-60,height:22),10,monitorGray,.center)
        }
        let x=mapRight+28,w=right-54,top=bounds.height-120
        monitorText((status?.category ?? activity.rawValue).uppercased(),NSRect(x:x,y:top,width:w,height:28),16,.white)
        monitorText("DEPTH",NSRect(x:x,y:top-66,width:w,height:22),12,monitorGray);monitorText(status?.depth.map(String.init) ?? "—",NSRect(x:x,y:top-66,width:w,height:22),14,.white,.right)
        monitorText("ZOOM",NSRect(x:x,y:top-113,width:w,height:22),12,monitorGray);monitorText(status?.zoom.map(String.init) ?? "—",NSRect(x:x,y:top-113,width:w,height:22),14,.white,.right)
        let sizeText=status?.bbox.map { String(format:"%.2f KM",$0.sizeKm) } ?? "— KM"
        monitorText(sizeText,NSRect(x:x,y:top-160,width:w,height:22),13,.white)
        monitorText(status?.newPlaceIds.map { "+\($0) POIs" } ?? "— POIs",NSRect(x:x,y:top-207,width:w,height:23),14,stateColor)
        monitorText(status?.totalPlaceIds.map { "\(formatNumber($0)) TOTAL" } ?? "— TOTAL",NSRect(x:x,y:top-254,width:w,height:23),13,.white)
        monitorText(record?.freshnessText ?? "OFFLINE",NSRect(x:x,y:chart+strip+20,width:w,height:24),11,stateColor)
        let streamText = ["\(activity.rawValue)  •  \(sourceCount) TASKS", areaProgress(status)].compactMap { $0 }.joined(separator:"  •  ")
        monitorText("QUADTREE",NSRect(x:22,y:chart+12,width:105,height:20),11,monitorRed);monitorText(streamText,NSRect(x:145,y:chart+12,width:400,height:20),11,.white)
        monitorText("● \(activity.rawValue)",NSRect(x:bounds.width-178,y:chart+12,width:156,height:20),11,stateColor,.right)
        monitorChart(metric.points,NSRect(x:20,y:18,width:bounds.width-40,height:chart-48));monitorText("POI yield / min",NSRect(x:22,y:chart-28,width:160,height:19),10,monitorRed)
    }
    private func drawCompact() {
        let s=record?.poi,activity=record?.activity ?? .offline
        monitorText(String(format:"%.1f/min",metric.rate ?? 0),NSRect(x:12,y:bounds.height-42,width:130,height:28),18,.white)
        let progress=s?.categoryIndex.map { "\($0)/\(s?.categoryTotal ?? 177)" } ?? "—/\(s?.categoryTotal ?? 177)"
        monitorText("\(progress)  •  \(activity.rawValue)",NSRect(x:145,y:bounds.height-39,width:bounds.width-157,height:22),10,activityColor(activity),.right)
        let depth=s?.depth.map { "D\($0)" },zoom=s?.zoom.map { "Z\($0)" },total=s?.totalPlaceIds.map { "\(formatNumber($0)) POIs" }
        let meta=[record?.key.location.rawValue,record?.unit,record?.jobState,areaProgress(s),displayCity(record?.city),s?.category,depth,zoom,total].compactMap{$0}.joined(separator:"  ·  ")
        monitorText(meta,NSRect(x:12,y:bounds.height-68,width:bounds.width-24,height:19),9.5,monitorGray);monitorChart(metric.points,NSRect(x:10,y:10,width:bounds.width-20,height:max(30,bounds.height-88)))
    }
}

private final class ReviewDashboard: NSView, MKMapViewDelegate {
    private var record:ProbeRecord?,metric=MetricState(rate:nil,points:[]),sourceCount=0,map:MKMapView?,releaseTimer:Timer?,previous:CLLocationCoordinate2D?,lastMapKey=""
    override var isOpaque:Bool{true}
    private var canShowMap:Bool{record?.hasFreshTelemetry == true && record?.review?.latitude != nil && record?.review?.longitude != nil}
    func update(_ record:ProbeRecord?,metric:MetricState?,sourceCount:Int){self.record=record;self.metric=metric ?? MetricState(rate:nil,points:[]);self.sourceCount=sourceCount;if bounds.width>=600&&bounds.height>=560&&canShowMap{ensureMap();updateMap()};needsLayout=true;needsDisplay=true}
    func deactivate(){releaseTimer?.invalidate();releaseTimer=nil;map?.removeFromSuperview();map=nil;lastMapKey=""}
    override func layout(){super.layout();let enhanced=bounds.width>=600&&bounds.height>=560;if enhanced&&canShowMap{releaseTimer?.invalidate();releaseTimer=nil;ensureMap();let chart=max(100,bounds.height*0.25),strip:CGFloat=42,right=max(300,bounds.width*0.39);map?.frame=NSRect(x:0,y:chart+strip,width:bounds.width-right,height:bounds.height-72-chart-strip);map?.isHidden=false;updateMap()}else{map?.isHidden=true;if map != nil&&releaseTimer==nil{releaseTimer=Timer.scheduledTimer(withTimeInterval:15,repeats:false){[weak self]_ in self?.deactivate()}}}}
    private func ensureMap(){guard map==nil else{return};let v=MKMapView(frame:.zero);v.delegate=self;v.mapType = .mutedStandard;v.showsBuildings=false;v.showsCompass=false;v.isPitchEnabled=false;v.isRotateEnabled=false;v.pointOfInterestFilter = .excludingAll;addSubview(v,positioned:.below,relativeTo:nil);map=v;lastMapKey=""}
    private func updateMap(){guard canShowMap,let map,map.bounds.width > 10,map.bounds.height > 10,let lat=record?.review?.latitude,let lng=record?.review?.longitude else{return};let key="\(record?.key.id ?? "")|\(lat)|\(lng)";guard key != lastMapKey else{return};lastMapKey=key;map.removeOverlays(map.overlays);let center=CLLocationCoordinate2D(latitude:lat,longitude:lng);if let old=previous{var line=[old,center];let flight=MKPolyline(coordinates:&line,count:2);flight.title="flight";map.addOverlay(flight)};map.addOverlay(MKCircle(center:center,radius:120));previous=center;map.setRegion(MKCoordinateRegion(center:center,latitudinalMeters:5500,longitudinalMeters:5500),animated:true)}
    func mapView(_ mapView:MKMapView,rendererFor overlay:MKOverlay)->MKOverlayRenderer{if let circle=overlay as? MKCircle{let r=MKCircleRenderer(circle:circle);r.strokeColor=monitorRed;r.fillColor=monitorRed.withAlphaComponent(0.18);r.lineWidth=2;return r};if let line=overlay as? MKPolyline{let r=MKPolylineRenderer(polyline:line);r.strokeColor=monitorRed.withAlphaComponent(0.9);r.lineWidth=2;r.lineDashPattern=[6,5];return r};return MKOverlayRenderer(overlay:overlay)}
    override func draw(_ dirtyRect:NSRect){NSColor(calibratedWhite:0.018,alpha:1).setFill();bounds.fill();bounds.width>=600&&bounds.height>=560 ? drawEnhanced():drawCompact()}
    private func drawEnhanced(){let chart=max(100,bounds.height*0.25),strip:CGFloat=42,right=max(300,bounds.width*0.39),mapRight=bounds.width-right,s=record?.review,activity=record?.activity ?? .offline,stateColor=activityColor(activity);NSColor(calibratedWhite:0.025,alpha:0.98).setFill();NSRect(x:0,y:bounds.height-72,width:bounds.width,height:72).fill();NSRect(x:mapRight,y:chart+strip,width:right,height:bounds.height-72-chart-strip).fill();NSRect(x:0,y:chart,width:bounds.width,height:strip).fill();NSRect(x:0,y:0,width:bounds.width,height:chart).fill();monitorSeparator(bounds.height-72);monitorSeparator(chart+strip);monitorSeparator(chart)
        monitorText(displayCity(record?.city),NSRect(x:22,y:bounds.height-49,width:bounds.width*0.28,height:28),17,.white);monitorText(record?.sourceSummary ?? "AUTO",NSRect(x:bounds.width*0.31,y:bounds.height-49,width:bounds.width*0.38,height:28),12,monitorGray,.center)
        let progress=(s?.total ?? 0)>0 ? "\(formatNumber(record?.amount ?? 0)) / \(formatNumber(s?.total ?? 0))" : activity.rawValue
        monitorText(progress,NSRect(x:bounds.width*0.62,y:bounds.height-49,width:bounds.width*0.33,height:28),15,stateColor,.right)
        if !canShowMap {
            let title: String
            switch activity {case .held:title="WAITING FOR POI SEARCH";case .queued:title="WAITING IN PBS QUEUE";case .stale:title="REVIEW TELEMETRY UNAVAILABLE";case .error:title="REVIEW TASK ERROR";case .complete:title="REVIEWS COMPLETE";case .offline:title="NO ACTIVE REVIEW TASK";case .running:title="WAITING FOR POI LOCATION"}
            let area=NSRect(x:0,y:chart+strip,width:mapRight,height:bounds.height-72-chart-strip)
            monitorText(title,NSRect(x:area.minX+28,y:area.midY+4,width:area.width-56,height:28),15,stateColor,.center)
            let subtitle = activity == .held ? (s?.phase ?? "PBS DEPENDENCY HOLD").replacingOccurrences(of:"_",with:" ").uppercased() : (record?.freshnessText ?? "AUTO DISCOVERY")
            monitorText(subtitle,NSRect(x:area.minX+28,y:area.midY-30,width:area.width-56,height:22),10,monitorGray,.center)
        }
        let x=mapRight+25,w=right-48,top=bounds.height-119;monitorText(s?.name ?? "Waiting for POI",NSRect(x:x,y:top,width:w,height:28),16,.white,.left,system:true);monitorText(s?.categories?.joined(separator:" · ") ?? "—",NSRect(x:x,y:top-35,width:w,height:23),12,monitorGray,.left,system:true)
        let coord=(s?.latitude != nil && s?.longitude != nil) ? String(format:"%.5f, %.5f",s!.latitude!,s!.longitude!):"—";monitorText(coord,NSRect(x:x,y:top-78,width:w,height:22),11,monitorGray)
        monitorText("\(activity.rawValue)  ·  \(s?.fetchedReviews ?? 0) / \(s?.expectedReviews ?? 0) REVIEWS",NSRect(x:x,y:top-111,width:w,height:22),10,stateColor)
        let latest=s?.latestReview;let rating=latest?.rating.map{String(format:"%.0f/5",$0)} ?? "—";monitorText("LATEST REVIEW  \(rating)",NSRect(x:x,y:top-158,width:w,height:20),10,stateColor);monitorText(latest?.text ?? (activity == .held ? "Review job is held until POI search completes." : "Waiting for the next review…"),NSRect(x:x,y:top-230,width:w,height:70),12,.white,.left,system:true)
        let processSummary = record?.processSummary ?? "WAITING"
        monitorText("REVIEW STREAM",NSRect(x:22,y:chart+12,width:125,height:20),11,monitorRed);monitorText("\(sourceCount) TASKS  •  \(processSummary)",NSRect(x:160,y:chart+12,width:360,height:20),11,.white);monitorText("● \(activity.rawValue)",NSRect(x:bounds.width-178,y:chart+12,width:156,height:20),11,stateColor,.right)
        monitorChart(metric.points,NSRect(x:20,y:18,width:bounds.width-40,height:chart-48));monitorText("reviews / min",NSRect(x:22,y:chart-28,width:190,height:19),10,monitorRed)
    }
    private func drawCompact(){let s=record?.review,activity=record?.activity ?? .offline;monitorText(String(format:"%.2f/min",metric.rate ?? 0),NSRect(x:12,y:bounds.height-42,width:135,height:28),18,.white);let progress=(s?.total ?? 0)>0 ? "\(formatNumber(record?.amount ?? 0))/\(formatNumber(s?.total ?? 0))" : "—";monitorText("\(progress)  •  \(activity.rawValue)",NSRect(x:150,y:bounds.height-39,width:bounds.width-162,height:22),10,activityColor(activity),.right);let meta=[record?.key.location.rawValue,record?.unit,record?.jobState,displayCity(record?.city),s?.categories?.first,s?.name].compactMap{$0}.joined(separator:"  ·  ");monitorText(meta,NSRect(x:12,y:bounds.height-68,width:bounds.width-24,height:19),9.5,monitorGray);monitorChart(metric.points,NSRect(x:10,y:10,width:bounds.width-20,height:max(30,bounds.height-88)))}
}

/// Generic view used by ALL TASKS. It guarantees that every project
/// process is visible even when that task has not adopted the optional common
/// progress sidecar yet.
private final class TaskDashboard: NSView {
    private var record: ProbeRecord?, metric = MetricState(rate: nil, points: []), sourceCount = 0
    override var isOpaque: Bool { true }
    func update(_ record: ProbeRecord?, metric: MetricState?, sourceCount: Int) {
        self.record = record; self.metric = metric ?? MetricState(rate: nil, points: []); self.sourceCount = sourceCount
        toolTip = record?.command
        needsDisplay = true
    }
    private func duration(_ seconds: Int) -> String {
        if seconds >= 86_400 { return String(format: "%dd %02d:%02d", seconds / 86_400, seconds / 3_600 % 24, seconds / 60 % 60) }
        return String(format: "%02d:%02d:%02d", seconds / 3_600, seconds / 60 % 60, seconds % 60)
    }
    private func amountText(_ value: Int, unit: String) -> String {
        guard unit.lowercased() == "bytes" else { return formatNumber(value) }
        if value == 0 { return "0 KB" }
        return ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file)
    }
    private func rateText() -> String {
        let value = metric.rate ?? 0, unit = record?.measureUnit ?? "items"
        if unit.lowercased() == "bytes" {
            if value == 0 { return "0 KB/min" }
            return "\(ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file))/min"
        }
        return String(format: value >= 100 ? "%.0f %@/min" : "%.2f %@/min", value, unit)
    }
    private func progress() -> (Int, Int) {
        guard let record else { return (0, 0) }
        if let task = record.task, let completed = task.completed { return (completed, task.total ?? record.progressTotal) }
        if record.key.stage == .poi {
            if let overall = overallPOIProgress(record.poi) { return overall }
            return (record.poi?.categoryIndex ?? 0, record.poi?.categoryTotal ?? record.progressTotal)
        }
        if record.key.stage == .reviews { return (record.amount, record.review?.total ?? record.progressTotal) }
        return (record.amount, record.progressTotal)
    }
    private func phase() -> String {
        record?.activity.rawValue ?? "OFFLINE"
    }
    private func currentItem() -> String {
        record?.task?.currentItem ?? record?.task?.message ?? record?.poi?.category ?? record?.review?.name ?? "Progress detail unavailable"
    }
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedWhite: 0.018, alpha: 1).setFill(); bounds.fill()
        bounds.width >= 600 && bounds.height >= 360 ? drawEnhanced() : drawCompact()
    }
    private func drawEnhanced() {
        let (completed, total) = progress(), chart = max(120, bounds.height * 0.30)
        let activity = record?.activity ?? .offline, stateColor = activityColor(activity)
        NSColor(calibratedWhite: 0.025, alpha: 0.98).setFill()
        NSRect(x: 0, y: bounds.height - 76, width: bounds.width, height: 76).fill()
        NSRect(x: 0, y: 0, width: bounds.width, height: chart).fill()
        monitorSeparator(bounds.height - 76); monitorSeparator(chart)
        monitorText((record?.taskType ?? "WAITING").replacingOccurrences(of: "_", with: " ").uppercased(),
                    NSRect(x: 22, y: bounds.height - 51, width: bounds.width * 0.32, height: 28), 17, .white)
        monitorText(record?.sourceSummary ?? "AUTO DISCOVERY", NSRect(x: bounds.width * 0.34, y: bounds.height - 49,
                    width: bounds.width * 0.34, height: 24), 11, monitorGray, .center)
        let progressLabel = record == nil ? "OUTPUT  —" : (total > 0 ? "\(formatNumber(completed)) / \(formatNumber(total))" : "OUTPUT  \(amountText(record?.amount ?? 0, unit: record?.measureUnit ?? "items"))")
        monitorText(progressLabel, NSRect(x: bounds.width * 0.69, y: bounds.height - 51, width: bounds.width * 0.27, height: 28), 16, .white, .right)

        let x: CGFloat = 28, top = bounds.height - 125, width = bounds.width - 56
        monitorText((record?.city ?? "project").replacingOccurrences(of: "_", with: " ").uppercased(),
                    NSRect(x: x, y: top, width: width * 0.42, height: 28), 16, .white)
        monitorText(phase().uppercased(), NSRect(x: x + width * 0.45, y: top, width: width * 0.55, height: 28), 13, stateColor, .right)
        monitorText(currentItem(), NSRect(x: x, y: top - 45, width: width, height: 26), 14, .white, .left, system: true)
        monitorText("RUNTIME  \(duration(record?.elapsedSeconds ?? 0))", NSRect(x: x, y: top - 87, width: width * 0.45, height: 22), 11, monitorGray)
        monitorText(record?.processSummary ?? "WAITING", NSRect(x: x + width * 0.5, y: top - 87, width: width * 0.5, height: 22), 11, monitorGray, .right)

        if total > 0 {
            let bar = NSRect(x: x, y: top - 128, width: width, height: 7)
            NSColor(calibratedWhite: 0.15, alpha: 1).setFill(); bar.fill()
            let ratio = max(0, min(1, CGFloat(completed) / CGFloat(total)))
            monitorRed.setFill(); NSRect(x: bar.minX, y: bar.minY, width: bar.width * ratio, height: bar.height).fill()
        }
        let entry = record.map { "ENTRY  \($0.commandSummary)\nOUTPUT  \($0.path)" } ?? "Waiting for a project task…"
        monitorText(entry, NSRect(x: x, y: chart + 22, width: width, height: max(35, top - 178 - chart)), 11, monitorGray, .left, system: true)
        monitorText("\(sourceCount) ACTIVE TASKS", NSRect(x: 22, y: chart - 28, width: 180, height: 20), 10, monitorRed)
        monitorText(rateText(), NSRect(x: bounds.width - 250, y: chart - 30, width: 226, height: 22), 12, .white, .right)
        monitorChart(metric.points, NSRect(x: 20, y: 18, width: bounds.width - 40, height: chart - 56))
    }
    private func drawCompact() {
        let (completed, total) = progress()
        monitorText(rateText(), NSRect(x: 12, y: bounds.height - 42, width: bounds.width * 0.48, height: 28), 17, .white)
        let progressLabel = total > 0 ? "\(formatNumber(completed))/\(formatNumber(total))" : "OUT \(amountText(record?.amount ?? 0, unit: record?.measureUnit ?? "items"))"
        monitorText("\(progressLabel)  •  \(sourceCount) TASKS", NSRect(x: bounds.width * 0.47, y: bounds.height - 39,
                    width: bounds.width * 0.5 - 12, height: 22), 10, monitorGray, .right)
        let meta = [record?.key.location.rawValue, record?.taskType.uppercased(), displayCity(record?.city), phase().uppercased()].compactMap { $0 }.joined(separator: "  ·  ")
        monitorText(meta, NSRect(x: 12, y: bounds.height - 68, width: bounds.width - 24, height: 19), 9.5, monitorGray)
        monitorChart(metric.points, NSRect(x: 10, y: 10, width: bounds.width - 20, height: max(30, bounds.height - 88)))
    }
}

private final class RootView:NSView {
    private let stageControl=NSSegmentedControl(labels:navigationStages.map(\.rawValue),trackingMode:.selectOne,target:nil,action:nil)
    private let sourceMenu=NSPopUpButton(frame:.zero,pullsDown:false),endpointLabel=NSTextField(labelWithString:"AUTO DISCOVERY")
    private let poiView=POIDashboard(),reviewView=ReviewDashboard(),taskView=TaskDashboard(),resourceView=ResourceDashboard(),store:MetricStore
    private var records:[ProbeRecord]=[],states:[SourceKey:MetricState]=[:],selected:SourceKey?,stage:Stage = .all,online:[Location:Bool]=[:]
    private var resourceOnline:[ResourceStation:Bool]=[:]
    init(frame:NSRect,store:MetricStore){self.store=store;super.init(frame:frame);wantsLayer=true;stageControl.selectedSegment=0;stageControl.target=self;stageControl.action = #selector(stageChanged);sourceMenu.target=self;sourceMenu.action = #selector(sourceChanged);endpointLabel.textColor=monitorGray;endpointLabel.font = .monospacedSystemFont(ofSize:10,weight:.regular);endpointLabel.alignment = .right;addSubview(stageControl);addSubview(sourceMenu);addSubview(endpointLabel);showDashboard()}
    required init?(coder:NSCoder){fatalError()}
    override func layout(){super.layout();let resourceMode=stage == .resources,narrowResource=resourceMode && bounds.width<720,twoRows=bounds.width<900 && !resourceMode,header:CGFloat=twoRows ? 76:44,top=bounds.height-38;stageControl.frame=NSRect(x:12,y:top,width:resourceMode ? (narrowResource ? bounds.width-24:min(440,bounds.width-190)):(twoRows ? bounds.width-24:430),height:28);sourceMenu.isHidden=resourceMode;endpointLabel.isHidden=narrowResource;if twoRows{sourceMenu.frame=NSRect(x:12,y:bounds.height-72,width:max(220,bounds.width-150),height:28);endpointLabel.frame=NSRect(x:bounds.width-132,y:bounds.height-68,width:118,height:20)}else{sourceMenu.frame=NSRect(x:454,y:top,width:max(180,bounds.width-680),height:28);endpointLabel.frame=NSRect(x:bounds.width-220,y:top+4,width:205,height:20)};let frame=NSRect(x:0,y:0,width:bounds.width,height:bounds.height-header);poiView.frame=frame;reviewView.frame=frame;taskView.frame=frame;resourceView.frame=frame}
    func update(records:[ProbeRecord],online:[Location:Bool]){self.online=online;self.records=records;for record in records{states[record.key]=store.add(record)};refreshResourceProgress();refreshMenu();refreshDashboard();refreshEndpoint()}
    func update(resources:[WorkstationSnapshot]){resourceView.update(resources);resourceOnline=Dictionary(uniqueKeysWithValues:resources.map{($0.station,$0.online)});refreshEndpoint()}
    @objc private func stageChanged(){stage=navigationStages[stageControl.selectedSegment];selected=nil;showDashboard();refreshMenu();refreshDashboard();refreshEndpoint();needsLayout=true;layoutSubtreeIfNeeded();displayIfNeeded();window?.displayIfNeeded()}
    @objc private func sourceChanged(){let options=stageRecords();let index=sourceMenu.indexOfSelectedItem;if options.indices.contains(index){selected=options[index].key};refreshDashboard();needsLayout=true;layoutSubtreeIfNeeded();displayIfNeeded();window?.displayIfNeeded()}
    private func stageRecords()->[ProbeRecord]{
        let rank:[Location:Int] = [.local:0,.chark:1,.remote:2,.atlas:3]
        return records.filter{stage != .resources && (stage == .all || $0.key.stage==stage)}.sorted{a,b in
            if a.key.location != b.key.location{return (rank[a.key.location] ?? 9) < (rank[b.key.location] ?? 9)}
            if a.city != b.city{return a.city < b.city}
            return a.key.pid < b.key.pid
        }
    }
    private func refreshEndpoint(){
        let atlasCount=records.filter{$0.key.location == .atlas && (stage == .all || $0.key.stage == stage)}.count
        let local=online[.local]==true ? "L✓":"L—"
        let chark=(resourceOnline[.chark]==true || online[.chark]==true) ? "C✓":"C—"
        let strix=(resourceOnline[.strix]==true || online[.remote]==true) ? "S✓":"S—"
        let atlas=(resourceOnline[.atlas]==true || online[.atlas]==true) ? "A✓":"A—"
        endpointLabel.stringValue=stage == .resources ? "\(chark)  \(strix)  \(atlas)" : "\(local)  \(chark)  \(strix)  \(atlas) \(atlasCount)"
    }
    // LOCAL has no workstation card in the resource view; every remote endpoint
    // maps onto the station it actually runs on.
    private func resourceStation(_ location:Location)->ResourceStation?{
        switch location{case .chark:return .chark;case .remote:return .strix;case .atlas:return .atlas;case .local:return nil}
    }
    private func refreshResourceProgress(){
        var grouped:[String:[ProbeRecord]] = [:]
        for record in records {
            guard let station=resourceStation(record.key.location) else{continue}
            let identifier=record.jobID ?? String(record.key.pid)
            grouped["\(station.rawValue):\(identifier)",default:[]].append(record)
        }
        let seeds:[TaskProgressSeed]=grouped.values.compactMap{values in
            guard let first=values.first,let station=resourceStation(first.key.location) else{return nil}
            let identifier=first.jobID ?? String(first.key.pid)
            var completed=0,total=0
            for record in values {
                if record.key.stage == .reviews { completed += record.review?.index ?? 0; total += record.review?.total ?? 0 }
                else if record.key.stage == .poi {
                    if let overall = overallPOIProgress(record.poi) { completed += overall.completed; total += overall.total }
                    else { completed += record.poi?.categoryIndex ?? 0; total += record.poi?.categoryTotal ?? 0 }
                }
                else { completed += record.task?.completed ?? 0; total += record.task?.total ?? 0 }
            }
            guard total>0 else{return nil}
            let city=first.city.replacingOccurrences(of:"_",with:" ")
            let kind=first.key.stage == .reviews ? "reviews":(first.key.stage == .poi ? "POI search":first.taskType)
            return TaskProgressSeed(station:station,owner:station == .atlas ? "haoxi.yuan":"haoxi",identifier:identifier,name:"\(city) · \(kind)",completed:completed,total:total,elapsedSeconds:values.map(\.elapsedSeconds).max() ?? 0,state:first.activity.rawValue)
        }
        resourceView.updateProgress(seeds)
    }
    private func refreshMenu(){let options=stageRecords();if !options.contains(where:{$0.key==selected}){selected=options.first?.key};sourceMenu.removeAllItems();if options.isEmpty{sourceMenu.addItem(withTitle:"NO ACTIVE \(stage.rawValue) PROCESS");sourceMenu.isEnabled=false}else{sourceMenu.addItems(withTitles:options.map{$0.label});sourceMenu.isEnabled=true;if let selected,let i=options.firstIndex(where:{$0.key==selected}){sourceMenu.selectItem(at:i)}}}
    private func showDashboard(){poiView.removeFromSuperview();reviewView.removeFromSuperview();taskView.removeFromSuperview();resourceView.removeFromSuperview();if stage == .poi{reviewView.deactivate();addSubview(poiView,positioned:.below,relativeTo:stageControl)}else if stage == .reviews{poiView.deactivate();addSubview(reviewView,positioned:.below,relativeTo:stageControl)}else if stage == .resources{poiView.deactivate();reviewView.deactivate();addSubview(resourceView,positioned:.below,relativeTo:stageControl)}else{poiView.deactivate();reviewView.deactivate();addSubview(taskView,positioned:.below,relativeTo:stageControl)};needsLayout=true;layoutSubtreeIfNeeded();displayIfNeeded()}
    private func refreshDashboard(){let options=stageRecords(),record=options.first(where:{$0.key==selected}),metric=record.flatMap{states[$0.key]};if stage == .poi{poiView.update(record,metric:metric,sourceCount:options.count)}else if stage == .reviews{reviewView.update(record,metric:metric,sourceCount:options.count)}else{taskView.update(record,metric:metric,sourceCount:options.count)}}
}

private final class AppDelegate:NSObject,NSApplicationDelegate {
    private let config:Config,coordinator:DiscoveryCoordinator,resourceCoordinator:ResourceCoordinator,store:MetricStore;private var window:NSWindow?,rootView:RootView?
    init(_ config:Config){self.config=config;coordinator=DiscoveryCoordinator(config);resourceCoordinator=ResourceCoordinator(charkHost:config.charkHost,strixHost:config.host,atlasHost:config.atlasHost,atlasRoot:config.atlasRoot,interval:config.resourceInterval,atlasInterval:config.atlasInterval);store=MetricStore(minutes:config.chartMinutes)}
    func applicationDidFinishLaunching(_ notification:Notification){NSApp.appearance=NSAppearance(named:.darkAqua);if let url=Bundle.main.url(forResource:"app-icon",withExtension:"png"),let icon=NSImage(contentsOf:url){NSApp.applicationIconImage=icon};let w=NSWindow(contentRect:NSRect(x:0,y:0,width:1080,height:720),styleMask:[.titled,.closable,.miniaturizable,.resizable],backing:.buffered,defer:false);w.title="Scraper Monitor";w.minSize=NSSize(width:420,height:235);w.level = .floating;w.backgroundColor=NSColor(calibratedWhite:0.018,alpha:1);w.isMovableByWindowBackground=true;w.collectionBehavior=[.canJoinAllSpaces,.fullScreenAuxiliary];w.setFrameAutosaveName("UnifiedScraperMonitorV1");let root=RootView(frame:w.contentView?.bounds ?? .zero,store:store);root.autoresizingMask=[.width,.height];w.contentView=root;if !w.setFrameUsingName("UnifiedScraperMonitorV1"){w.center()};root.frame=w.contentView?.bounds ?? root.frame;root.needsLayout=true;root.layoutSubtreeIfNeeded();root.displayIfNeeded();w.makeKeyAndOrderFront(nil);NSApp.activate(ignoringOtherApps:true);window=w;rootView=root;coordinator.onUpdate={[weak root] records,online in root?.update(records:records,online:online)};resourceCoordinator.onUpdate={[weak root] values in root?.update(resources:values)};coordinator.start();resourceCoordinator.start()}
    func applicationShouldTerminateAfterLastWindowClosed(_ sender:NSApplication)->Bool{true}
    func applicationShouldHandleReopen(_ sender:NSApplication,hasVisibleWindows flag:Bool)->Bool{if !flag{window?.makeKeyAndOrderFront(nil)};return true}
    func applicationWillTerminate(_ notification:Notification){coordinator.stop();resourceCoordinator.stop()}
}

@main
private enum ScraperMonitorMain {
    static func main() {
        let config=Config.parse(CommandLine.arguments)
        let application=NSApplication.shared
        let delegate=AppDelegate(config)
        application.delegate=delegate
        application.run()
    }
}
