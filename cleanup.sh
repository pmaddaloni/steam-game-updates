#!/bin/bash

# Kill SteamWebPipes processes
PIDS=$(pgrep -f SteamWebPipes)

if [ -z "$PIDS" ]; then
    echo "No processes with 'SteamWebPipes' found. Nothing to kill."
else
    echo "Found the following SteamWebPipes processes to kill:"
    echo "$PIDS"
    pkill -f SteamWebPipes
    echo "SteamWebPipes processes killed."
fi

# Kill workerpool worker processes (look for sortWorker.js or other worker entrypoints)
WORKER_PIDS=$(pgrep -f sortWorker.js)

if [ -z "$WORKER_PIDS" ]; then
    echo "No workerpool worker processes found. Nothing to kill."
else
    echo "Found the following workerpool processes to kill:"
    echo "$WORKER_PIDS"
    pkill -f sortWorker.js
    echo "Workerpool processes killed."
fi
