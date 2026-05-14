// background.js - Enhanced Native Messaging Bridge
let nativePort = null;
let reconnectTimeout = null;

function connectNative() {
    if (nativePort) return nativePort;

    console.log('[GlassLinq] Connecting to Bridge...');
    
    try {
        nativePort = chrome.runtime.connectNative('com.glasslinq.bridge');

        nativePort.onMessage.addListener((msg) => {
            console.log('[GlassLinq] Received from Bridge:', msg);

            // Handle start, stop, and web_spy_request actions
            if (msg.action === "web_spy_request" || msg.action === "start_web_spy" || msg.action === "stop_web_spy") {
                
                // FIX: We remove 'lastFocusedWindow: true' because when you click 'Spy' in Studio, 
                // Studio is the last focused window, and Chrome might be ignored.
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs && tabs.length > 0) {
                        // Find the first tab that isn't a chrome:// settings page
                        const targetTab = tabs.find(t => t.url && !t.url.startsWith('chrome://'));
                        
                        if (targetTab) {
                            console.log(`[GlassLinq] Sending ${msg.action} to Tab ${targetTab.id}`);
                            chrome.tabs.sendMessage(targetTab.id, msg).catch(err => {
                                console.error("[GlassLinq] Content script unreachable:", err.message);
                            });
                        }
                    } else {
                        console.warn("[GlassLinq] No active browser tab found to receive command");
                    }
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
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[GlassLinq] Message from page:', message);

if (message.action === "element_hovered" || message.action === "element_captured") {
        const port = connectNative();
        if (port) {
            try {
                port.postMessage(message);
                console.log('[GlassLinq] Selector forwarded to Bridge:', message.selector?.substring(0, 100) + '...');
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