#!/bin/bash

# Minimal Hong Kong POI Search Test
# 最小化测试：只测试1个采样点 × 1个类别

echo "=========================================="
echo "Minimal Hong Kong POI Search Test"
echo "测试1个采样点 × 1个类别 (Restaurant)"
echo "=========================================="

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# 创建临时的单类别配置文件
TEMP_CATEGORIES="$PROJECT_ROOT/config/categories_minimal.json"
cat > "$TEMP_CATEGORIES" << 'EOF'
{
  "categories": ["Restaurant"]
}
EOF

echo "Created temporary categories file: $TEMP_CATEGORIES"

# 运行测试
node "$PROJECT_ROOT/src/gmaps_batch_scrape_with_reviews.js" \
  --search-mode \
  --points "$PROJECT_ROOT/data/hongkong/hong_kong_points.csv" \
  --categories "$TEMP_CATEGORIES" \
  --search-zoom "1000m" \
  --max-search-scrolls 5 \
  --search-delay 1000 \
  --output "$PROJECT_ROOT/output/hongkong_minimal_test.ndjson" \
  --search-results "$PROJECT_ROOT/output/hongkong_minimal_search.json" \
  --limit 1 \
  --no-reviews \
  --format both

EXIT_CODE=$?

# 清理临时文件
rm -f "$TEMP_CATEGORIES"

if [ $EXIT_CODE -eq 0 ]; then
    echo ""
    echo "✅ Test completed successfully!"

    if [ -f "$PROJECT_ROOT/output/hongkong_minimal_search.json" ]; then
        echo ""
        echo "Search results:"
        cat "$PROJECT_ROOT/output/hongkong_minimal_search.json" | jq '.totalPlaceIds, .totalSearches'
    fi
else
    echo ""
    echo "❌ Test failed with error code: $EXIT_CODE"
    exit 1
fi
