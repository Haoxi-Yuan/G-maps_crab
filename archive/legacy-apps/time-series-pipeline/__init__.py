"""
Time Series Patch Pipeline

A pipeline for extracting and repairing opening hours and popularity data
from Google Maps reviews using vector search and LLM-based extraction.
"""

from .schemas import (
    HourChangeEvent,
    PopularitySignal,
    PlaceExtraction,
    ReviewCandidate,
    PlaceCandidates,
    HistoricalHours,
    PopularityAdjustment,
)

from .vectorizer import VectorSearcher, HOUR_QUERIES, POPULARITY_QUERIES
from .extractor import create_extractor, StructuredExtractor, MockExtractor
from .patcher import create_patcher, TimelinePatcher
from .pipeline import TimeSeriesPatchPipeline

__version__ = "0.1.0"
__all__ = [
    "TimeSeriesPatchPipeline",
    "VectorSearcher",
    "create_extractor",
    "create_patcher",
    "StructuredExtractor",
    "MockExtractor",
    "TimelinePatcher",
    "HourChangeEvent",
    "PopularitySignal",
    "PlaceExtraction",
]
