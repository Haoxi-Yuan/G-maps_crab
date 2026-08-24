"""
Time Series Data Builder Module.
Builds time series data for opening hours and popular times from review extractions.
"""

import json
from typing import List, Dict, Optional, Any, Tuple
from datetime import datetime
from collections import defaultdict
from dataclasses import dataclass, field
from copy import deepcopy


# Day name constants
DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
DAY_ALIASES = {
    "weekdays": ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"],
    "weekends": ["Saturday", "Sunday"],
    "all": DAY_NAMES
}

# Popularity level to score mapping
POPULARITY_LEVEL_TO_SCORE = {
    "very_low": 10,
    "low": 30,
    "medium": 50,
    "high": 70,
    "very_high": 90
}

# Time period to hours mapping
TIME_PERIOD_TO_HOURS = {
    "morning": list(range(6, 12)),
    "afternoon": list(range(12, 18)),
    "evening": list(range(18, 22)),
    "night": list(range(22, 24)) + list(range(0, 6)),
    "lunch": list(range(11, 14)),
    "dinner": list(range(18, 21)),
}


def get_all_months_in_range(start_period: str, end_period: str) -> List[str]:
    """Generate all YYYY-MM periods between start and end (inclusive)."""
    start_year, start_month = int(start_period[:4]), int(start_period[5:7])
    end_year, end_month = int(end_period[:4]), int(end_period[5:7])

    months = []
    year, month = start_year, start_month
    while (year, month) <= (end_year, end_month):
        months.append(f"{year:04d}-{month:02d}")
        month += 1
        if month > 12:
            month = 1
            year += 1
    return months


def normalize_days(day_spec: str) -> List[str]:
    """Normalize day specification to list of day names."""
    if not day_spec:
        return DAY_NAMES

    day_lower = day_spec.lower()
    if day_lower in DAY_ALIASES:
        return DAY_ALIASES[day_lower]

    # Check if it's a valid day name
    for day in DAY_NAMES:
        if day.lower() == day_lower:
            return [day]

    return DAY_NAMES


