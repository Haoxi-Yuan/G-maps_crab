import React from 'react';
import { AlertTriangle, CheckCircle } from 'lucide-react';

export function ExitConfirmModal({ taskCount, onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-50 animate-in fade-in">
      <div className="bg-zinc-900 border border-zinc-800 max-w-md w-full mx-4 animate-in slide-in-from-bottom-4">
        <div className="border-b border-zinc-800 p-6 flex items-center gap-3">
          <AlertTriangle className="w-6 h-6 text-yellow-500" />
          <h2 className="text-zinc-100 text-lg font-bold tracking-wide">
            检测到运行中的任务
          </h2>
        </div>

        <div className="p-6 space-y-4">
          <p className="text-zinc-400 leading-relaxed">
            您有 <span className="text-zinc-100 font-bold font-mono">{taskCount}</span> 个任务正在运行。
          </p>

          <div className="bg-zinc-950 border border-zinc-800 p-4 space-y-2">
            <div className="flex items-start gap-3">
              <CheckCircle className="w-4 h-4 text-green-500 mt-0.5" />
              <div className="flex-1">
                <div className="text-zinc-200 text-sm font-medium">后台继续运行</div>
                <div className="text-zinc-500 text-xs mt-1">
                  关闭页面后,任务将继续在服务器后台执行
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <CheckCircle className="w-4 h-4 text-green-500 mt-0.5" />
              <div className="flex-1">
                <div className="text-zinc-200 text-sm font-medium">随时恢复监控</div>
                <div className="text-zinc-500 text-xs mt-1">
                  重新打开页面时,可以继续查看任务进度
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="border-t border-zinc-800 p-6 flex gap-4">
          <button
            onClick={onCancel}
            className="flex-1 bg-zinc-800 text-zinc-300 py-3 px-6 text-sm font-bold uppercase tracking-widest hover:bg-zinc-700 transition-colors"
          >
            留在页面
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 bg-zinc-100 text-zinc-950 py-3 px-6 text-sm font-bold uppercase tracking-widest hover:bg-white transition-colors"
          >
            转后台运行
          </button>
        </div>
      </div>
    </div>
  );
}
