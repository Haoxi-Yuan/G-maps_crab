/**
 * Change Detector - Pure comparison logic.
 * Compares current scraped data against baseline record
 * for the 4 monitoring fields.
 */

function detectChanges(current, baseline, config) {
  const changes = [];

  // 1. reviewCount: exact numeric comparison
  if (current.reviewCount !== null && baseline.reviewCount !== null) {
    if (current.reviewCount !== baseline.reviewCount) {
      changes.push({
        field: 'reviewCount',
        old: baseline.reviewCount,
        new: current.reviewCount,
        diff: current.reviewCount - baseline.reviewCount
      });
    }
  }

  // 2. rating: float comparison with tolerance
  const tolerance = config.thresholds?.ratingTolerance ?? 0.05;
  if (current.rating !== null && baseline.rating !== null) {
    if (Math.abs(current.rating - baseline.rating) > tolerance) {
      changes.push({
        field: 'rating',
        old: baseline.rating,
        new: current.rating,
        diff: +(current.rating - baseline.rating).toFixed(2)
      });
    }
  }

  // 3. openingHoursHash: exact string comparison
  if (current.openingHoursHash && baseline.openingHoursHash) {
    if (current.openingHoursHash !== baseline.openingHoursHash) {
      changes.push({
        field: 'openingHoursHash',
        old: baseline.openingHoursHash,
        new: current.openingHoursHash
      });
    }
  }

  // 4. popularTimesHash: exact string comparison
  if (current.popularTimesHash && baseline.popularTimesHash) {
    if (current.popularTimesHash !== baseline.popularTimesHash) {
      changes.push({
        field: 'popularTimesHash',
        old: baseline.popularTimesHash,
        new: current.popularTimesHash
      });
    }
  }

  return {
    hasChanges: changes.length > 0,
    changes,
    changeType: determineChangeType(changes)
  };
}

function determineChangeType(changes) {
  if (changes.length === 0) return null;
  const fields = new Set(changes.map(c => c.field));

  if (fields.has('reviewCount') || fields.has('rating')) {
    if (fields.has('openingHoursHash') || fields.has('popularTimesHash')) {
      return 'MULTI_CHANGE';
    }
    return 'REVIEW_CHANGE';
  }
  if (fields.has('openingHoursHash')) return 'HOURS_CHANGE';
  if (fields.has('popularTimesHash')) return 'POPULAR_TIMES_CHANGE';
  return 'FIELD_CHANGE';
}

module.exports = { detectChanges };