class TimeSeriesBuilder:
    """Build time series data from extractions."""

    def __init__(
        self,
        extractions: Dict[str, Dict],
        current_period: str = "2026-01"
    ):
        """
        Initialize the builder.

        Args:
            extractions: Dict mapping place_id to extraction results
            current_period: The period to assign to current/original data
        """
        self.extractions = extractions
        self.current_period = current_period

    def build_hours_timeseries(
        self,
        place_id: str,
        original_hours: Optional[Dict],
        fill_gaps: bool = True
    ) -> List[Dict]:
        """
        Build opening hours time series for a place.

        Args:
            place_id: Place ID
            original_hours: Original openingHours data from NDJSON
            fill_gaps: Whether to fill missing months with nearest data

        Returns:
            List of time series snapshots
        """
        extraction = self.extractions.get(place_id, {})
        hours_obs = extraction.get("hours_observations", [])

        # Build snapshots by period
        periods_data: Dict[str, Dict] = {}

        # Add current data as the current_period
        if original_hours and original_hours.get("weeklyHours"):
            periods_data[self.current_period] = {
                "period": self.current_period,
                "weeklyHours": deepcopy(original_hours["weeklyHours"]),
                "source": "current_data",
                "evidence": "Current data from Google Maps",
                "source_reviews": [],
                "confidence": 1.0
            }

        # Process each hours observation
        for obs in hours_obs:
            period = obs.get("inferred_period", "")
            if not period or len(period) < 7:
                continue

            mentioned_hours = obs.get("mentioned_hours", [])
            if not mentioned_hours:
                continue

            # If this period doesn't exist yet, create it based on current data or empty
            if period not in periods_data:
                if self.current_period in periods_data:
                    # Start with a copy of current data
                    periods_data[period] = {
                        "period": period,
                        "weeklyHours": deepcopy(periods_data[self.current_period]["weeklyHours"]),
                        "source": "review_inference",
                        "evidence": obs.get("evidence", ""),
                        "source_reviews": [obs.get("review_id", "")],
                        "confidence": obs.get("confidence", 0.5)
                    }
                else:
                    # Create empty structure
                    periods_data[period] = {
                        "period": period,
                        "weeklyHours": [],
                        "source": "review_inference",
                        "evidence": obs.get("evidence", ""),
                        "source_reviews": [obs.get("review_id", "")],
                        "confidence": obs.get("confidence", 0.5)
                    }
            else:
                # Append to existing evidence and source_reviews
                existing = periods_data[period]
                if obs.get("evidence"):
                    if existing.get("evidence"):
                        existing["evidence"] += f"; {obs.get('evidence')}"
                    else:
                        existing["evidence"] = obs.get("evidence")

                review_id = obs.get("review_id", "")
                if review_id and review_id not in existing["source_reviews"]:
                    existing["source_reviews"].append(review_id)

                # Average confidence
                existing["confidence"] = (existing["confidence"] + obs.get("confidence", 0.5)) / 2

            # Apply mentioned hours to this period
            for mh in mentioned_hours:
                affected_days = normalize_days(mh.get("day", "all"))
                hours_str = mh.get("hours", "")
                open_hour = mh.get("openHour")
                close_hour = mh.get("closeHour")
                is_24h = "24" in hours_str.lower() if hours_str else False

                # Update the weekly hours for affected days
                weekly = periods_data[period]["weeklyHours"]

                for day in affected_days:
                    # Find or create entry for this day
                    day_entry = None
                    for entry in weekly:
                        if entry.get("day") == day:
                            day_entry = entry
                            break

                    if day_entry is None:
                        day_entry = {"day": day}
                        weekly.append(day_entry)

                    # Update with extracted info
                    if hours_str:
                        day_entry["hours"] = hours_str
                    if open_hour is not None:
                        day_entry["openHour"] = open_hour
                    if close_hour is not None:
                        day_entry["closeHour"] = close_hour
                    if is_24h:
                        day_entry["hours"] = "Open 24 hours"
                        day_entry["openHour"] = 0
                        day_entry["closeHour"] = 24

        # Fill gaps if requested
        if fill_gaps and periods_data:
            periods_data = self._fill_hours_gaps(periods_data)

        # Sort by period and return as list
        return [periods_data[p] for p in sorted(periods_data.keys())]

    def build_popularity_timeseries(
        self,
        place_id: str,
        original_popularity: Optional[Dict],
        fill_gaps: bool = True
    ) -> List[Dict]:
        """
        Build popular times time series for a place.

        Args:
            place_id: Place ID
            original_popularity: Original popularTimes data from NDJSON
            fill_gaps: Whether to fill missing months with nearest data

        Returns:
            List of time series snapshots
        """
        extraction = self.extractions.get(place_id, {})
        pop_obs = extraction.get("popularity_observations", [])

        # Build snapshots by period
        periods_data: Dict[str, Dict] = {}

        # Add current data as the current_period
        if original_popularity and original_popularity.get("weeklyData"):
            periods_data[self.current_period] = {
                "period": self.current_period,
                "weeklyData": deepcopy(original_popularity["weeklyData"]),
                "source": "current_data",
                "evidence": "Current data from Google Maps",
                "source_reviews": [],
                "confidence": 1.0
            }

        # Process each popularity observation
        for obs in pop_obs:
            period = obs.get("inferred_period", "")
            if not period or len(period) < 7:
                continue

            observations = obs.get("observations", [])
            if not observations:
                continue

            # If this period doesn't exist yet, create it based on current data
            if period not in periods_data:
                if self.current_period in periods_data:
                    # Start with a copy of current data
                    periods_data[period] = {
                        "period": period,
                        "weeklyData": deepcopy(periods_data[self.current_period]["weeklyData"]),
                        "source": "review_inference",
                        "evidence": obs.get("evidence", ""),
                        "source_reviews": [obs.get("review_id", "")],
                        "confidence": obs.get("confidence", 0.5)
                    }
                else:
                    # Create default structure with medium popularity
                    periods_data[period] = {
                        "period": period,
                        "weeklyData": self._create_default_weekly_popularity(),
                        "source": "review_inference",
                        "evidence": obs.get("evidence", ""),
                        "source_reviews": [obs.get("review_id", "")],
                        "confidence": obs.get("confidence", 0.5)
                    }
            else:
                # Append to existing evidence and source_reviews
                existing = periods_data[period]
                if obs.get("evidence"):
                    if existing.get("evidence"):
                        existing["evidence"] += f"; {obs.get('evidence')}"
                    else:
                        existing["evidence"] = obs.get("evidence")

                review_id = obs.get("review_id", "")
                if review_id and review_id not in existing["source_reviews"]:
                    existing["source_reviews"].append(review_id)

                # Average confidence
                existing["confidence"] = (existing["confidence"] + obs.get("confidence", 0.5)) / 2

            # Apply observations to this period
            for pop_obs_item in observations:
                day_spec = pop_obs_item.get("day")
                hour = pop_obs_item.get("hour")
                time_period = pop_obs_item.get("time_period")
                pop_level = pop_obs_item.get("popularity_level")
                pop_score = pop_obs_item.get("popularity_score")

                # Determine score
                if pop_score is not None:
                    score = int(pop_score)
                elif pop_level:
                    score = POPULARITY_LEVEL_TO_SCORE.get(pop_level, 50)
                else:
                    continue

                # Determine affected days
                affected_days = normalize_days(day_spec) if day_spec else DAY_NAMES

                # Determine affected hours
                if hour is not None:
                    affected_hours = [int(hour)]
                elif time_period and time_period in TIME_PERIOD_TO_HOURS:
                    affected_hours = TIME_PERIOD_TO_HOURS[time_period]
                else:
                    # Apply to all operating hours (9-21 as default)
                    affected_hours = list(range(9, 22))

                # Update weekly data
                weekly_data = periods_data[period]["weeklyData"]

                for day in affected_days:
                    # Find day entry
                    day_entry = None
                    for de in weekly_data:
                        if de.get("day") == day:
                            day_entry = de
                            break

                    if day_entry is None:
                        day_entry = {"day": day, "hourlyData": []}
                        weekly_data.append(day_entry)

                    hourly_data = day_entry.get("hourlyData", [])
                    if not hourly_data:
                        day_entry["hourlyData"] = []
                        hourly_data = day_entry["hourlyData"]

                    # Update affected hours
                    for h in affected_hours:
                        # Find or create hour entry
                        hour_entry = None
                        for he in hourly_data:
                            if he.get("hour") == h:
                                hour_entry = he
                                break

                        if hour_entry is None:
                            hour_entry = {"hour": h, "popularity": score}
                            hourly_data.append(hour_entry)
                        else:
                            # Average with existing
                            hour_entry["popularity"] = int((hour_entry["popularity"] + score) / 2)

        # Fill gaps if requested
        if fill_gaps and periods_data:
            periods_data = self._fill_popularity_gaps(periods_data)

        # Sort by period and return as list
        return [periods_data[p] for p in sorted(periods_data.keys())]

    def _fill_hours_gaps(self, periods_data: Dict[str, Dict]) -> Dict[str, Dict]:
        """Fill missing months in hours data with nearest available data."""
        if not periods_data:
            return periods_data

        sorted_periods = sorted(periods_data.keys())
        start_period = sorted_periods[0]
        end_period = sorted_periods[-1]

        all_months = get_all_months_in_range(start_period, end_period)

        for month in all_months:
            if month not in periods_data:
                # Find nearest available period
                nearest = self._find_nearest_period(month, sorted_periods)
                if nearest:
                    periods_data[month] = {
                        "period": month,
                        "weeklyHours": deepcopy(periods_data[nearest]["weeklyHours"]),
                        "source": "interpolated",
                        "evidence": f"Interpolated from {nearest} data",
                        "source_reviews": [],
                        "confidence": periods_data[nearest]["confidence"] * 0.8
                    }

        return periods_data

    def _fill_popularity_gaps(self, periods_data: Dict[str, Dict]) -> Dict[str, Dict]:
        """Fill missing months in popularity data with nearest available data."""
        if not periods_data:
            return periods_data

        sorted_periods = sorted(periods_data.keys())
        start_period = sorted_periods[0]
        end_period = sorted_periods[-1]

        all_months = get_all_months_in_range(start_period, end_period)

        for month in all_months:
            if month not in periods_data:
                # Find nearest available period
                nearest = self._find_nearest_period(month, sorted_periods)
                if nearest:
                    periods_data[month] = {
                        "period": month,
                        "weeklyData": deepcopy(periods_data[nearest]["weeklyData"]),
                        "source": "interpolated",
                        "evidence": f"Interpolated from {nearest} data",
                        "source_reviews": [],
                        "confidence": periods_data[nearest]["confidence"] * 0.8
                    }

        return periods_data

    def _find_nearest_period(self, target: str, available: List[str]) -> Optional[str]:
        """Find the nearest available period to the target."""
        if not available:
            return None

        target_year, target_month = int(target[:4]), int(target[5:7])
        target_total = target_year * 12 + target_month

        nearest = None
        min_diff = float('inf')

        for period in available:
            year, month = int(period[:4]), int(period[5:7])
            total = year * 12 + month
            diff = abs(total - target_total)
            if diff < min_diff:
                min_diff = diff
                nearest = period

        return nearest

    def _create_default_weekly_popularity(self) -> List[Dict]:
        """Create default weekly popularity structure with medium values."""
        weekly = []
        for day in DAY_NAMES:
            hourly = []
            for hour in range(24):
                hourly.append({
                    "hour": hour,
                    "popularity": 50,
                    "timeLabel": f"{hour % 12 or 12} {'am' if hour < 12 else 'pm'}"
                })
            weekly.append({
                "day": day,
                "hourlyData": hourly
            })
        return weekly

    def build_place_timeseries(
        self,
        place_id: str,
        original_record: Dict,
        fill_gaps: bool = True
    ) -> Dict:
        """
        Build complete time series data for a place.

        Args:
            place_id: Place ID
            original_record: Original NDJSON record
            fill_gaps: Whether to fill missing months

        Returns:
            Time series record for this place
        """
        business_name = original_record.get("business", {}).get("name", "")
        original_hours = original_record.get("openingHours", {})
        original_popularity = original_record.get("popularTimes", {})

        hours_ts = self.build_hours_timeseries(place_id, original_hours, fill_gaps)
        pop_ts = self.build_popularity_timeseries(place_id, original_popularity, fill_gaps)

        return {
            "place_id": place_id,
            "business_name": business_name,
            "openingHours_timeseries": hours_ts,
            "popularTimes_timeseries": pop_ts
        }


