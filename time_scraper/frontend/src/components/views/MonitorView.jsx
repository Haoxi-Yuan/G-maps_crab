import { useState, useEffect, useCallback } from 'react';
import { Pause, Play, Square, Terminal, Trash2, FileJson, PlayCircle } from 'lucide-react';
import { useTask } from '../../hooks/useTask';
import { Card, Button } from '../shared/UIComponents';
import api from '../../services/api';

export function MonitorView({ taskId, onTaskDeleted, onSwitchTask }) {
  const { task, loading, pause, resume, stop, deleteTask } = useTask(taskId);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [groupTasks, setGroupTasks] = useState([]);
  const [stoppingGroup, setStoppingGroup] = useState(false);

  const groupId = task?.config?.groupId;
  const isGroupTask = !!groupId;

  const loadGroupTasks = useCallback(async () => {
    if (!groupId) return;
    try {
      const res = await api.getTaskGroup(groupId);
      setGroupTasks(res.tasks || []);
    } catch (e) {
      console.error('Failed to load group tasks:', e);
    }
  }, [groupId]);

  useEffect(() => {
    if (!groupId) {
      setGroupTasks([]);
      return;
    }
    loadGroupTasks();
    const interval = setInterval(loadGroupTasks, 5000);
    return () => clearInterval(interval);
  }, [groupId, loadGroupTasks]);

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await deleteTask();
      setShowDeleteConfirm(false);
      if (onTaskDeleted) {
        onTaskDeleted(taskId);
      }
    } catch (err) {
      alert('Failed to delete task: ' + err.message);
    } finally {
      setIsDeleting(false);
    }
  };

  const handleConvert = async () => {
    setIsConverting(true);
    try {
      const result = await api.convertToJSON(taskId);
      alert(`Successfully converted to JSON!\n\nOutput: ${result.outputPath}\nRecords: ${result.recordCount}`);
    } catch (err) {
      alert('Failed to convert to JSON: ' + err.message);
    } finally {
      setIsConverting(false);
    }
  };

  const handleResumeFromCheckpoint = async () => {
    if (!confirm('Resume this task from the last saved checkpoint?\n\nThe task will continue from where it stopped.')) {
      return;
    }

    try {
      const result = await api.resumeFromCheckpoint(taskId);
      alert(`Task resumed successfully!\n\n${result.message}\n\nThe task is now running and will continue from checkpoint.`);
    } catch (err) {
      alert('Failed to resume from checkpoint: ' + err.message);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-zinc-500">Loading task...</div>
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-zinc-500">No task selected. Start a task from the Scraper Config tab.</div>
      </div>
    );
  }

  const formatETA = (seconds) => {
    if (!seconds) return 'Calculating...';
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  };

  const handleStopGroup = async () => {
    if (!groupId) return;
    setStoppingGroup(true);
    try {
      await api.stopTaskGroup(groupId);
      await loadGroupTasks();
    } catch (err) {
      alert('Failed to stop group: ' + err.message);
    } finally {
      setStoppingGroup(false);
    }
  };

  // Group aggregate stats
  const groupAgg = isGroupTask && groupTasks.length > 0 ? {
    current: groupTasks.reduce((s, t) => s + (t.progress?.current || 0), 0),
    total: groupTasks.reduce((s, t) => s + (t.progress?.total || 0), 0),
    success: groupTasks.reduce((s, t) => s + (t.stats?.success || 0), 0),
    failed: groupTasks.reduce((s, t) => s + (t.stats?.failed || 0), 0),
    reviews: groupTasks.reduce((s, t) => s + (t.stats?.reviews || 0), 0),
    images: groupTasks.reduce((s, t) => s + (t.stats?.images || 0), 0),
  } : null;

  const groupPercentage = groupAgg && groupAgg.total > 0
    ? Math.round((groupAgg.current / groupAgg.total) * 100)
    : 0;

  return (
    <div className="space-y-6 animate-in fade-in duration-500">

      {isGroupTask && groupTasks.length > 0 && (
        <div className="bg-zinc-900/60 border border-zinc-700 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-3">
              <span className="text-zinc-400 text-xs uppercase tracking-widest font-bold">
                Parallel Group: {task.config.groupLabel}
              </span>
              <span className="text-zinc-600 text-xs">
                {groupTasks.length} parts
              </span>
            </div>
            <div className="flex gap-2">
              {groupTasks.some(t => ['running', 'paused'].includes(t.status)) && (
                <button
                  onClick={handleStopGroup}
                  disabled={stoppingGroup}
                  className="px-3 py-1 text-xs border border-red-800 text-red-400 hover:bg-red-900/30 transition-colors disabled:opacity-50"
                >
                  {stoppingGroup ? 'Stopping...' : 'Stop All'}
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 mb-3">
            <div className="flex-1">
              <div className="w-full bg-zinc-800 h-1.5 rounded">
                <div
                  className="bg-zinc-300 h-1.5 rounded transition-all duration-500"
                  style={{ width: `${groupPercentage}%` }}
                />
              </div>
            </div>
            <span className="text-zinc-300 text-xs font-mono shrink-0">
              {groupAgg.current}/{groupAgg.total} ({groupPercentage}%)
            </span>
          </div>

          <div className="flex items-center gap-4 mb-3 text-xs text-zinc-500">
            <span>Success: <span className="text-zinc-200">{groupAgg.success}</span></span>
            <span>Failed: <span className="text-red-400">{groupAgg.failed}</span></span>
            <span>Reviews: <span className="text-zinc-200">{groupAgg.reviews.toLocaleString()}</span></span>
            <span>Images: <span className="text-zinc-200">{groupAgg.images.toLocaleString()}</span></span>
          </div>

          <div className="flex items-center gap-1.5 flex-wrap">
            {groupTasks
              .sort((a, b) => (a.config?.groupIndex || 0) - (b.config?.groupIndex || 0))
              .map(gt => {
                const dotColor =
                  gt.status === 'running' ? 'bg-green-500' :
                  gt.status === 'paused' ? 'bg-yellow-500' :
                  gt.status === 'completed' ? 'bg-blue-500' :
                  gt.status === 'failed' ? 'bg-red-500' :
                  'bg-zinc-600';
                const isCurrent = gt.task_id === taskId;
                const idx = (gt.config?.groupIndex ?? 0) + 1;
                return (
                  <button
                    key={gt.task_id}
                    onClick={() => onSwitchTask && onSwitchTask(gt.task_id)}
                    className={`
                      flex items-center gap-1.5 px-2 py-1 text-[11px] border transition-all
                      ${isCurrent
                        ? 'border-zinc-400 bg-zinc-800 text-zinc-100'
                        : 'border-zinc-800 text-zinc-500 hover:border-zinc-600'
                      }
                    `}
                    title={`Part ${idx}: ${gt.status} (${gt.progress?.current || 0}/${gt.progress?.total || 0})`}
                  >
                    <span className={`w-2 h-2 rounded-full ${dotColor}`} />
                    <span className="font-mono">#{String(idx).padStart(3, '0')}</span>
                    <span className="text-zinc-600">{gt.progress?.percentage || 0}%</span>
                  </button>
                );
              })}
          </div>
        </div>
      )}

      <div className="bg-zinc-900 border border-zinc-800 p-6 flex flex-col md:flex-row justify-between items-center gap-6">
        <div className="flex-1 w-full">
          <div className="flex justify-between items-end mb-2">
            <div>
              <h2 className="text-zinc-100 font-mono text-lg">{task.task_id}</h2>
              <div className="flex items-center mt-1 space-x-2">
                <span className={`w-2 h-2 rounded-full animate-pulse ${
                  task.status === 'running' ? 'bg-green-500' :
                  task.status === 'paused' ? 'bg-yellow-500' :
                  task.status === 'completed' ? 'bg-blue-500' :
                  task.status === 'failed' ? 'bg-red-500' :
                  'bg-zinc-500'
                }`}></span>
                <span className={`text-xs font-bold tracking-wider uppercase ${
                  task.status === 'running' ? 'text-green-500' :
                  task.status === 'paused' ? 'text-yellow-500' :
                  task.status === 'completed' ? 'text-blue-500' :
                  task.status === 'failed' ? 'text-red-500' :
                  'text-zinc-500'
                }`}>
                  {task.status}
                </span>
                <span className="text-zinc-600 text-xs">|</span>
                <span className="text-zinc-400 text-xs">{task.current_place || 'Initializing...'}</span>
              </div>
            </div>
            <span className="text-zinc-100 font-mono text-xl">
              {task.progress?.percentage || 0}%
            </span>
          </div>
          <div className="w-full bg-zinc-800 h-1">
            <div
              className="bg-zinc-100 h-1 shadow-[0_0_10px_rgba(255,255,255,0.5)] transition-all duration-300"
              style={{ width: `${task.progress?.percentage || 0}%` }}
            ></div>
          </div>
          <div className="flex justify-between mt-2 text-xs font-mono text-zinc-500">
            <span>{task.progress?.current || 0} / {task.progress?.total || 0} Processed</span>
            <span>ETA: {formatETA(task.progress?.eta)}</span>
          </div>
        </div>

        <div className="flex gap-3">
          {task.status === 'running' && (
            <Button variant="secondary" icon={Pause} onClick={pause}>Pause</Button>
          )}
          {task.status === 'paused' && (
            <Button variant="primary" icon={Play} onClick={resume}>Resume</Button>
          )}
          {(task.status === 'starting' || task.status === 'running' || task.status === 'paused') && (
            <Button variant="danger" icon={Square} onClick={stop}>Stop</Button>
          )}
          {(task.status === 'stopped' || task.status === 'failed') && (
            <Button variant="primary" icon={PlayCircle} onClick={handleResumeFromCheckpoint}>
              Resume from Checkpoint
            </Button>
          )}
          {(task.status === 'paused' || task.status === 'completed' || task.status === 'failed' || task.status === 'stopped') && (
            <Button
              variant="secondary"
              icon={FileJson}
              onClick={handleConvert}
              disabled={isConverting}
            >
              {isConverting ? 'Converting...' : 'Convert to JSON'}
            </Button>
          )}
          {(task.status === 'pending' || task.status === 'completed' || task.status === 'failed' || task.status === 'stopped') && (
            <Button variant="danger" icon={Trash2} onClick={() => setShowDeleteConfirm(true)}>Delete</Button>
          )}
        </div>
      </div>

      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/80 flex items-center justify-center z-50">
          <div className="bg-zinc-900 border border-zinc-800 p-6 max-w-md w-full mx-4">
            <h3 className="text-zinc-100 text-lg font-bold mb-2">Confirm Delete Task</h3>
            <p className="text-zinc-400 text-sm mb-6">
              Are you sure you want to delete task <span className="text-zinc-100 font-mono">{taskId}</span>?
              This action cannot be undone. All task data and logs will be permanently removed.
            </p>
            <div className="flex gap-3 justify-end">
              <Button
                variant="secondary"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                onClick={handleDelete}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting...' : 'Confirm Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
        <Card className="flex flex-col justify-between">
          <span className="text-zinc-500 text-xs uppercase tracking-wider">Success</span>
          <span className="text-zinc-100 text-3xl font-mono mt-2">
            {task.stats?.success || 0}
          </span>
        </Card>
        <Card className="flex flex-col justify-between">
          <span className="text-zinc-500 text-xs uppercase tracking-wider">Failed</span>
          <span className="text-zinc-100 text-3xl font-mono mt-2 text-red-400">
            {task.stats?.failed || 0}
          </span>
        </Card>
        <Card className="flex flex-col justify-between">
          <span className="text-zinc-500 text-xs uppercase tracking-wider">Reviews</span>
          <span className="text-zinc-100 text-3xl font-mono mt-2">
            {(task.stats?.reviews || 0).toLocaleString()}
          </span>
        </Card>
        <Card className="flex flex-col justify-between">
          <span className="text-zinc-500 text-xs uppercase tracking-wider">Images</span>
          <span className="text-zinc-100 text-3xl font-mono mt-2">
            {(task.stats?.images || 0).toLocaleString()}
          </span>
        </Card>
      </div>

      <div className="bg-black border border-zinc-800 p-4 font-mono text-xs h-[400px] overflow-y-auto custom-scrollbar">
        <div className="flex items-center gap-2 mb-4 pb-2 border-b border-zinc-900 sticky top-0 bg-black">
          <Terminal className="w-4 h-4 text-zinc-500" />
          <span className="text-zinc-500 uppercase tracking-widest">System Log</span>
        </div>
        <div className="space-y-1.5">
          {task.logs && task.logs.length > 0 ? (
            task.logs.map((log, idx) => (
              <div key={idx} className="flex gap-3 text-zinc-400">
                <span className="text-zinc-600">[{new Date(log.timestamp).toLocaleTimeString()}]</span>
                <span className={
                  log.level === 'error' ? 'text-red-500' :
                  log.level === 'warn' ? 'text-yellow-500' :
                  log.level === 'success' ? 'text-green-500' :
                  'text-blue-400'
                }>{log.level ? log.level.toUpperCase() : 'INFO'}</span>
                <span className="text-zinc-300">{log.message || ''}</span>
              </div>
            ))
          ) : (
            <div className="text-zinc-600 italic">No logs yet...</div>
          )}
          <div className="mt-2 w-3 h-4 bg-zinc-500 animate-pulse"></div>
        </div>
      </div>
    </div>
  );
}
