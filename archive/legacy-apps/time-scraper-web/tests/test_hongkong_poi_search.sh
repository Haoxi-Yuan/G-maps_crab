#!/bin/bash

# Hong Kong POI Search Test
# 测试从香港采样点搜索POI的功能

echo "=========================================="
echo "Hong Kong POI Search Test"
echo "=========================================="

# 配置路径
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

POINTS_FILE="$PROJECT_ROOT/data/hongkong/hong_kong_points.csv"
CATEGORIES_FILE="$PROJECT_ROOT/config/categories.json"
OUTPUT_FILE="$PROJECT_ROOT/output/hongkong_test_results.ndjson"
SEARCH_RESULTS_FILE="$PROJECT_ROOT/output/hongkong_test_search_results.json"

# 检查文件是否存在
if [ ! -f "$POINTS_FILE" ]; then
    echo "ERROR: Points file not found: $POINTS_FILE"
    exit 1
fi

if [ ! -f "$CATEGORIES_FILE" ]; then
    echo "ERROR: Categories file not found: $CATEGORIES_FILE"
    exit 1
fi

echo ""
echo "Configuration:"
echo "  Points file: $POINTS_FILE"
echo "  Categories file: $CATEGORIES_FILE"
echo "  Output file: $OUTPUT_FILE"
echo "  Search results: $SEARCH_RESULTS_FILE"
echo ""

# 测试参数
# 限制测试规模：只测试前2个采样点
# 这样 2 points × 53 categories = 106 次搜索
TEST_LIMIT=2
SEARCH_ZOOM="1000m"
MAX_SEARCH_SCROLLS=10
SEARCH_DELAY=1500

echo "Test parameters:"
echo "  Sampling points: $TEST_LIMIT (first $TEST_LIMIT points only)"
echo "  Search zoom: $SEARCH_ZOOM"
echo "  Max search scrolls: $MAX_SEARCH_SCROLLS"
echo "  Search delay: ${SEARCH_DELAY}ms"
echo ""

read -p "Press Enter to start test (Ctrl+C to cancel)..."

# 运行测试
node "$PROJECT_ROOT/src/gmaps_batch_scrape_with_reviews.js" \
  --search-mode \
  --points "$POINTS_FILE" \
  --categories "$CATEGORIES_FILE" \
  --search-zoom "$SEARCH_ZOOM" \
  --max-search-scrolls "$MAX_SEARCH_SCROLLS" \
  --search-delay "$SEARCH_DELAY" \
  --search-results "$SEARCH_RESULTS_FILE" \
  --output "$OUTPUT_FILE" \
  --limit "$TEST_LIMIT" \
  --headless \
  --no-reviews \
  --format both

# 检查结果
if [ $? -eq 0 ]; then
    echo ""
    echo "=========================================="
    echo "Test completed successfully!"
    echo "=========================================="

    if [ -f "$SEARCH_RESULTS_FILE" ]; then
        echo ""
        echo "Search results summary:"
        cat "$SEARCH_RESULTS_FILE" | grep -E '"totalSearches"|"totalPlaceIds"'
    fi

    if [ -f "$OUTPUT_FILE" ]; then
        echo ""
        echo "Output file created: $OUTPUT_FILE"
        echo "Lines in output: $(wc -l < "$OUTPUT_FILE")"
    fi
else
    echo ""
    echo "=========================================="
    echo "Test failed with error code: $?"
    echo "=========================================="
    exit 1
fi
