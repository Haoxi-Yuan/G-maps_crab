#!/bin/bash
cd "$(dirname "$0")"

echo ""
echo "=== Google Maps POI Change Monitor ==="
echo ""
echo "  1) stats          - View database statistics"
echo "  2) scan-all       - Scan all POIs"
echo "  3) scan-new       - Scan new-format POIs only (~19K)"
echo "  4) scan-test      - Test scan (50 POIs)"
echo "  5) scan-resume    - Resume interrupted scan"
echo "  6) report         - View latest scan report"
echo "  7) import-old     - Import old-format data"
echo "  8) import-new     - Import new-format data (Pipeline)"
echo "  9) discover       - Discover new POIs (city-wide)"
echo " 10) discover-quick - Quick discovery (20 searches)"
echo " 11) clean-scan     - Clean last bad scan + restore baseline"
echo "  0) Exit"
echo ""
read -p "Select option [0-11]: " choice

case $choice in
  1)
    node cli.js stats
    ;;
  2)
    node cli.js scan
    ;;
  3)
    node cli.js scan --limit 19300
    ;;
  4)
    node cli.js scan --limit 50
    ;;
  5)
    node cli.js scan --resume
    ;;
  6)
    SCAN_ID=$(node -e "
      const MonitorDB = require('./src/db');
      const { loadConfig } = require('./src/config');
      const db = new MonitorDB(loadConfig().paths.database);
      const scan = db.getLastScan();
      if (scan) console.log(scan.scanId);
      db.close();
    ")
    if [ -z "$SCAN_ID" ]; then
      echo "No scan records found"
    else
      echo "Latest scan: $SCAN_ID"
      node cli.js report --scan-id "$SCAN_ID"
    fi
    ;;
  7)
    node cli.js import --source /Volumes/Data/scraped_by_categories --format old
    ;;
  8)
    node cli.js import --source /Volumes/Data/Pipeline/data --format new
    ;;
  9)
    node cli.js discover --city Singapore
    ;;
  10)
    node cli.js discover --city Singapore --limit 20 --points 3 --categories "Restaurant,Supermarket,Cafe"
    ;;
  11)
    SCAN_ID=$(node -e "
      const MonitorDB = require('./src/db');
      const { loadConfig } = require('./src/config');
      const db = new MonitorDB(loadConfig().paths.database);
      const scan = db.getLastScan();
      if (scan) console.log(scan.scanId);
      db.close();
    ")
    if [ -z "$SCAN_ID" ]; then
      echo "No scan records found"
    else
      echo "Will clean scan: $SCAN_ID"
      read -p "Confirm? (y/N): " confirm
      if [ "$confirm" = "y" ] || [ "$confirm" = "Y" ]; then
        node cli.js clean-scan --scan-id "$SCAN_ID"
      else
        echo "Cancelled"
      fi
    fi
    ;;
  0)
    exit 0
    ;;
  *)
    echo "Invalid option"
    ;;
esac
