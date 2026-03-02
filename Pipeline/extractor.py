"""
LLM-based structured extraction module.
Extracts opening hours changes and popularity signals from review candidates.
"""

import json
import re
from typing import List, Dict, Optional, Any
from dataclasses import dataclass
from datetime import datetime, timedelta
import os

# Will be imported based on available backend
try:
    import openai
    HAS_OPENAI = True
except ImportError:
    HAS_OPENAI = False

try:
    import anthropic
    HAS_ANTHROPIC = True
except ImportError:
    HAS_ANTHROPIC = False


EXTRACTION_PROMPT = '''You are an expert at extracting time-series data about business operating hours and crowd levels from customer reviews.

## Task
Analyze the reviews below and extract TWO types of time-series observations:

1. **Opening Hours Observations**: What opening hours were observed at specific time periods?
   - Look for explicit mentions of opening/closing times
   - Note any day-specific hours (e.g., "open till 10pm on weekdays")
   - Identify if the business was open 24h or closed on certain days
   - Pay attention to temporal context (when was this observation made?)

2. **Popularity/Crowd Observations**: What crowd levels were observed at specific times?
   - How busy/crowded was the place at specific hours or periods?
   - What were the wait times or queue situations?
   - Which days/times were busier or quieter?

## Input
- Business: {business_name}
- Place ID: {place_id}
- Reviews (with dates):
{reviews_json}

## Output Requirements
Return ONLY valid JSON (no markdown, no explanation) with this exact structure:

{{
  "hours_observations": [
    {{
      "review_id": "the review_id from input",
      "review_date": "copy from input",
      "inferred_period": "YYYY-MM format - the month this observation applies to",
      "mentioned_hours": [
        {{
          "day": "Monday|Tuesday|...|Sunday|weekdays|weekends|all",
          "hours": "human readable format like '9:00 AM–9:00 PM' or 'Open 24 hours' or 'Closed'",
          "openHour": 0-23 or null,
          "closeHour": 0-24 or null (24 means midnight/next day)
        }}
      ],
      "evidence": "exact quote or close paraphrase from the review that supports this",
      "confidence": 0.0-1.0
    }}
  ],
  "popularity_observations": [
    {{
      "review_id": "the review_id from input",
      "review_date": "copy from input",
      "inferred_period": "YYYY-MM format - the month this observation applies to",
      "observations": [
        {{
          "day": "Monday|...|Sunday|weekdays|weekends|all" or null,
          "hour": 0-23 or null,
          "time_period": "morning|afternoon|evening|night|lunch|dinner" or null,
          "popularity_level": "very_low|low|medium|high|very_high",
          "popularity_score": 0-100 estimated value
        }}
      ],
      "evidence": "exact quote or close paraphrase from the review that supports this",
      "confidence": 0.0-1.0
    }}
  ]
}}

## Critical Rules

### Time Period Inference
- The `inferred_period` should be the YYYY-MM when the observation was MADE
- Usually this is the same month as the review_date (extract YYYY-MM from review_date)
- If reviewer says "last month it was..." or "a few weeks ago...", adjust accordingly
- If reviewer says "back in 2024..." or "when I visited in March...", use that period

### Evidence Field (IMPORTANT)
- MUST include the exact text or close paraphrase that supports your extraction
- This is critical for verification - be specific about what the reviewer said
- Example: "The reviewer stated: 'Opens at 9am sharp every day'"

### Confidence Scoring
- 1.0: Explicit statement like "opens at 9am" or "packed at 6pm"
- 0.7-0.9: Clear but less specific like "usually opens around 9" or "very busy on weekends"
- 0.5-0.6: Somewhat vague like "seems to open late" or "can get crowded"
- 0.3-0.4: Indirect hints only

### Popularity Score Mapping
- very_low (0-20): "empty", "deserted", "nobody there", "completely dead"
- low (20-40): "quiet", "few people", "not busy", "easy to find seats"
- medium (40-60): "moderate", "some customers", "normal", "decent crowd"
- high (60-80): "busy", "crowded", "lots of people", "had to wait a bit"
- very_high (80-100): "packed", "extremely crowded", "long queue", "impossible to get in"

### Empty Results
- If NO relevant information found in a review, do NOT include it in output
- Only extract what is explicitly or clearly implied in the review text
'''


