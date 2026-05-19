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
    let captureLock = false;             // FIX: Prevents polling requests from forcefully re-spying after a click

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
    // MESSAGE HANDLER (Start/Stop Spy Mode + Runtime Commands)
    // ═══════════════════════════════════════════════════════════════
    function handleMessage(message, sender, sendResponse) {
        console.log('[GlassLinq Content] Received:', message);

        // Design-time commands (Safe to reply inline or drop)
        if (message.action === 'start_web_spy' || message.action === 'web_spy_request') {
            // FIX: Do not restart spying if we are locked waiting for Studio to acknowledge a capture
            if (!captureLock) {
                startSpying();
            }
            if (typeof sendResponse === 'function') sendResponse({ status: 'started' });
        } 
        else if (message.action === 'stop_web_spy') {
            // FIX: Studio has sent the formal stop instruction, release the lock safely
            captureLock = false;
            stopSpying();
            if (typeof sendResponse === 'function') sendResponse({ status: 'stopped' });
        }
        // Runtime commands (No longer passing volatile sendResponse references)
        else if (message.action === 'GET_TEXT') {
            handleGetText(message);
        }
        else if (message.action === 'CLICK') {
            handleClick(message);
        }
        else if (message.action === 'TYPE_INTO') {
            handleTypeInto(message);
        }

        // Do NOT return true; let this invocation finish synchronously
        return false;
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

        // CALCULATION AT RUNTIME: Compute the web anchor silently on click selection
        const anchorSelector = findWebAnchor(element);

        // FIX: Immediately lock spying states so that lingering 'web_spy_request' messages 
        // in transit don't spin the crosshair/highlighter window back up before Studio responds.
        captureLock = true;

        // Send capture event to Studio, passing the calculated anchor selector
        chrome.runtime.sendMessage({
            action: 'element_captured',
            selector: selector,
            anchorSelector: anchorSelector, // <--- INTEGRATED: Safely sent over native messaging bridge
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

        // Inside content.js -> buildUiPathSelector() where classes are filtered:
        if (element.className && typeof element.className === 'string') {
            const cleanedClass = element.className
                .split(/\s+/)
                .filter(cls => {
                    return cls && 
                        cls !== 'glasslinq-highlight' &&
                        !cls.startsWith('ng-') &&            // Strips Angular state flags
                        !cls.includes('valid') &&            // Strips form validation states
                        !cls.includes('invalid') &&
                        !cls.includes('pristine') &&
                        !cls.includes('dirty') &&
                        !cls.includes('touched');
                })
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
    // RUNTIME EXECUTION HANDLERS
    // ═══════════════════════════════════════════════════════════════

    /**
     * Handle GET_TEXT runtime command
     * Parses UiPath-style selector and extracts text from matching element
     */
    function handleGetText(message) {
        console.log('[GlassLinq Content] Executing GET_TEXT:', message);

        try {
            const selector = message.selector;
            const transactionId = message.transactionId;
            const element = findElementBySelector(selector);

            if (!element) {
                chrome.runtime.sendMessage({
                    action: 'GET_TEXT_RESPONSE',
                    transactionId: transactionId,
                    success: false,
                    error: 'Element not found'
                });
                return;
            }

            let text = '';
            if (element.value !== undefined && element.value !== null && element.tagName === 'INPUT') {
                text = element.value;
            } else if (element.innerText) {
                text = element.innerText.trim();
            } else if (element.textContent) {
                text = element.textContent.trim();
            } else if (element.getAttribute('value')) {
                text = element.getAttribute('value');
            }

            console.log('[GlassLinq Content] Extracted text:', text);

            // Explicitly relay to background script
            chrome.runtime.sendMessage({
                action: 'GET_TEXT_RESPONSE',
                transactionId: transactionId,
                success: true,
                text: text,
                tag: element.tagName,
                timestamp: Date.now()
            });

        } catch (error) {
            console.error('[GlassLinq Content] GET_TEXT error:', error);
            chrome.runtime.sendMessage({
                action: 'GET_TEXT_RESPONSE',
                transactionId: message.transactionId,
                success: false,
                error: error.message || 'Unknown error'
            });
        }
    }

    /**
     * Handle CLICK runtime command
     * Parses selector and clicks the matching element
     */
    function handleClick(message) {
        console.log('[GlassLinq Content] Executing CLICK:', message);

        try {
            const element = findElementBySelector(message.selector);

            if (!element) {
                chrome.runtime.sendMessage({
                    action: 'CLICK_RESPONSE',
                    transactionId: message.transactionId,
                    success: false,
                    error: 'Element not found'
                });
                return;
            }

            element.click();

            chrome.runtime.sendMessage({
                action: 'CLICK_RESPONSE',
                transactionId: message.transactionId,
                success: true,
                timestamp: Date.now()
            });

        } catch (error) {
            console.error('[GlassLinq Content] CLICK error:', error);
            chrome.runtime.sendMessage({
                action: 'CLICK_RESPONSE',
                transactionId: message.transactionId,
                success: false,
                error: error.message
            });
        }
    }

    /**
     * Handle TYPE_INTO runtime command
     * Parses selector and types text into the matching element
     */
    function handleTypeInto(message) {
        console.log('[GlassLinq Content] Executing TYPE_INTO:', message);

        try {
            const element = findElementBySelector(message.selector);

            if (!element) {
                chrome.runtime.sendMessage({
                    action: 'TYPE_INTO_RESPONSE',
                    transactionId: message.transactionId,
                    success: false,
                    error: 'Element not found'
                });
                return;
            }

            if (message.emptyField) {
                element.value = '';
            }

            element.value = message.text || '';
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));

            chrome.runtime.sendMessage({
                action: 'TYPE_INTO_RESPONSE',
                transactionId: message.transactionId,
                success: true,
                timestamp: Date.now()
            });

        } catch (error) {
            console.error('[GlassLinq Content] TYPE_INTO error:', error);
            chrome.runtime.sendMessage({
                action: 'TYPE_INTO_RESPONSE',
                transactionId: message.transactionId,
                success: false,
                error: error.message
            });
        }
    }

    /**
     * Parse UiPath-style XML selector and find matching DOM element
     * Example: <webctrl tag='INPUT' id='username' />
     * Example: <webctrl tag='SPAN' class='price' aaname='$19.99' />
     */
    function findElementBySelector(xmlSelector) {
        console.log('[GlassLinq Content] Parsing selector:', xmlSelector);

        // Extract attributes from the XML selector
        const attributes = parseXmlSelector(xmlSelector);

        if (!attributes.tag) {
            console.error('[GlassLinq Content] No tag specified in selector');
            return null;
        }

        // Build CSS selector
        let cssSelector = attributes.tag.toLowerCase();

        if (attributes.id) {
            cssSelector += `#${CSS.escape(attributes.id)}`;
        }

        if (attributes.class) {
            const classes = attributes.class.split(/\s+/).filter(c => c);
            classes.forEach(cls => {
                cssSelector += `.${CSS.escape(cls)}`;
            });
        }

        if (attributes.name) {
            cssSelector += `[name="${CSS.escape(attributes.name)}"]`;
        }

        if (attributes.type) {
            cssSelector += `[type="${CSS.escape(attributes.type)}"]`;
        }

        console.log('[GlassLinq Content] Built CSS selector:', cssSelector);

        // Find all matching elements
        let candidates = Array.from(document.querySelectorAll(cssSelector));

        if (candidates.length === 0) {
            console.warn('[GlassLinq Content] No elements found for selector:', cssSelector);
            return null;
        }

        // Filter by additional attributes if needed
        if (attributes.aaname) {
            candidates = candidates.filter(el => {
                const text = (el.innerText || el.textContent || '').trim();
                return text.includes(attributes.aaname);
            });
        }

        if (attributes['aria-label']) {
            candidates = candidates.filter(el => {
                return el.getAttribute('aria-label') === attributes['aria-label'];
            });
        }

        if (attributes.role) {
            candidates = candidates.filter(el => {
                return el.getAttribute('role') === attributes.role;
            });
        }

        if (candidates.length === 0) {
            console.warn('[GlassLinq Content] No elements matched after filtering');
            return null;
        }

        // Return the first matching element
        console.log('[GlassLinq Content] Found element:', candidates[0]);
        return candidates[0];
    }

// ═══════════════════════════════════════════════════════════════
    // INTELLECTUAL WEB ANCHOR HEURISTIC ENGINE (FLOATING LABEL PROXIMITY)
    // ═══════════════════════════════════════════════════════════════
    function findWebAnchor(clickedElement) {
        // Only seek anchors for input-style fields
        const targetTag = clickedElement.tagName.toUpperCase();
        if (targetTag !== 'INPUT' && targetTag !== 'TEXTAREA' && targetTag !== 'SELECT') {
            return "";
        }

        // Rule 1: Check for explicit HTML 'for' attribute mapping
        if (clickedElement.id) {
            const explicitLabel = document.querySelector(`label[for="${clickedElement.id}"]`);
            if (explicitLabel && explicitLabel.innerText.trim()) {
                const txt = explicitLabel.innerText.trim().replace(/'/g, "\\'");
                return `<webctrl aaname='${txt}' tag='LABEL' check:innerText='${txt}' />`;
            }
        }

        // Rule 2: Check if input is nested cleanly inside a <label> wrapper tag
        const parentLabel = clickedElement.closest('label');
        if (parentLabel) {
            let text = "";
            parentLabel.childNodes.forEach(node => {
                if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
                else if (node.nodeType === Node.ELEMENT_NODE && node !== clickedElement) text += node.innerText;
            });
            text = text.trim().replace(/'/g, "\\'");
            if (text && text.length < 40) {
                return `<webctrl aaname='${text}' tag='LABEL' check:innerText='${text}' />`;
            }
        }

        // Rule 3: Form Wrapper / Isolated Sibling Matching (Handles Floating Labels Safely)
        // Look up for localized frame layout containers while avoiding giant grid/row containers
        let formContainer = clickedElement.closest('.form-group, .form-field, .input-container, .field-wrapper, .form-floating, .mat-form-field');
        
        // Fallback: If no known CSS layout framework class is found, scope down tightly to immediate parent element
        if (!formContainer) {
            formContainer = clickedElement.parentElement;
        }

        if (formContainer && formContainer !== document.body && formContainer !== document.documentElement) {
            // Find short text elements inside this container box *only*
            const internalLabels = formContainer.querySelectorAll('label, div.form-label, span, p');
            for (let label of internalLabels) {
                const txt = label.innerText ? label.innerText.trim() : "";
                
                // Ensure it's valid label text, not empty, and not the clicked element itself
                if (txt && txt.length > 0 && txt.length < 40 && label !== clickedElement) {
                    const cleanTxt = txt.replace(/'/g, "\\'");
                    console.log(`[GlassLinq] Isolated Container Anchor Found: ${cleanTxt} (${label.tagName})`);
                    return `<webctrl aaname='${cleanTxt}' tag='${label.tagName.toUpperCase()}' check:innerText='${cleanTxt}' />`;
                }
            }
        }

        // Rule 4: Intelligent Directional Proximity Map (Fallback)
        const candidates = document.querySelectorAll('label, span, th, td, p, div.form-label');
        let closestAnchor = null;
        let minDistance = 250; // Max search radius in pixels
        const inputRect = clickedElement.getBoundingClientRect();
        
        const inputCenter = {
            x: inputRect.left + inputRect.width / 2,
            y: inputRect.top + inputRect.height / 2
        };

        candidates.forEach(candidate => {
            const text = candidate.innerText ? candidate.innerText.trim() : "";
            // Ignore blank nodes, large headers, or parent containers holding the target
            if (!text || text.length > 40 || candidate.contains(clickedElement)) return;

            const candidateRect = candidate.getBoundingClientRect();
            const candidateCenter = {
                x: candidateRect.left + candidateRect.width / 2,
                y: candidateRect.top + candidateRect.height / 2
            };

            // Calculate directional distance offsets
            const deltaX = inputCenter.x - candidateCenter.x; // Positive means candidate is to the LEFT
            const deltaY = inputCenter.y - candidateCenter.y; // Positive means candidate is ABOVE

            // DIRECTIONAL REJECTION CRITICAL FOR FLOATING LAYOUTS:
            // If the text block is located completely BELOW the target input box, reject it instantly
            if (deltaY < -15) return; 
            
            // If the text block is located significantly to the RIGHT of the target input box, reject it
            if (deltaX < -30) return;

            // Compute math hypotenuse
            let distance = Math.hypot(deltaX, deltaY);
            
            // Bias: Give a visual advantage bonus to label items sitting cleanly to the left inline on the same row
            if (deltaX > 0 && Math.abs(deltaY) < 20) {
                distance *= 0.75; 
            }

            if (distance < minDistance) {
                minDistance = distance;
                closestAnchor = candidate;
            }
        });

        if (closestAnchor) {
            const txt = closestAnchor.innerText.trim().replace(/'/g, "\\'");
            console.log(`[GlassLinq] Geometrical Proximity Anchor Found: ${txt} (${closestAnchor.tagName})`);
            return `<webctrl aaname='${txt}' tag='${closestAnchor.tagName.toUpperCase()}' check:innerText='${txt}' />`;
        }

        return "";
    }

    /**
     * Parse XML-style selector string into attribute object
     * Example: "<webctrl tag='INPUT' id='username' />" 
     * Returns: { tag: 'INPUT', id: 'username' }
     */
    function parseXmlSelector(xmlString) {
        const attributes = {};

        // Extract all attribute="value" or attribute='value' pairs
        const regex = /(\w+(?:-\w+)*)=['"]([^'\"]+)['"]/g;
        let match;

        while ((match = regex.exec(xmlString)) !== null) {
            const key = match[1];
            const value = match[2];
            attributes[key] = value;
        }

        return attributes;
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