def generate_timeseries_file(
    extractions: Dict[str, Dict],
    input_path: str,
    output_path: str,
    current_period: str = "2026-01",
    fill_gaps: bool = True,
    progress_callback=None
) -> Dict[str, int]:
    """
    Generate a time series NDJSON file from extractions and original data.

    Args:
        extractions: Dict mapping place_id to extraction results
        input_path: Path to original NDJSON file
        output_path: Path for output time series file
        current_period: Period to assign to current data
        fill_gaps: Whether to fill missing months
        progress_callback: Optional callback(line_num, has_extraction)

    Returns:
        Statistics dict
    """
    builder = TimeSeriesBuilder(extractions, current_period)

    stats = {
        "total_records": 0,
        "records_with_extractions": 0,
        "total_hours_snapshots": 0,
        "total_popularity_snapshots": 0
    }

    with open(input_path, 'r', encoding='utf-8') as infile, \
         open(output_path, 'w', encoding='utf-8') as outfile:

        for line_num, line in enumerate(infile):
            try:
                record = json.loads(line)
                place_id = record.get("business", {}).get("placeId", "")

                # Build time series for this place
                ts_record = builder.build_place_timeseries(
                    place_id, record, fill_gaps
                )

                # Update stats
                stats["total_records"] += 1

                has_extraction = place_id in extractions
                if has_extraction:
                    stats["records_with_extractions"] += 1

                stats["total_hours_snapshots"] += len(ts_record.get("openingHours_timeseries", []))
                stats["total_popularity_snapshots"] += len(ts_record.get("popularTimes_timeseries", []))

                # Write to output
                outfile.write(json.dumps(ts_record, ensure_ascii=False) + '\n')

                if progress_callback:
                    progress_callback(line_num, has_extraction)

            except json.JSONDecodeError:
                stats["total_records"] += 1
                continue

    return stats


# Legacy compatibility
def create_patcher(extractions: Dict[str, Dict]) -> "TimeSeriesBuilder":
    """
    Legacy factory function - now returns TimeSeriesBuilder.

    Args:
        extractions: Extraction results from extractor

    Returns:
        TimeSeriesBuilder instance
    """
    return TimeSeriesBuilder(extractions)
