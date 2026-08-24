import React, { useMemo } from 'react';

function TaskButton({ inst, isActive, onSwitch }) {
  const statusColor =
    inst.status === 'running' ? 'bg-green-500' :
    inst.status === 'paused' ? 'bg-yellow-500' :
    'bg-zinc-500';

  const config = inst.config || {};
  const groupIndex = config.groupIndex;
  const label = groupIndex !== undefined
    ? `#${String(groupIndex + 1).padStart(3, '0')}`
    : `#${inst.task_id.slice(-8)}`;

  return (
    <button
      onClick={() => onSwitch(inst.task_id)}
      className={`
        group relative px-3 py-2 text-xs border transition-all
        ${isActive
          ? 'bg-zinc-800 border-zinc-100 text-zinc-100'
          : 'bg-zinc-950 border-zinc-800 text-zinc-500 hover:border-zinc-600'
        }
      `}
    >
      <div className="flex items-center gap-2 min-w-[100px]">
        <span className={`w-1.5 h-1.5 rounded-full ${statusColor}`} />
        <div className="flex-1 text-left">
          <div className="font-mono font-bold">{label}</div>
          <div className="text-[10px] text-zinc-600">
            {inst.progress?.current || 0}/{inst.progress?.total || 0}
          </div>
        </div>
        <div className={`
          text-[10px] px-1.5 py-0.5 rounded
          ${isActive ? 'bg-zinc-700' : 'bg-zinc-900'}
        `}>
          {inst.progress?.percentage || 0}%
        </div>
      </div>

      <div className="
        absolute bottom-full left-1/2 -translate-x-1/2 mb-2
        px-3 py-2 bg-black border border-zinc-700 text-xs
        opacity-0 group-hover:opacity-100 transition-opacity
        pointer-events-none whitespace-nowrap z-10
      ">
        <div className="font-bold text-zinc-100">{inst.task_id}</div>
        <div className="text-zinc-500 mt-1">
          Created: {new Date(inst.created_at).toLocaleString()}
        </div>
      </div>
    </button>
  );
}

export function InstanceSwitcher({ instances, currentInstance, onSwitch }) {
  if (!instances || instances.length === 0) {
    return (
      <div className="text-zinc-600 text-xs italic">No active tasks</div>
    );
  }

  const { groups, standalone } = useMemo(() => {
    const groupMap = {};
    const solo = [];

    instances.forEach(inst => {
      const config = inst.config || {};
      if (config.groupId) {
        if (!groupMap[config.groupId]) {
          groupMap[config.groupId] = {
            groupId: config.groupId,
            label: config.groupLabel || 'Group',
            total: config.groupTotal || 0,
            tasks: []
          };
        }
        groupMap[config.groupId].tasks.push(inst);
      } else {
        solo.push(inst);
      }
    });

    // Sort tasks within each group by groupIndex
    Object.values(groupMap).forEach(g => {
      g.tasks.sort((a, b) => (a.config?.groupIndex || 0) - (b.config?.groupIndex || 0));
    });

    return { groups: Object.values(groupMap), standalone: solo };
  }, [instances]);

  return (
    <div className="flex gap-2 overflow-x-auto max-w-3xl items-start">
      {groups.map(group => (
        <div
          key={group.groupId}
          className="flex items-center gap-1 border border-zinc-700 rounded px-1.5 py-1 bg-zinc-900/50"
        >
          <span className="text-[10px] text-zinc-500 uppercase tracking-wider px-1 shrink-0">
            {group.label} [{group.total}]
          </span>
          {group.tasks.map(inst => (
            <TaskButton
              key={inst.task_id}
              inst={inst}
              isActive={currentInstance === inst.task_id}
              onSwitch={onSwitch}
            />
          ))}
        </div>
      ))}
      {standalone.map(inst => (
        <TaskButton
          key={inst.task_id}
          inst={inst}
          isActive={currentInstance === inst.task_id}
          onSwitch={onSwitch}
        />
      ))}
    </div>
  );
}
