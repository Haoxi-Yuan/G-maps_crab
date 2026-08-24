import React, { useEffect, useMemo, useState } from 'react';
import { Radar, Play, Upload, Search, Download, ChevronRight, X, Clock, BarChart3, AlertCircle, Square, RotateCcw } from 'lucide-react';
import { Card, SectionTitle, Label, Input, Button } from '../shared/UIComponents';
import { useMonitor } from '../../hooks/useMonitor';
import api from '../../services/api';

export function POIMonitorView({ onTaskStarted }) {
  const {
    stats, scans, changes, selectedScan, loading, toast, meta,
    selectedCity, availableCities, setSelectedCity,
    scanTask, checkpoint, checkpoints,
    startScan, resumeScanTask, resumeFromCheckpoint, stopScanTask,
    startImport, startDiscover, selectScan, loadChanges, clearToast
  } = useMonitor();

  const [importSource, setImportSource] = useState('');
  const [importFormat, setImportFormat] = useState('auto');
  const [scanLimit, setScanLimit] = useState('');
  const [discoverCategories, setDiscoverCategories] = useState('');
  const [discoverCellSize, setDiscoverCellSize] = useState('2000');
  const [discoverLimit, setDiscoverLimit] = useState('');

  useEffect(() => {
    if (!importSource && meta.defaultBaselineSource) {
      setImportSource(meta.defaultBaselineSource);
    }
  }, [importSource, meta.defaultBaselineSource]);

  const cityOptions = useMemo(() => {
    const all = new Set(['ALL', selectedCity, meta.defaultCity, ...availableCities].filter(Boolean));
    return Array.from(all);
  }, [selectedCity, meta.defaultCity, availableCities]);

  async function handleStartScan() {
    const config = { city: selectedCity || meta.defaultCity };
    if (scanLimit) config.limit = parseInt(scanLimit, 10);
    const taskId = await startScan(config);
    if (taskId && onTaskStarted) onTaskStarted(taskId);
  }

  async function handleResumeScan() {
    const taskId = await resumeScanTask();
    if (taskId && onTaskStarted) onTaskStarted(taskId);
  }

  async function handleResumeFromCheckpoint() {
    const taskId = await resumeFromCheckpoint();
    if (taskId && onTaskStarted) onTaskStarted(taskId);
  }

  const scanTaskResumable = scanTask && ['failed', 'stopped'].includes(scanTask.status);
  const scanTaskRunning = scanTask && ['running', 'paused'].includes(scanTask.status);
  const hasCheckpoints = checkpoints && checkpoints.length > 0;

  async function handleStartImport() {
    if (!importSource.trim()) return;
    const importCity = selectedCity === 'ALL' ? (meta.defaultCity || 'Singapore') : (selectedCity || meta.defaultCity);
    const taskId = await startImport({
      source: importSource.trim(),
      format: importFormat,
      city: importCity
    });
    if (taskId && onTaskStarted) onTaskStarted(taskId);
  }

  async function handleAutoImportDefault() {
    if (!meta.defaultBaselineSource) return;
    setImportSource(meta.defaultBaselineSource);
    const importCity = selectedCity === 'ALL' ? (meta.defaultCity || 'Singapore') : (selectedCity || meta.defaultCity);
    const taskId = await startImport({
      source: meta.defaultBaselineSource,
      format: 'auto',
      city: importCity
    });
    if (taskId && onTaskStarted) onTaskStarted(taskId);
  }

  async function handleStartDiscover() {
    const discoverCity = selectedCity === 'ALL' ? (meta.defaultCity || 'Singapore') : (selectedCity || meta.defaultCity);
    const config = { city: discoverCity };
    if (discoverCategories.trim()) config.categories = discoverCategories.trim();
    if (discoverCellSize) config.cellSize = parseInt(discoverCellSize, 10);
    if (discoverLimit) config.limit = parseInt(discoverLimit, 10);
    const taskId = await startDiscover(config);
    if (taskId && onTaskStarted) onTaskStarted(taskId);
  }

  const activePois = stats?.byStatus?.find(s => s.status === 'active')?.count || 0;
  const gonePois = stats?.byStatus?.find(s => s.status === 'gone')?.count || 0;
  const coverage = stats?.fieldCoverage || {};

  return (
    <div className="space-y-8">
      {toast && (
        <div className={`flex items-center justify-between px-4 py-3 border ${
          toast.level === 'error' ? 'bg-red-950/30 border-red-900/50 text-red-400'
            : 'bg-emerald-950/30 border-emerald-900/50 text-emerald-400'
        }`}>
          <div className="flex items-center space-x-2">
            <AlertCircle className="w-4 h-4" />
            <span className="text-sm">{toast.message}</span>
          </div>
          <button onClick={clearToast} className="text-zinc-500 hover:text-zinc-300"><X className="w-4 h-4" /></button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="space-y-6">
          <Card>
            <SectionTitle icon={BarChart3} title="Dashboard" description="POI database overview by city" />

            <div className="mb-4">
              <Label>City Scope</Label>
              <div className="flex items-center space-x-2">
                <select
                  value={selectedCity || meta.defaultCity || 'Singapore'}
                  onChange={e => setSelectedCity(e.target.value)}
                  className="w-full px-3 py-2 bg-zinc-950 border border-zinc-800 text-zinc-300 text-sm"
                >
                  {cityOptions.map(city => (
                    <option key={city} value={city}>{city === 'ALL' ? 'ALL (All Cities)' : city}</option>
                  ))}
                </select>
              </div>
            </div>

            {!stats ? (
              <p className="text-zinc-600 text-sm">No data yet. Import a baseline to begin.</p>
            ) : (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <StatBlock label="Total POIs" value={stats.totalPois} />
                  <StatBlock label="Active" value={activePois} />
                  <StatBlock label="Gone" value={gonePois} />
                  <StatBlock label="Last Scan" value={stats.lastScan?.scanId?.slice(-6) || '—'} small />
                </div>

                {stats.lastScan && (
                  <div className="pt-3 border-t border-zinc-800 space-y-1">
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-500">Last scan status</span>
                      <span className={stats.lastScan.status === 'completed' ? 'text-emerald-500' : 'text-yellow-500'}>
                        {stats.lastScan.status}
                      </span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-500">Changes detected</span>
                      <span className="text-zinc-300">{stats.lastScan.changedCount}</span>
                    </div>
                    <div className="flex justify-between text-xs">
                      <span className="text-zinc-500">Milestone window</span>
                      <span className="text-zinc-300">{formatMilestone(stats.lastScan.baselineMilestoneAt, stats.lastScan.startedAt)}</span>
                    </div>
                  </div>
                )}

                {coverage.total > 0 && (
                  <div className="pt-3 border-t border-zinc-800 space-y-2">
                    <p className="text-xs text-zinc-500 uppercase tracking-wider">Field Coverage</p>
                    <CoverageBar label="Rating" value={coverage.withRating} total={coverage.total} />
                    <CoverageBar label="Reviews" value={coverage.withReviewCount} total={coverage.total} />
                    <CoverageBar label="Hours" value={coverage.withOpeningHours} total={coverage.total} />
                    <CoverageBar label="Popular" value={coverage.withPopularTimes} total={coverage.total} />
                  </div>
                )}
              </div>
            )}
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <SectionTitle icon={Upload} title="Import Baseline" description="Load city baseline from scraper output or sqlite DB" />
            <div className="space-y-3">
              <div>
                <Label>Source path</Label>
                <Input
                  placeholder="/path/to/data.ndjson or /path/to/baseline.db"
                  value={importSource}
                  onChange={e => setImportSource(e.target.value)}
                />
              </div>
              <div>
                <Label>Format</Label>
                <div className="flex space-x-2">
                  {['auto', 'new', 'old', 'sqlite'].map(f => (
                    <button key={f} onClick={() => setImportFormat(f)}
                      className={`px-3 py-1.5 text-xs uppercase tracking-wider border ${
                        importFormat === f
                          ? 'bg-zinc-100 text-zinc-950 border-zinc-100'
                          : 'bg-zinc-950 text-zinc-500 border-zinc-800 hover:border-zinc-600'
                      }`}
                    >{f}</button>
                  ))}
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <Button icon={Upload} onClick={handleStartImport} className="w-full mt-2" disabled={loading || !importSource.trim()}>
                  Import Baseline
                </Button>
                <Button icon={Upload} variant="secondary" onClick={handleAutoImportDefault} className="w-full mt-2" disabled={loading || !meta.defaultBaselineSource}>
                  Auto Load Default
                </Button>
              </div>
              {meta.defaultBaselineSource && (
                <p className="text-xs text-zinc-600 break-all">Default: {meta.defaultBaselineSource}</p>
              )}
            </div>
          </Card>

          <Card>
            <SectionTitle icon={Radar} title="Run Scan" description="Detect incremental changes against previous milestone" />
            <div className="space-y-3">
              {/* Current scan task status */}
              {scanTask && (
                <div className={`px-3 py-2 border text-xs space-y-1 ${
                  scanTaskRunning ? 'bg-blue-950/20 border-blue-900/50' :
                  scanTaskResumable ? 'bg-amber-950/20 border-amber-900/50' :
                  'bg-zinc-900 border-zinc-800'
                }`}>
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-400 font-mono">{scanTask.task_id?.slice(-12)}</span>
                    <span className={`px-1.5 py-0.5 uppercase tracking-wider font-bold ${
                      scanTask.status === 'running' ? 'text-blue-400' :
                      scanTask.status === 'paused' ? 'text-yellow-400' :
                      scanTask.status === 'failed' ? 'text-red-400' :
                      scanTask.status === 'stopped' ? 'text-amber-400' :
                      scanTask.status === 'completed' ? 'text-emerald-400' :
                      'text-zinc-500'
                    }`}>{scanTask.status}</span>
                  </div>
                  {scanTask.progress_current != null && scanTask.progress_total > 0 && (
                    <div>
                      <div className="flex justify-between text-zinc-500 mb-1">
                        <span>{scanTask.progress_current?.toLocaleString()} / {scanTask.progress_total?.toLocaleString()}</span>
                        <span>{Math.round((scanTask.progress_current / scanTask.progress_total) * 100)}%</span>
                      </div>
                      <div className="h-1 bg-zinc-800 rounded-full overflow-hidden">
                        <div className="h-full bg-blue-500 rounded-full transition-all" style={{ width: `${Math.round((scanTask.progress_current / scanTask.progress_total) * 100)}%` }} />
                      </div>
                    </div>
                  )}
                  {scanTask.error && (
                    <p className="text-red-400 truncate">{scanTask.error}</p>
                  )}
                </div>
              )}

              {/* Available checkpoints from output directory */}
              {hasCheckpoints && (
                <div className="px-3 py-2 bg-zinc-900 border border-zinc-800 text-xs space-y-1">
                  <p className="text-zinc-400 font-medium mb-1">Checkpoints on disk ({checkpoints.length})</p>
                  {checkpoints.map((cp, i) => (
                    <div key={cp.file} className={`flex items-center justify-between py-1 ${i > 0 ? 'border-t border-zinc-800' : ''}`}>
                      <div className="text-zinc-500">
                        <span className="text-zinc-400 font-mono">{cp.file?.replace('.checkpoint.json', '')}</span>
                      </div>
                      <div className="text-zinc-500">
                        {cp.lastIndex?.toLocaleString()}/{cp.stats?.total?.toLocaleString()}
                        {' '}({Math.round(((cp.lastIndex + 1) / (cp.stats?.total || 1)) * 100)}%)
                        {' · '}{cp.stats?.scanned?.toLocaleString()} ok, {cp.stats?.changed?.toLocaleString()} chg
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div>
                <Label>Limit (optional)</Label>
                <Input type="number" placeholder="All POIs in selected city" value={scanLimit} onChange={e => setScanLimit(e.target.value)} />
              </div>

              {/* Action buttons based on task state */}
              {scanTaskRunning ? (
                <Button icon={Square} variant="secondary" onClick={stopScanTask} className="w-full" disabled={loading}>
                  Stop Scan
                </Button>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  {(scanTaskResumable || hasCheckpoints) && (
                    <Button icon={RotateCcw} onClick={scanTaskResumable ? handleResumeScan : handleResumeFromCheckpoint} className="w-full" disabled={loading}>
                      Resume
                    </Button>
                  )}
                  <Button icon={Play} variant={scanTaskResumable || hasCheckpoints ? 'secondary' : undefined} onClick={handleStartScan} className="w-full" disabled={loading || !selectedCity}>
                    {scanTaskResumable || hasCheckpoints ? 'New Scan' : `Start Scan (${selectedCity || meta.defaultCity || 'City'})`}
                  </Button>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <SectionTitle icon={Search} title="Discover POIs" description="Find new POIs for the selected city" />
            <div className="space-y-3">
              <div>
                <Label>City</Label>
                <Input value={selectedCity || meta.defaultCity || ''} disabled />
              </div>
              <div>
                <Label>Categories (comma-separated, optional)</Label>
                <Input placeholder="Restaurant,Cafe,Hotel" value={discoverCategories} onChange={e => setDiscoverCategories(e.target.value)} />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Cell size (m)</Label>
                  <Input type="number" value={discoverCellSize} onChange={e => setDiscoverCellSize(e.target.value)} />
                </div>
                <div>
                  <Label>Limit</Label>
                  <Input type="number" placeholder="No limit" value={discoverLimit} onChange={e => setDiscoverLimit(e.target.value)} />
                </div>
              </div>
              <Button icon={Search} variant="secondary" onClick={handleStartDiscover} className="w-full" disabled={loading || !selectedCity}>
                Start Discovery
              </Button>
            </div>
          </Card>
        </div>

        <div className="space-y-6">
          <Card>
            <SectionTitle icon={Clock} title="Scan History" description="Milestones for selected city" />

            {scans.length === 0 ? (
              <p className="text-zinc-600 text-sm">No scans yet.</p>
            ) : (
              <div className="space-y-1 max-h-64 overflow-y-auto">
                {scans.map(scan => (
                  <button key={scan.scanId} onClick={() => selectScan(scan.scanId)}
                    className={`w-full text-left px-3 py-2 flex items-center justify-between group transition-colors ${
                      selectedScan?.scanId === scan.scanId ? 'bg-zinc-800' : 'hover:bg-zinc-800/50'
                    }`}
                  >
                    <div>
                      <span className="text-zinc-300 text-xs font-mono">{scan.scanId}</span>
                      <div className="text-zinc-600 text-xs">{formatDate(scan.startedAt)} • {scan.city || 'N/A'}</div>
                      <div className="text-zinc-700 text-xs">{formatMilestone(scan.baselineMilestoneAt, scan.startedAt)}</div>
                    </div>
                    <div className="flex items-center space-x-3 text-xs">
                      <span className="text-zinc-500">{scan.scannedCount} scanned</span>
                      <span className={scan.changedCount > 0 ? 'text-amber-500' : 'text-zinc-600'}>
                        {scan.changedCount} changed
                      </span>
                      <ChevronRight className="w-3 h-3 text-zinc-700 group-hover:text-zinc-400" />
                    </div>
                  </button>
                ))}
              </div>
            )}
          </Card>

          {selectedScan && (
            <Card>
              <div className="flex items-center justify-between mb-4">
                <h4 className="text-zinc-100 text-sm font-mono">{selectedScan.scanId}</h4>
                <button onClick={() => selectScan(null)} className="text-zinc-600 hover:text-zinc-400">
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="mb-3 space-y-1 text-xs">
                <div><span className="text-zinc-600">City: </span><span className="text-zinc-300">{selectedScan.city || 'N/A'}</span></div>
                <div><span className="text-zinc-600">Milestone: </span><span className="text-zinc-300">{formatMilestone(selectedScan.baselineMilestoneAt, selectedScan.startedAt)}</span></div>
              </div>

              {selectedScan.summary && (
                <div className="grid grid-cols-2 gap-2 mb-4">
                  <MiniStat label="Scanned" value={selectedScan.summary.totalScanned} />
                  <MiniStat label="Changed" value={selectedScan.summary.totalChanged} />
                  <MiniStat label="Rating" value={selectedScan.summary.ratingChanged} />
                  <MiniStat label="Reviews" value={selectedScan.summary.reviewCountChanged} />
                  <MiniStat label="Hours" value={selectedScan.summary.openingHoursChanged} />
                  <MiniStat label="Gone" value={selectedScan.summary.gonePois} />
                </div>
              )}

              <div className="flex space-x-2">
                <a href={api.getMonitorReportDownloadUrl(selectedScan.scanId)}
                  className="flex items-center space-x-1 px-3 py-1.5 text-xs bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
                  download
                >
                  <Download className="w-3 h-3" />
                  <span>Report</span>
                </a>
                <a href={api.getMonitorPlaceIdsDownloadUrl(selectedScan.scanId)}
                  className="flex items-center space-x-1 px-3 py-1.5 text-xs bg-zinc-800 text-zinc-400 border border-zinc-700 hover:border-zinc-500 hover:text-zinc-200 transition-colors"
                  download
                >
                  <Download className="w-3 h-3" />
                  <span>Place IDs</span>
                </a>
              </div>

              {selectedScan.changes && selectedScan.changes.length > 0 && (
                <div className="mt-4 border-t border-zinc-800 pt-3 space-y-1 max-h-48 overflow-y-auto">
                  {selectedScan.changes.slice(0, 50).map((c, i) => (
                    <div key={i} className="text-xs py-1 border-b border-zinc-900">
                      <div className="flex items-center justify-between">
                        <span className="text-zinc-400 font-mono truncate max-w-[140px]">{c.placeId}</span>
                        <span className={`px-2 py-0.5 ${changeTypeColor(c.changeType)}`}>
                          {c.changeType}
                        </span>
                      </div>
                      <div className="text-zinc-700 mt-1">{formatMilestone(c.previousMilestoneAt, c.currentMilestoneAt)}</div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}

          <Card>
            <SectionTitle title="Recent Changes" description="Latest detected changes in current city scope" />
            {changes.changes.length === 0 ? (
              <p className="text-zinc-600 text-sm">No changes detected yet.</p>
            ) : (
              <>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {changes.changes.map((c, i) => (
                    <div key={i} className="text-xs py-1.5 border-b border-zinc-900">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2 truncate">
                          <span className="text-zinc-500 font-mono">{c.placeId?.slice(0, 12)}...</span>
                          {c.name && <span className="text-zinc-400 truncate max-w-[100px]">{c.name}</span>}
                        </div>
                        <span className={`px-2 py-0.5 whitespace-nowrap ${changeTypeColor(c.changeType)}`}>
                          {c.changeType}
                        </span>
                      </div>
                      <div className="text-zinc-700 mt-1">{formatMilestone(c.previousMilestoneAt, c.currentMilestoneAt)}</div>
                    </div>
                  ))}
                </div>
                {changes.totalPages > 1 && (
                  <div className="flex items-center justify-center space-x-2 pt-3">
                    <button
                      disabled={changes.page <= 1}
                      onClick={() => loadChanges(changes.page - 1, selectedCity)}
                      className="px-3 py-1 text-xs text-zinc-500 border border-zinc-800 hover:border-zinc-600 disabled:opacity-30"
                    >Prev</button>
                    <span className="text-xs text-zinc-600">{changes.page} / {changes.totalPages}</span>
                    <button
                      disabled={changes.page >= changes.totalPages}
                      onClick={() => loadChanges(changes.page + 1, selectedCity)}
                      className="px-3 py-1 text-xs text-zinc-500 border border-zinc-800 hover:border-zinc-600 disabled:opacity-30"
                    >Next</button>
                  </div>
                )}
              </>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

function StatBlock({ label, value, small }) {
  return (
    <div className="bg-zinc-950 border border-zinc-800 p-3">
      <div className="text-zinc-600 text-xs uppercase tracking-wider">{label}</div>
      <div className={`text-zinc-100 font-bold ${small ? 'text-sm' : 'text-xl'} mt-1`}>
        {typeof value === 'number' ? value.toLocaleString() : value}
      </div>
    </div>
  );
}

function CoverageBar({ label, value, total }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-zinc-500">{label}</span>
        <span className="text-zinc-400">{pct}%</span>
      </div>
      <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div className="h-full bg-zinc-400 rounded-full transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MiniStat({ label, value }) {
  return (
    <div className="text-xs">
      <span className="text-zinc-600">{label}: </span>
      <span className="text-zinc-300 font-mono">{value ?? 0}</span>
    </div>
  );
}

function formatDate(value) {
  if (!value) return 'N/A';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'N/A';
  return date.toLocaleString();
}

function formatMilestone(previousAt, currentAt) {
  const from = previousAt ? formatDate(previousAt) : 'initial baseline';
  const to = currentAt ? formatDate(currentAt) : 'current scan';
  return `${from} -> ${to}`;
}

function changeTypeColor(type) {
  switch (type) {
    case 'REVIEW_CHANGE': return 'text-blue-400 bg-blue-950/30';
    case 'HOURS_CHANGE': return 'text-amber-400 bg-amber-950/30';
    case 'POPULAR_TIMES_CHANGE': return 'text-purple-400 bg-purple-950/30';
    case 'MULTI_CHANGE': return 'text-orange-400 bg-orange-950/30';
    case 'POI_GONE': return 'text-red-400 bg-red-950/30';
    case 'NEW_POI': return 'text-emerald-400 bg-emerald-950/30';
    default: return 'text-zinc-400 bg-zinc-800';
  }
}
