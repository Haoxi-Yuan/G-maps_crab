"""
Main pipeline entry point.
Orchestrates the full flow: vectorize → extract → patch
"""

import json
import glob
import os
from typing import List, Dict, Optional
from datetime import datetime
from tqdm import tqdm

from vectorizer import VectorSearcher
from extractor import create_extractor, StructuredExtractor
from patcher import TimeSeriesBuilder, generate_timeseries_file


class TimeSeriesPatchPipeline:
    """
    Complete pipeline for extracting and patching time-series data.

    Flow:
    1. Load reviews from NDJSON files
    2. Build vector index and search for relevant reviews
    3. Extract structured information using LLM
    4. Patch original data with extracted information
    """

    def __init__(
        self,
        embedding_model: str = "all-MiniLM-L6-v2",
        llm_backend: str = "openai",
        llm_model: str = "gpt-4o-mini",
        llm_api_key: Optional[str] = None,
        llm_base_url: Optional[str] = None,
        cache_dir: str = "/data2/shared/haoxi/.cache/huggingface",
        device: str = "cpu"
    ):
        """
        Initialize the pipeline.

        Args:
            embedding_model: Sentence transformer model name
            llm_backend: LLM backend ("openai", "anthropic", "local", "mock")
            llm_model: LLM model name
            llm_api_key: API key for LLM
            llm_base_url: Base URL for LLM API
            cache_dir: Cache directory for models
            device: Device for embedding model
        """
        print("=" * 60)
        print("Initializing Time Series Patch Pipeline")
        print("=" * 60)

        # Initialize vector searcher
        print("\n[1/2] Loading embedding model...")
        self.searcher = VectorSearcher(
            model_name=embedding_model,
            cache_dir=cache_dir,
            device=device
        )

        # Initialize extractor
        print("\n[2/2] Initializing LLM extractor...")
        self.extractor = create_extractor(
            backend=llm_backend,
            model=llm_model,
            api_key=llm_api_key,
            base_url=llm_base_url
        )
        print(f"  Backend: {llm_backend}")
        print(f"  Model: {llm_model}")

        self.ts_builder: Optional[TimeSeriesBuilder] = None
        self.extractions: Dict[str, Dict] = {}

        print("\nPipeline initialized successfully!")
        print("=" * 60)

    def load_data(self, file_paths: List[str]) -> int:
        """
        Load reviews from NDJSON files.

        Args:
            file_paths: List of NDJSON file paths

        Returns:
            Number of reviews loaded
        """
        print("\n" + "=" * 60)
        print("Step 1: Loading Data")
        print("=" * 60)

        return self.searcher.load_reviews_from_ndjson(file_paths)

    def build_index(self, batch_size: int = 256) -> None:
        """Build vector index."""
        print("\n" + "=" * 60)
        print("Step 2: Building Vector Index")
        print("=" * 60)

        self.searcher.build_index(batch_size=batch_size)

    def search_candidates(
        self,
        query_type: str = "both",
        top_k_per_query: int = 100,
        max_per_place: int = 20,
        threshold: float = 0.35
    ) -> Dict[str, Dict]:
        """
        Search for relevant review candidates.

        Args:
            query_type: "hours", "popularity", or "both"
            top_k_per_query: Top results per query
            max_per_place: Max reviews per place
            threshold: Similarity threshold

        Returns:
            Candidates grouped by place
        """
        print("\n" + "=" * 60)
        print("Step 3: Searching Candidates")
        print("=" * 60)

        candidates = self.searcher.get_candidates_for_extraction(
            query_type=query_type,
            top_k_per_query=top_k_per_query,
            max_per_place=max_per_place,
            threshold=threshold
        )

        # Statistics
        total_candidates = sum(len(c["candidates"]) for c in candidates.values())
        print(f"\nSearch complete:")
        print(f"  Places with candidates: {len(candidates)}")
        print(f"  Total review candidates: {total_candidates}")

        return candidates

    def extract_structured(
        self,
        candidates: Dict[str, Dict],
        save_intermediate: Optional[str] = None
    ) -> Dict[str, Dict]:
        """
        Extract structured information from candidates using LLM.

        Args:
            candidates: Candidates from search_candidates()
            save_intermediate: Optional path to save intermediate results

        Returns:
            Extraction results by place
        """
        print("\n" + "=" * 60)
        print("Step 4: LLM Structured Extraction")
        print("=" * 60)

        total = len(candidates)
        self.extractions = {}

        with tqdm(total=total, desc="Extracting", unit="place") as pbar:
            for place_id, info in candidates.items():
                try:
                    result = self.extractor.extract(
                        place_id=place_id,
                        business_name=info["business_name"],
                        candidates=info["candidates"]
                    )
                    self.extractions[place_id] = {
                        "place_id": place_id,
                        "business_name": info["business_name"],
                        **result
                    }
                except Exception as e:
                    print(f"\n  Error extracting {info['business_name']}: {e}")
                    self.extractions[place_id] = {
                        "place_id": place_id,
                        "business_name": info["business_name"],
                        "hour_changes": [],
                        "popularity_signals": [],
                        "error": str(e)
                    }

                pbar.update(1)

                # Show current stats
                hour_count = sum(len(e.get("hour_changes", [])) for e in self.extractions.values())
                pop_count = sum(len(e.get("popularity_signals", [])) for e in self.extractions.values())
                pbar.set_postfix({
                    "hours": hour_count,
                    "popularity": pop_count
                })

        # Save intermediate if requested
        if save_intermediate:
            with open(save_intermediate, 'w', encoding='utf-8') as f:
                json.dump(self.extractions, f, ensure_ascii=False, indent=2)
            print(f"\nIntermediate results saved to: {save_intermediate}")

        # Statistics
        total_hours = sum(len(e.get("hour_changes", [])) for e in self.extractions.values())
        total_pop = sum(len(e.get("popularity_signals", [])) for e in self.extractions.values())

        print(f"\nExtraction complete:")
        print(f"  Places processed: {len(self.extractions)}")
        print(f"  Hour changes found: {total_hours}")
        print(f"  Popularity signals found: {total_pop}")

        return self.extractions

    def generate_timeseries(
        self,
        input_paths: List[str],
        output_dir: str,
        current_period: str = "2026-01",
        fill_gaps: bool = True
    ) -> Dict[str, Dict]:
        """
        Generate time series data files from extractions.

        Args:
            input_paths: Original NDJSON file paths
            output_dir: Output directory for time series files
            current_period: Period to assign to current/original data
            fill_gaps: Whether to fill missing months with nearest data

        Returns:
            Statistics for each file
        """
        print("\n" + "=" * 60)
        print("Step 5: Generating Time Series Data")
        print("=" * 60)

        if not self.extractions:
            raise ValueError("No extractions available. Run extract_structured first.")

        # Create time series builder
        self.ts_builder = TimeSeriesBuilder(self.extractions, current_period)

        # Ensure output directory exists
        os.makedirs(output_dir, exist_ok=True)

        all_stats = {}

        for input_path in tqdm(input_paths, desc="Processing files", unit="file"):
            filename = os.path.basename(input_path)
            output_path = os.path.join(output_dir, f"timeseries_{filename}")

            # Count lines for progress
            with open(input_path, 'r') as f:
                total_lines = sum(1 for _ in f)

            # Generate time series with progress bar
            with tqdm(total=total_lines, desc=f"  {filename}", unit="record", leave=False) as pbar:
                def progress_callback(line_num, has_extraction):
                    pbar.update(1)
                    if has_extraction:
                        pbar.set_postfix({"extracted": "✓"})

                stats = generate_timeseries_file(
                    extractions=self.extractions,
                    input_path=input_path,
                    output_path=output_path,
                    current_period=current_period,
                    fill_gaps=fill_gaps,
                    progress_callback=progress_callback
                )

            all_stats[filename] = stats
            print(f"  {filename}: {stats['records_with_extractions']}/{stats['total_records']} with extractions")

        # Summary
        print("\nTime series generation complete:")
        total_with_extractions = sum(s["records_with_extractions"] for s in all_stats.values())
        total_records = sum(s["total_records"] for s in all_stats.values())
        total_hours_snapshots = sum(s["total_hours_snapshots"] for s in all_stats.values())
        total_pop_snapshots = sum(s["total_popularity_snapshots"] for s in all_stats.values())

        print(f"  Total records: {total_records}")
        print(f"  Records with extractions: {total_with_extractions}")
        print(f"  Total hours snapshots: {total_hours_snapshots}")
        print(f"  Total popularity snapshots: {total_pop_snapshots}")
        print(f"\nOutput directory: {output_dir}")

        return all_stats

    def run(
        self,
        input_paths: List[str],
        output_dir: str,
        query_type: str = "both",
        top_k_per_query: int = 100,
        max_per_place: int = 20,
        threshold: float = 0.35,
        batch_size: int = 256,
        save_intermediate: Optional[str] = None,
        current_period: str = "2026-01",
        fill_gaps: bool = True
    ) -> Dict:
        """
        Run the complete pipeline.

        Args:
            input_paths: Input NDJSON file paths
            output_dir: Output directory
            query_type: Type of queries to run
            top_k_per_query: Top results per query
            max_per_place: Max reviews per place
            threshold: Similarity threshold
            batch_size: Batch size for encoding
            save_intermediate: Optional path for intermediate results
            current_period: Period to assign to current data (default: 2026-01)
            fill_gaps: Whether to fill missing months with nearest data

        Returns:
            Pipeline results and statistics
        """
        start_time = datetime.now()

        print("\n" + "=" * 60)
        print("TIME SERIES DATA PIPELINE")
        print("=" * 60)
        print(f"Start time: {start_time.isoformat()}")
        print(f"Input files: {len(input_paths)}")
        print(f"Output dir: {output_dir}")
        print(f"Current period: {current_period}")
        print(f"Fill gaps: {fill_gaps}")

        # Step 1: Load data
        num_reviews = self.load_data(input_paths)

        # Step 2: Build index
        self.build_index(batch_size=batch_size)

        # Step 3: Search candidates
        candidates = self.search_candidates(
            query_type=query_type,
            top_k_per_query=top_k_per_query,
            max_per_place=max_per_place,
            threshold=threshold
        )

        # Step 4: Extract structured info
        extractions = self.extract_structured(
            candidates,
            save_intermediate=save_intermediate
        )

        # Step 5: Generate time series files
        ts_stats = self.generate_timeseries(
            input_paths,
            output_dir,
            current_period=current_period,
            fill_gaps=fill_gaps
        )

        end_time = datetime.now()
        duration = (end_time - start_time).total_seconds()

        print("\n" + "=" * 60)
        print("PIPELINE COMPLETE")
        print("=" * 60)
        print(f"Duration: {duration:.1f} seconds")
        print(f"Reviews processed: {num_reviews}")
        print(f"Places with extractions: {len(extractions)}")

        return {
            "start_time": start_time.isoformat(),
            "end_time": end_time.isoformat(),
            "duration_seconds": duration,
            "num_reviews": num_reviews,
            "num_places_extracted": len(extractions),
            "timeseries_stats": ts_stats
        }


