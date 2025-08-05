#!/bin/bash

# Use pgrep to find the process IDs of all processes containing "SteamWebPipes"
# The -f flag matches the pattern against the full command line.
PIDS=$(pgrep -f SteamWebPipes)

# Check if any processes were found
if [ -z "$PIDS" ]; then
    echo "No processes with 'SteamWebPipes' found. Nothing to kill."
else
    echo "Found the following processes to kill:"
    echo "$PIDS"

    # Use pkill with the -f flag to kill the processes gracefully.
    # The default signal is SIGTERM (15), which allows for a clean shutdown.
    # If the processes do not exit after a reasonable time, you can add a -9 flag for a forceful kill.
    pkill -f SteamWebPipes
    echo "Processes killed."
fi
