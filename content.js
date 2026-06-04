// content.js - Stable Web Spy Implementation (UiPath-inspired)
// Prevents feedback loops, cleans selectors, and captures clicks reliably

(function () {
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

        // ─── GENERATE CSS SELECTOR ───────────────────────────────────────────
        // generateCssSelector() returns the full <webctrl …/> tag for embedding
        // verbatim in the Selector XML string.  We also extract the plain unescaped
        // path and idx separately so SpyOverlayWindow can populate CapturedCssSelector
        // with a value ClickActivity can use directly without re-parsing XML.
        const cssSelectorTag = generateCssSelector(element);

        const cssSelectorPathMatch = cssSelectorTag.match(/css-selector='([^']+)'/);
        const cssSelectorIdxMatch = cssSelectorTag.match(/idx='(\d+)'/);
        // Unescape &gt; → > so the plain path is valid for querySelectorAll
        const cssSelectorPath = cssSelectorPathMatch
            ? cssSelectorPathMatch[1].replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
            : '';
        const cssSelectorIdx = cssSelectorIdxMatch ? parseInt(cssSelectorIdxMatch[1], 10) : 0;

        // FIX: Immediately lock spying states so that lingering 'web_spy_request' messages 
        // in transit don't spin the crosshair/highlighter window back up before Studio responds.
        captureLock = true;

        // Send capture event to Studio with all three CSS representations:
        //   cssSelector    – full <webctrl …/> tag, embedded verbatim in Selector XML
        //   cssSelectorPath – plain unescaped path, stored directly in CapturedCssSelector
        //   cssSelectorIdx  – integer index, available for downstream use
        chrome.runtime.sendMessage({
            action: 'element_captured',
            selector: selector,
            anchorSelector: anchorSelector,
            cssSelector: cssSelectorTag,
            cssSelectorPath: cssSelectorPath,
            cssSelectorIdx: cssSelectorIdx,
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

    /**
     * Generates a structural CSS Selector path matching UiPath formatting:
     * Escapes '>' chars into '&gt;' and utilizes tag names with sequential :nth-of-type structural indices.
     */
    /**
     * Generates a CSS selector path that exactly matches UiPath's format:
     *
     *   STRATEGY: Always walks to <body> using plain tag names only — no :nth-of-type
     *   is ever emitted. This produces paths like "body>div>div>div>span>svg" which
     *   will match multiple elements on the page.  The correct element is identified
     *   by idx: the 0-based position of the target in document.querySelectorAll(path).
     *
     *   This is identical to UiPath's approach and ensures cross-tool selector
     *   compatibility.
     *
     *   WHY NOT nth-of-type: emitting :nth-of-type makes the path match exactly one
     *   element (idx always 0) but uses a different strategy than UiPath. Mixing the
     *   two approaches in the same workflow causes idx mismatches and silent wrong-
     *   element clicks.
     *
     *   STABLE ID SHORTCUT: If a stable, human-authored ancestor ID is found while
     *   climbing (e.g. id="main-nav"), the path is rooted there instead of body.
     *   The idx is still computed against the shorter path, which remains unique
     *   enough to be reliable. Volatile framework hashes are ignored.
     */
    function generateCssSelector(el) {
        if (!(el instanceof Element)) return '';

        const targetTag = el.tagName.toUpperCase();
        const originalEl = el;
        const segments = [];
        let current = el;

        // NEW: Variable to hold a stable ancestor ID if discovered
        let parentIdValue = '';

        while (current && current.nodeType === Node.ELEMENT_NODE) {
            const nodeName = current.nodeName.toLowerCase();

            if (nodeName === 'html') break;

            segments.push(nodeName);

            // NEW: Look for a stable parent ID (skip the target element itself)
            if (!parentIdValue && current !== originalEl && current.id && !isVolatileId(current.id)) {
                parentIdValue = current.id;
            }

            if (nodeName === 'body') break;

            // Shadow DOM: if parentNode is a ShadowRoot, jump to the host element
            const parent = current.parentNode;
            if (parent instanceof ShadowRoot) {
                current = parent.host;
            } else {
                current = parent;
            }
        }

        segments.reverse();
        const fullCssPath = segments.join('&gt;');

        // idx computed against the light-DOM path only
        let idx = 0;
        try {
            const matches = Array.from(document.querySelectorAll(segments.join('>')));
            const pos = matches.indexOf(originalEl);
            if (pos >= 0) idx = pos;
        } catch (_) { }

        // NEW: Formulate the parentid attribute string if one was found
        const parentIdAttr = parentIdValue ? ` parentid='${escapeXml(parentIdValue)}'` : '';

        // Combined output tag safely utilizing existing variables
        return `<webctrl css-selector='${fullCssPath}'${parentIdAttr} tag='${targetTag}' idx='${idx}' />`;
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
     * Returns true when an element ID looks like a framework-generated volatile hash
     * that will change on the next page load and should never be used as a CSS anchor.
     * Examples: MUI's "_0tkgatH3J...", Kendo's "k-uid-...", styled-components "css-xxxxx"
     */
    /**
     * Returns true when an element ID is a framework-generated volatile hash that
     * will rotate on every page load or React re-render and must never be used as
     * a CSS anchor in a saved selector.
     *
     * Covers the most common generators seen in production SPAs:
     *   • React/Emotion/MUI  – leading underscore + long alphanumeric (_0tkgatH3J...)
     *   • MUI components     – "mui-NNNN"
     *   • Kendo UI           – "k-uid-..."
     *   • styled-components  – "css-xxxxx" class-as-id
     *   • Google rich cards  – "atritem-<hash>_<digits>" (the exact pattern from this bug)
     *   • Angular CDK        – "cdk-..." with numeric suffix
     *   • Radix / Headless   – "radix-:rXX:"
     *   • Pure numeric IDs   – auto-incremented counters (not stable across sessions)
     *   • Very long IDs      – anything over 64 chars is almost certainly generated
     *
     * An ID that passes none of these checks is considered stable (e.g. "main-nav",
     * "submit-btn", "logo") and safe to use as a path anchor.
     */
    function isVolatileId(idValue) {
        if (!idValue || typeof idValue !== 'string') return true;

        // Too long to be a human-authored id
        if (idValue.length > 64) return true;

        // Pure numeric — auto-incremented, not stable
        if (/^\d+$/.test(idValue)) return true;

        const patterns = [
            /^_[A-Za-z0-9]{8,}/,           // React/Emotion/MUI leading-underscore hash
            /^mui-/i,                        // MUI internal component IDs
            /^k-uid-/i,                      // Kendo UI
            /^css-[a-z0-9]{4,}/i,           // styled-components / Emotion
            /^atritem-[A-Za-z0-9_]{10,}/,   // Google Search rich-snippet cards (the reported bug)
            /^cdk-[a-z]+-\d+/i,             // Angular CDK (overlays, drag-drop, etc.)
            /^radix-:/,                      // Radix UI / shadcn portals
            /^ng-[a-z]+-\d+/i,              // Angular auto IDs
            /^__BVID__/,                     // Vue Bootstrap
            /[A-Za-z0-9]{20,}/,             // Any segment with 20+ consecutive alphanumerics
        ];

        return patterns.some(re => re.test(idValue));
    }

    /**
     * Handle CLICK runtime command.
     *
     * Priority routing:
     *   1. CSS-Selector  – message.cssSelector present → handleClickByCssSelector()
     *   2. Legacy webctrl – message.selector XML string → findElementBySelector()
     *   3. Error          – neither strategy resolved an element
     */
    function handleClick(message) {
        console.log('[GlassLinq Content] Executing CLICK:', message);

        try {
            // ── Strategy 1: CSS-Selector (Tier 1 from ClickActivity) ──────────
            if (message.cssSelector) {
                handleClickByCssSelector(message);
                return;
            }

            // ── Strategy 2: Legacy webctrl XML selector ────────────────────────
            const element = findElementBySelector(message.selector);

            if (!element) {
                chrome.runtime.sendMessage({
                    action: 'CLICK_RESPONSE',
                    transactionId: message.transactionId,
                    success: false,
                    reason: 'Element not found via legacy webctrl selector'
                });
                return;
            }

            dispatchDomClick(element, message.clickType);

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
                reason: error.message
            });
        }
    }

    /**
     * CSS-selector click handler — called by handleClick() when message.cssSelector is present.
     *
     * Element resolution (two-tier):
     *   Tier 1 – querySelectorAll(rawCss).  Skipped if the path contains a volatile ID hash.
     *   Tier 2 – querySelectorAll(tag) fallback using the tag name from message.selector XML.
     *            Used when Tier 1 produces no matches (dynamic ID drift, SPA re-render, etc.)
     *
     * Execution mode (message.mode):
     *   'simulate' (default) – synthetic MouseEvent chain dispatched inside the DOM.
     *   'hardware'           – returns getBoundingClientRect() + window.screenX/Y to C# so
     *                          the native mouse_event API can move the real OS cursor there.
     */
    function handleClickByCssSelector(message) {
        const rawCss = message.cssSelector;   // Already unescaped by C# before sending
        const idx = typeof message.idx === 'number' ? message.idx : 0;
        const mode = message.mode || 'simulate';
        const clickType = message.clickType || 'CLICK_SINGLE';
        const txId = message.transactionId;

        console.log(`[GlassLinq Content] CSS-Click | css="${rawCss}" idx=${idx} mode=${mode}`);

        let candidates = [];

        // ── Tier 1: Strict CSS path ────────────────────────────────────────────
        // Skip if the path roots on a volatile ID — it will have rotated since capture.
        const idSegment = rawCss.match(/#([^\s>+~[:.]+)/)?.[1] ?? '';
        const skipStrictPath = idSegment && isVolatileId(idSegment);

        if (!skipStrictPath) {
            try {
                candidates = Array.from(document.querySelectorAll(rawCss));
            } catch (queryErr) {
                console.warn('[GlassLinq Content] querySelectorAll failed:', queryErr.message);
            }
        } else {
            console.warn(`[GlassLinq Content] Volatile ID detected in CSS path — skipping strict match.`);
        }

        // ── Tier 2: Tag-name recovery ─────────────────────────────────────────
        // If Tier 1 returned nothing, extract the tag from the legacy webctrl XML
        // (message.selector) and collect all elements of that type, then let idx
        // pick the right one positionally.
        if (candidates.length === 0 && message.selector) {
            try {
                const attrs = parseXmlSelector(message.selector);
                if (attrs.tag) {
                    console.log(`[GlassLinq Content] Recovery mode — querying all <${attrs.tag}> elements`);
                    candidates = Array.from(document.querySelectorAll(attrs.tag.toLowerCase()));
                }
            } catch (fallbackErr) {
                console.warn('[GlassLinq Content] Tag recovery failed:', fallbackErr.message);
            }
        }
        // ── Tier 2.5: Shadow DOM pierce ───────────────────────────────────────
        // If the path contains custom elements (contain a hyphen), the target may
        // be inside a shadow root. Walk the path manually, piercing shadows.
        if (candidates.length === 0) {
            try {
                candidates = querySelectorDeep(rawCss);
            } catch (e) {
                console.warn('[GlassLinq Content] Shadow DOM pierce failed:', e.message);
            }
        }

        if (candidates.length === 0) {
            chrome.runtime.sendMessage({
                action: 'CLICK_RESPONSE',
                transactionId: txId,
                success: false,
                reason: `No DOM elements matched css-selector or recovery tag. VolatileIDSkip=${skipStrictPath}`
            });
            return;
        }

        // Clamp idx — never silently click the wrong element on out-of-range
        const resolvedIdx = Math.min(idx, candidates.length - 1);
        if (resolvedIdx !== idx) {
            console.warn(`[GlassLinq Content] idx=${idx} out of range (${candidates.length} matches) — using ${resolvedIdx}`);
        }

        const element = candidates[resolvedIdx];
        console.log('[GlassLinq Content] CSS-Click resolved →', element);

        // ── Execution mode ─────────────────────────────────────────────────────
        if (mode === 'hardware') {
            const rect = element.getBoundingClientRect();

            if (rect.width === 0 && rect.height === 0) {
                chrome.runtime.sendMessage({
                    action: 'CLICK_RESPONSE',
                    transactionId: txId,
                    success: false,
                    reason: 'Element has a zero bounding box — it may be hidden or not yet rendered.'
                });
                return;
            }

            // Absolute screen origin: viewport-relative rect + browser chrome offset.
            // window.scrollX/Y accounts for page scroll so the coordinate maps to the
            // correct physical pixel regardless of scroll position.
            const originX = window.screenX + window.scrollX;
            const originY = window.screenY + window.scrollY;

            chrome.runtime.sendMessage({
                action: 'CLICK_RESPONSE',
                transactionId: txId,
                success: true,
                // C# computes centre as: screenX + width/2, screenY + height/2
                screenX: originX + rect.left,
                screenY: originY + rect.top,
                width: rect.width,
                height: rect.height,
                timestamp: Date.now()
            });

        } else {
            // 'simulate' — fire a synthetic event chain in the DOM
            dispatchDomClick(element, clickType);

            chrome.runtime.sendMessage({
                action: 'CLICK_RESPONSE',
                transactionId: txId,
                success: true,
                timestamp: Date.now()
            });
        }
    }

    function querySelectorDeep(cssPath) {
        const parts = cssPath.split('>').map(s => s.trim());
        let contexts = [document];

        for (const part of parts) {
            const next = [];
            for (const ctx of contexts) {
                // Query in light DOM
                const found = Array.from(ctx.querySelectorAll ? ctx.querySelectorAll(part) : []);
                next.push(...found);

                // Query inside any shadow roots attached to children
                const all = Array.from(ctx.querySelectorAll ? ctx.querySelectorAll('*') : []);
                for (const el of all) {
                    if (el.shadowRoot) {
                        const shadowed = Array.from(el.shadowRoot.querySelectorAll(part));
                        next.push(...shadowed);
                    }
                }
            }
            contexts = next;
            if (contexts.length === 0) break;
        }

        return contexts;
    }

    /**
     * Fire a synthetic mouse-click sequence on an element.
     *
     * Uses MouseEvent (not the bare element.click()) so that React, Vue, and Angular
     * synthetic event systems see a full mousedown → mouseup → click chain.
     * element.click() is still appended for CLICK_SINGLE as a final fallback for
     * plain HTML pages where framework listeners are absent.
     *
     * @param {Element} element   Target DOM element.
     * @param {string}  clickType CLICK_SINGLE | CLICK_DOUBLE | CLICK_DOWN | CLICK_UP
     */
    function dispatchDomClick(element, clickType) {
        const init = { bubbles: true, cancelable: true, view: window };

        switch (clickType) {
            case 'CLICK_DOUBLE':
                element.dispatchEvent(new MouseEvent('mousedown', init));
                element.dispatchEvent(new MouseEvent('mouseup', init));
                element.dispatchEvent(new MouseEvent('click', init));
                element.dispatchEvent(new MouseEvent('click', { ...init, detail: 2 }));
                break;
            case 'CLICK_DOWN':
                element.dispatchEvent(new MouseEvent('mousedown', init));
                break;
            case 'CLICK_UP':
                element.dispatchEvent(new MouseEvent('mouseup', init));
                break;
            case 'CLICK_SINGLE':
            default:
                element.dispatchEvent(new MouseEvent('mousedown', init));
                element.dispatchEvent(new MouseEvent('mouseup', init));
                element.dispatchEvent(new MouseEvent('click', init));
                if (typeof element.click === 'function') element.click(); // SVG elements don't have .click()
                break;
        }
    }

    /**
     * Handle TYPE_INTO runtime command
     * Parses selector and types text into the matching element
     */
    function handleTypeInto(message) {
        console.log('[GlassLinq Content] Executing TYPE_INTO:', message);

        try {
            let element = null;

            // 1. STRATEGY A: Attempt resolution using the resilient CSS Path layer
            if (message.cssSelector) {
                try {
                    console.log(`[GlassLinq Content] Trying CSS Selector lookup: ${message.cssSelector} (idx: ${message.idx || 0})`);
                    const candidates = Array.from(document.querySelectorAll(message.cssSelector));

                    if (candidates.length > 0) {
                        // Safe boundaries: fall back to index 0 if message.idx is out of bounds
                        const targetIndex = (message.idx && message.idx < candidates.length) ? message.idx : 0;
                        element = candidates[targetIndex];
                        console.log('[GlassLinq Content] Element successfully resolved via CSS Selector Path.');
                    }
                } catch (cssError) {
                    console.warn('[GlassLinq Content] CSS Selector syntax search failed:', cssError);
                }
            }

            // 2. STRATEGY B: Fall back to legacy XML Selector if CSS resolution missed
            if (!element && message.selector) {
                console.log('[GlassLinq Content] CSS lookup missed or empty. Falling back to legacy XML parsing...');
                element = findElementBySelector(message.selector);
            }

            // 3. EXCEPTION HANDLING: Neither strategy located the target DOM element
            if (!element) {
                chrome.runtime.sendMessage({
                    action: 'TYPE_INTO_RESPONSE',
                    transactionId: message.transactionId,
                    success: false,
                    error: 'Element not found via CSS path or XML attributes.'
                });
                return;
            }

            // 4. EXECUTION FLOW (Focus and Input Tracking Integration)
            element.focus();

            // Dynamically extract prototype setter based on element type (supports INPUT and TEXTAREA)
            const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            const valueDescriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

            if (!valueDescriptor || !valueDescriptor.set) {
                throw new Error('Target element does not support native value properties.');
            }

            const nativeInputSetter = valueDescriptor.set;

            // Handle field clear if configured
            if (message.emptyField) {
                nativeInputSetter.call(element, '');
                element.dispatchEvent(new Event('input', { bubbles: true }));
            }

            // Apply text data payload via native prototype invocation
            nativeInputSetter.call(element, message.text || '');

            // Dispatch synthetic events to kick off React/MUI framework binding hooks
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));

            // Force Material-UI Combobox dropdown overlays to unroll/render
            element.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true, cancelable: true, key: 'ArrowDown', keyCode: 40
            }));
            element.dispatchEvent(new KeyboardEvent('keyup', {
                bubbles: true, cancelable: true, key: 'ArrowDown', keyCode: 40
            }));

            // Send successful transmission callback back up the native message pipeline
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

        const attributes = parseXmlSelector(xmlSelector);

        if (!attributes.tag) {
            console.error('[GlassLinq Content] No tag specified in selector');
            return null;
        }

        // Build the leanest possible CSS selector.
        // If a stable id is present, use ONLY tag + id — never append class,
        // because MUI/Ember class strings contain generated hashes (css-XXXXXXX)
        // that change on every page load and will cause querySelector to return null.
        let cssSelector = attributes.tag.toLowerCase();

        if (attributes.id) {
            cssSelector += `#${CSS.escape(attributes.id)}`;
            // Stop here — id is globally unique, no further attributes needed.
            const element = document.querySelector(cssSelector);
            console.log(`[GlassLinq Content] ID-based lookup "${cssSelector}":`, element);
            return element;
        }

        // No id — build selector from stable attributes only,
        // skipping class entirely to avoid volatile MUI hash tokens.
        if (attributes.name) {
            cssSelector += `[name="${CSS.escape(attributes.name)}"]`;
        }

        if (attributes.type) {
            cssSelector += `[type="${CSS.escape(attributes.type)}"]`;
        }

        if (attributes.role) {
            cssSelector += `[role="${CSS.escape(attributes.role)}"]`;
        }

        if (attributes['aria-label']) {
            cssSelector += `[aria-label="${CSS.escape(attributes['aria-label'])}"]`;
        }

        console.log('[GlassLinq Content] Attribute-based lookup:', cssSelector);

        let candidates = Array.from(document.querySelectorAll(cssSelector));

        // Post-filter by aaname/innerText if present
        if (attributes.aaname && candidates.length > 1) {
            candidates = candidates.filter(el =>
                (el.innerText || el.textContent || '').trim().includes(attributes.aaname)
            );
        }

        if (candidates.length === 0) {
            console.warn('[GlassLinq Content] No elements found for selector:', cssSelector);
            return null;
        }

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