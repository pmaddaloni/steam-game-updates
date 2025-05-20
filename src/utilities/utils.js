const maxRetries = 50;

export function webSocketConnectWithRetry(url, retryInterval = 3000) {
    let ws;
    let retries = 0;

    function attemptConnect() {
        ws = new WebSocket(url);

        ws.onopen = () => {
            console.log("WebSocket connected");
        };

        ws.onclose = (event) => {
            console.log(`WebSocket at ${ws.url} closed, reason: ${event.reason}, code: ${event.code}`);
            if (event.code !== 1000 && retries < maxRetries) { // Don't retry if closed normally
                retries++;
                setTimeout(attemptConnect, retryInterval);
            }
        };

        ws.onerror = (error) => {
            console.error("WebSocket error:", error);
        };
    }
    attemptConnect();
    return ws;
}
