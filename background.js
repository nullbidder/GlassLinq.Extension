// background.js - Enhanced Native Messaging Bridge
let nativePort = null;
let reconnectTimeout = null;

// Sends a message to a tab, auto-injecting content.js if the receiving
// end doesn't exist yet (e.g. page was loaded before the extension was installed).
function sendToTab(tabId, msg) {
    console.log(`[GlassLinq] Sending ${msg.action} to tab ${tabId}`);
    chrome.tabs.sendMessage(tabId, msg).catch((err) => {
        if (err.message && err.message.includes("Receiving end does not exist")) {
            console.warn(`[GlassLinq] Content script missing on tab ${tabId}, injecting...`);
            chrome.scripting.executeScript({
                target: { tabId },
                files: ['content.js']
            }).then(() => {
                setTimeout(() => {
                    chrome.tabs.sendMessage(tabId, msg).catch(retryErr => {
                        console.error(`[GlassLinq] Retry failed on tab ${tabId}:`, retryErr.message);
                    });
                }, 150);
            }).catch(injectErr => {
                console.error(`[GlassLinq] Inject failed on tab ${tabId}:`, injectErr.message);
            });
        } else {
            console.error(`[GlassLinq] sendToTab error on tab ${tabId}:`, err.message);
        }
    });
}

function connectNative() {
    if (nativePort) return nativePort;

    console.log('[GlassLinq] Connecting to Bridge...');

    try {
        nativePort = chrome.runtime.connectNative('com.glasslinq.bridge');

        // background.js
        nativePort.onMessage.addListener((msg) => {
            console.log('[GlassLinq] Received from Bridge:', msg);

            // Spy actions (design-time): target the active tab — the user is
            // looking at the page they want to spy on.
            const spyActions = ["web_spy_request", "start_web_spy", "stop_web_spy"];

            // Runtime execution actions: Studio has OS focus, so Chrome tabs are
            // NOT "active". Broadcast to ALL eligible tabs so the correct page
            // receives the command regardless of which window is in the foreground.
            const runtimeExecutionActions = ["GET_TEXT", "CLICK", "TYPE_INTO",
                "GET_ELEMENT_COUNT", "GET_ELEMENT_ATTRIBUTE", "GET_TABLE_DATA"];

            if (spyActions.includes(msg.action)) {
                // Design-time: prefer the active tab in the current Chrome window,
                // fall back to any active tab across all windows.
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    const targetTab = (tabs || []).find(
                        t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('edge://')
                    );
                    if (targetTab) {
                        sendToTab(targetTab.id, msg);
                    } else {
                        chrome.tabs.query({ active: true }, (allActiveTabs) => {
                            const fallback = (allActiveTabs || []).find(
                                t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('edge://')
                            );
                            if (fallback) sendToTab(fallback.id, msg);
                            else console.warn("[GlassLinq] No eligible active tab for spy action:", msg.action);
                        });
                    }
                });

            } else if (runtimeExecutionActions.includes(msg.action)) {
                // Runtime: broadcast to ALL eligible tabs.
                chrome.tabs.query({}, (tabs) => {
                    const eligibleTabs = (tabs || []).filter(
                        t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('edge://')
                    );
                    if (eligibleTabs.length === 0) {
                        console.warn("[GlassLinq] No eligible tabs for runtime action:", msg.action);
                        return;
                    }
                    console.log(`[GlassLinq] Broadcasting ${msg.action} to ${eligibleTabs.length} tab(s)`);
                    eligibleTabs.forEach(tab => sendToTab(tab.id, msg));
                });
            }
        });
        nativePort.onDisconnect.addListener(() => {
            console.warn('[GlassLinq] Bridge Disconnected');
            nativePort = null;

            // Safety Switch: Tell all tabs to stop highlighting if bridge is lost
            chrome.tabs.query({}, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { action: "stop_web_spy" }).catch(() => { });
                });
            });

            // Auto-reconnect after 2 seconds
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            reconnectTimeout = setTimeout(() => {
                console.log('[GlassLinq] Attempting to reconnect...');
                connectNative();
            }, 2000);
        });

        console.log('[GlassLinq] Bridge connected successfully');
        return nativePort;
    } catch (error) {
        console.error('[GlassLinq] Failed to connect to bridge:', error);
        nativePort = null;
        return null;
    }
}

// Listen for messages from content scripts (the selector data coming BACK from the page)
// background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[GlassLinq] Message from page:', message);

    const runtimeActions = [
        "element_hovered", "element_captured",
        "GET_TEXT_RESPONSE", "CLICK_RESPONSE", "TYPE_INTO_RESPONSE",
        "GET_ELEMENT_COUNT_RESPONSE", "GET_ELEMENT_ATTRIBUTE_RESPONSE",
        "GET_TABLE_DATA_RESPONSE"
    ];

    if (runtimeActions.includes(message.action)) {
        const port = connectNative();
        if (port) {
            try {
                port.postMessage(message);
                console.log(`[GlassLinq] Action ${message.action} forwarded to Bridge.`);
                sendResponse({ status: 'forwarded', success: true });
            } catch (error) {
                console.error('[GlassLinq] Failed to forward message:', error);
                sendResponse({ status: 'error', success: false, message: error.message });
            }
        }
    }
    return true;
});

// Lifecycle events
chrome.runtime.onStartup.addListener(() => connectNative());
chrome.runtime.onInstalled.addListener(() => connectNative());

// Immediate connection attempt
connectNative();

// Keep service worker alive
setInterval(() => {
    if (nativePort) {
        try {
            nativePort.postMessage({ action: 'ping', timestamp: Date.now() });
        } catch (error) {
            console.error('[GlassLinq] Heartbeat failed:', error);
        }
    }
}, 20000);