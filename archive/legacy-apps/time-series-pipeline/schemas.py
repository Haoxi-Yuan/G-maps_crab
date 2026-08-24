"""
Pydantic schemas for structured extraction output.
Defines the data models for time series opening hours and popularity data.
"""

from pydantic import BaseModel, Field
from typing import Optional, List, Literal, Dict, Any
from datetime import datetime
from enum import Enum


# ============================================================
# Basic Enums
# ============================================================

class PopularityLevel(str, Enum):
    VERY_LOW = "very_low"      # 0-20
    LOW = "low"                # 20-40
    MEDIUM = "medium"          # 40-60
    HIGH = "high"              # 60-80
    VERY_HIGH = "very_high"    # 80-100


class TimePeriod(str, Enum):
    MORNING = "morning"
    AFTERNOON = "afternoon"
    EVENING = "evening"
    NIGHT = "night"
    LUNCH = "lunch"
    DINNER = "dinner"


# ============================================================
# Time Series Data Models (NEW)
# ============================================================

class DayHours(BaseModel):
    """Opening hours for a single day - matches original format"""
    day: str  # Monday, Tuesday, etc.
    hours: str  # e.g., "9:00 AM–9:00 PM" or "Open 24 hours" or "Closed"
    openHour: Optional[int] = None  # 0-23
    closeHour: Optional[int] = None  # 0-24 (24 for midnight next day)
    is_24h: bool = False


class HourlyPopularity(BaseModel):
    """Popularity for a single hour - matches original format"""
    hour: int  # 0-23
    popularity: int  # 0-100
    timeLabel: Optional[str] = None  # e.g., "9 am"


class DayPopularity(BaseModel):
    """Popularity for a single day - matches original format"""
    day: str  # Sunday, Monday, etc.
    hourlyData: List[HourlyPopularity]


class OpeningHoursSnapshot(BaseModel):
    """A snapshot of opening hours for a specific time period"""
    period: str  # YYYY-MM format, e.g., "2025-06"
    weeklyHours: List[DayHours]
    source: Literal["current_data", "review_inference", "interpolated"]
    evidence: Optional[str] = Field(
        None,
        description="LLM's reasoning/evidence from review text"
    )
    source_reviews: List[str] = Field(default_factory=list)
    confidence: float = Field(1.0, ge=0.0, le=1.0)


class PopularTimesSnapshot(BaseModel):
    """A snapshot of popular times for a specific time period"""
    period: str  # YYYY-MM format, e.g., "2025-06"
    weeklyData: List[DayPopularity]
    source: Literal["current_data", "review_inference", "interpolated"]
    evidence: Optional[str] = Field(
        None,
        description="LLM's reasoning/evidence from review text"
    )
    source_reviews: List[str] = Field(default_factory=list)
    confidence: float = Field(1.0, ge=0.0, le=1.0)


class PlaceTimeSeries(BaseModel):
    """Complete time series data for a POI"""
    place_id: str
    business_name: str
    openingHours_timeseries: List[OpeningHoursSnapshot] = Field(default_factory=list)
    popularTimes_timeseries: List[PopularTimesSnapshot] = Field(default_factory=list)


# ============================================================
# LLM Extraction Models (Updated for time series)
# ============================================================

class ExtractedHoursForPeriod(BaseModel):
    """Hours data extracted for a specific period from review"""
    review_id: str
    review_date: str  # The date of the review
    inferred_period: str  # YYYY-MM format - when the hours observation applies to

    # The actual hours mentioned in the review
    mentioned_hours: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="List of {day, hours, openHour, closeHour} observed"
    )

    evidence: str = Field(
        ...,
        description="The exact quote or paraphrase from review supporting this inference"
    )
    confidence: float = Field(..., ge=0.0, le=1.0)


class ExtractedPopularityForPeriod(BaseModel):
    """Popularity data extracted for a specific period from review"""
    review_id: str
    review_date: str  # The date of the review
    inferred_period: str  # YYYY-MM format - when the popularity observation applies to

    # The actual popularity observations
    observations: List[Dict[str, Any]] = Field(
        default_factory=list,
        description="List of {day, hour, popularity_level, popularity_score} observed"
    )

    evidence: str = Field(
        ...,
        description="The exact quote or paraphrase from review supporting this inference"
    )
    confidence: float = Field(..., ge=0.0, le=1.0)


class PlaceExtraction(BaseModel):
    """Extraction results for a single place (updated for time series)"""
    place_id: str
    business_name: str

    hours_observations: List[ExtractedHoursForPeriod] = Field(default_factory=list)
    popularity_observations: List[ExtractedPopularityForPeriod] = Field(default_factory=list)


# ============================================================
# Review Candidate Models (unchanged)
# ============================================================

class ReviewCandidate(BaseModel):
    """A review candidate for LLM extraction"""
    review_id: str
    review_date: str
    review_text: str
    relevance_score: float
    match_type: Literal["hours", "popularity", "both"]


class PlaceCandidates(BaseModel):
    """All review candidates for a single place"""
    place_id: str
    business_name: str
    candidates: List[ReviewCandidate]


# ============================================================
# Legacy Models (kept for backward compatibility)
# ============================================================

class EventType(str, Enum):
    """Legacy event types"""
    HOURS_MODIFIED = "hours_modified"
    CLOSED_TEMPORARILY = "closed_temporarily"
    CLOSED_PERMANENTLY = "closed_permanently"
    REOPENED = "reopened"
    SCHEDULE_REDUCED = "schedule_reduced"
    SCHEDULE_EXTENDED = "schedule_extended"


class HoursSpec(BaseModel):
    """Legacy specification for opening/closing hours"""
    status: Literal["open", "closed", "unknown"] = "open"
    open_time: Optional[str] = Field(None, description="Opening time in HH:MM format")
    close_time: Optional[str] = Field(None, description="Closing time in HH:MM format")
    is_24h: bool = False


class HistoricalHours(BaseModel):
    """Legacy historical opening hours record"""
    valid_from: str
    valid_until: Optional[str] = None
    weekly_hours: List[dict]
    source: Literal["review_inference", "direct_observation"] = "review_inference"
    source_reviews: List[str] = Field(default_factory=list)
    confidence: float


class PopularityAdjustment(BaseModel):
    """Legacy adjustment to popularity data"""
    day: str
    hour: int
    original_popularity: int
    adjusted_popularity: int
    reason: str
    source_reviews: List[str] = Field(default_factory=list)
    confidence: float


# ============================================================
# LLM Request/Response Models
# ============================================================

class LLMExtractionRequest(BaseModel):
    """Request format for LLM extraction"""
    place_id: str
    business_name: str
    reviews: List[dict]


class LLMExtractionResponse(BaseModel):
    """Response format from LLM extraction (updated)"""
    hours_observations: List[dict] = Field(default_factory=list)
    popularity_observations: List[dict] = Field(default_factory=list)