@dataclass
class LLMConfig:
    """Configuration for LLM backend"""
    backend: str  # "openai", "anthropic", "local"
    model: str
    api_key: Optional[str] = None
    base_url: Optional[str] = None
    max_tokens: int = 4096
    temperature: float = 0.1


class StructuredExtractor:
    """Extract structured information from reviews using LLM"""

    def __init__(self, config: LLMConfig):
        """
        Initialize the extractor with LLM configuration.

        Args:
            config: LLM configuration
        """
        self.config = config
        self._init_client()

    def _init_client(self):
        """Initialize the LLM client based on backend"""
        if self.config.backend == "openai":
            if not HAS_OPENAI:
                raise ImportError("openai package not installed")
            self.client = openai.OpenAI(
                api_key=self.config.api_key or os.environ.get("OPENAI_API_KEY"),
                base_url=self.config.base_url
            )
        elif self.config.backend == "anthropic":
            if not HAS_ANTHROPIC:
                raise ImportError("anthropic package not installed")
            self.client = anthropic.Anthropic(
                api_key=self.config.api_key or os.environ.get("ANTHROPIC_API_KEY")
            )
        elif self.config.backend == "local":
            # For local models via OpenAI-compatible API
            if not HAS_OPENAI:
                raise ImportError("openai package not installed (needed for local API)")
            self.client = openai.OpenAI(
                api_key=self.config.api_key or "not-needed",
                base_url=self.config.base_url or "http://localhost:8000/v1"
            )
        else:
            raise ValueError(f"Unknown backend: {self.config.backend}")

    def _call_llm(self, prompt: str) -> str:
        """Call the LLM and return response text"""
        if self.config.backend in ("openai", "local"):
            response = self.client.chat.completions.create(
                model=self.config.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=self.config.max_tokens,
                temperature=self.config.temperature,
            )
            return response.choices[0].message.content

        elif self.config.backend == "anthropic":
            response = self.client.messages.create(
                model=self.config.model,
                max_tokens=self.config.max_tokens,
                temperature=self.config.temperature,
                messages=[{"role": "user", "content": prompt}]
            )
            return response.content[0].text

    def _parse_json_response(self, response: str) -> Dict:
        """Parse JSON from LLM response, handling common issues"""
        # Remove markdown code blocks if present
        response = re.sub(r'^```json\s*', '', response.strip())
        response = re.sub(r'\s*```$', '', response)
        response = re.sub(r'^```\s*', '', response)

        try:
            return json.loads(response)
        except json.JSONDecodeError as e:
            # Try to find JSON object in response
            match = re.search(r'\{[\s\S]*\}', response)
            if match:
                try:
                    return json.loads(match.group())
                except:
                    pass
            print(f"Failed to parse JSON: {e}")
            print(f"Response was: {response[:500]}...")
            return {"hours_observations": [], "popularity_observations": []}

    def extract(
        self,
        place_id: str,
        business_name: str,
        candidates: List[Dict]
    ) -> Dict:
        """
        Extract time-series information from review candidates.

        Args:
            place_id: Place ID
            business_name: Business name
            candidates: List of review candidate dicts

        Returns:
            Extraction results with hours_observations and popularity_observations
        """
        # Prepare reviews for prompt
        reviews_for_prompt = [
            {
                "review_id": c["review_id"],
                "review_date": c["review_date"],
                "review_text": c["review_text"][:1000]  # Truncate long reviews
            }
            for c in candidates
        ]

        prompt = EXTRACTION_PROMPT.format(
            business_name=business_name,
            place_id=place_id,
            reviews_json=json.dumps(reviews_for_prompt, indent=2, ensure_ascii=False)
        )

        response_text = self._call_llm(prompt)
        result = self._parse_json_response(response_text)

        # Ensure required keys exist (new format)
        if "hours_observations" not in result:
            result["hours_observations"] = []
        if "popularity_observations" not in result:
            result["popularity_observations"] = []

        # Add review text snippets to results for reference
        review_map = {c["review_id"]: c["review_text"][:500] for c in candidates}

        for obs in result.get("hours_observations", []):
            rid = obs.get("review_id", "")
            obs["review_text_snippet"] = review_map.get(rid, "")

        for obs in result.get("popularity_observations", []):
            rid = obs.get("review_id", "")
            obs["review_text_snippet"] = review_map.get(rid, "")

        return result

    def batch_extract(
        self,
        candidates_by_place: Dict[str, Dict],
        progress_callback=None
    ) -> Dict[str, Dict]:
        """
        Extract from multiple places.

        Args:
            candidates_by_place: Dict mapping place_id to candidate info
            progress_callback: Optional callback(place_id, idx, total)

        Returns:
            Dict mapping place_id to extraction results
        """
        results = {}
        total = len(candidates_by_place)

        for idx, (place_id, info) in enumerate(candidates_by_place.items()):
            if progress_callback:
                progress_callback(place_id, idx, total)

            try:
                result = self.extract(
                    place_id=place_id,
                    business_name=info["business_name"],
                    candidates=info["candidates"]
                )
                results[place_id] = {
                    "place_id": place_id,
                    "business_name": info["business_name"],
                    **result
                }
            except Exception as e:
                print(f"Error extracting from {place_id}: {e}")
                results[place_id] = {
                    "place_id": place_id,
                    "business_name": info["business_name"],
                    "hour_changes": [],
                    "popularity_signals": [],
                    "error": str(e)
                }

        return results


