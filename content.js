// content.js - GlassLinq Web Spy & Runtime Engine (Unified Selector Model)
// Implements a single <webctrl /> selector tag with multi-tiered fallback resolution.

(function () {
    'use strict';

    // ═══════════════════════════════════════════════════════════════
    // STATE MANAGEMENT
    // ═══════════════════════════════════════════════════════════════
    let isSpying = false;
    let lastHighlightedElement = null;
    let highlightOverlay = null;
    let captureLock = false;

    // ═══════════════════════════════════════════════════════════════
    // INITIALIZATION
    // ═══════════════════════════════════════════════════════════════
    function init() {
        console.log('[GlassLinq Content] Initializing...');
        createHighlightOverlay();
        chrome.runtime.onMessage.addListener(handleMessage);
    }

    // ═══════════════════════════════════════════════════════════════
    // MESSAGE HANDLER
    // ═══════════════════════════════════════════════════════════════
    function handleMessage(message, sender, sendResponse) {
        console.log('[GlassLinq Content] Received:', message);

        if (message.action === 'start_web_spy' || message.action === 'web_spy_request') {
            if (!captureLock) startSpying();
            if (typeof sendResponse === 'function') sendResponse({ status: 'started' });
        }
        else if (message.action === 'stop_web_spy') {
            captureLock = false;
            stopSpying();
            if (typeof sendResponse === 'function') sendResponse({ status: 'stopped' });
        }
        else if (message.action === 'GET_TEXT') { handleGetText(message); }
        else if (message.action === 'CLICK') { handleClick(message); }
        else if (message.action === 'TYPE_INTO') { handleTypeInto(message); }
        else if (message.action === 'GET_ELEMENT_COUNT') { handleGetElementCount(message); }
        else if (message.action === 'GET_ELEMENT_ATTRIBUTE') { handleGetElementAttribute(message); }
        else if (message.action === 'GET_TABLE_DATA') { handleGetTableData(message); }

        return false;
    }

    // ═══════════════════════════════════════════════════════════════
    // HIGHLIGHT OVERLAY
    // ═══════════════════════════════════════════════════════════════
    function createHighlightOverlay() {
        if (highlightOverlay) return;
        highlightOverlay = document.createElement('div');
        highlightOverlay.id = 'glasslinq-highlight-overlay';
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
    // SPY LIFECYCLE
    // ═══════════════════════════════════════════════════════════════
    function startSpying() {
        if (isSpying) return;
        isSpying = true;
        lastHighlightedElement = null;
        console.log('[GlassLinq Content] Web Spy ACTIVATED');
        document.addEventListener('mousemove', onMouseMove, true);
        document.addEventListener('click', onClickCapture, true);
        document.body.style.cursor = 'crosshair';
    }

    function stopSpying() {
        if (!isSpying) return;
        isSpying = false;
        lastHighlightedElement = null;
        console.log('[GlassLinq Content] Web Spy DEACTIVATED');
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('click', onClickCapture, true);
        if (highlightOverlay) highlightOverlay.style.display = 'none';
        document.body.style.cursor = '';
    }

    // ═══════════════════════════════════════════════════════════════
    // MOUSE MOVE — live hover preview
    // ═══════════════════════════════════════════════════════════════
    function onMouseMove(event) {
        if (!isSpying) return;
        const element = document.elementFromPoint(event.clientX, event.clientY);
        if (!element || element === document.body || element === document.documentElement) return;
        if (element === lastHighlightedElement) return;

        lastHighlightedElement = element;
        updateHighlight(element);

        // For hover we only need the lightweight attribute selector (no CSS path computation)
        const selector = buildUiPathSelector(element);
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
    // CLICK CAPTURE — emit unified <webctrl /> selector
    // ═══════════════════════════════════════════════════════════════
    function onClickCapture(event) {
        if (!isSpying) return;
        event.preventDefault();
        event.stopPropagation();

        const element = event.target;
        console.log('[GlassLinq Content] Element CAPTURED:', element);

        // Build the single unified XML selector tag
        const unifiedSelector = buildUnifiedSelector(element);

        // Anchor (proximity label / for= label)
        const anchorSelector = findWebAnchor(element);

        // Extract the raw (unescaped) CSS path so C# consumers never need to
        // decode &gt; entities themselves.  buildCssPath is called again here
        // because buildUnifiedSelector doesn't expose rawPath externally.
        // The second call is cheap — same DOM walk, negligible cost at capture time.
        const { rawPath: rawCssPath } = buildCssPath(element);

        captureLock = true;

        chrome.runtime.sendMessage({
            action: 'element_captured',
            selector: unifiedSelector,   // ← the ONE unified <webctrl … /> tag
            anchorSelector: anchorSelector,
            // cssSelector kept for backward compat with SpyOverlayWindow CSS-selector field
            cssSelector: unifiedSelector,
            // rawCssSelector: unescaped CSS path ready for querySelectorAll / bridge.
            // Use this in C# instead of decoding the &gt; entities in css-selector.
            rawCssSelector: rawCssPath,
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

        stopSpying();
    }

    // ═══════════════════════════════════════════════════════════════
    // UNIFIED SELECTOR BUILDER
    //
    // Merges the structural CSS path, idx, and all stable descriptive
    // attributes into a single <webctrl /> tag, e.g.:
    //
    //   <webctrl css-selector='body&gt;div&gt;form&gt;input'
    //            tag='INPUT' id='username' name='user'
    //            type='text' aaname='Login' idx='0' />
    //
    // Rules:
    //  • css-selector — structural path with > escaped as &gt;
    //  • tag          — upper-case tag name (always present)
    //  • id           — only when not volatile
    //  • name, type, role, aria-label — when present
    //  • aaname       — trimmed inner text ≤ 80 chars
    //  • idx          — 0-based position in querySelectorAll(path)
    //  • parentid     — nearest stable ancestor id (when found)
    // ═══════════════════════════════════════════════════════════════
    function buildUnifiedSelector(el) {
        if (!(el instanceof Element)) return '';

        const tag = el.tagName.toUpperCase();
        const attrs = [];

        // ── 1. Structural CSS path ────────────────────────────────
        const { escapedPath, rawPath, idx, parentId } = buildCssPath(el);

        if (escapedPath) attrs.push(`css-selector='${escapedPath}'`);
        if (parentId) attrs.push(`parentid='${escapeXml(parentId)}'`);

        // ── 2. Tag (always) ───────────────────────────────────────
        attrs.push(`tag='${tag}'`);

        // ── 3. Stable ID ──────────────────────────────────────────
        if (el.id && !isVolatileId(el.id)) {
            attrs.push(`id='${escapeXml(el.id)}'`);
        }

        // ── 4. Descriptive attributes ─────────────────────────────
        if (el.name) attrs.push(`name='${escapeXml(el.name)}'`);
        if (el.type) attrs.push(`type='${escapeXml(el.type)}'`);
        if (el.getAttribute('role')) attrs.push(`role='${escapeXml(el.getAttribute('role'))}'`);
        if (el.getAttribute('aria-label')) attrs.push(`aria-label='${escapeXml(el.getAttribute('aria-label'))}'`);
        if (el.getAttribute('data-testid')) attrs.push(`data-testid='${escapeXml(el.getAttribute('data-testid'))}'`);
        if (el.getAttribute('placeholder')) attrs.push(`placeholder='${escapeXml(el.getAttribute('placeholder').substring(0, 60))}'`);

        // ── 5. Inner text (aaname) ────────────────────────────────
        const text = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
        if (text && text.length > 0 && text.length <= 80) {
            attrs.push(`aaname='${escapeXml(text)}'`);
        }

        // ── 6. Positional index ───────────────────────────────────
        attrs.push(`idx='${idx}'`);

        return `<webctrl ${attrs.join(' ')} />`;
    }

    /**
     * Walk the DOM upward from `el` to build a CSS path.
     * Returns: { escapedPath, rawPath, idx, parentId }
     *
     * Key behaviour — stop at the first stable ancestor id:
     *   Instead of always climbing to <body>, we stop as soon as we find
     *   an ancestor whose id passes isVolatileId(). The path is then rooted
     *   at "#stableId > ... > tag" rather than "body > div > div > ...".
     *
     *   This mirrors how UiPath uses parentid — a short, anchor-rooted path
     *   like "#desktop-3 > ul > li > span > a > img" is far more resilient
     *   than a 10-deep anonymous-div chain from body.
     *
     *   idx is calculated within the scoped root (the stable ancestor element
     *   or document when no stable ancestor exists) so it stays correct.
     */
    function buildCssPath(el) {
        const originalEl = el;
        const segments = [];   // tag names from el upward, reversed at end
        let current = el;
        let parentId = '';   // stable ancestor id when found
        let anchorElement = null; // the DOM element whose id is parentId

        while (current && current.nodeType === Node.ELEMENT_NODE) {
            const nodeName = current.nodeName.toLowerCase();
            if (nodeName === 'html') break;

            segments.push(nodeName);

            // Check ancestors (not the element itself) for a stable id.
            if (!parentId && current !== originalEl && current.id && !isVolatileId(current.id)) {
                parentId = current.id;
                anchorElement = current;
                break;  // ← Stop climbing. We have a stable root.
            }

            if (nodeName === 'body') break;

            const parent = current.parentNode;
            current = (parent instanceof ShadowRoot) ? parent.host : parent;
        }

        segments.reverse();

        let rawPath, escapedPath;

        if (parentId) {
            // Root the path at the stable id anchor, e.g.:
            //   "#desktop-3 > ul > li > span > a > img"
            // segments[0] is the anchor tag itself — drop it and prepend the id selector.
            const relativeSegments = segments.slice(1);  // everything below the anchor
            rawPath = relativeSegments.length > 0
                ? `#${parentId} > ${relativeSegments.join(' > ')}`
                : `#${parentId}`;
            escapedPath = relativeSegments.length > 0
                ? `#${parentId} &gt; ${relativeSegments.join(' &gt; ')}`
                : `#${parentId}`;
        } else {
            // No stable ancestor — fall back to the original body-rooted path.
            rawPath = segments.join('>');
            escapedPath = segments.join('&gt;');
        }

        // Calculate idx scoped to the anchor element (or document) so it's
        // correct relative to the path we just built.
        let idx = 0;
        try {
            const searchRoot = anchorElement ?? document;
            const matches = Array.from(searchRoot.querySelectorAll(
                anchorElement
                    ? segments.slice(1).join(' > ') || segments[segments.length - 1]
                    : rawPath
            ));
            const pos = matches.indexOf(originalEl);
            if (pos >= 0) idx = pos;
        } catch (_) { /* malformed path — idx stays 0 */ }

        return { escapedPath, rawPath, idx, parentId };
    }

    // ═══════════════════════════════════════════════════════════════
    // LIGHTWEIGHT ATTRIBUTE SELECTOR (hover preview only)
    // ═══════════════════════════════════════════════════════════════
    function buildUiPathSelector(element) {
        const tag = element.tagName.toUpperCase();
        const attributes = [];

        if (element.id && !isVolatileId(element.id)) attributes.push(`id='${escapeXml(element.id)}'`);
        if (element.name) attributes.push(`name='${escapeXml(element.name)}'`);
        if (element.type) attributes.push(`type='${escapeXml(element.type)}'`);
        if (element.getAttribute('role')) attributes.push(`role='${escapeXml(element.getAttribute('role'))}'`);
        if (element.getAttribute('aria-label')) attributes.push(`aria-label='${escapeXml(element.getAttribute('aria-label'))}'`);

        const text = (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
        if (text && text.length > 0 && text.length <= 80) {
            attributes.push(`aaname='${escapeXml(text)}'`);
        }

        const attrString = attributes.length > 0 ? ' ' + attributes.join(' ') : '';
        return `<webctrl tag='${tag}'${attrString} />`;
    }

    // ═══════════════════════════════════════════════════════════════
    // VOLATILE ID DETECTOR
    // ═══════════════════════════════════════════════════════════════
    function isVolatileId(idValue) {
        if (!idValue || typeof idValue !== 'string') return true;
        if (idValue.length > 64) return true;
        if (/^\d+$/.test(idValue)) return true;

        const patterns = [
            /^_[A-Za-z0-9]{8,}/,
            /^mui-/i,
            /^k-uid-/i,
            /^css-[a-z0-9]{4,}/i,
            /^atritem-[A-Za-z0-9_]{10,}/,
            /^cdk-[a-z]+-\d+/i,
            /^radix-:/,
            /^ng-[a-z]+-\d+/i,
            /^__BVID__/,
            /[A-Za-z0-9]{20,}/,
            // GUID / UUID format: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        ];
        return patterns.some(re => re.test(idValue));
    }

    // ═══════════════════════════════════════════════════════════════
    // UNIFIED ELEMENT RESOLUTION ENGINE
    //
    // Accepts a unified <webctrl /> XML string and resolves it through
    // three tiers so a single code path services CLICK, GET_TEXT, and
    // TYPE_INTO equally.
    //
    //  Tier 1 — css-selector attribute (structural path + idx)
    //           Skipped when the path roots on a volatile ID hash.
    //  Tier 2 — stable attribute query: id, name, type, role, aria-label
    //  Tier 3 — tag + aaname text containment or positional idx fallback
    //
    // Returns the resolved DOM Element or null.
    // ═══════════════════════════════════════════════════════════════
    function resolveElement(xmlSelector) {
        console.log('[GlassLinq Content] Resolving element for:', xmlSelector);

        const attrs = parseXmlSelector(xmlSelector);

        if (!attrs.tag) {
            console.error('[GlassLinq Content] Selector has no tag attribute');
            return null;
        }

        const idx = parseInt(attrs.idx || '0', 10) || 0;

        // ── Tier 1: Structural CSS path ───────────────────────────
        if (attrs['css-selector']) {
            // Unescape &gt; → > so querySelectorAll receives a valid CSS string
            const rawCss = attrs['css-selector']
                .replace(/&gt;/g, '>')
                .replace(/&lt;/g, '<')
                .replace(/&amp;/g, '&');

            const idSegment = rawCss.match(/#([^\s>+~[:.]+)/)?.[1] ?? '';
            const skipStrictPath = idSegment && isVolatileId(idSegment);

            if (!skipStrictPath) {
                try {
                    let candidates = Array.from(document.querySelectorAll(rawCss));

                    if (candidates.length === 0) {
                        // Try shadow DOM pierce before giving up on Tier 1
                        candidates = querySelectorDeep(rawCss);
                    }

                    if (candidates.length > 0) {
                        const resolvedIdx = Math.min(idx, candidates.length - 1);
                        const el = candidates[resolvedIdx];
                        console.log(`[GlassLinq Content] Tier 1 resolved → idx=${resolvedIdx}`, el);
                        return el;
                    }
                } catch (e) {
                    console.warn('[GlassLinq Content] Tier 1 querySelectorAll failed:', e.message);
                }
            } else {
                console.warn('[GlassLinq Content] Tier 1: volatile ID detected — skipping strict path');
            }
        }

        // ── Tier 2: Stable attribute query ────────────────────────
        // Build the leanest CSS string from non-volatile, non-structural attributes.
        // NOTE: Never land on a type=file input unless the selector explicitly asks for one —
        //       programmatic value assignment on file inputs throws a security error.
        {
            const tagLower = attrs.tag.toLowerCase();
            const selectorType = (attrs.type || '').toLowerCase();
            // Append :not([type=file]) for input elements when the selector doesn't target a file picker
            const fileExclusion = (tagLower === 'input' && selectorType !== 'file') ? ':not([type="file"])' : '';
            let cssTier2 = tagLower + fileExclusion;

            // id is the most selective — if stable, use it alone and return immediately
            if (attrs.id && !isVolatileId(attrs.id)) {
                const candidate = document.querySelector(`${tagLower}#${CSS.escape(attrs.id)}`);
                if (candidate) {
                    console.log('[GlassLinq Content] Tier 2 (id) resolved →', candidate);
                    return candidate;
                }
            }

            // Build compound selector from remaining stable attributes
            if (attrs.name) cssTier2 += `[name="${CSS.escape(attrs.name)}"]`;
            if (attrs.type) cssTier2 += `[type="${CSS.escape(attrs.type)}"]`;
            if (attrs.role) cssTier2 += `[role="${CSS.escape(attrs.role)}"]`;
            if (attrs['aria-label']) cssTier2 += `[aria-label="${CSS.escape(attrs['aria-label'])}"]`;
            if (attrs['data-testid']) cssTier2 += `[data-testid="${CSS.escape(attrs['data-testid'])}"]`;

            if (cssTier2 !== tagLower) {
                try {
                    let candidates = Array.from(document.querySelectorAll(cssTier2));

                    // Narrow by aaname if we still have multiple matches
                    if (attrs.aaname && candidates.length > 1) {
                        candidates = candidates.filter(el =>
                            (el.innerText || el.textContent || '').trim().includes(attrs.aaname)
                        );
                    }

                    if (candidates.length > 0) {
                        const resolvedIdx = Math.min(idx, candidates.length - 1);
                        console.log(`[GlassLinq Content] Tier 2 (attrs) resolved → idx=${resolvedIdx}`, candidates[resolvedIdx]);
                        return candidates[resolvedIdx];
                    }
                } catch (e) {
                    console.warn('[GlassLinq Content] Tier 2 query failed:', e.message);
                }
            }
        }

        // ── Tier 3: Tag + aaname text / positional idx ────────────
        {
            const tagLower = attrs.tag.toLowerCase();
            const selectorType = (attrs.type || '').toLowerCase();
            // Exclude file inputs unless the selector explicitly targets one
            const fileGuard = (tagLower === 'input' && selectorType !== 'file')
                ? ':not([type="file"])'
                : '';
            let candidates = Array.from(document.querySelectorAll(tagLower + fileGuard));

            if (candidates.length === 0) {
                console.warn('[GlassLinq Content] Tier 3: no elements with tag', tagLower);
                return null;
            }

            // Prefer aaname text match
            if (attrs.aaname) {
                const byText = candidates.filter(el =>
                    (el.innerText || el.textContent || '').trim().includes(attrs.aaname)
                );
                if (byText.length > 0) {
                    console.log('[GlassLinq Content] Tier 3 (aaname) resolved →', byText[0]);
                    return byText[0];
                }
            }

            // Fall back to positional idx
            const resolvedIdx = Math.min(idx, candidates.length - 1);
            console.log(`[GlassLinq Content] Tier 3 (idx=${resolvedIdx}) resolved →`, candidates[resolvedIdx]);
            return candidates[resolvedIdx];
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // RUNTIME — GET_ELEMENT_COUNT
    //
    // Counts elements matching cssSelector within an optional
    // scopeSelector container (or document when omitted).
    // Scoping prevents cross-section bleed on pages with multiple
    // repeating regions — e.g. several Amazon carousels sharing
    // the same li class name.
    //
    // Request:  { action, cssSelector, scopeSelector? }
    // Response: { action:'GET_ELEMENT_COUNT_RESPONSE', success, count }
    // ═══════════════════════════════════════════════════════════════
    function handleGetElementCount(message) {
        try {
            const { cssSelector, scopeSelector, transactionId } = message;

            if (!cssSelector) {
                chrome.runtime.sendMessage({
                    action: 'GET_ELEMENT_COUNT_RESPONSE',
                    transactionId,
                    success: false,
                    error: 'cssSelector is required'
                });
                return;
            }

            const root = resolveScope(scopeSelector);
            if (!root) {
                chrome.runtime.sendMessage({
                    action: 'GET_ELEMENT_COUNT_RESPONSE',
                    transactionId,
                    success: false,
                    error: `Scope element not found for selector: "${scopeSelector}"`
                });
                return;
            }

            const count = root.querySelectorAll(cssSelector).length;
            console.log(`[GlassLinq Content] GET_ELEMENT_COUNT css="${cssSelector}" scope="${scopeSelector || 'document'}" → ${count}`);

            chrome.runtime.sendMessage({
                action: 'GET_ELEMENT_COUNT_RESPONSE',
                transactionId,
                success: true,
                count
            });

        } catch (err) {
            console.error('[GlassLinq Content] GET_ELEMENT_COUNT error:', err);
            chrome.runtime.sendMessage({
                action: 'GET_ELEMENT_COUNT_RESPONSE',
                transactionId: message.transactionId,
                success: false,
                error: err.message
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // RUNTIME — GET_ELEMENT_ATTRIBUTE
    //
    // Reads a named attribute from the element at position [idx]
    // within querySelectorAll(cssSelector) scoped to scopeSelector.
    // "innerText" / "text" are treated as pseudo-attributes and
    // read via the innerText property instead of getAttribute().
    //
    // Request:  { action, cssSelector, scopeSelector?, idx, attribute }
    // Response: { action:'GET_ELEMENT_ATTRIBUTE_RESPONSE', success, value }
    // ═══════════════════════════════════════════════════════════════
    function handleGetElementAttribute(message) {
        try {
            const { cssSelector, scopeSelector, idx, attribute, transactionId } = message;

            if (!cssSelector || idx === undefined || !attribute) {
                chrome.runtime.sendMessage({
                    action: 'GET_ELEMENT_ATTRIBUTE_RESPONSE',
                    transactionId,
                    success: false,
                    error: 'cssSelector, idx and attribute are all required'
                });
                return;
            }

            const root = resolveScope(scopeSelector);
            if (!root) {
                chrome.runtime.sendMessage({
                    action: 'GET_ELEMENT_ATTRIBUTE_RESPONSE',
                    transactionId,
                    success: false,
                    error: `Scope element not found for selector: "${scopeSelector}"`
                });
                return;
            }

            const elements = Array.from(root.querySelectorAll(cssSelector));

            if (idx < 0 || idx >= elements.length) {
                chrome.runtime.sendMessage({
                    action: 'GET_ELEMENT_ATTRIBUTE_RESPONSE',
                    transactionId,
                    success: false,
                    error: `Index ${idx} out of range (found ${elements.length} elements)`
                });
                return;
            }

            const el = elements[idx];
            const key = attribute.toLowerCase();
            let value;

            if (key === 'innertext' || key === 'text') {
                // innerText respects CSS visibility and gives clean rendered text
                value = (el.innerText ?? el.textContent ?? '').trim();
            } else if (key === 'href' || key === 'src') {
                // Use the resolved absolute URL rather than the raw attribute string
                value = el[attribute] ?? el.getAttribute(attribute) ?? '';
            } else {
                value = el.getAttribute(attribute) ?? el[attribute] ?? '';
            }

            console.log(`[GlassLinq Content] GET_ELEMENT_ATTRIBUTE css="${cssSelector}" idx=${idx} attr="${attribute}" → "${value}"`);

            chrome.runtime.sendMessage({
                action: 'GET_ELEMENT_ATTRIBUTE_RESPONSE',
                transactionId,
                success: true,
                value: String(value).trim()
            });

        } catch (err) {
            console.error('[GlassLinq Content] GET_ELEMENT_ATTRIBUTE error:', err);
            chrome.runtime.sendMessage({
                action: 'GET_ELEMENT_ATTRIBUTE_RESPONSE',
                transactionId: message.transactionId,
                success: false,
                error: err.message
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // RUNTIME — GET_TABLE_DATA
    //
    // Walks an HTML table matched by cssSelector and returns every
    // row as an array of cell text values.
    //
    // Request:  { action, cssSelector, includeHeaders? }
    // Response: { action, success, headers: string[],
    //             rows: string[][], rowCount, columnCount }
    //
    // includeHeaders (default true):
    //   true  → first row of <th> cells becomes the headers array;
    //            data rows are <tr> elements that contain <td> cells.
    //   false → headers array is empty; ALL <tr> rows are treated as data.
    //
    // The activity uses headers[] to name DataTable columns and rows[][]
    // for DataTable rows, giving a faithful replica of the browser table.
    // ═══════════════════════════════════════════════════════════════
    function handleGetTableData(message) {
        const transactionId = message.transactionId;
        try {
            const cssSelector = (message.cssSelector || '').trim();
            const includeHeaders = message.includeHeaders !== false; // default true

            if (!cssSelector) {
                chrome.runtime.sendMessage({
                    action: 'GET_TABLE_DATA_RESPONSE',
                    transactionId,
                    success: false,
                    error: 'cssSelector is required'
                });
                return;
            }

            // Resolve the table element — accept <table>, or walk up from any
            // descendant the user happened to spy (e.g. a <td> or <tbody>).
            let tableEl = document.querySelector(cssSelector);
            if (!tableEl) {
                chrome.runtime.sendMessage({
                    action: 'GET_TABLE_DATA_RESPONSE',
                    transactionId,
                    success: false,
                    error: `No element found for selector: "${cssSelector}"`
                });
                return;
            }

            // If the user spied a cell or section rather than the <table> itself,
            // walk up to the nearest ancestor <table>.
            if (tableEl.tagName !== 'TABLE') {
                const ancestor = tableEl.closest('table');
                if (ancestor) tableEl = ancestor;
                // If there's still no <table>, treat the element as a generic
                // grid container and extract its direct <tr>-like children.
            }

            // ── Extract header row ─────────────────────────────────
            let headers = [];
            if (includeHeaders) {
                // Prefer explicit <thead> > <tr> > <th> structure.
                const thead = tableEl.querySelector('thead');
                if (thead) {
                    const headerRow = thead.querySelector('tr');
                    if (headerRow) {
                        headers = Array.from(headerRow.querySelectorAll('th, td'))
                            .map(cell => (cell.innerText ?? cell.textContent ?? '').trim());
                    }
                }
                // Fallback: first <tr> that contains only <th> elements.
                if (headers.length === 0) {
                    const firstRow = tableEl.querySelector('tr');
                    if (firstRow && firstRow.querySelectorAll('th').length > 0) {
                        headers = Array.from(firstRow.querySelectorAll('th'))
                            .map(cell => (cell.innerText ?? cell.textContent ?? '').trim());
                    }
                }
            }

            // ── Extract data rows ──────────────────────────────────
            // Collect all <tr> elements from <tbody>, or from the table directly
            // if there is no <tbody>. Skip any row that was already captured as
            // the header row.
            const allRows = Array.from(tableEl.querySelectorAll('tr'));
            const headerRowEl = (() => {
                if (!includeHeaders || headers.length === 0) return null;
                const thead = tableEl.querySelector('thead tr');
                if (thead) return thead;
                // Was the first row used as the header fallback?
                const firstRow = tableEl.querySelector('tr');
                if (firstRow && firstRow.querySelectorAll('th').length > 0) return firstRow;
                return null;
            })();

            const dataRows = allRows
                .filter(tr => tr !== headerRowEl)           // skip header row
                .filter(tr => tr.querySelectorAll('td').length > 0 ||   // has data cells
                    (!includeHeaders && tr.querySelectorAll('th, td').length > 0))
                .map(tr =>
                    Array.from(tr.querySelectorAll('td, th'))
                        .map(cell => (cell.innerText ?? cell.textContent ?? '').trim())
                );

            const rowCount = dataRows.length;
            const columnCount = headers.length > 0
                ? headers.length
                : (dataRows[0] ? dataRows[0].length : 0);

            console.log(`[GlassLinq Content] GET_TABLE_DATA css="${cssSelector}" → ${rowCount} rows × ${columnCount} cols`);

            chrome.runtime.sendMessage({
                action: 'GET_TABLE_DATA_RESPONSE',
                transactionId,
                success: true,
                headers,
                rows: dataRows,
                rowCount,
                columnCount
            });

        } catch (err) {
            console.error('[GlassLinq Content] GET_TABLE_DATA error:', err);
            chrome.runtime.sendMessage({
                action: 'GET_TABLE_DATA_RESPONSE',
                transactionId: message.transactionId,
                success: false,
                error: err.message
            });
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // SCOPE RESOLVER
    //
    // Returns the DOM node to use as the querySelectorAll root.
    //   blank / null  → document (search the whole page)
    //   found node    → that specific container element
    //   no match      → null  (caller reports error)
    // ═══════════════════════════════════════════════════════════════
    function resolveScope(scopeSelector) {
        if (!scopeSelector || scopeSelector.trim() === '') return document;
        const el = document.querySelector(scopeSelector);
        if (!el) console.warn(`[GlassLinq Content] resolveScope: no match for "${scopeSelector}"`);
        return el;
    }

    // ═══════════════════════════════════════════════════════════════
    // RUNTIME — CLICK
    // ═══════════════════════════════════════════════════════════════
    function handleClick(message) {

        console.log('[GlassLinq Content] Executing CLICK:', message);

        try {
            // The unified selector is always in message.selector
            const selector = message.selector;
            if (!selector) {
                sendClickResponse(message, false, 'No selector provided');
                return;
            }

            const mode = message.mode || 'simulate';
            const clickType = message.clickType || 'CLICK_SINGLE';

            const element = resolveElement(selector);

            console.log('[GlassLinq Debug] Resolved:', element.tagName, element.outerHTML.substring(0, 300));

            if (!element) {
                sendClickResponse(message, false,
                    'Element not resolved via Tier 1 (css-selector), Tier 2 (stable attrs), or Tier 3 (tag+aaname/idx)');
                return;
            }

            if (mode === 'hardware') {
                const rect = element.getBoundingClientRect();
                if (rect.width === 0 && rect.height === 0) {
                    sendClickResponse(message, false,
                        'Element has a zero bounding box — it may be hidden or not yet rendered');
                    return;
                }
                const originX = window.screenX + window.scrollX;
                const originY = window.screenY + window.scrollY;
                chrome.runtime.sendMessage({
                    action: 'CLICK_RESPONSE',
                    transactionId: message.transactionId,
                    success: true,
                    screenX: originX + rect.left,
                    screenY: originY + rect.top,
                    width: rect.width,
                    height: rect.height,
                    timestamp: Date.now()
                });
            } else {
                dispatchDomClick(element, clickType);
                sendClickResponse(message, true, null);
            }

        } catch (error) {
            console.error('[GlassLinq Content] CLICK error:', error);
            sendClickResponse(message, false, error.message);
        }

    }

    function sendClickResponse(message, success, reason) {
        const payload = {
            action: 'CLICK_RESPONSE',
            transactionId: message.transactionId,
            success
        };
        if (!success && reason) payload.reason = reason;
        if (success) payload.timestamp = Date.now();
        chrome.runtime.sendMessage(payload);
    }

    // ═══════════════════════════════════════════════════════════════
    // RUNTIME — GET_TEXT
    // ═══════════════════════════════════════════════════════════════
    function handleGetText(message) {
        console.log('[GlassLinq Content] Executing GET_TEXT:', message);

        try {
            const selector = message.selector;
            if (!selector) {
                sendGetTextResponse(message, false, null, 'No selector provided');
                return;
            }

            const element = resolveElement(selector);

            if (!element) {
                sendGetTextResponse(message, false, null, 'Element not found');
                return;
            }

            let text = '';
            if (element.tagName === 'INPUT' && element.value !== undefined && element.value !== null) {
                text = element.value;
            } else if (element.innerText) {
                text = element.innerText.trim();
            } else if (element.textContent) {
                text = element.textContent.trim();
            } else if (element.getAttribute('value')) {
                text = element.getAttribute('value');
            }

            console.log('[GlassLinq Content] Extracted text:', text);
            sendGetTextResponse(message, true, text, null);

        } catch (error) {
            console.error('[GlassLinq Content] GET_TEXT error:', error);
            sendGetTextResponse(message, false, null, error.message || 'Unknown error');
        }
    }

    function sendGetTextResponse(message, success, text, error) {
        const payload = {
            action: 'GET_TEXT_RESPONSE',
            transactionId: message.transactionId,
            success
        };
        if (success) { payload.text = text; payload.timestamp = Date.now(); }
        else { payload.error = error; }
        chrome.runtime.sendMessage(payload);
    }

    // ═══════════════════════════════════════════════════════════════
    // RUNTIME — TYPE_INTO
    // ═══════════════════════════════════════════════════════════════
    function handleTypeInto(message) {
        console.log('[GlassLinq Content] Executing TYPE_INTO:', message);

        try {
            const selector = message.selector;
            if (!selector) {
                sendTypeIntoResponse(message, false, 'No selector provided');
                return;
            }

            const element = resolveElement(selector);

            if (!element) {
                sendTypeIntoResponse(message, false,
                    'Element not found via Tier 1/2/3 resolution pipeline');
                return;
            }

            // Guard: the browser prohibits setting value on <input type="file"> programmatically.
            // If resolution somehow landed on a file input (e.g. structural path collision),
            // report a clear error rather than letting the native setter throw a security exception.
            if (element.tagName === 'INPUT' &&
                (element.getAttribute('type') || '').toLowerCase() === 'file') {
                sendTypeIntoResponse(message, false,
                    'Resolved element is <input type="file"> — programmatic value assignment is ' +
                    'forbidden by the browser. Verify your selector targets the correct text input.');
                return;
            }

            element.focus();

            const prototype = element.tagName === 'TEXTAREA'
                ? window.HTMLTextAreaElement.prototype
                : window.HTMLInputElement.prototype;
            const valueDescriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

            if (!valueDescriptor || !valueDescriptor.set) {
                throw new Error('Target element does not support native value properties.');
            }

            const nativeInputSetter = valueDescriptor.set;

            if (message.emptyField) {
                nativeInputSetter.call(element, '');
                element.dispatchEvent(new Event('input', { bubbles: true }));
            }

            nativeInputSetter.call(element, message.text || '');
            element.dispatchEvent(new Event('input', { bubbles: true }));
            element.dispatchEvent(new Event('change', { bubbles: true }));

            // Trigger MUI / combobox dropdowns
            element.dispatchEvent(new KeyboardEvent('keydown', {
                bubbles: true, cancelable: true, key: 'ArrowDown', keyCode: 40
            }));
            element.dispatchEvent(new KeyboardEvent('keyup', {
                bubbles: true, cancelable: true, key: 'ArrowDown', keyCode: 40
            }));

            sendTypeIntoResponse(message, true, null);

        } catch (error) {
            console.error('[GlassLinq Content] TYPE_INTO error:', error);
            sendTypeIntoResponse(message, false, error.message);
        }
    }

    function sendTypeIntoResponse(message, success, error) {
        const payload = {
            action: 'TYPE_INTO_RESPONSE',
            transactionId: message.transactionId,
            success
        };
        if (success) payload.timestamp = Date.now();
        else payload.error = error;
        chrome.runtime.sendMessage(payload);
    }

    // ═══════════════════════════════════════════════════════════════
    // SYNTHETIC CLICK DISPATCHER
    //
    // Full mousedown → mouseup → click chain so React/Vue/Angular
    // synthetic event systems correctly register the interaction.
    // ═══════════════════════════════════════════════════════════════
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
                element.click();
                if (element.hasAttribute('aria-expanded')) {
                    const details = element.closest('details');
                    if (details) details.open = !details.open;
                }
                break;
        }
    }

    // ═══════════════════════════════════════════════════════════════
    // SHADOW DOM PIERCE
    // ═══════════════════════════════════════════════════════════════
    function querySelectorDeep(cssPath) {
        const parts = cssPath.split('>').map(s => s.trim());
        let contexts = [document];

        for (const part of parts) {
            const next = [];
            for (const ctx of contexts) {
                const found = Array.from(ctx.querySelectorAll ? ctx.querySelectorAll(part) : []);
                next.push(...found);
                const all = Array.from(ctx.querySelectorAll ? ctx.querySelectorAll('*') : []);
                for (const el of all) {
                    if (el.shadowRoot) {
                        next.push(...Array.from(el.shadowRoot.querySelectorAll(part)));
                    }
                }
            }
            contexts = next;
            if (contexts.length === 0) break;
        }
        return contexts;
    }

    // ═══════════════════════════════════════════════════════════════
    // XML SELECTOR PARSER
    // Converts <webctrl attr1='v1' attr2='v2' /> → { attr1:'v1', ... }
    // ═══════════════════════════════════════════════════════════════
    function parseXmlSelector(xmlString) {
        const attributes = {};
        // Match hyphenated attribute names too (e.g. css-selector, aria-label, data-testid)
        const regex = /([\w][\w-]*)=['"]([^'"]*)['"]/g;
        let match;
        while ((match = regex.exec(xmlString)) !== null) {
            attributes[match[1]] = match[2];
        }
        return attributes;
    }

    // ═══════════════════════════════════════════════════════════════
    // XML ESCAPE
    // ═══════════════════════════════════════════════════════════════
    function escapeXml(text) {
        if (!text) return '';
        return String(text)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    // ═══════════════════════════════════════════════════════════════
    // WEB ANCHOR HEURISTIC ENGINE (unchanged from original)
    // ═══════════════════════════════════════════════════════════════
    function findWebAnchor(clickedElement) {
        const targetTag = clickedElement.tagName.toUpperCase();
        if (targetTag !== 'INPUT' && targetTag !== 'TEXTAREA' && targetTag !== 'SELECT') return '';

        // Rule 1: explicit label[for=id]
        if (clickedElement.id) {
            const explicitLabel = document.querySelector(`label[for="${clickedElement.id}"]`);
            if (explicitLabel && explicitLabel.innerText.trim()) {
                const txt = explicitLabel.innerText.trim().replace(/'/g, "\\'");
                return `<webctrl aaname='${txt}' tag='LABEL' check:innerText='${txt}' />`;
            }
        }

        // Rule 2: parent <label> wrapper
        const parentLabel = clickedElement.closest('label');
        if (parentLabel) {
            let text = '';
            parentLabel.childNodes.forEach(node => {
                if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
                else if (node.nodeType === Node.ELEMENT_NODE && node !== clickedElement) text += node.innerText;
            });
            text = text.trim().replace(/'/g, "\\'");
            if (text && text.length < 40) {
                return `<webctrl aaname='${text}' tag='LABEL' check:innerText='${text}' />`;
            }
        }

        // Rule 3: known CSS layout container
        let formContainer = clickedElement.closest(
            '.form-group, .form-field, .input-container, .field-wrapper, .form-floating, .mat-form-field'
        ) || clickedElement.parentElement;

        if (formContainer && formContainer !== document.body && formContainer !== document.documentElement) {
            const internalLabels = formContainer.querySelectorAll('label, div.form-label, span, p');
            for (let label of internalLabels) {
                const txt = label.innerText ? label.innerText.trim() : '';
                if (txt && txt.length > 0 && txt.length < 40 && label !== clickedElement) {
                    const cleanTxt = txt.replace(/'/g, "\\'");
                    return `<webctrl aaname='${cleanTxt}' tag='${label.tagName.toUpperCase()}' check:innerText='${cleanTxt}' />`;
                }
            }
        }

        // Rule 4: geometric proximity
        const candidates = document.querySelectorAll('label, span, th, td, p, div.form-label');
        let closestAnchor = null;
        let minDistance = 250;
        const inputRect = clickedElement.getBoundingClientRect();
        const inputCenter = {
            x: inputRect.left + inputRect.width / 2,
            y: inputRect.top + inputRect.height / 2
        };

        candidates.forEach(candidate => {
            const text = candidate.innerText ? candidate.innerText.trim() : '';
            if (!text || text.length > 40 || candidate.contains(clickedElement)) return;

            const r = candidate.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;

            const deltaX = inputCenter.x - cx;
            const deltaY = inputCenter.y - cy;

            if (deltaY < -15) return;
            if (deltaX < -30) return;

            let distance = Math.hypot(deltaX, deltaY);
            if (deltaX > 0 && Math.abs(deltaY) < 20) distance *= 0.75;

            if (distance < minDistance) {
                minDistance = distance;
                closestAnchor = candidate;
            }
        });

        if (closestAnchor) {
            const txt = closestAnchor.innerText.trim().replace(/'/g, "\\'");
            return `<webctrl aaname='${txt}' tag='${closestAnchor.tagName.toUpperCase()}' check:innerText='${txt}' />`;
        }

        return '';
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