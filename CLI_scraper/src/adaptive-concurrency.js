'use strict';

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

class AdaptiveConcurrencyController {
  constructor(options = {}) {
    this.minimum = options.minimum ?? 1;
    this.maximum = options.maximum ?? 12;
    this.current = clamp(options.start ?? this.minimum, this.minimum, this.maximum);
    this.minimumGain = options.minimumGain ?? 0.08;
    this.maximumErrorRate = options.maximumErrorRate ?? 0.03;
    this.maximumThrottleRate = options.maximumThrottleRate ?? 0.01;
    this.maximumP95Multiplier = options.maximumP95Multiplier ?? 1.5;
    this.plateauWindows = options.plateauWindows ?? 2;
    this.history = [];
    this.best = null;
    this.flatWindows = 0;
  }

  observe(metrics) {
    const point = { ...metrics, concurrency: this.current };
    const previous = this.history[this.history.length - 1] || null;
    this.history.push(point);
    if (!this.best || point.profiles_per_minute > this.best.profiles_per_minute) this.best = point;

    const unsafe = point.error_rate > this.maximumErrorRate
      || point.throttle_rate > this.maximumThrottleRate;
    if (unsafe) {
      this.current = clamp(Math.floor(this.current * 0.7), this.minimum, this.maximum);
      this.flatWindows = 0;
      return { concurrency: this.current, action: 'backoff', reason: 'errors_or_throttling' };
    }

    if (previous) {
      const gain = previous.profiles_per_minute > 0
        ? (point.profiles_per_minute - previous.profiles_per_minute) / previous.profiles_per_minute
        : Infinity;
      const p95Multiplier = previous.duration_p95_ms > 0
        ? point.duration_p95_ms / previous.duration_p95_ms
        : 1;
      if (gain < this.minimumGain || p95Multiplier > this.maximumP95Multiplier) this.flatWindows += 1;
      else this.flatWindows = 0;
    }

    if (this.flatWindows >= this.plateauWindows) {
      this.current = this.best.concurrency;
      return { concurrency: this.current, action: 'hold', reason: 'throughput_plateau', best_concurrency: this.best.concurrency };
    }
    if (this.current >= this.maximum) return { concurrency: this.current, action: 'hold', reason: 'maximum_concurrency' };
    this.current += 1;
    return { concurrency: this.current, action: 'increase', reason: 'healthy_headroom' };
  }
}

module.exports = { AdaptiveConcurrencyController, clamp };

