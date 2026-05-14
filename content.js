// content.js - Stable Web Spy Implementation (UiPath-inspired)
// Prevents feedback loops, cleans selectors, and captures clicks reliably

(function() {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // STATE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════
    let isSpying = false;
    let lastHighlightedElement = null;  // Prevents redundant messaging
    let highlightOverlay = null;

    // ═══════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════
    function init() {
        console.log('[GlassLinq Content] Initializing...');
        createHighlightOverlay();
        
        // Listen for commands from background.js
        chrome.runtime.onMessage.addListener(handleMessage);
    }

    // ═══════════════════════════════════════════════════════════════
    // MESSAGE HANDLER (Start/Stop Spy Mode)
    // ═══════════════════════════════════════════════════════════════
    function handleMessage(message, sender, sendResponse) {
        console.log('[GlassLinq Content] Received:', message);

        if (message.action === 'start_web_spy' || message.action === 'web_spy_request') {
            startSpying();
            sendResponse({ status: 'started' });
        } 
        else if (message.action === 'stop_web_spy') {
            stopSpying();
            sendResponse({ status: 'stopped' });
        }

        return true;
    }

    // ═══════════════════════════════════════════════════════════════
    // CREATE HIGHLIGHT OVERLAY
    // ═══════════════════════════════════════════════════════════════
    function createHighlightOverlay() {
        if (highlightOverlay) return;

        highlightOverlay = document.createElement('div');
        highlightOverlay.id = 'glasslinq-highlight-overlay';
        
        // CRITICAL: pointer-events: none makes this invisible to elementFromPoint
        highlightOverlay.style.cssText = `
            position: absolute;
            border: 3px solid #00FF41;
            background: rgba(0, 255, 65, 0.1);
            pointer-events: none;
            z-index: 2147483647;
            display: none;
            box-sizing: border-box;
        `;
        
        document.documentElement.appendChild(highlightOverlay);
        console.log('[GlassLinq Content] Highlight overlay created');
    }

    // ═══════════════════════════════════════════════════════════════
    // START SPYING
    // ═══════════════════════════════════════════════════════════════
    function startSpying() {
        if (isSpying) {
            console.log('[GlassLinq Content] Already spying');
            return;
        }

        isSpying = true;
        lastHighlightedElement = null;
        
        console.log('[GlassLinq Content] Web Spy ACTIVATED');
        
        // Attach event listeners
        document.addEventListener('mousemove', onMouseMove, true);
        document.addEventListener('click', onClickCapture, true);
        
        // Show cursor feedback
        document.body.style.cursor = 'crosshair';
    }

    // ═══════════════════════════════════════════════════════════════
    // STOP SPYING
    // ═══════════════════════════════════════════════════════════════
    function stopSpying() {
        if (!isSpying) return;

        isSpying = false;
        lastHighlightedElement = null;
        
        console.log('[GlassLinq Content] Web Spy DEACTIVATED');
        
        // Remove event listeners
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('click', onClickCapture, true);
        
        // Hide highlight
        if (highlightOverlay) {
            highlightOverlay.style.display = 'none';
        }
        
        // Restore cursor
        document.body.style.cursor = '';
    }

    // ═══════════════════════════════════════════════════════════════
    // MOUSE MOVE HANDLER
    // ═══════════════════════════════════════════════════════════════
    function onMouseMove(event) {
        if (!isSpying) return;

        // Get the actual element under the cursor (ignoring our overlay)
        const element = document.elementFromPoint(event.clientX, event.clientY);
        
        if (!element || element === document.body || element === document.documentElement) {
            return;
        }

        // CRITICAL: Only proceed if this is a NEW element
        if (element === lastHighlightedElement) {
            return;
        }

        // Update state
        lastHighlightedElement = element;

        // Update visual highlight
        updateHighlight(element);

        // Build and send selector
        const selector = buildUiPathSelector(element);
        sendSelectorToBackground(selector, element);
    }

    // ═══════════════════════════════════════════════════════════════
    // CLICK CAPTURE (Intercept and Capture Final Element)
    // ═══════════════════════════════════════════════════════════════
    function onClickCapture(event) {
        if (!isSpying) return;

        // Prevent the default action (navigation, form submit, etc.)
        event.preventDefault();
        event.stopPropagation();

        const element = event.target;
        
        console.log('[GlassLinq Content] Element CAPTURED:', element);

        // Build final clean selector
        const selector = buildUiPathSelector(element);

        // Send capture event to Studio
        chrome.runtime.sendMessage({
            action: 'element_captured',
            selector: selector,
            tag: element.tagName,
            text: element.textContent?.trim().substring(0, 50) || '',
            timestamp: Date.now()
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('[GlassLinq Content] Send error:', chrome.runtime.lastError);
            } else {
                console.log('[GlassLinq Content] Capture confirmed:', response);
            }
        });

        // Stop spying after capture
        stopSpying();
    }

    // ═══════════════════════════════════════════════════════════════
    // UPDATE VISUAL HIGHLIGHT
    // ═══════════════════════════════════════════════════════════════
    function updateHighlight(element) {
        if (!highlightOverlay) return;

        const rect = element.getBoundingClientRect();
        const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
        const scrollY = window.pageYOffset || document.documentElement.scrollTop;

        highlightOverlay.style.display = 'block';
        highlightOverlay.style.left = (rect.left + scrollX) + 'px';
        highlightOverlay.style.top = (rect.top + scrollY) + 'px';
        highlightOverlay.style.width = rect.width + 'px';
        highlightOverlay.style.height = rect.height + 'px';
    }

    // ═══════════════════════════════════════════════════════════════
    // BUILD UIPATH-STYLE SELECTOR (Clean & Stable)
    // ═══════════════════════════════════════════════════════════════
    function buildUiPathSelector(element) {
        const attributes = [];

        // Tag name (always included)
        const tag = element.tagName.toLowerCase();

        // ID (highest priority)
        if (element.id) {
            attributes.push(`id='${cleanAttributeValue(element.id)}'`);
        }

        // Class (CLEANED - remove glasslinq-highlight)
        if (element.className && typeof element.className === 'string') {
            const cleanedClass = element.className
                .split(/\s+/)
                .filter(cls => cls && cls !== 'glasslinq-highlight')  // CRITICAL FIX
                .join(' ')
                .trim();
            
            if (cleanedClass) {
                attributes.push(`class='${cleanAttributeValue(cleanedClass)}'`);
            }
        }

        // Text content (aaname in UiPath)
        const text = element.textContent?.trim();
        if (text && text.length > 0 && text.length < 100) {
            // Use only the first 50 chars for stability
            const shortText = text.substring(0, 50).replace(/\s+/g, ' ').trim();
            attributes.push(`aaname='${escapeXml(shortText)}'`);
        }

        // Common attributes
        if (element.name) {
            attributes.push(`name='${cleanAttributeValue(element.name)}'`);
        }
        if (element.type) {
            attributes.push(`type='${cleanAttributeValue(element.type)}'`);
        }
        if (element.href) {
            attributes.push(`href='${cleanAttributeValue(element.href)}'`);
        }
        if (element.value && element.tagName !== 'INPUT') {
            attributes.push(`value='${cleanAttributeValue(element.value)}'`);
        }

        // ARIA attributes
        if (element.getAttribute('aria-label')) {
            attributes.push(`aria-label='${cleanAttributeValue(element.getAttribute('aria-label'))}'`);
        }
        if (element.getAttribute('role')) {
            attributes.push(`role='${cleanAttributeValue(element.getAttribute('role'))}'`);
        }

        // Build final selector
        const attrString = attributes.length > 0 ? ' ' + attributes.join(' ') : '';
        return `<webctrl tag='${tag.toUpperCase()}'${attrString} />`;
    }

    // ═══════════════════════════════════════════════════════════════
    // HELPER: Clean Attribute Values
    // ═══════════════════════════════════════════════════════════════
    function cleanAttributeValue(value) {
        if (!value) return '';
        
        return value
            .toString()
            .trim()
            .replace(/glasslinq-highlight/g, '')  // Strip our class
            .replace(/\s+/g, ' ')                  // Normalize whitespace
            .trim()
            .substring(0, 200);                    // Limit length
    }

    // ═══════════════════════════════════════════════════════════════
    // HELPER: Escape XML Special Characters
    // ═══════════════════════════════════════════════════════════════
    function escapeXml(text) {
        if (!text) return '';
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    // ═══════════════════════════════════════════════════════════════
    // SEND SELECTOR TO BACKGROUND.JS
    // ═══════════════════════════════════════════════════════════════
    function sendSelectorToBackground(selector, element) {
        chrome.runtime.sendMessage({
            action: 'element_hovered',
            selector: selector,
            tag: element.tagName,
            timestamp: Date.now()
        }, (response) => {
            if (chrome.runtime.lastError) {
                console.error('[GlassLinq Content] Send error:', chrome.runtime.lastError);
            }
        });
    }

    // ═══════════════════════════════════════════════════════════════
    // AUTO-INITIALIZE
    // ═══════════════════════════════════════════════════════════════
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

})();