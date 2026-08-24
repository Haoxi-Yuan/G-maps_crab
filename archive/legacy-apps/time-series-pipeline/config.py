"""
Configuration for the pipeline.
"""

import os
from dataclasses import dataclass, field
from typing import Optional, List


@dataclass
class PipelineConfig:
    """Pipeline configuration"""

    # Paths
    input_dir: str = "/data2/shared/haoxi/projects/G-maps_crab/time_scraper/output"
    output_dir: str = "/data2/shared/haoxi/projects/G-maps_crab/Pipeline/output"
    cache_dir: str = "/data2/shared/haoxi/.cache/huggingface"

    # Input file pattern
    input_pattern: str = "coordinates_singapore_00[1-6].ndjson"

    # Embedding model
    embedding_model: str = "all-MiniLM-L6-v2"
    embedding_device: str = "cpu"
    embedding_batch_size: int = 256

    # Vector search
    search_threshold: float = 0.35
    search_top_k_per_query: int = 100
    search_max_per_place: int = 15
    search_query_type: str = "both"  # "hours", "popularity", or "both"

    # LLM extraction
    llm_backend: str = "mock"  # "openai", "anthropic", "local", "mock"
    llm_model: str = "gpt-4o-mini"
    llm_api_key: Optional[str] = None
    llm_base_url: Optional[str] = None

    # Output options
    save_intermediate: bool = True
    intermediate_filename: str = "extractions.json"

    def __post_init__(self):
        # Load API key from environment if not provided
        if self.llm_api_key is None:
            if self.llm_backend == "openai":
                self.llm_api_key = os.environ.get("OPENAI_API_KEY")
            elif self.llm_backend == "anthropic":
                self.llm_api_key = os.environ.get("ANTHROPIC_API_KEY")

    @property
    def intermediate_path(self) -> str:
        return os.path.join(self.output_dir, self.intermediate_filename)


# Preset configurations

MOCK_CONFIG = PipelineConfig(
    llm_backend="mock",
    search_max_per_place=10,
)

OPENAI_CONFIG = PipelineConfig(
    llm_backend="openai",
    llm_model="gpt-4o-mini",
)

ANTHROPIC_CONFIG = PipelineConfig(
    llm_backend="anthropic",
    llm_model="claude-3-haiku-20240307",
)

LOCAL_CONFIG = PipelineConfig(
    llm_backend="local",
    llm_model="llama3",
    llm_base_url="http://localhost:11434/v1",
)
