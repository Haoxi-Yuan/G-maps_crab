"""
Vector search module for filtering relevant reviews.
Uses sentence-transformers for embedding and FAISS for similarity search.
"""

import json
import os
from typing import List, Dict, Tuple, Optional
from dataclasses import dataclass
import numpy as np
import faiss
from sentence_transformers import SentenceTransformer
from tqdm import tqdm


# Predefined queries for different extraction targets
HOUR_QUERIES = [
    # Direct mentions of hour changes
    "Opening hours changed modified different now",
    "Used to be open 24 hours now closes earlier",
    "New operating hours schedule timing",
    "Hours are wrong incorrect on Google Maps",
    "Shop closed when I arrived not open yet",
    "Permanently closed shut down out of business",
    "Temporarily closed renovation maintenance",
    "Reopened after renovation new hours",
    "Opens later earlier than before used to",
    "Closes earlier later than listed shown",
    "No longer 24 hours reduced hours",
    "Extended hours now open longer",
    "Sunday Monday closed not open on weekends",
    "Holiday hours special schedule",
]

POPULARITY_QUERIES = [
    # Crowd level observations
    "Very crowded busy packed full of people",
    "Empty quiet no customers nobody there",
    "Long queue waiting line outside",
    "Best time to visit avoid crowd peak",
    "Usually busy around dinner lunch time",
    "Weekends are extremely crowded packed",
    "Weekday mornings are quiet empty",
    "Wait time minutes hour for table seat",
    "No waiting got seat immediately",
    "Standing room only very busy",
    "Peak hours rush hour busy period",
    "Off-peak quiet not many people",
]


@dataclass
class ReviewRecord:
    """A review record with metadata"""
    review_id: str
    review_text: str
    review_date: str
    place_id: str
    business_name: str
    embedding: Optional[np.ndarray] = None


