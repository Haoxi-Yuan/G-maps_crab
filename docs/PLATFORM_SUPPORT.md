# Platform support

The maintained CLI targets Node.js 20 or newer and Python 3.10 or newer on:

- macOS;
- Ubuntu and other mainstream Linux distributions;
- Windows 10/11 with native Node.js, Python, and PowerShell.

`CLI_scraper/scripts/bootstrap.js` is the canonical environment installer.
`bootstrap.sh` and `bootstrap.ps1` are thin platform launchers. Dependency
versions are recorded in `package-lock.json` and `requirements.txt`; installed
`node_modules`, `.venv`, and Playwright browsers are always rebuilt locally.

The portable command entry point is:

```text
node bin/gmaps-crab.js <command>
```

Unix users may continue to use the richer Bash wizards. Windows users can call
`bin\gmaps-crab.ps1` or the Node entry point directly. Long-running background
process management is intentionally platform-specific; the core runners stay
in the foreground and can be hosted by tmux, systemd, PowerShell jobs, Task
Scheduler, or another local supervisor.

The Stage 5 portable command is `gmaps-crab images`, which delegates to the
SQLite-backed downloader. The tmux-based `src/cli/image-wizard.js` remains an
optional Unix convenience UI and is not the Windows entry point.

The Swift graphical monitor is macOS-only. `tools/local-monitor/monitor.js`
provides a small cross-platform local monitor based solely on live sidecars.
