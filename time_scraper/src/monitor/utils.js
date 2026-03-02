const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function stableStringify(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return '[' + obj.map(item => stableStringify(item)).join(',') + ']';
  }
  const keys = Object.keys(obj).sort();
  const parts = keys.map(k => JSON.stringify(k) + ':' + stableStringify(obj[k]));
  return '{' + parts.join(',') + '}';
}

function computeHash(obj) {
  if (obj === null || obj === undefined) return null;
  if (typeof obj === 'object' && Object.keys(obj).length === 0) return null;
  const str = stableStringify(obj);
  return crypto.createHash('sha256').update(str).digest('hex');
}

function normalizeOpeningHours(oh) {
  if (!oh) return null;
  const weeklyHours = oh.weeklyHours;
  if (!Array.isArray(weeklyHours) || weeklyHours.length === 0) return null;
  const normalized = weeklyHours.map(entry => {
    const item = { day: entry.day };
    if (entry.hours !== undefined && entry.hours !== null) item.hours = entry.hours;
    if (entry.openHour !== undefined && entry.openHour !== null) item.openHour = entry.openHour;
    if (entry.closeHour !== undefined && entry.closeHour !== null) item.closeHour = entry.closeHour;
    return item;
  });
  return { weeklyHours: normalized };
}

function normalizePopularTimes(pt) {
  if (!pt) return null;
  const weeklyData = pt.weeklyData;
  if (!Array.isArray(weeklyData) || weeklyData.length === 0) return null;
  const normalized = weeklyData.map(dayEntry => {
    const item = { day: dayEntry.day };
    if (Array.isArray(dayEntry.hourlyData)) {
      item.hourlyData = dayEntry.hourlyData.map(h => {
        const hourItem = { hour: h.hour, popularity: h.popularity };
        if (h.timeLabel !== undefined && h.timeLabel !== null) {
          hourItem.timeLabel = String(h.timeLabel).replace(/\u202f/g, ' ');
        }
        return hourItem;
      });
    }
    return item;
  });
  return { weeklyData: normalized };
}

function generateScanId() {
  const now = new Date();
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  const dateStr = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate())
  ].join('');
  const timeStr = [
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
  return `scan-${dateStr}-${timeStr}`;
}

function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainMin = minutes % 60;
  return `${hours}h ${remainMin}m ${remainSec}s`;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  if (data) {
    console.log(`${prefix} ${message}`, data);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

module.exports = {
  stableStringify,
  computeHash,
  normalizeOpeningHours,
  normalizePopularTimes,
  generateScanId,
  formatDuration,
  ensureDir,
  log
};