class VectorSearcher:
    """Vector-based search for relevant reviews"""

    def __init__(
        self,
        model_name: str = "all-MiniLM-L6-v2",
        cache_dir: Optional[str] = None,
        device: str = "cpu"
    ):
        """
        Initialize the vector searcher.

        Args:
            model_name: Name of the sentence-transformer model
            cache_dir: Directory for model cache
            device: Device to run model on ('cpu' or 'cuda')
        """
        if cache_dir:
            os.environ['HF_HOME'] = cache_dir
            os.environ['TRANSFORMERS_CACHE'] = cache_dir

        print(f"Loading embedding model: {model_name} ...", flush=True)
        import sys
        sys.stdout.flush()
        self.model = SentenceTransformer(model_name, device=device)
        self.embedding_dim = self.model.get_sentence_embedding_dimension()
        print(f"Model loaded. Embedding dimension: {self.embedding_dim}", flush=True)

        self.reviews: List[ReviewRecord] = []
        self.index: Optional[faiss.Index] = None

        # Pre-compute query embeddings
        print("Computing query embeddings...", flush=True)
        self.hour_query_embeddings = self._encode_queries(HOUR_QUERIES)
        print("  - Hour queries encoded", flush=True)
        self.popularity_query_embeddings = self._encode_queries(POPULARITY_QUERIES)
        print("  - Popularity queries encoded", flush=True)
        print("Initialization complete!", flush=True)

    def _encode_queries(self, queries: List[str]) -> np.ndarray:
        """Encode query strings to embeddings"""
        embeddings = self.model.encode(queries, convert_to_numpy=True)
        faiss.normalize_L2(embeddings)
        return embeddings

    def load_reviews_from_ndjson(self, file_paths: List[str]) -> int:
        """
        Load reviews from NDJSON files.

        Args:
            file_paths: List of NDJSON file paths

        Returns:
            Number of reviews loaded
        """
        self.reviews = []

        # 先统计总行数
        print("Counting lines in files...")
        total_lines = 0
        file_lines = {}
        for file_path in tqdm(file_paths, desc="Scanning files", unit="file"):
            with open(file_path, 'r', encoding='utf-8') as f:
                count = sum(1 for _ in f)
                file_lines[file_path] = count
                total_lines += count

        print(f"Total records to process: {total_lines}")

        # 加载数据，显示总体进度
        with tqdm(total=total_lines, desc="Loading reviews", unit="record") as pbar:
            for file_path in file_paths:
                pbar.set_postfix({"file": os.path.basename(file_path)})
                with open(file_path, 'r', encoding='utf-8') as f:
                    for line in f:
                        try:
                            data = json.loads(line)
                            place_id = data.get('business', {}).get('placeId', '')
                            business_name = data.get('business', {}).get('name', '')

                            for review in data.get('detailedReviews', []):
                                review_text = review.get('review_text')
                                if review_text:
                                    self.reviews.append(ReviewRecord(
                                        review_id=review.get('review_id', ''),
                                        review_text=review_text,
                                        review_date=review.get('published_at_date', ''),
                                        place_id=place_id,
                                        business_name=business_name,
                                    ))
                        except json.JSONDecodeError:
                            continue
                        pbar.update(1)

        print(f"Loaded {len(self.reviews)} reviews from {len(file_paths)} files")
        return len(self.reviews)

    def build_index(self, batch_size: int = 256) -> None:
        """
        Build FAISS index from loaded reviews.

        Args:
            batch_size: Batch size for encoding
        """
        if not self.reviews:
            raise ValueError("No reviews loaded. Call load_reviews_from_ndjson first.")

        print(f"Encoding {len(self.reviews)} reviews (batch_size={batch_size})...")
        texts = [r.review_text for r in self.reviews]

        # Encode in batches with progress
        all_embeddings = []
        total_batches = (len(texts) + batch_size - 1) // batch_size
        with tqdm(total=len(texts), desc="Encoding reviews", unit="review") as pbar:
            for i in range(0, len(texts), batch_size):
                batch = texts[i:i + batch_size]
                embeddings = self.model.encode(batch, convert_to_numpy=True, show_progress_bar=False)
                all_embeddings.append(embeddings)
                pbar.update(len(batch))
                pbar.set_postfix({"batch": f"{i//batch_size + 1}/{total_batches}"})

        print("Stacking embeddings...")
        embeddings = np.vstack(all_embeddings).astype('float32')
        faiss.normalize_L2(embeddings)

        # Store embeddings in review records
        print("Storing embeddings in review records...")
        for i, review in enumerate(self.reviews):
            review.embedding = embeddings[i]

        # Build FAISS index (Inner Product = Cosine similarity after normalization)
        print("Building FAISS index...")
        self.index = faiss.IndexFlatIP(self.embedding_dim)
        self.index.add(embeddings)
        print(f"Index built with {self.index.ntotal} vectors")

    def search(
        self,
        query_type: str = "both",
        top_k: int = 100,
        threshold: float = 0.3
    ) -> Dict[str, List[Tuple[ReviewRecord, float, str]]]:
        """
        Search for relevant reviews.

        Args:
            query_type: "hours", "popularity", or "both"
            top_k: Number of top results per query
            threshold: Minimum similarity threshold

        Returns:
            Dict mapping place_id to list of (review, score, match_type) tuples
        """
        if self.index is None:
            raise ValueError("Index not built. Call build_index first.")

        results: Dict[str, List[Tuple[ReviewRecord, float, str]]] = {}

        def search_with_queries(query_embeddings: np.ndarray, match_type: str):
            """Search with a set of query embeddings"""
            D, I = self.index.search(query_embeddings.astype('float32'), top_k)

            for q_idx in range(len(query_embeddings)):
                for rank, (score, idx) in enumerate(zip(D[q_idx], I[q_idx])):
                    if score < threshold:
                        continue
                    if idx < 0 or idx >= len(self.reviews):
                        continue

                    review = self.reviews[idx]
                    place_id = review.place_id

                    if place_id not in results:
                        results[place_id] = []

                    # Check if already added
                    existing = [r for r, s, t in results[place_id] if r.review_id == review.review_id]
                    if not existing:
                        results[place_id].append((review, float(score), match_type))
                    else:
                        # Update match type to "both" if found with different type
                        for i, (r, s, t) in enumerate(results[place_id]):
                            if r.review_id == review.review_id and t != match_type:
                                results[place_id][i] = (r, max(s, float(score)), "both")

        if query_type in ("hours", "both"):
            print("Searching for hour-related reviews...")
            search_with_queries(self.hour_query_embeddings, "hours")

        if query_type in ("popularity", "both"):
            print("Searching for popularity-related reviews...")
            search_with_queries(self.popularity_query_embeddings, "popularity")

        # Sort by score within each place
        for place_id in results:
            results[place_id].sort(key=lambda x: x[1], reverse=True)

        print(f"Found relevant reviews in {len(results)} places")
        return results

    def get_candidates_for_extraction(
        self,
        query_type: str = "both",
        top_k_per_query: int = 100,
        max_per_place: int = 20,
        threshold: float = 0.3
    ) -> Dict[str, Dict]:
        """
        Get review candidates grouped by place for LLM extraction.

        Args:
            query_type: "hours", "popularity", or "both"
            top_k_per_query: Number of top results per query
            max_per_place: Maximum reviews per place
            threshold: Minimum similarity threshold

        Returns:
            Dict mapping place_id to candidate info
        """
        search_results = self.search(query_type, top_k_per_query, threshold)

        candidates = {}
        for place_id, reviews in search_results.items():
            # Take top N per place
            top_reviews = reviews[:max_per_place]

            if not top_reviews:
                continue

            business_name = top_reviews[0][0].business_name

            candidates[place_id] = {
                "place_id": place_id,
                "business_name": business_name,
                "candidates": [
                    {
                        "review_id": r.review_id,
                        "review_date": r.review_date,
                        "review_text": r.review_text,
                        "relevance_score": score,
                        "match_type": match_type
                    }
                    for r, score, match_type in top_reviews
                ]
            }

        return candidates

    def save_index(self, path: str) -> None:
        """Save FAISS index to disk"""
        if self.index is not None:
            faiss.write_index(self.index, path)
            print(f"Index saved to {path}")

    def load_index(self, path: str) -> None:
        """Load FAISS index from disk"""
        self.index = faiss.read_index(path)
        print(f"Index loaded from {path}, {self.index.ntotal} vectors")


