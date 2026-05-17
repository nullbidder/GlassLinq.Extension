// background.js - Enhanced Native Messaging Bridge
let nativePort = null;
let reconnectTimeout = null;

function connectNative() {
    if (nativePort) return nativePort;

    console.log('[GlassLinq] Connecting to Bridge...');
    
    try {
        nativePort = chrome.runtime.connectNative('com.glasslinq.bridge');

// background.js
nativePort.onMessage.addListener((msg) => {
    console.log('[GlassLinq] Received from Bridge:', msg);

    // Process both design-time spying actions AND runtime execution actions
    if (["web_spy_request", "start_web_spy", "stop_web_spy", "GET_TEXT", "CLICK", "TYPE_INTO"].includes(msg.action)) {
        
        // Query the active tab across ALL windows to ensure focus shift doesn't break target matching
        chrome.tabs.query({ active: true }, (tabs) => {
            if (!tabs || tabs.length === 0) {
                console.warn("[GlassLinq] No active browser tab found to receive command");
                return;
            }

            // Find an eligible web tab (ignore chrome:// internal and restricted settings tabs)
            const targetTab = tabs.find(t => t.url && !t.url.startsWith('chrome://') && !t.url.startsWith('edge://'));
            
            if (!targetTab) {
                console.warn("[GlassLinq] Target tab is restricted or invalid:", tabs[0]?.url);
                return;
            }

            console.log(`[GlassLinq] Attempting to send command ${msg.action} to Tab ${targetTab.id}`);

            // Try sending the message normally
            chrome.tabs.sendMessage(targetTab.id, msg).catch((err) => {
                // If "Receiving end does not exist", programmatic injection is required
                if (err.message.includes("Receiving end does not exist")) {
                    console.warn(`[GlassLinq] Content script missing on Tab ${targetTab.id}. Dynamically injecting content.js...`);

                    // Script Injection via scripting API (Manifest V3 style standard compatibility)
                    chrome.scripting.executeScript({
                        target: { tabId: targetTab.id },
                        files: ['content.js']
                    }).then(() => {
                        // Small delay to allow initialization, then retry sending the payload
                        setTimeout(() => {
                            chrome.tabs.sendMessage(targetTab.id, msg).catch(retryErr => {
                                console.error("[GlassLinq] Dynamic retry failed:", retryErr.message);
                            });
                        }, 150);
                    }).catch(injectErr => {
                        console.error("[GlassLinq] Critical error inject failed:", injectErr.message);
                    });
                } else {
                    console.error("[GlassLinq] Content script unreachable due to:", err.message);
                }
            });
        });
    }
});
        nativePort.onDisconnect.addListener(() => {
            console.warn('[GlassLinq] Bridge Disconnected');
            nativePort = null;

            // Safety Switch: Tell all tabs to stop highlighting if bridge is lost
            chrome.tabs.query({}, (tabs) => {
                tabs.forEach(tab => {
                    chrome.tabs.sendMessage(tab.id, { action: "stop_web_spy" }).catch(() => {});
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
        "GET_TEXT_RESPONSE", "CLICK_RESPONSE", "TYPE_INTO_RESPONSE"
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