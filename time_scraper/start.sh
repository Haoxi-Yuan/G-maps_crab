#!/bin/bash

# Google Maps Batch Scraper - Startup Script
# Checks dependencies, installs if needed, and starts both backend and frontend

set -e

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
echo -e "${BLUE}Google Maps Batch Scraper - Startup${NC}"
echo -e "${BLUE}========================================${NC}\n"

# Check Node.js — also search in conda environments
echo -e "${YELLOW}[1/5] Checking Node.js...${NC}"
if ! command -v node &> /dev/null; then
    # Try to find node in conda envs (common on HPC / shared servers)
    CONDA_NODE=""
    for candidate in \
        "$HOME/miniconda3/envs/gmaps_crab/bin" \
        "$(dirname "$SCRIPT_DIR")/../miniconda3/envs/gmaps_crab/bin" \
        "/data/$(whoami)/miniconda3/envs/gmaps_crab/bin"; do
        if [ -x "$candidate/node" ]; then
            CONDA_NODE="$candidate"
            break
        fi
    done

    if [ -n "$CONDA_NODE" ]; then
        echo -e "${YELLOW}Node.js not in PATH, found in conda: $CONDA_NODE${NC}"
        export PATH="$CONDA_NODE:$PATH"
    else
        echo -e "${RED}Error: Node.js is not installed${NC}"
        echo "Please install Node.js 16+ from https://nodejs.org/"
        exit 1
    fi
fi

NODE_VERSION=$(node -v)
echo -e "${GREEN}✓ Node.js version: $NODE_VERSION${NC}\n"

# Check backend dependencies
echo -e "${YELLOW}[2/5] Checking backend dependencies...${NC}"
if [ ! -d "backend/node_modules" ]; then
    echo -e "${YELLOW}Backend dependencies not found. Installing...${NC}"
    cd backend
    npm install
    cd ..
    echo -e "${GREEN}✓ Backend dependencies installed${NC}\n"
else
    echo -e "${GREEN}✓ Backend dependencies found${NC}\n"
fi

# Check frontend dependencies
echo -e "${YELLOW}[3/5] Checking frontend dependencies...${NC}"
if [ ! -d "frontend/node_modules" ]; then
    echo -e "${YELLOW}Frontend dependencies not found. Installing...${NC}"
    cd frontend
    npm install
    cd ..
    echo -e "${GREEN}✓ Frontend dependencies installed${NC}\n"
else
    echo -e "${GREEN}✓ Frontend dependencies found${NC}\n"
fi

# Create necessary directories
echo -e "${YELLOW}[4/5] Setting up directories...${NC}"
mkdir -p db output data config
echo -e "${GREEN}✓ Directories ready${NC}\n"

# Check if services are already running
echo -e "${YELLOW}[5/5] Checking for running services...${NC}"

# Kill orphaned nodemon processes from previous sessions
OLD_NODEMON=$(pgrep -f "nodemon server.js" 2>/dev/null || true)
if [ -n "$OLD_NODEMON" ]; then
    echo -e "${YELLOW}Cleaning up old nodemon processes...${NC}"
    kill -TERM $OLD_NODEMON 2>/dev/null || true
    sleep 1
    # Force kill any remaining
    pgrep -f "nodemon server.js" >/dev/null 2>&1 && kill -9 $(pgrep -f "nodemon server.js") 2>/dev/null || true
    echo -e "${GREEN}✓ Old nodemon processes cleaned${NC}"
fi

BACKEND_PID=$(lsof -ti:3000 2>/dev/null || true)
if [ -n "$BACKEND_PID" ]; then
    echo -e "${YELLOW}Port 3000 in use (PID: $BACKEND_PID), killing old server...${NC}"
    kill -TERM $BACKEND_PID 2>/dev/null || true
    sleep 2
    # Force kill if still alive
    if lsof -ti:3000 >/dev/null 2>&1; then
        kill -9 $(lsof -ti:3000) 2>/dev/null || true
        sleep 1
    fi
    echo -e "${GREEN}✓ Old server stopped${NC}"
fi

FRONTEND_PID=$(lsof -ti:5173 2>/dev/null || true)
if [ -n "$FRONTEND_PID" ]; then
    echo -e "${YELLOW}Port 5173 in use (PID: $FRONTEND_PID), killing old frontend...${NC}"
    kill -TERM $FRONTEND_PID 2>/dev/null || true
    sleep 2
    if lsof -ti:5173 >/dev/null 2>&1; then
        kill -9 $(lsof -ti:5173) 2>/dev/null || true
        sleep 1
    fi
    echo -e "${GREEN}✓ Old frontend stopped${NC}"
fi

echo -e "${GREEN}✓ Ports are available${NC}\n"

# Start services
echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Starting Services${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${YELLOW}Starting backend server on port 3000...${NC}"
cd backend
nohup npm run dev > ../logs/backend.log 2>&1 &
BACKEND_PID=$!
echo $BACKEND_PID > ../logs/backend.pid
cd ..
sleep 2

# Check if backend started successfully
if ps -p $BACKEND_PID > /dev/null; then
    echo -e "${GREEN}✓ Backend started (PID: $BACKEND_PID)${NC}\n"
else
    echo -e "${RED}✗ Failed to start backend${NC}"
    echo "Check logs/backend.log for details"
    exit 1
fi

echo -e "${YELLOW}Starting frontend server on port 5173...${NC}"
cd frontend
nohup npm run dev > ../logs/frontend.log 2>&1 &
FRONTEND_PID=$!
echo $FRONTEND_PID > ../logs/frontend.pid
cd ..
sleep 3

# Check if frontend started successfully
if ps -p $FRONTEND_PID > /dev/null; then
    echo -e "${GREEN}✓ Frontend started (PID: $FRONTEND_PID)${NC}\n"
else
    echo -e "${RED}✗ Failed to start frontend${NC}"
    echo "Check logs/frontend.log for details"
    exit 1
fi

echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✓ All services started successfully!${NC}"
echo -e "${BLUE}========================================${NC}\n"

echo -e "${GREEN}Backend:${NC}  http://localhost:3000"
echo -e "${GREEN}Frontend:${NC} http://localhost:5173"
echo ""
echo -e "${YELLOW}Logs:${NC}"
echo "  Backend:  logs/backend.log"
echo "  Frontend: logs/frontend.log"
echo ""
echo -e "${YELLOW}To stop services, run:${NC} ./stop.sh"
echo ""