def main():
    """Test the vectorizer"""
    import glob

    # Find NDJSON files
    data_dir = "/data2/shared/haoxi/projects/G-maps_crab/Pipeline/data"
    files = sorted(glob.glob(f"{data_dir}/coordinates_singapore_00[1-6].ndjson"))

    if not files:
        print("No NDJSON files found")
        return

    print(f"\n{'='*60}")
    print(f"Vector Search Pipeline")
    print(f"{'='*60}")
    print(f"Found {len(files)} files:")
    for f in files:
        print(f"  - {os.path.basename(f)}")

    # Initialize searcher
    print(f"\n{'='*60}")
    print("Step 1: Initialize Model")
    print(f"{'='*60}")
    searcher = VectorSearcher(
        cache_dir="/data2/shared/haoxi/.cache/huggingface"
    )

    # Load and index
    print(f"\n{'='*60}")
    print("Step 2: Load Reviews")
    print(f"{'='*60}")
    searcher.load_reviews_from_ndjson(files)

    print(f"\n{'='*60}")
    print("Step 3: Build Index")
    print(f"{'='*60}")
    searcher.build_index(batch_size=512)

    # Search
    print(f"\n{'='*60}")
    print("Step 4: Search Candidates")
    print(f"{'='*60}")
    candidates = searcher.get_candidates_for_extraction(
        query_type="both",
        top_k_per_query=50,
        max_per_place=10,
        threshold=0.35
    )

    # Statistics
    print(f"\n{'='*60}")
    print("Results Summary")
    print(f"{'='*60}")
    print(f"Places with candidates: {len(candidates)}")
    total_candidates = sum(len(c['candidates']) for c in candidates.values())
    print(f"Total candidate reviews: {total_candidates}")

    # Count by match type
    hours_count = sum(1 for c in candidates.values() for r in c['candidates'] if r['match_type'] == 'hours')
    pop_count = sum(1 for c in candidates.values() for r in c['candidates'] if r['match_type'] == 'popularity')
    both_count = sum(1 for c in candidates.values() for r in c['candidates'] if r['match_type'] == 'both')
    print(f"  - Hours related: {hours_count}")
    print(f"  - Popularity related: {pop_count}")
    print(f"  - Both: {both_count}")

    # Save results
    output_path = "/data2/shared/haoxi/projects/G-maps_crab/Pipeline/vector_search_results.json"
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(candidates, f, ensure_ascii=False, indent=2)
    print(f"\nResults saved to: {output_path}")

    # Show sample
    print(f"\n{'='*60}")
    print("Sample Results (Top 5 places)")
    print(f"{'='*60}")
    for i, (place_id, info) in enumerate(list(candidates.items())[:5]):
        print(f"\n【{i+1}】{info['business_name']}")
        print(f"    Candidates: {len(info['candidates'])}")
        for c in info['candidates'][:3]:
            text_preview = c['review_text'][:70].replace('\n', ' ')
            print(f"    [{c['match_type']:10}] {c['relevance_score']:.3f}: {text_preview}...")


if __name__ == "__main__":
    main()