class MockExtractor(StructuredExtractor):
    """Mock extractor for testing without LLM API"""

    def __init__(self):
        self.config = LLMConfig(backend="mock", model="mock")

    def _init_client(self):
        pass

    def extract(
        self,
        place_id: str,
        business_name: str,
        candidates: List[Dict]
    ) -> Dict:
        """Return mock extraction results for testing (new format)"""
        hours_observations = []
        popularity_observations = []

        for c in candidates:
            text = c["review_text"].lower() if c.get("review_text") else ""
            review_date = c.get("review_date", "")

            # Extract YYYY-MM from review_date
            inferred_period = review_date[:7] if len(review_date) >= 7 else "2025-01"

            # Simple pattern matching for mock - hours
            if any(kw in text for kw in ["hour", "open", "close", "24"]):
                hours_observations.append({
                    "review_id": c["review_id"],
                    "review_date": review_date,
                    "inferred_period": inferred_period,
                    "mentioned_hours": [
                        {
                            "day": "all",
                            "hours": "9:00 AM–9:00 PM",
                            "openHour": 9,
                            "closeHour": 21
                        }
                    ],
                    "evidence": f"[Mock] Review mentions hours-related keywords",
                    "confidence": 0.5,
                    "review_text_snippet": c.get("review_text", "")[:200]
                })

            # Simple pattern matching for mock - popularity
            if any(kw in text for kw in ["crowd", "busy", "queue", "wait", "empty"]):
                is_busy = any(kw in text for kw in ["crowd", "busy", "queue"])
                level = "high" if is_busy else "low"
                score = 75 if is_busy else 25

                popularity_observations.append({
                    "review_id": c["review_id"],
                    "review_date": review_date,
                    "inferred_period": inferred_period,
                    "observations": [
                        {
                            "day": None,
                            "hour": None,
                            "time_period": None,
                            "popularity_level": level,
                            "popularity_score": score
                        }
                    ],
                    "evidence": f"[Mock] Review mentions crowd-related keywords",
                    "confidence": 0.5,
                    "review_text_snippet": c.get("review_text", "")[:200]
                })

        return {
            "hours_observations": hours_observations,
            "popularity_observations": popularity_observations
        }


def create_extractor(
    backend: str = "openai",
    model: str = "gpt-4o-mini",
    api_key: Optional[str] = None,
    base_url: Optional[str] = None
) -> StructuredExtractor:
    """
    Factory function to create an extractor.

    Args:
        backend: "openai", "anthropic", "local", or "mock"
        model: Model name
        api_key: API key (optional, uses env var if not provided)
        base_url: Base URL for API (optional, for local models)

    Returns:
        StructuredExtractor instance
    """
    if backend == "mock":
        return MockExtractor()

    config = LLMConfig(
        backend=backend,
        model=model,
        api_key=api_key,
        base_url=base_url
    )
    return StructuredExtractor(config)
