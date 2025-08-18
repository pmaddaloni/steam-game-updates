import workerpool from 'workerpool';

function sortUpdates(gameUpdatesIDs) {
    return gameUpdatesIDs.sort((a, b) => b[0] - a[0]);
}

// Expose it to the pool
workerpool.worker({
    sortUpdates
});
