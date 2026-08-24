#!/bin/bash

# Quick test script for batch scraper with reviews integration

# Get script directory and project root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo "=== Testing Batch Scraper with Reviews ==="
echo ""

# Check if reviews extractor exists
if [ ! -f "$PROJECT_ROOT/src/reviews_extractor_scroll.js" ]; then
    echo "ERROR: reviews_extractor_scroll.js not found!"
    exit 1
fi

# Check if pipeline exists
if [ ! -f "/Volumes/Data/scraper/google-maps-scraper-pipeline.js" ]; then
    echo "ERROR: Pipeline script not found!"
    exit 1
fi

# Create test input with just one place
TEST_INPUT="$PROJECT_ROOT/test_single_place.json"
echo '[{"place_id":"ChIJo3EXjvAZ2jERRdFfHa-rqT8"}]' > "$TEST_INPUT"

TEST_OUTPUT="$PROJECT_ROOT/output/test_batch_reviews.ndjson"

echo "Test configuration:"
echo "  Input: $TEST_INPUT (1 place)"
echo "  Output: $TEST_OUTPUT"
echo "  Max reviews: 30"
echo "  Max scrolls: 10"
echo ""

# Run test
echo "Starting test..."
node "$PROJECT_ROOT/src/gmaps_batch_scrape_with_reviews.js" \
  --input "$TEST_INPUT" \
  --output "$TEST_OUTPUT" \
  --limit 1 \
  --max-reviews 30 \
  --max-scrolls 10 \
  --no-resume

# Check result
if [ $? -eq 0 ]; then
    echo ""
    echo "=== Test Result ==="

    if [ -f "$TEST_OUTPUT" ]; then
        echo "✓ Output file created"

        # Check if reviews were extracted
        REVIEW_COUNT=$(jq '.detailedReviews | length' "$TEST_OUTPUT" 2>/dev/null || echo "0")

        if [ "$REVIEW_COUNT" -gt 0 ]; then
            echo "✓ Reviews extracted: $REVIEW_COUNT"
            echo ""
            echo "Sample review:"
            jq '.detailedReviews[0] | {rating, reviewer_name, review_text: .review_text[:80]}' "$TEST_OUTPUT" 2>/dev/null
            echo ""
            echo "SUCCESS: Integration test passed!"
        else
            echo "⚠ No reviews extracted (check logs above)"
            echo "But basic data extraction may have succeeded."
        fi

        # Show basic data
        echo ""
        echo "Basic data:"
        jq '{name: .business.name, rating: .business.rating, reviews_count: (.detailedReviews | length)}' "$TEST_OUTPUT" 2>/dev/null
    else
        echo "✗ Output file not created"
        exit 1
    fi
else
    echo "✗ Test failed with exit code $?"
    exit 1
fi

# Cleanup
rm "$TEST_INPUT"

echo ""
echo "Test complete. Check $TEST_OUTPUT for full results."
