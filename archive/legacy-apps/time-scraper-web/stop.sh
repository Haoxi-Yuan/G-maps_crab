#!/bin/bash

# Google Maps Batch Scraper - Stop Script
# Safely stops backend, frontend, and optionally scraper tasks

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Google Maps Batch Scraper - Stop${NC}"
echo -e "${BLUE}========================================${NC}\n"

# Function to stop process gracefully
stop_process() {
    local PID=$1
    local NAME=$2

    if ps -p $PID > /dev/null 2>&1; then
        echo -e "${YELLOW}Stopping $NAME (PID: $PID)...${NC}"
        kill -TERM $PID 2>/dev/null

        # Wait up to 10 seconds for graceful shutdown
        for i in {1..10}; do
            if ! ps -p $PID > /dev/null 2>&1; then
                echo -e "${GREEN}✓ $NAME stopped${NC}"
                return 0
            fi
            sleep 1
        done

        # Force kill if still running
        if ps -p $PID > /dev/null 2>&1; then
            echo -e "${YELLOW}Force killing $NAME...${NC}"
            kill -9 $PID 2>/dev/null
            sleep 1
            if ps -p $PID > /dev/null 2>&1; then
                echo -e "${RED}✗ Failed to stop $NAME${NC}"
                return 1
            else
                echo -e "${GREEN}✓ $NAME force stopped${NC}"
                return 0
            fi
        fi
    else
        echo -e "${YELLOW}$NAME is not running${NC}"
        return 0
    fi
}

# Check for running services
BACKEND_PORT_PID=$(lsof -ti:3000 2>/dev/null || true)
FRONTEND_PORT_PID=$(lsof -ti:5173 2>/dev/null || true)

BACKEND_PID=""
FRONTEND_PID=""

if [ -f "logs/backend.pid" ]; then
    BACKEND_PID=$(cat logs/backend.pid)
fi

if [ -f "logs/frontend.pid" ]; then
    FRONTEND_PID=$(cat logs/frontend.pid)
fi

# Find scraper tasks
SCRAPER_PIDS=$(pgrep -f "gmaps_batch_scrape_ipc.js" || true)

# Show current status
echo -e "${YELLOW}Current Status:${NC}"
echo "----------------------------------------"

if [ -n "$BACKEND_PID" ] && ps -p $BACKEND_PID > /dev/null 2>&1; then
    echo -e "Backend:  ${GREEN}Running${NC} (PID: $BACKEND_PID)"
elif [ -n "$BACKEND_PORT_PID" ]; then
    echo -e "Backend:  ${GREEN}Running${NC} (PID: $BACKEND_PORT_PID)"
    BACKEND_PID=$BACKEND_PORT_PID
else
    echo -e "Backend:  ${YELLOW}Not running${NC}"
fi

if [ -n "$FRONTEND_PID" ] && ps -p $FRONTEND_PID > /dev/null 2>&1; then
    echo -e "Frontend: ${GREEN}Running${NC} (PID: $FRONTEND_PID)"
elif [ -n "$FRONTEND_PORT_PID" ]; then
    echo -e "Frontend: ${GREEN}Running${NC} (PID: $FRONTEND_PORT_PID)"
    FRONTEND_PID=$FRONTEND_PORT_PID
else
    echo -e "Frontend: ${YELLOW}Not running${NC}"
fi

if [ -n "$SCRAPER_PIDS" ]; then
    SCRAPER_COUNT=$(echo "$SCRAPER_PIDS" | wc -l | tr -d ' ')
    echo -e "Scrapers: ${GREEN}$SCRAPER_COUNT running${NC}"
    echo "$SCRAPER_PIDS" | while read pid; do
        echo "  - PID: $pid"
    done
else
    echo -e "Scrapers: ${YELLOW}Not running${NC}"
fi

echo "----------------------------------------"
echo ""

# Interactive mode if scrapers are running
if [ -n "$SCRAPER_PIDS" ]; then
    echo -e "${YELLOW}Warning: Active scraper tasks detected!${NC}"
    echo ""
    echo "What would you like to do?"
    echo "  1) Stop ALL (backend + frontend + scrapers)"
    echo "  2) Stop servers only (keep scrapers running)"
    echo "  3) Stop scrapers only (keep servers running)"
    echo "  4) Cancel"
    echo ""
    read -p "Enter choice [1-4]: " choice
    echo ""

    case $choice in
        1)
            echo -e "${BLUE}Stopping all services and scrapers...${NC}\n"
            STOP_BACKEND=true
            STOP_FRONTEND=true
            STOP_SCRAPERS=true
            ;;
        2)
            echo -e "${BLUE}Stopping servers only...${NC}\n"
            STOP_BACKEND=true
            STOP_FRONTEND=true
            STOP_SCRAPERS=false
            ;;
        3)
            echo -e "${BLUE}Stopping scrapers only...${NC}\n"
            STOP_BACKEND=false
            STOP_FRONTEND=false
            STOP_SCRAPERS=true
            ;;
        4)
            echo -e "${YELLOW}Cancelled${NC}"
            exit 0
            ;;
        *)
            echo -e "${RED}Invalid choice${NC}"
            exit 1
            ;;
    esac
else
    # No scrapers running, stop servers by default
    STOP_BACKEND=true
    STOP_FRONTEND=true
    STOP_SCRAPERS=false
fi

# Stop services
if [ "$STOP_BACKEND" = true ] && [ -n "$BACKEND_PID" ]; then
    stop_process $BACKEND_PID "Backend server"
    rm -f logs/backend.pid
fi

if [ "$STOP_FRONTEND" = true ] && [ -n "$FRONTEND_PID" ]; then
    stop_process $FRONTEND_PID "Frontend server"
    rm -f logs/frontend.pid
fi

if [ "$STOP_SCRAPERS" = true ] && [ -n "$SCRAPER_PIDS" ]; then
    echo "$SCRAPER_PIDS" | while read pid; do
        if [ -n "$pid" ]; then
            stop_process $pid "Scraper task"
        fi
    done
fi

echo ""
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✓ Shutdown complete${NC}"
echo -e "${BLUE}========================================${NC}\n"

# Show remaining processes if any
REMAINING_BACKEND=$(lsof -ti:3000 2>/dev/null || true)
REMAINING_FRONTEND=$(lsof -ti:5173 2>/dev/null || true)
REMAINING_SCRAPERS=$(pgrep -f "gmaps_batch_scrape_ipc.js" || true)

if [ -n "$REMAINING_BACKEND" ] || [ -n "$REMAINING_FRONTEND" ] || [ -n "$REMAINING_SCRAPERS" ]; then
    echo -e "${YELLOW}Note: Some processes are still running:${NC}"
    [ -n "$REMAINING_BACKEND" ] && echo "  - Backend on port 3000 (PID: $REMAINING_BACKEND)"
    [ -n "$REMAINING_FRONTEND" ] && echo "  - Frontend on port 5173 (PID: $REMAINING_FRONTEND)"
    if [ -n "$REMAINING_SCRAPERS" ]; then
        REMAINING_COUNT=$(echo "$REMAINING_SCRAPERS" | wc -l | tr -d ' ')
        echo "  - $REMAINING_COUNT scraper task(s)"
    fi
    echo ""
fi
