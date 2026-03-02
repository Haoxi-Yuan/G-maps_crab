import { useState, useEffect } from 'react';
import { Settings, Activity } from 'lucide-react';
import crabIcon from './image/crab.png';
import { InstanceSwitcher } from './components/InstanceSwitcher';
import { ExitConfirmModal } from './components/ExitModal';
import { MonitorView } from './components/views/MonitorView';
import { ScraperConfigView } from './components/views/ScraperConfigView';
import api from './services/api';

export default function App() {
  const [activeTab, setActiveTab] = useState('config');
  const [runningInstances, setRunningInstances] = useState([]);
  const [currentTaskId, setCurrentTaskId] = useState(null);
  const [showExitModal, setShowExitModal] = useState(false);

  useEffect(() => {
    loadRunningInstances();

    const interval = setInterval(loadRunningInstances, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handleBeforeUnload = (e) => {
      if (runningInstances.length > 0) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [runningInstances]);

  async function loadRunningInstances() {
    try {
      const response = await api.getRunningTasks();
      const tasks = response.tasks || [];
      setRunningInstances(tasks);

      setCurrentTaskId(prev => {
        if (!prev && tasks.length > 0) {
          return tasks[0].task_id;
        }
        return prev;
      });
    } catch (error) {
      console.error('Failed to load instances:', error);
    }
  }

  async function handleStartTask(config) {
    try {
      if (config.parallel && config.splitCount >= 2) {
        // Parallel splitting mode
        const { splitCount, parallel, ...baseConfig } = config;
        const createResult = await api.createParallelTasks(baseConfig, splitCount);
        await api.startParallelTasks(createResult.taskIds);

        await loadRunningInstances();
        if (createResult.taskIds.length > 0) {
          setCurrentTaskId(createResult.taskIds[0]);
        }
        setActiveTab('monitor');
      } else {
        // Single task mode
        const result = await api.createTask(config);
        await api.startTask(result.taskId);

        await loadRunningInstances();
        setCurrentTaskId(result.taskId);
        setActiveTab('monitor');
      }
    } catch (error) {
      console.error('Failed to start task:', error);
      alert('启动任务失败: ' + error.message);
    }
  }

  async function handleTaskDeleted(deletedTaskId) {
    await loadRunningInstances();

    if (currentTaskId === deletedTaskId) {
      const response = await api.getRunningTasks();
      const tasks = response.tasks || [];

      if (tasks.length > 0) {
        setCurrentTaskId(tasks[0].task_id);
      } else {
        setCurrentTaskId(null);
        setActiveTab('config');
      }
    }
  }

  const tabs = [
    { id: 'config', label: 'Scraper Config', icon: Settings },
    { id: 'monitor', label: 'Task Monitor', icon: Activity },
  ];

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300 font-sans selection:bg-zinc-700 selection:text-white">
      <header className="border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 bg-zinc-100 flex items-center justify-center">
              <img src={crabIcon} alt="crab" className="w-5 h-5" />
            </div>
            <h1 className="text-zinc-100 font-bold tracking-tight text-lg">
              G-MAPS <span className="font-light text-zinc-500">CRAB</span>
            </h1>
          </div>
          <div className="flex items-center space-x-2">
            <span className={`h-2 w-2 rounded-full ${
              runningInstances.length > 0 ? 'bg-green-500 animate-pulse' : 'bg-zinc-500'
            }`}></span>
            <span className="text-xs text-zinc-500 uppercase tracking-widest">
              {runningInstances.length > 0 ? `${runningInstances.length} Running` : 'System Idle'}
            </span>
          </div>
        </div>
      </header>

      {runningInstances.length > 0 && (
        <div className="border-b border-zinc-800 bg-zinc-950/50">
          <div className="max-w-7xl mx-auto px-6 py-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-3">
                <span className="text-zinc-500 text-xs uppercase tracking-widest">Active Tasks</span>
                <InstanceSwitcher
                  instances={runningInstances}
                  currentInstance={currentTaskId}
                  onSwitch={(taskId) => {
                    setCurrentTaskId(taskId);
                    setActiveTab('monitor');
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="border-b border-zinc-900 bg-zinc-950">
        <div className="max-w-7xl mx-auto px-6">
          <div className="flex space-x-8">
            {tabs.map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`group flex items-center py-4 text-sm font-medium tracking-wide transition-all border-b-2 ${
                    isActive
                      ? 'border-zinc-100 text-zinc-100'
                      : 'border-transparent text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  <Icon className={`w-4 h-4 mr-2 ${isActive ? 'text-zinc-100' : 'text-zinc-600 group-hover:text-zinc-400'}`} />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <main className="max-w-7xl mx-auto px-6 py-8">
        {activeTab === 'config' && <ScraperConfigView onStart={handleStartTask} />}
        {activeTab === 'monitor' && <MonitorView taskId={currentTaskId} onTaskDeleted={handleTaskDeleted} onSwitchTask={setCurrentTaskId} />}
      </main>

      {showExitModal && (
        <ExitConfirmModal
          taskCount={runningInstances.length}
          onConfirm={() => setShowExitModal(false)}
          onCancel={() => setShowExitModal(false)}
        />
      )}
    </div>
  );
}