def main():
    """Run pipeline on Singapore data"""
    import argparse

    parser = argparse.ArgumentParser(description="Time Series Data Pipeline")
    parser.add_argument(
        "--input-dir",
        default="/data2/shared/haoxi/projects/G-maps_crab/Pipeline/data",
        help="Input directory containing NDJSON files"
    )
    parser.add_argument(
        "--output-dir",
        default="/data2/shared/haoxi/projects/G-maps_crab/Pipeline/output",
        help="Output directory for time series files"
    )
    parser.add_argument(
        "--pattern",
        default="coordinates_singapore_00[1-6].ndjson",
        help="Glob pattern for input files"
    )
    parser.add_argument(
        "--llm-backend",
        default="mock",
        choices=["openai", "anthropic", "local", "mock"],
        help="LLM backend"
    )
    parser.add_argument(
        "--llm-model",
        default="gpt-4o-mini",
        help="LLM model name"
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=0.35,
        help="Similarity threshold"
    )
    parser.add_argument(
        "--max-per-place",
        type=int,
        default=15,
        help="Max reviews per place"
    )
    parser.add_argument(
        "--save-intermediate",
        help="Path to save intermediate extraction results"
    )
    parser.add_argument(
        "--current-period",
        default="2026-01",
        help="Period to assign to current data (YYYY-MM format)"
    )
    parser.add_argument(
        "--no-fill-gaps",
        action="store_true",
        help="Do not fill missing months with nearest data"
    )

    args = parser.parse_args()

    # Find input files
    input_files = sorted(glob.glob(os.path.join(args.input_dir, args.pattern)))
    if not input_files:
        print(f"No files found matching: {os.path.join(args.input_dir, args.pattern)}")
        return

    print(f"Found {len(input_files)} input files")

    # Create pipeline
    pipeline = TimeSeriesPatchPipeline(
        llm_backend=args.llm_backend,
        llm_model=args.llm_model
    )

    # Run pipeline
    results = pipeline.run(
        input_paths=input_files,
        output_dir=args.output_dir,
        threshold=args.threshold,
        max_per_place=args.max_per_place,
        save_intermediate=args.save_intermediate,
        current_period=args.current_period,
        fill_gaps=not args.no_fill_gaps
    )

    # Save results
    results_path = os.path.join(args.output_dir, "pipeline_results.json")
    with open(results_path, 'w') as f:
        json.dump(results, f, indent=2)
    print(f"\nResults saved to: {results_path}")


if __name__ == "__main__":
    main()
