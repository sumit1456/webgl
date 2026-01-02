/**
 * Hybrid Canvas Layout Engine
 * Three rendering modes:
 * 1. CSS Layout Engine (manual layout building) - Original
 * 2. Geometry Snapshot (DOM capture) - NEW
 * 3. PixiJS Renderer (GPU accelerated) - NEW
 * 
 * Choose based on your needs:
 * - Mode 1: Full control, pure programmatic
 * - Mode 2: WYSIWYG, captures real DOM
 * - Mode 3: Best performance, GPU rendering
 */

import React, { useState, useRef, useEffect, useCallback, forwardRef, useImperativeHandle } from "react";
import * as PIXI from 'pixi.js';
import { getGradientWorker, getStyleWorker } from './workerManager';

// ==================== UTILITY FUNCTIONS ====================

function parseSize(value, base = 0) {
    if (typeof value === 'number') return value;
    if (!value) return 0;

    const str = String(value);
    if (str.endsWith('px')) return parseFloat(str);
    if (str.endsWith('%')) return (parseFloat(str) / 100) * base;
    if (str === 'auto') return 0;
    return parseFloat(str) || 0;
}

function parsePadding(padding) {
    if (typeof padding === 'number') {
        return { top: padding, right: padding, bottom: padding, left: padding };
    }
    if (typeof padding === 'object') {
        return {
            top: padding.top || 0,
            right: padding.right || 0,
            bottom: padding.bottom || 0,
            left: padding.left || 0
        };
    }
    return { top: 0, right: 0, bottom: 0, left: 0 };
}

function parseMargin(margin) {
    return parsePadding(margin);
}

// ==================== MODE 2: GEOMETRY SNAPSHOT ENGINE ====================
// Captures DOM layout geometry (positions, styles) without pixel data
// Ultra-lightweight: ~10-50KB vs 50-100MB for image capture

class GeometrySnapshot {
    constructor(options = {}) {
        this.options = {
            mode: 'performance', // 'performance' (fast) or 'deep' (high fidelity)
            useWorkers: !!options.styleWorker, // Auto-enable if workers provided
            ...options
        };
        this.nodes = [];
        this.rootWidth = 0;
        this.rootHeight = 0;

        // Workers for offloading heavy processing
        this.styleWorker = options.styleWorker;
        this.gradientWorker = options.gradientWorker;

        // Promise queues for async worker resolution
        this.stylePromises = [];
        this.gradientPromises = [];
        this.captureStartTime = 0;
    }

    /**
     * Capture DOM geometry recursively
     * Returns: { nodes: [], width: number, height: number }
     */
    async capture(element, overrideOptions = {}) {
        if (!element) return null;

        this.captureStartTime = performance.now();
        const options = { ...this.options, ...overrideOptions };
        this.currentMode = options.mode;
        const useWorkers = options.useWorkers && this.styleWorker;

        // Store original transform
        const originalTransform = element.style.transform;

        // Temporarily remove any transforms that might affect measurement
        const transforms = [];
        let current = element;
        while (current && current !== document.body) {
            const transform = current.style.transform;
            if (transform && transform !== 'none') {
                transforms.push({ element: current, transform });
                current.style.transform = 'none';
            }
            current = current.parentElement;
        }

        const rootRect = element.getBoundingClientRect();
        this.rootRect = rootRect;
        this.rootWidth = Math.ceil(rootRect.width);
        this.rootHeight = Math.ceil(rootRect.height);
        this.nodes = [];
        this.processedNodes = new Set();
        this.stylePromises = [];
        this.gradientPromises = [];

        // START RECURSIVE CAPTURE
        this.captureNode(element);

        // RESTORE TRANSFORMS IMMEDIATELY
        transforms.forEach(({ element, transform }) => {
            element.style.transform = transform;
        });

        // RESOLVE ASYNC TASKS (Workers)
        const workerStartTime = performance.now();

        // 1. Resolve Styles
        if (this.stylePromises.length > 0) {
            console.log(`⏳ Resolving ${this.stylePromises.length} worker style batches...`);
            await Promise.all(this.stylePromises);
        }

        // 2. Resolve Gradients
        if (this.gradientPromises.length > 0) {
            console.log(`⏳ Resolving ${this.gradientPromises.length} gradient tasks...`);
            await Promise.all(this.gradientPromises);
        }

        const totalTime = performance.now() - this.captureStartTime;
        const workerWait = performance.now() - workerStartTime;


        ;


        this.verifyCapture();

        return {
            nodes: this.nodes,
            width: this.rootWidth,
            height: this.rootHeight,
            stats: { nodeCount: this.nodes.length, captureTime: totalTime }
        };
    }

    captureNode(element, batchContext = null, parentClip = null) {
        if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
        if (this.processedNodes.has(element)) return;

        const rect = element.getBoundingClientRect();
        // 🔧 Round to WHOLE pixels to prevent gaps in PDF export
        const x = Math.round(rect.left - this.rootRect.left);
        const y = Math.round(rect.top - this.rootRect.top);
        const width = Math.round(rect.width);
        const height = Math.round(rect.height);

        const computed = window.getComputedStyle(element);

        if (computed.display === 'none' || parseFloat(computed.opacity) === 0) {
            return;
        }

        const type = this.getNodeType(element, computed);

        // Calculate effective clip region
        let currentClip = parentClip;
        if (computed.overflow === 'hidden' || computed.overflow === 'auto') {
            let br = computed.borderRadius || '0px';
            let radius = 0;
            if (br.includes('%')) {
                radius = (Math.min(width, height) * parseFloat(br)) / 100;
            } else {
                radius = parseFloat(br) || 0;
            }

            const myClip = { x, y, width, height, radius };
            if (parentClip) {
                // Intersect parent clip and my clip
                const x1 = Math.max(parentClip.x, myClip.x);
                const y1 = Math.max(parentClip.y, myClip.y);
                const x2 = Math.min(parentClip.x + parentClip.width, myClip.x + myClip.width);
                const y2 = Math.min(parentClip.y + parentClip.height, myClip.y + myClip.height);

                if (x2 > x1 && y2 > y1) {
                    currentClip = { x: x1, y: y1, width: x2 - x1, height: y2 - y1, radius: myClip.radius };
                } else {
                    currentClip = { x: 0, y: 0, width: 0, height: 0, radius: 0 };
                }
            } else {
                currentClip = myClip;
            }
        }

        // Threshold for batching styles
        const useWorkers = this.options.useWorkers && this.styleWorker;
        const isSmallElement = rect.width < 1 && rect.height < 1;

        const nodeData = {
            type,
            x, y, width, height,
            styles: {}, // Will be populated by extractStyles
            zIndex: parseInt(computed.zIndex) || 0,
            href: (element.tagName === 'A') ? element.getAttribute('href') : null,
            tagName: element.tagName,
            clip: parentClip // Store inherited clip
        };

        // Populate styles (Directly or via Worker)
        this.extractStyles(element, computed, nodeData, batchContext);

        if (type === 'text') {
            nodeData.text = element.textContent.trim();
            if (!nodeData.text) return;
            this.markProcessedRecursive(element);
        } else if (type === 'image') {
            nodeData.src = element.src;
            this.processedNodes.add(element);
        } else {
            this.processedNodes.add(element);
        }

        if (type === 'box') {
            const directTextNodes = Array.from(element.childNodes)
                .filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0);

            if (directTextNodes.length > 0) {
                nodeData.text = directTextNodes.map(n => n.textContent).join(' ').trim();
            }
        }

        this.nodes.push(nodeData);

        // Coordination Diagnostic
        if (this.nodes.length < 10 || nodeData.width === 0) {
            console.log(`[GEO-DEBUG] Capture ${nodeData.type} #${this.nodes.length}: ${nodeData.width}x${nodeData.height} at ${x},${y}`);
        }

        if (type !== 'text') {
            let nextBatch = batchContext;
            let ownBatch = null;
            if (useWorkers && !batchContext && element.children.length > 30) {
                ownBatch = { nodes: [], rawStyles: [] };
                nextBatch = ownBatch;
            }

            for (const child of element.children) {
                this.captureNode(child, nextBatch, currentClip);
            }

            if (ownBatch) {
                this.stylePromises.push((async () => {
                    const batch = ownBatch;
                    try {
                        const response = await this.styleWorker.execute('PARSE_STYLES', { rawStylesBatch: batch.rawStyles });
                        if (response && response.processedBatch) {
                            response.processedBatch.forEach((style, i) => {
                                Object.assign(batch.nodes[i].styles, style);
                            });
                        } else {
                            this.processBatchLocally(batch);
                        }
                    } catch (error) {
                        console.error('Style worker execution failed, falling back:', error);
                        this.processBatchLocally(batch);
                    }
                })());
            }
        }
    }

    verifyCapture() {


        // Check for suspicious patterns
        const nodesAtOrigin = this.nodes.filter(n => n.x === 0 && n.y === 0 && n.width > 0 && n.height > 0);
        if (nodesAtOrigin.length > 5) {
            console.warn(`⚠️ WARNING: ${nodesAtOrigin.length} non-empty nodes at (0,0) - likely positioning bug!`);
            console.log('Nodes at origin:', nodesAtOrigin.map(n => ({
                type: n.type,
                text: n.text?.substring(0, 30),
                size: `${n.width}x${n.height}`
            })));
        }

        // Check for overlapping text nodes
        const textNodes = this.nodes.filter(n => n.type === 'text');
        let overlaps = 0;
        for (let i = 0; i < textNodes.length; i++) {
            for (let j = i + 1; j < textNodes.length; j++) {
                const a = textNodes[i];
                const b = textNodes[j];

                // Check if rectangles overlap
                if (a.x < b.x + b.width && a.x + a.width > b.x &&
                    a.y < b.y + b.height && a.y + a.height > b.y) {
                    overlaps++;
                    if (overlaps <= 3) { // Only show first 3
                        console.warn('Overlapping text:', {
                            text1: a.text?.substring(0, 20),
                            pos1: `(${a.x}, ${a.y})`,
                            text2: b.text?.substring(0, 20),
                            pos2: `(${b.x}, ${b.y})`
                        });
                    }
                }
            }
        }

        if (overlaps > 0) {
            console.warn(`⚠️ Found ${overlaps} overlapping text nodes`);
        }

        console.groupEnd();
    }

    /**
     * SMART SNAPSHOT LOGIC
     * returns true if the style difference requires a full DOM capture
     * returns false if we can just update the Pixi object directly (position/scale)
     */
    static shouldReCapture(oldStyle = {}, newStyle = {}) {
        // Properties we can safely ignore (handled by Pixi/Layout engine directly)
        const ignoredProperties = new Set(['x', 'y', 'left', 'top', 'transform', 'opacity', 'zIndex', 'position']);

        const isDifferent = (a, b) => {
            // If one is null/undefined and other isn't (but allow null vs undefined mismatch if both falsy?? No, strict check better)
            if (a === b) return false;

            // Deep compare objects
            if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
                const keysA = Object.keys(a);
                const keysB = Object.keys(b);

                // If specialized keys differ, we need capture
                if (keysA.length !== keysB.length) return true;

                for (const key of keysA) {
                    if (ignoredProperties.has(key)) continue;
                    if (isDifferent(a[key], b[key])) return true;
                }
                return false;
            }

            return true;
        };

        // We compare everything EXCEPT the ignored properties.
        // This implicitly includes width/height, causing a snapshot if they change.
        return isDifferent(oldStyle, newStyle);
    }

    // Recurse into children


    markProcessedRecursive(element) {
        this.processedNodes.add(element);
        for (const child of element.children) {
            this.markProcessedRecursive(child);
        }
    }

    getNodeType(element, computed) {
        if (element.tagName === 'IMG') return 'image';

        const hasVisibleBoxStyle =
            (computed.backgroundColor !== 'rgba(0, 0, 0, 0)' && computed.backgroundColor !== 'transparent') ||
            (computed.backgroundImage && computed.backgroundImage !== 'none') ||
            (parseFloat(computed.borderTopWidth) > 0 && computed.borderTopStyle !== 'none') ||
            (computed.boxShadow && computed.boxShadow !== 'none');

        if (hasVisibleBoxStyle) return 'box';

        const textContent = element.textContent.trim();
        // RICH TEXT FIX: Only treat as text if it's a leaf node with content
        const hasNoElementTypeChildren = Array.from(element.children).every(child =>
            ['BR', 'WBR'].includes(child.tagName)
        );

        const isTextElement = ['SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
            'STRONG', 'EM', 'B', 'I', 'LABEL', 'A', 'LI'].includes(element.tagName);

        if (isTextElement && textContent.length > 0 && hasNoElementTypeChildren) {
            return 'text';
        }

        const hasDirectText = Array.from(element.childNodes).some(
            child => child.nodeType === Node.TEXT_NODE &&
                child.textContent.trim().length > 0
        );

        if (hasDirectText && !element.querySelector('div, section, article, main, aside, header, footer, nav')) {
            return 'text';
        }

        return 'box';
    }

    extractRawStyles(element, computed) {
        return {
            backgroundColor: computed.backgroundColor,
            backgroundImage: computed.backgroundImage,
            borderTopWidth: computed.borderTopWidth,
            borderTopColor: computed.borderTopColor,
            borderTopStyle: computed.borderTopStyle,
            borderRightWidth: computed.borderRightWidth,
            borderRightColor: computed.borderRightColor,
            borderBottomWidth: computed.borderBottomWidth,
            borderBottomColor: computed.borderBottomColor,
            borderLeftWidth: computed.borderLeftWidth,
            borderLeftColor: computed.borderLeftColor,
            borderRadius: computed.borderRadius,
            color: computed.color,
            fontSize: computed.fontSize,
            fontFamily: computed.fontFamily,
            fontWeight: computed.fontWeight,
            fontStyle: computed.fontStyle,
            textAlign: computed.textAlign,
            justifyContent: computed.justifyContent,
            alignItems: computed.alignItems,
            lineHeight: computed.lineHeight,
            letterSpacing: computed.letterSpacing,
            paddingTop: computed.paddingTop,
            paddingRight: computed.paddingRight,
            paddingBottom: computed.paddingBottom,
            paddingLeft: computed.paddingLeft,
            opacity: computed.opacity,
            boxShadow: computed.boxShadow,
            transform: computed.transform,
            zIndex: computed.zIndex,
            overflow: computed.overflow,
            visibility: computed.visibility,
            whiteSpace: computed.whiteSpace,
            wordBreak: computed.wordBreak
        };
    }

    processBatchLocally(batch) {
        if (!batch || !batch.nodes) return;
        batch.nodes.forEach((node, i) => {
            const raw = batch.rawStyles[i];
            Object.assign(node.styles, {
                backgroundColor: raw.backgroundColor,
                backgroundImage: raw.backgroundImage,
                borderWidth: parseFloat(raw.borderTopWidth) || 0,
                borderRightWidth: parseFloat(raw.borderRightWidth) || 0,
                borderBottomWidth: parseFloat(raw.borderBottomWidth) || 0,
                borderLeftWidth: parseFloat(raw.borderLeftWidth) || 0,
                borderColor: raw.borderTopColor,
                borderRightColor: raw.borderRightColor,
                borderBottomColor: raw.borderBottomColor,
                borderLeftColor: raw.borderLeftColor,
                borderStyle: raw.borderTopStyle,
                borderRadius: raw.borderRadius,
                color: raw.color,
                display: raw.display,
                justifyContent: raw.justifyContent,
                alignItems: raw.alignItems,
                fontSize: parseFloat(raw.fontSize) || 12,
                fontFamily: raw.fontFamily,
                fontWeight: raw.fontWeight,
                fontStyle: raw.fontStyle,
                textAlign: raw.textAlign,
                lineHeight: parseFloat(raw.lineHeight) || parseFloat(raw.fontSize) * 1.2,
                padding: {
                    top: parseFloat(raw.paddingTop) || 0,
                    right: parseFloat(raw.paddingRight) || 0,
                    bottom: parseFloat(raw.paddingBottom) || 0,
                    left: parseFloat(raw.paddingLeft) || 0
                },
                boxShadow: raw.boxShadow !== 'none' ? raw.boxShadow : null,
                transform: raw.transform !== 'none' ? raw.transform : null,
                letterSpacing: parseFloat(raw.letterSpacing) || 0,
                whiteSpace: raw.whiteSpace,
                wordBreak: raw.wordBreak
            });

            // Also handle gradient if present
            if (raw.backgroundImage && raw.backgroundImage !== 'none') {
                const gradient = this.parseGradient(raw.backgroundImage);
                if (gradient) node.styles.gradient = gradient;
            }
        });
    }

    extractStyles(element, computed, nodeData, batchContext = null) {
        const styles = nodeData.styles;

        // 1. Direct Style Extraction (Required for Logic or Performance)
        styles.opacity = parseFloat(computed.opacity) || 1;
        styles.zIndex = computed.zIndex !== 'auto' ? parseInt(computed.zIndex) : 0;
        styles.display = computed.display;

        // 2. Complex/Logic-Heavy Styles (Gradients)
        if (computed.backgroundImage && computed.backgroundImage !== 'none') {
            let workerTriggered = false;
            // If we are batching, the style worker will handle the gradient automatically
            if (batchContext) {
                workerTriggered = true; // Optimization: don't parse locally if batching
            } else if (this.gradientWorker && typeof this.gradientWorker.execute === 'function') {
                this.gradientPromises.push((async () => {
                    try {
                        const response = await this.gradientWorker.execute('PARSE_GRADIENT', { backgroundImage: computed.backgroundImage });
                        if (response && response.gradient) {
                            nodeData.styles.gradient = response.gradient;
                        } else {
                            // FALLBACK: Parse locally if worker returns null (fallbackMode)
                            const gradient = this.parseGradient(computed.backgroundImage);
                            if (gradient) nodeData.styles.gradient = gradient;
                        }
                    } catch (error) {
                        console.error('Gradient worker execution failed, falling back:', error);
                        const gradient = this.parseGradient(computed.backgroundImage);
                        if (gradient) nodeData.styles.gradient = gradient;
                    }
                })());
                workerTriggered = true;
            } else if (this.gradientWorker && typeof this.gradientWorker.postMessage === 'function') {
                // Compatibility for standard Worker if provided directly
                this.gradientPromises.push(new Promise(resolve => {
                    this.gradientWorker.postMessage({ type: 'PARSE_GRADIENT', data: { backgroundImage: computed.backgroundImage } });
                    this.gradientWorker.onmessage = (e) => {
                        if (e.data && e.data.gradient) nodeData.styles.gradient = e.data.gradient;
                        resolve();
                    };
                }));
                workerTriggered = true;
            }

            if (!workerTriggered) {
                const gradient = this.parseGradient(computed.backgroundImage);
                if (gradient) styles.gradient = gradient;
            }
        }

        // 3. Batched Style Extraction (Offload to Worker)
        if (batchContext) {
            batchContext.nodes.push(nodeData);
            batchContext.rawStyles.push(this.extractRawStyles(element, computed));
        } else {
            // Direct parsing fallback - RESTORED MISSING PROPERTIES
            Object.assign(styles, {
                backgroundColor: computed.backgroundColor,
                backgroundImage: computed.backgroundImage, // Added for potential reference
                borderWidth: parseFloat(computed.borderTopWidth) || 0,
                borderRightWidth: parseFloat(computed.borderRightWidth) || 0,
                borderBottomWidth: parseFloat(computed.borderBottomWidth) || 0,
                borderLeftWidth: parseFloat(computed.borderLeftWidth) || 0,
                borderColor: computed.borderTopColor || computed.borderColor,
                borderRightColor: computed.borderRightColor,
                borderBottomColor: computed.borderBottomColor,
                borderLeftColor: computed.borderLeftColor,
                borderStyle: computed.borderTopStyle || computed.borderStyle,
                borderRadius: computed.borderRadius, // PASS RAW STRING TO RENDERER FOR ROBUST MATH
                color: computed.color,
                display: computed.display,
                justifyContent: computed.justifyContent,
                alignItems: computed.alignItems,
                fontSize: parseFloat(computed.fontSize) || 12,
                fontFamily: computed.fontFamily,
                fontWeight: computed.fontWeight,
                fontStyle: computed.fontStyle,
                textAlign: computed.textAlign,
                lineHeight: parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) * 1.2,
                padding: {
                    top: parseFloat(computed.paddingTop) || 0,
                    right: parseFloat(computed.paddingRight) || 0,
                    bottom: parseFloat(computed.paddingBottom) || 0,
                    left: parseFloat(computed.paddingLeft) || 0
                },
                boxShadow: computed.boxShadow !== 'none' ? computed.boxShadow : null,
                transform: computed.transform !== 'none' ? computed.transform : null,
                letterSpacing: parseFloat(computed.letterSpacing) || 0,
                whiteSpace: computed.whiteSpace,
                wordBreak: computed.wordBreak,
                backgroundClip: computed.backgroundClip || computed.webkitBackgroundClip,
                webkitTextFillColor: computed.webkitTextFillColor,
                listStyleType: computed.listStyleType
            });
        }
    }

    parseGradient(bgImage) {
        if (!bgImage || bgImage === 'none') return null;

        console.log('================ GRADIENT PARSE START ================');
        console.log('Raw BG Image:', bgImage);

        // Robust layer splitting: match top-level commas
        let layers = [];
        let depth = 0;
        let lastIdx = 0;
        for (let i = 0; i < bgImage.length; i++) {
            if (bgImage[i] === '(') depth++;
            else if (bgImage[i] === ')') depth--;
            else if (bgImage[i] === ',' && depth === 0) {
                layers.push(bgImage.substring(lastIdx, i).trim());
                lastIdx = i + 1;
            }
        }
        layers.push(bgImage.substring(lastIdx).trim());

        const cleanBg = layers[0];
        console.log('Target Layer:', cleanBg);

        let result = null;

        // Match linear or radial gradient, taking everything inside the outermost parentheses
        const linearMatch = cleanBg.match(/linear-gradient\((.*)\)/s);
        const radialMatch = cleanBg.match(/radial-gradient\((.*)\)/s);

        if (linearMatch) {
            // Find the balanced content for linear-gradient
            // Since we split cleanBg already, we can assume the rest is content
            const content = linearMatch[1].trim();
            result = this.parseLinearGradient(content);
        } else if (radialMatch) {
            const content = radialMatch[1].trim();
            result = this.parseRadialGradient(content);
        }

        if (result) {
            console.log('Parsed Result:', JSON.stringify(result, null, 2));
        } else {
            console.warn('Failed to parse gradient string');
        }
        console.log('================ GRADIENT PARSE END ==================');

        return result;
    }

    parseLinearGradient(content) {
        // Robust splitting of linear-gradient parts
        let parts = [];
        let depth = 0;
        let lastIdx = 0;
        for (let i = 0; i < content.length; i++) {
            if (content[i] === '(') depth++;
            else if (content[i] === ')') depth--;
            else if (content[i] === ',' && depth === 0) {
                parts.push(content.substring(lastIdx, i).trim());
                lastIdx = i + 1;
            }
        }
        parts.push(content.substring(lastIdx).trim());

        let angle = 180; // default (to bottom)
        let startIdx = 0;

        const firstPart = parts[0];
        if (firstPart.includes('deg')) {
            angle = parseFloat(parts[0]);
            startIdx = 1;
        } else if (parts[0].includes('to ')) {
            const direction = parts[0].toLowerCase();
            if (direction.includes('right')) angle = 90;
            if (direction.includes('left')) angle = 270;
            if (direction.includes('top')) angle = 0;
            if (direction.includes('bottom')) angle = 180;
            startIdx = 1;
        }

        const stops = this.parseColorStops(parts, startIdx);
        return { type: 'linear', angle, stops };
    }

    parseRadialGradient(content) {
        let parts = [];
        let depth = 0;
        let lastIdx = 0;
        for (let i = 0; i < content.length; i++) {
            if (content[i] === '(') depth++;
            else if (content[i] === ')') depth--;
            else if (content[i] === ',' && depth === 0) {
                parts.push(content.substring(lastIdx, i).trim());
                lastIdx = i + 1;
            }
        }
        parts.push(content.substring(lastIdx).trim());

        // Radial gradients can have a shape/size/position first
        const hasShape = parts[0].includes('circle') || parts[0].includes('ellipse') || parts[0].includes('at ');

        return {
            type: 'radial',
            stops: this.parseColorStops(parts, hasShape ? 1 : 0)
        };
    }

    parseColorStops(parts, startIdx) {
        const stops = [];
        for (let i = startIdx; i < parts.length; i++) {
            const stop = parts[i];
            // Split into color and position (e.g., "#fff 50%")
            // But be careful: color might be rgb(0,0,0)
            const colorMatch = stop.match(/(#[a-fA-F0-0]{3,8}|rgba?\(.*?\)|[a-zA-Z]+)/);
            const percentMatch = stop.match(/(\d+)%/);

            if (colorMatch) {
                const color = colorMatch[0];
                const position = percentMatch ? parseFloat(percentMatch[1]) / 100 :
                    (i - startIdx) / (parts.length - startIdx - 1 || 1);

                stops.push({ color, position });
            }
        }
        return stops;
    }

    compactStyles(styles) {
        const compact = {};

        for (const [key, value] of Object.entries(styles)) {
            if (value === null || value === undefined || value === '' || value === 0) continue;
            if (key === 'backgroundColor' && (value === 'rgba(0, 0, 0, 0)' || value === 'transparent')) continue;
            if (key === 'borderStyle' && value === 'none') continue;

            compact[key] = value;
        }

        return compact;
    }

    estimateSize() {
        const json = JSON.stringify({ nodes: this.nodes, width: this.rootWidth, height: this.rootHeight });
        return Math.round(json.length / 1024 * 10) / 10;
    }

    // Convert to Canvas2D rendering
    renderToCanvas(canvas, scale = 8) {
        const ctx = canvas.getContext('2d');
        canvas.width = this.rootWidth * scale;
        canvas.height = this.rootHeight * scale;
        ctx.scale(scale, scale);

        // Clear
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, this.rootWidth, this.rootHeight);

        // Sort nodes by z-index if available, or maintain original order
        const sortedNodes = [...this.nodes].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

        // Render each node
        for (const node of sortedNodes) {
            this.renderNode(ctx, node);
        }

        return canvas;
    }


    renderNode(ctx, node) {
        const { x, y, width, height, styles, type, text, src } = node;

        ctx.save();

        // 0. GLOBAL OPACITY
        if (styles.opacity !== undefined) {
            ctx.globalAlpha = styles.opacity;
        }

        // 1. SHADOW (Apply to the box/image first)
        if (styles.boxShadow && styles.boxShadow !== 'none') {
            const colorMatch = styles.boxShadow.match(/(rgba?\(.*?\)|#[0-9a-fA-F]{3,8}|[a-zA-Z]+)/);
            if (colorMatch) {
                const shadowColor = colorMatch[0];
                const otherParts = styles.boxShadow.replace(shadowColor, '').trim().split(/\s+/);

                ctx.shadowColor = shadowColor;
                ctx.shadowOffsetX = parseFloat(otherParts[0]) || 0;
                ctx.shadowOffsetY = parseFloat(otherParts[1]) || 0;
                ctx.shadowBlur = parseFloat(otherParts[2]) || 0;
            }
        }

        // Helper to get absolute border radius
        const getRadius = () => {
            let r = styles.borderRadius || 0;
            if (typeof r === 'string' && r.endsWith('%')) {
                return (Math.min(width, height) * parseFloat(r)) / 100;
            }
            return parseFloat(r) || 0;
        };
        const radius = getRadius();


        // 2. BACKGROUND 
        if (styles.backgroundColor && styles.backgroundColor !== 'transparent') {
            ctx.fillStyle = styles.backgroundColor;
            if (radius > 0) {
                this.roundRect(ctx, x, y, width, height, radius);
                ctx.fill();
            } else {
                ctx.fillRect(x, y, width, height);
            }
        }


        // 3. GRADIENT OVERLAY
        if (styles.gradient) {
            let gradient;
            if (styles.gradient.type === 'radial') {
                const centerX = x + width / 2;
                const centerY = y + height / 2;
                const gr = Math.max(width, height) / 2;
                gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, gr);

            } else {
                const angle = styles.gradient.angle !== undefined ? styles.gradient.angle : 180;
                const angleRad = ((angle - 90) * Math.PI) / 180;
                const length = Math.abs(width * Math.cos(angleRad)) + Math.abs(height * Math.sin(angleRad));
                const centerX = x + width / 2;
                const centerY = y + height / 2;
                const x1 = centerX - (Math.cos(angleRad) * length) / 2;
                const y1 = centerY - (Math.sin(angleRad) * length) / 2;
                const x2 = centerX + (Math.cos(angleRad) * length) / 2;
                const y2 = centerY + (Math.sin(angleRad) * length) / 2;
                gradient = ctx.createLinearGradient(x1, y1, x2, y2);
            }

            styles.gradient.stops.forEach(stop => {
                gradient.addColorStop(stop.position, stop.color);
            });

            ctx.fillStyle = gradient;
            if (radius > 0) {
                this.roundRect(ctx, x, y, width, height, radius);
                ctx.fill();
            } else {
                ctx.fillRect(x, y, width, height);
            }

        }

        // 4. IMAGE
        if (type === 'image' && src) {
            // NOTE: This assumes images are preloaded or cached in browser.
            // For a benchmark, the source images already exist on page.
            const img = new Image();
            img.src = src;
            if (img.complete) {
                if (radius > 0) {
                    ctx.save();
                    this.roundRect(ctx, x, y, width, height, radius);
                    ctx.clip();
                    ctx.drawImage(img, x, y, width, height);
                    ctx.restore();
                } else {
                    ctx.drawImage(img, x, y, width, height);
                }

            } else {
                // If not complete, draw a placeholder but start loading
                ctx.fillStyle = '#f3f4f6';
                ctx.fillRect(x, y, width, height);
                img.onload = () => { /* Redraw will happen on next run */ };
            }
        }

        // Reset shadow for subsequent items
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;

        // 5. BORDER
        if (styles.borderWidth > 0 && styles.borderStyle !== 'none') {
            ctx.strokeStyle = styles.borderColor || '#000';
            ctx.lineWidth = styles.borderWidth;

            // Handle dashed/dotted
            if (styles.borderStyle === 'dashed') {
                ctx.setLineDash([styles.borderWidth * 3, styles.borderWidth * 2]);
            } else if (styles.borderStyle === 'dotted') {
                ctx.setLineDash([styles.borderWidth, styles.borderWidth * 2]);
            } else {
                ctx.setLineDash([]);
            }

            if (radius > 0) {
                this.roundRect(ctx, x, y, width, height, radius);
                ctx.stroke();
            } else {
                const strokeOffset = ctx.lineWidth / 2;
                ctx.strokeRect(x + strokeOffset, y + strokeOffset, width - ctx.lineWidth, height - ctx.lineWidth);
            }

            ctx.setLineDash([]); // Reset
        }

        // 6. TEXT (Works for both 'text' type and 'box' type with direct text)
        if (text) {
            ctx.fillStyle = styles.color || '#000';
            ctx.font = `${styles.fontStyle || ''} ${styles.fontWeight || ''} ${styles.fontSize}px ${styles.fontFamily || 'Helvetica'}`;
            ctx.textBaseline = 'top';

            const pLeft = (styles.padding?.left || 0);
            const pTop = (styles.padding?.top || 0);
            const pRight = (styles.padding?.right || 0);
            const mWidth = Math.max(10, width - pLeft - pRight);

            const lines = this.wrapText(ctx, text, mWidth);
            let cY = y + pTop;

            // Adjust vertical centering if it's a box with single line text
            if (type === 'box' && lines.length === 1 && !styles.padding?.top) {
                const tHeight = styles.lineHeight || styles.fontSize * 1.2;
                cY = y + (height - tHeight) / 2;
            }

            lines.forEach(line => {
                let aX = x + pLeft;
                if (styles.textAlign === 'center') {
                    const m = ctx.measureText(line);
                    aX = x + width / 2 - m.width / 2;
                } else if (styles.textAlign === 'right') {
                    const m = ctx.measureText(line);
                    aX = x + width - pRight - m.width;
                }
                ctx.fillText(line, aX, cY);
                cY += (styles.lineHeight || styles.fontSize * 1.2);
            });
        }


        ctx.restore();
    }


    wrapText(ctx, text, maxWidth) {
        const words = text.split(' ');
        const lines = [];
        let currentLine = '';

        words.forEach(word => {
            const testLine = currentLine ? `${currentLine} ${word}` : word;
            const metrics = ctx.measureText(testLine);

            if (metrics.width > maxWidth && currentLine) {
                lines.push(currentLine);
                currentLine = word;
            } else {
                currentLine = testLine;
            }
        });

        if (currentLine) {
            lines.push(currentLine);
        }

        return lines;
    }

    roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }
}



// ==================== MODE 3: PIXI RENDERER (GPU ACCELERATED) ====================

class PixiRendererEngine {
    constructor(container, options = {}) {
        this.container = container;
        this.options = {
            width: options.width || 595,
            height: options.height || 842,
            backgroundColor: options.backgroundColor || 0xffffff,
            resolution: options.resolution || 1,
            antialias: options.antialias ?? true,
            ...options
        };
        this.app = null;
        this.textureCache = new Map();
    }

    async initialize() {
        // Use imported PIXI first, fall back to window.PIXI
        const PIXI_LIB = PIXI || window.PIXI;

        if (!PIXI_LIB) {
            console.error('PixiJS not loaded. Add: <script src="https://cdnjs.cloudflare.com/ajax/libs/pixi.js/7.3.2/pixi.min.js"></script>');
            return false;
        }

        const appOptions = {
            width: this.options.width,
            height: this.options.height,
            backgroundColor: this.options.backgroundColor,
            resolution: this.options.resolution,
            antialias: this.options.antialias,
            autoDensity: true
        };

        try {
            // Support both PIXI v7 and v8
            if (PIXI_LIB.Application.prototype.init) {
                // v8 style
                this.app = new PIXI_LIB.Application();
                await this.app.init(appOptions);
                this.container.appendChild(this.app.canvas);
            } else {
                // v7 style
                this.app = new PIXI_LIB.Application(appOptions);
                this.container.appendChild(this.app.view);
            }

            return true;
        } catch (e) {
            console.error('PixiJS Initialization failed:', e);
            if (!this.container) {
                console.error('CRITICAL: PixiRendererEngine container is null during initialization.');
            }
            return false;
        }
    }

    async render(geometrySnapshot, options = {}) {
        const renderStartTime = performance.now();
        if (!this.app && !options.targetContainer) {
            const initialized = await this.initialize();
            if (!initialized) return null;
        }

        const stage = options.targetContainer || this.app.stage;

        if (!options.targetContainer) {
            stage.removeChildren();
        }

        const PIXI_LIB = PIXI || window.PIXI;
        const mainContainer = new PIXI_LIB.Container();
        stage.addChild(mainContainer);

        // 1. Render Shapes (Background)
        if (options.shapes && options.shapes.length > 0) {
            const shapesContainer = new PIXI_LIB.Container();
            mainContainer.addChild(shapesContainer);
            this.renderShapes(options.shapes, shapesContainer);
        }

        // 2. Render Content
        if (geometrySnapshot && geometrySnapshot.nodes) {
            const contentContainer = new PIXI_LIB.Container();
            mainContainer.addChild(contentContainer);

            const sortedNodes = [...geometrySnapshot.nodes].sort((a, b) => {
                const za = a.styles?.zIndex || 0;
                const zb = b.styles?.zIndex || 0;
                return za - zb;
            });

            console.log(`[RENDER] Starting render of ${sortedNodes.length} nodes...`);
            for (const node of sortedNodes) {
                // Diagnostic for missing pixel art
                if (node.width === 20 && node.height === 20) {
                    // console.log(`[PIXEL-DEBUG] Rendering pixel at ${node.x},${node.y} color: ${node.styles.backgroundColor}`);
                }
                const displayObject = await this.renderNode(node);
                if (displayObject) contentContainer.addChild(displayObject);
            }
        }

        // 3. Render Lines
        if (options.lines && options.lines.length > 0) {
            const linesContainer = new PIXI_LIB.Container();
            mainContainer.addChild(linesContainer);
            this.renderLines(options.lines, linesContainer);
        }

        const renderTime = performance.now() - renderStartTime;

        return mainContainer;
    }

    renderShapes(shapes, container) {
        const PIXI_LIB = PIXI || window.PIXI;
        shapes.forEach(shape => {
            const graphics = new PIXI_LIB.Graphics();
            const colorData = this.parseColor(shape.color || '#cccccc');
            const alpha = colorData.alpha !== undefined ? colorData.alpha : 1;

            if (graphics.fill) {
                graphics.fill({ color: colorData.hex, alpha });
                if (shape.type === 'circle') {
                    graphics.circle(shape.width / 2, shape.height / 2, shape.width / 2);
                } else {
                    // Default to rect
                    graphics.rect(0, 0, shape.width, shape.height);
                }
            } else {
                graphics.beginFill(colorData.hex, alpha);
                if (shape.type === 'circle') {
                    graphics.drawCircle(shape.width / 2, shape.height / 2, shape.width / 2);
                } else {
                    graphics.drawRect(0, 0, shape.width, shape.height);
                }
                graphics.endFill();
            }

            graphics.x = shape.x;
            graphics.y = shape.y;
            console.log(`   └─ Shape: ${shape.type || 'rect'} at (${shape.x}, ${shape.y}) size ${shape.width}x${shape.height} color: ${shape.color}`);
            container.addChild(graphics);
        });
    }

    renderLines(lines, container) {
        const PIXI_LIB = PIXI || window.PIXI;
        lines.forEach(line => {
            const graphics = new PIXI_LIB.Graphics();
            const colorData = this.parseColor(line.color || '#000000');
            const alpha = colorData.alpha !== undefined ? colorData.alpha : 1;

            if (graphics.stroke) {
                graphics.stroke({ color: colorData.hex, width: line.thickness || 1, alpha });
                graphics.moveTo(line.x1, line.y1);
                graphics.lineTo(line.x2, line.y2);
            } else {
                graphics.lineStyle(line.thickness || 1, colorData.hex, alpha);
                graphics.moveTo(line.x1, line.y1);
                graphics.lineTo(line.x2, line.y2);
            }
            console.log(`   └─ Line: (${line.x1}, ${line.y1}) to (${line.x2}, ${line.y2}) color: ${line.color}`);
            container.addChild(graphics);
        });
    }

    async renderNode(node) {

        switch (node.type) {
            case 'box':
                return this.renderBox(node);
            case 'text':
                return this.renderText(node);
            case 'image':
                return await this.renderImage(node);
            case 'video':
                return await this.renderVideo(node);
            default:
                return null;
        }
    }

    // internal helper for consistent radius math
    _calculateRadius(node, styles) {
        let r = styles.borderRadius;
        if (typeof r === 'string' && r.endsWith('%')) {
            return (Math.min(node.width, node.height) * parseFloat(r)) / 100;
        }
        return parseFloat(r) || 0;
    }

    renderBox(node) {
        const PIXI_LIB = PIXI || window.PIXI;
        // Wrap everything in a container for v8 compatibility with shadow ordering
        const wrap = new PIXI_LIB.Container();
        const graphics = new PIXI_LIB.Graphics();
        const { x, y, width, height, styles } = node;

        // Diagnostic log for borders
        if (styles.borderWidth > 0) {
            console.log(`[RENDER-BOX] Border found: ${styles.borderWidth}px ${styles.borderStyle} ${styles.borderColor}`);
        }

        wrap.addChild(graphics);

        // Apply visual properties
        if (styles.opacity !== undefined) wrap.alpha = styles.opacity;

        // 0. CLIP (Parent Overflow)
        if (node.clip) {
            const mask = new PIXI_LIB.Graphics();

            // Let's draw the mask in LOCAL coordinates of the wrap
            const localX = node.clip.x - x;
            const localY = node.clip.y - y;

            if (mask.fill) {
                // v8 style
                mask.beginPath();
                if (node.clip.radius > 0) {
                    mask.roundRect(localX, localY, node.clip.width, node.clip.height, node.clip.radius);
                } else {
                    mask.rect(localX, localY, node.clip.width, node.clip.height);
                }
                mask.fill(0xffffff);
            } else {
                // v7 style fallback
                mask.beginFill(0xffffff);
                if (node.clip.radius > 0) {
                    mask.drawRoundedRect(localX, localY, node.clip.width, node.clip.height, node.clip.radius);
                } else {
                    mask.drawRect(localX, localY, node.clip.width, node.clip.height);
                }
                mask.endFill();
            }

            wrap.addChild(mask);
            wrap.mask = mask;
        }

        // Respect transform
        if (styles.transform && styles.transform !== 'none') {
            this.applyTransform(wrap, styles.transform, x, y, width, height);
        } else {
            wrap.x = x;
            wrap.y = y;
        }

        // DIAGNOSTIC for circles and small items
        const isCircle = styles.borderRadius === '50%' || (parseFloat(styles.borderRadius) > 10);
        if (isCircle && width < 100) {
            console.log(`[CIRCLE-DEBUG] Shape Detected: ${width}x${height}, Type: ${node.type}, Radius: ${styles.borderRadius}`);
        }
        if (width < 30 || height < 30) {
            // Log pixels from grid
            // console.log(`[SMALL-BOX-DEBUG] ${width}x${height} at ${x},${y} color: ${styles.backgroundColor}`);
        }

        // 1. BOX SHADOW
        if (styles.boxShadow && styles.boxShadow !== 'none') {
            this.renderShadow(wrap, styles.boxShadow, width, height, styles.borderRadius);
        }

        // 2. BACKGROUND COLOR
        if (styles.backgroundColor && styles.backgroundColor !== 'transparent') {
            const colorData = this.parseColor(styles.backgroundColor);
            const fillAlpha = (styles.opacity !== undefined ? styles.opacity : 1) * colorData.alpha;

            const radius = this._calculateRadius(node, styles);

            if (graphics.fill) {
                graphics.beginPath();
                graphics.roundRect(0, 0, width, height, radius);
                graphics.fill({ color: colorData.hex, alpha: fillAlpha });
            } else {
                graphics.beginFill(colorData.hex, fillAlpha);
                graphics.drawRoundedRect(0, 0, width, height, radius);
                graphics.endFill();
            }
        }

        // 3. GRADIENT OVERLAY
        if (styles.gradient) {
            const texture = this.createGradientTexture(width, height, styles.gradient);
            if (texture) {
                const sprite = new PIXI_LIB.Sprite(texture);
                sprite.width = width;
                sprite.height = height;

                const radius = this._calculateRadius(node, styles);

                if (styles.backgroundClip === 'text' && node.text) {
                    // MASKED BY TEXT (for gradient text)
                    const textMask = this.renderText(node, true, true); // true, true = local coordinates, isMask
                    if (textMask) {
                        sprite.mask = textMask;
                        wrap.addChild(textMask);
                        wrap.addChild(sprite);
                    }
                } else if (radius > 0) {
                    const mask = new PIXI_LIB.Graphics();
                    if (mask.fill) {
                        mask.beginPath();
                        mask.roundRect(0, 0, width, height, radius);
                        mask.fill(0xffffff);
                    } else {
                        mask.beginFill(0xffffff);
                        mask.drawRoundedRect(0, 0, width, height, radius);
                        mask.endFill();
                    }
                    sprite.mask = mask;
                    wrap.addChild(mask);
                    wrap.addChild(sprite);
                } else {
                    wrap.addChild(sprite); // Add gradient to wrap on top of background
                }
            }
        }

        // 4. BORDER (Trapezoid Logic for multi-side & triangles)
        const btw = styles.borderWidth || 0;
        const brw = styles.borderRightWidth || 0;
        const bbw = styles.borderBottomWidth || 0;
        const blw = styles.borderLeftWidth || 0;

        if ((btw > 0 || brw > 0 || bbw > 0 || blw > 0) && styles.borderStyle !== 'none') {
            const radius = this._calculateRadius(node, styles);
            const borderGraphics = new PIXI_LIB.Graphics();

            // If uniform and simple, use faster draw
            const isUniform = (btw === brw && btw === bbw && btw === blw);

            if (isUniform && radius > 0) {
                const borderColorData = this.parseColor(styles.borderColor || '#000000');
                if (borderGraphics.stroke) {
                    borderGraphics.beginPath();
                    borderGraphics.roundRect(0, 0, width, height, radius);
                    borderGraphics.stroke({ color: borderColorData.hex, width: btw, alignment: 0, alpha: borderColorData.alpha });
                } else {
                    borderGraphics.lineStyle(btw, borderColorData.hex, borderColorData.alpha);
                    borderGraphics.drawRoundedRect(0, 0, width, height, radius);
                }
            } else {
                // Trapezoid implementation for CSS Triangles & mixed borders
                // Top
                if (btw > 0) {
                    const c = this.parseColor(styles.borderColor || '#000000');
                    if (c.alpha > 0) {
                        borderGraphics.beginFill(c.hex, c.alpha);
                        borderGraphics.drawPolygon([0, 0, width, 0, width - brw, btw, blw, btw]);
                        borderGraphics.endFill();
                    }
                }
                // Right
                if (brw > 0) {
                    const c = this.parseColor(styles.borderRightColor || styles.borderColor || '#000000');
                    if (c.alpha > 0) {
                        borderGraphics.beginFill(c.hex, c.alpha);
                        borderGraphics.drawPolygon([width, 0, width, height, width - brw, height - bbw, width - brw, btw]);
                        borderGraphics.endFill();
                    }
                }
                // Bottom
                if (bbw > 0) {
                    const c = this.parseColor(styles.borderBottomColor || styles.borderColor || '#000000');
                    if (c.alpha > 0) {
                        borderGraphics.beginFill(c.hex, c.alpha);
                        borderGraphics.drawPolygon([0, height, width, height, width - brw, height - bbw, blw, height - bbw]);
                        borderGraphics.endFill();
                    }
                }
                // Left
                if (blw > 0) {
                    const c = this.parseColor(styles.borderLeftColor || styles.borderColor || '#000000');
                    if (c.alpha > 0) {
                        borderGraphics.beginFill(c.hex, c.alpha);
                        borderGraphics.drawPolygon([0, 0, 0, height, blw, height - bbw, blw, btw]);
                        borderGraphics.endFill();
                    }
                }
            }
            wrap.addChild(borderGraphics);
        }

        // 5. INTERNAL TEXT (For elements that are both box and text)
        if (node.text && styles.backgroundClip !== 'text') {
            const textSprite = this.renderText(node, true); // true = local coordinates
            if (textSprite) wrap.addChild(textSprite);
        }

        // 6. INTERACTIVITY
        if (node.href) {
            wrap.eventMode = 'static';
            wrap.cursor = 'pointer';
            wrap.on('pointerdown', (e) => {
                e.stopPropagation();
                window.open(node.href, '_blank');
            });
        }

        return wrap;
    }

    createGradientTexture(width, height, gradient) {
        if (!gradient || !gradient.stops || gradient.stops.length === 0) return null;

        const cacheKey = `${width}x${height}_${gradient.type}_${gradient.angle || 0}_${JSON.stringify(gradient.stops)}`;
        if (this.textureCache.has(cacheKey)) return this.textureCache.get(cacheKey);

        console.log('================ TEXTURE GEN START ================');
        console.log(`Size: ${width}x${height}, Type: ${gradient.type}, Angle: ${gradient.angle}`);

        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(width);
        canvas.height = Math.ceil(height);
        const ctx = canvas.getContext('2d');

        let grad;
        if (gradient.type === 'radial') {
            const centerX = width / 2;
            const centerY = height / 2;
            const radius = Math.max(width, height) / 2;
            grad = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
        } else {
            const angle = gradient.angle !== undefined ? gradient.angle : 180;
            const angleRad = ((angle - 90) * Math.PI) / 180;
            const length = Math.abs(width * Math.cos(angleRad)) + Math.abs(height * Math.sin(angleRad));

            const centerX = width / 2;
            const centerY = height / 2;

            const x1 = centerX - (Math.cos(angleRad) * length) / 2;
            const y1 = centerY - (Math.sin(angleRad) * length) / 2;
            const x2 = centerX + (Math.cos(angleRad) * length) / 2;
            const y2 = centerY + (Math.sin(angleRad) * length) / 2;

            grad = ctx.createLinearGradient(x1, y1, x2, y2);
        }

        gradient.stops.forEach(stop => {
            const colorData = this.parseColor(stop.color);
            // Convert hex to rgb string for canvas
            const r = (colorData.hex >> 16) & 255;
            const g = (colorData.hex >> 8) & 255;
            const b = colorData.hex & 255;
            grad.addColorStop(stop.position, `rgba(${r},${g},${b},${colorData.alpha})`);
        });

        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);

        const PIXI_LIB = PIXI || window.PIXI;
        const texture = PIXI_LIB.Texture.from(canvas);
        this.textureCache.set(cacheKey, texture);

        console.log('Texture Generated and Cached');
        console.log('================ TEXTURE GEN END ==================');

        return texture;
    }

    drawDashedBorder(container, node) {
        const { styles, width, height } = node;
        const borderColorData = this.parseColor(styles.borderColor || '#000000');
        const strokeAlpha = borderColorData.alpha;
        const PIXI_LIB = PIXI || window.PIXI;
        const dashGraphics = new PIXI_LIB.Graphics();

        let radius = styles.borderRadius;
        if (typeof radius === 'string' && radius.endsWith('%')) {
            radius = (Math.min(width, height) * parseFloat(radius)) / 100;
        }
        radius = parseFloat(radius) || 0;

        const dashLen = styles.borderStyle === 'dotted' ? Math.max(1, styles.borderWidth * 0.5) : 10;
        const gapLen = styles.borderStyle === 'dotted' ? styles.borderWidth * 2 : 5;

        // Use a path-based dashing approach for complex shapes
        const drawSegmentedPath = (points) => {
            let overflow = 0;
            for (let i = 0; i < points.length - 1; i++) {
                const p1 = points[i];
                const p2 = points[i + 1];
                const dx = p2.x - p1.x;
                const dy = p2.y - p1.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                const nx = dx / dist;
                const ny = dy / dist;

                let pos = overflow;
                while (pos < dist) {
                    const d = Math.min(dashLen, dist - pos);
                    dashGraphics.moveTo(p1.x + nx * pos, p1.y + ny * pos);
                    dashGraphics.lineTo(p1.x + nx * (pos + d), p1.y + ny * (pos + d));
                    pos += dashLen + gapLen;
                }
                overflow = pos - dist;
            }
        };

        // Create a precise set of points for the rounded rectangle
        let points = [];
        if (radius === 0) {
            points = [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }, { x: 0, y: 0 }];
        } else {
            const r = Math.min(radius, width / 2, height / 2);
            const steps = 8; // Points per corner for smooth look

            // Top-Right
            for (let i = 0; i <= steps; i++) {
                const ang = (Math.PI * 1.5) + (Math.PI * 0.5 * (i / steps));
                points.push({ x: width - r + Math.cos(ang) * r, y: r + Math.sin(ang) * r });
            }
            // Bottom-Right
            for (let i = 0; i <= steps; i++) {
                const ang = 0 + (Math.PI * 0.5 * (i / steps));
                points.push({ x: width - r + Math.cos(ang) * r, y: height - r + Math.sin(ang) * r });
            }
            // Bottom-Left
            for (let i = 0; i <= steps; i++) {
                const ang = (Math.PI * 0.5) + (Math.PI * 0.5 * (i / steps));
                points.push({ x: r + Math.cos(ang) * r, y: height - r + Math.sin(ang) * r });
            }
            // Top-Left
            for (let i = 0; i <= steps; i++) {
                const ang = Math.PI + (Math.PI * 0.5 * (i / steps));
                points.push({ x: r + Math.cos(ang) * r, y: r + Math.sin(ang) * r });
            }
            points.push(points[0]); // Close path
        }

        drawSegmentedPath(points);

        if (dashGraphics.stroke) {
            dashGraphics.stroke({ color: borderColorData.hex, width: styles.borderWidth, alpha: strokeAlpha, alignment: 0 });
        } else {
            dashGraphics.lineStyle(styles.borderWidth, borderColorData.hex, strokeAlpha);
        }

        container.addChild(dashGraphics);
    }

    renderShadow(container, shadowStr, width, height, radius) {
        const PIXI_LIB = PIXI || window.PIXI;
        const parts = shadowStr.split(/ (?![^(]*\))/);
        let color = '#000000';
        let ox = undefined, oy = undefined, blur = undefined;

        for (const part of parts) {
            if (part.includes('rgb') || part.startsWith('#')) {
                color = part;
            } else if (part.endsWith('px') || /^\d+$/.test(part)) {
                const val = parseFloat(part);
                if (ox === undefined) ox = val;
                else if (oy === undefined) oy = val;
                else if (blur === undefined) blur = val;
            }
        }

        // Defaults
        ox = ox || 0;
        oy = oy || 0;
        blur = blur || 0;

        const shadowColorData = this.parseColor(color);
        const shadow = new PIXI_LIB.Graphics();

        // Multi-layer for smoothness
        const shadowAlpha = (shadowColorData.alpha || 0.2) / 5; // Lighter layers

        for (let i = 1; i <= 5; i++) {
            const b = (blur / 5) * i;
            if (shadow.fill) {
                shadow.beginPath();
                shadow.roundRect(ox - b, oy - b, width + b * 2, height + b * 2, (radius || 0) + b);
                shadow.fill({ color: shadowColorData.hex, alpha: shadowAlpha });
            } else {
                shadow.beginFill(shadowColorData.hex, shadowAlpha);
                shadow.drawRoundedRect(ox - b, oy - b, width + b * 2, height + b * 2, (radius || 0) + b);
                shadow.endFill();
            }
        }

        // Add at the back of the container
        container.addChildAt(shadow, 0);
    }

    applyTransform(displayObject, transformStr, x, y, width, height) {
        const matrixMatch = transformStr.match(/matrix\(([^)]+)\)/);
        if (matrixMatch) {
            const [a, b, c, d, tx, ty] = matrixMatch[1].split(',').map(v => parseFloat(v));
            displayObject.x = x;
            displayObject.y = y;
            displayObject.scale.x = Math.sqrt(a * a + b * b);
            displayObject.scale.y = Math.sqrt(c * c + d * d);
            displayObject.rotation = Math.atan2(b, a);
        } else {
            displayObject.x = x;
            displayObject.y = y;
        }
    }

    renderText(node, isLocal = false, isMask = false) {
        if (!node || !node.text) return null;
        const PIXI_LIB = PIXI || window.PIXI;
        const { x, y, width, height, text, styles } = node;

        let lineHeight = styles.lineHeight || styles.fontSize * 1.2;
        if (lineHeight < styles.fontSize && lineHeight > 0 && lineHeight < 10) {
            lineHeight = styles.fontSize * lineHeight;
        }

        const textStyleOptions = {
            fontFamily: styles.fontFamily || 'Helvetica',
            fontSize: styles.fontSize || 14,
            fontWeight: styles.fontWeight || 'normal',
            fontStyle: styles.fontStyle || 'normal',
            fill: styles.color || '#000000',
            align: styles.textAlign || 'left',
            lineHeight: lineHeight,
            padding: 5,
            fill: isMask ? 0xffffff : (styles.color || '#000000')
        };

        const paddingLeft = (styles.padding?.left || 0);
        const paddingRight = (styles.padding?.right || 0);
        const paddingTop = (styles.padding?.top || 0);
        const effectiveWidth = Math.max(1, width - paddingLeft - paddingRight);
        const isSingleLine = height < lineHeight * 1.5;

        if (isSingleLine || styles.whiteSpace === 'nowrap') {
            textStyleOptions.wordWrap = false;
        } else {
            textStyleOptions.wordWrap = true;
            textStyleOptions.wordWrapWidth = effectiveWidth + 10;
        }

        let pixiText;
        try {
            pixiText = new PIXI_LIB.Text({ text: text, style: textStyleOptions });
        } catch (e) {
            pixiText = new PIXI_LIB.Text(text, new PIXI_LIB.TextStyle(textStyleOptions));
        }

        // --- LIST BULLETS ---
        if (node.tagName === 'LI' && styles.listStyleType !== 'none') {
            const bullet = new PIXI_LIB.Graphics();
            const bulletColor = this.parseColor(styles.color || '#000000');
            const bulletSize = (styles.fontSize || 14) * 0.25;

            if (bullet.fill) {
                bullet.beginPath();
                bullet.circle(-bulletSize * 3, (lineHeight / 2) - paddingTop, bulletSize);
                bullet.fill({ color: bulletColor.hex, alpha: bulletColor.alpha });
            } else {
                bullet.beginFill(bulletColor.hex, bulletColor.alpha);
                bullet.drawCircle(-bulletSize * 3, (lineHeight / 2) - paddingTop, bulletSize);
                bullet.endFill();
            }
            pixiText.addChild(bullet);
        }

        const align = (styles.textAlign || 'left').toLowerCase();
        const jc = (styles.justifyContent || '').toLowerCase();
        const ai = (styles.alignItems || '').toLowerCase();
        const isFlexCenter = jc.includes('center') || ai.includes('center');

        if (align === 'center' || (isLocal && isFlexCenter)) {
            pixiText.anchor.set(0.5, 0);
            pixiText.x = (isLocal ? 0 : x) + width / 2;
        } else if (align === 'right') {
            pixiText.anchor.set(1, 0);
            pixiText.x = (isLocal ? 0 : x) + width - paddingRight;
        } else {
            pixiText.x = (isLocal ? 0 : x) + paddingLeft;
        }

        // Vertical Centering for boxes or flex items
        if (isSingleLine && (height > lineHeight * 1.1 || isFlexCenter)) {
            pixiText.anchor.y = 0.5;
            pixiText.y = (isLocal ? 0 : y) + height / 2;
        } else {
            pixiText.y = (isLocal ? 0 : y) + paddingTop;
        }

        if (isMask) {
            pixiText.alpha = 1;
            pixiText.style.fill = 0xffffff;
        } else {
            let textColor = styles.color || '#000000';
            // Handle -webkit-text-fill-color for transparency/gradients
            if (styles.webkitTextFillColor && styles.webkitTextFillColor !== 'initial') {
                if (styles.webkitTextFillColor === 'transparent' && styles.backgroundClip === 'text') {
                    // Transparency is required for background-clip: text to show the background
                    textColor = 'rgba(0,0,0,0)';
                } else if (styles.webkitTextFillColor !== 'transparent') {
                    textColor = styles.webkitTextFillColor;
                }
            }

            const colorData = this.parseColor(textColor);
            pixiText.alpha = (styles.opacity !== undefined ? styles.opacity : 1) * (colorData.alpha !== undefined ? colorData.alpha : 1);
            pixiText.style.fill = colorData.hex;
        }

        // --- INTERACTIVITY ---
        if (node.href) {
            pixiText.eventMode = 'static';
            pixiText.cursor = 'pointer';
            pixiText.on('pointerdown', (e) => {
                e.stopPropagation();
                window.open(node.href, '_blank');
            });
        }

        return pixiText;
    }

    async renderImage(node) {
        const PIXI_LIB = PIXI || window.PIXI;
        const { x, y, width, height, src, styles } = node;

        try {
            const texture = PIXI_LIB.Assets ? await PIXI_LIB.Assets.load(src) : await PIXI_LIB.Texture.fromURL(src);
            if (!texture) return null;

            const sprite = new PIXI_LIB.Sprite(texture);

            // --- OBJECT-FIT: COVER LOGIC ---
            const iW = texture.width;
            const iH = texture.height;
            if (iW > 0 && iH > 0) {
                const imageRatio = iW / iH;
                const containerRatio = width / height;

                let finalScale = 1;
                if (containerRatio > imageRatio) {
                    finalScale = width / iW;
                } else {
                    finalScale = height / iH;
                }

                sprite.scale.set(finalScale);
                sprite.x = x + (width - iW * finalScale) / 2;
                sprite.y = y + (height - iH * finalScale) / 2;
            } else {
                sprite.x = x;
                sprite.y = y;
                sprite.width = width;
                sprite.height = height;
            }

            if (styles.opacity !== undefined) sprite.alpha = styles.opacity;

            // Apply clipping mask
            const mask = new PIXI_LIB.Graphics();
            if (mask.rect) {
                mask.beginPath();
                mask.rect(x, y, width, height);
                mask.fill(0xffffff);
            } else {
                mask.beginFill(0xffffff);
                mask.drawRect(x, y, width, height);
                mask.endFill();
            }
            sprite.mask = mask;

            const container = new PIXI_LIB.Container();
            container.addChild(sprite);
            container.addChild(mask);

            return container;
        } catch (error) {
            console.error('Failed to load image:', src);
            return null;
        }
    }

    parseColor(cssColor) {
        if (!cssColor) return { hex: 0xffffff, alpha: 0 };
        cssColor = cssColor.trim().toLowerCase();
        if (cssColor === 'transparent') return { hex: 0xffffff, alpha: 0 };

        // Handle Hex
        if (cssColor.startsWith('#')) {
            let hex = cssColor.slice(1);
            if (hex.length === 3) hex = hex.split('').map(s => s + s).join('');
            if (hex.length === 6) return { hex: parseInt(hex, 16), alpha: 1 };
            if (hex.length === 8) return { hex: parseInt(hex.slice(0, 6), 16), alpha: parseInt(hex.slice(6, 8), 16) / 255 };
        }

        // Handle RGB/RGBA
        if (cssColor.startsWith('rgb')) {
            const match = cssColor.match(/[\d.]+/g);
            if (match && match.length >= 3) {
                const r = Math.min(255, parseInt(match[0]));
                const g = Math.min(255, parseInt(match[1]));
                const b = Math.min(255, parseInt(match[2]));
                const a = match[3] !== undefined ? parseFloat(match[3]) : 1;
                return { hex: (r << 16) | (g << 8) | b, alpha: a };
            }
        }

        // Handle HSL/HSLA
        if (cssColor.startsWith('hsl')) {
            const match = cssColor.match(/[\d.]+/g);
            if (match && match.length >= 3) {
                const h = parseFloat(match[0]) / 360;
                const s = parseFloat(match[1]) / 100;
                const l = parseFloat(match[2]) / 100;
                const a = match[3] !== undefined ? parseFloat(match[3]) : 1;

                // HSL to RGB conversion
                let r, g, b;
                if (s === 0) {
                    r = g = b = l;
                } else {
                    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                    const p = 2 * l - q;
                    const hue2rgb = (p, q, t) => {
                        if (t < 0) t += 1;
                        if (t > 1) t -= 1;
                        if (t < 1 / 6) return p + (q - p) * 6 * t;
                        if (t < 1 / 2) return q;
                        if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                        return p;
                    };
                    r = hue2rgb(p, q, h + 1 / 3);
                    g = hue2rgb(p, q, h);
                    b = hue2rgb(p, q, h - 1 / 3);
                }
                return {
                    hex: (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255),
                    alpha: a
                };
            }
        }

        // Handle Named Colors (Extensive List)
        const namedColors = {
            black: 0x000000, white: 0xffffff, red: 0xff0000, lime: 0x00ff00, blue: 0x0000ff, yellow: 0xffff00, cyan: 0x00ffff, magenta: 0xff00ff,
            silver: 0xc0c0c0, gray: 0x808080, grey: 0x808080, maroon: 0x800000, olive: 0x808000, green: 0x008000, purple: 0x800080, teal: 0x008080, navy: 0x000080,
            orange: 0xffa500, pink: 0xffc0cb, gold: 0xffd700, brown: 0xa52a2a, salmon: 0xfa8072, skyblue: 0x87ceeb, violet: 0xee82ee, tomato: 0xff6347,
            indigo: 0x4b0082, slateblue: 0x6a5acd, royalblue: 0x4169e1, dodgerblue: 0x1e90ff, lightblue: 0xadd8e6, darkblue: 0x00008b,
            forestgreen: 0x228b22, darkgreen: 0x006400, seagreen: 0x2e8b57, lightgreen: 0x90ee90, palegreen: 0x98fb98,
            darkorange: 0xff8c00, coral: 0xff7f50, hotpink: 0xff69b4, deeppink: 0xff1493, fuchsia: 0xff00ff,
            darkgrey: 0xa9a9a9, darkgray: 0xa9a9a9, lightgrey: 0xd3d3d3, lightgray: 0xd3d3d3, gainsboro: 0xdcdcdc, whitesmoke: 0xf5f5f5,
            aliceblue: 0xf0f8ff, azure: 0xf0ffff, beige: 0xf5f5dc, bisque: 0xffe4c4, blanchedalmond: 0xffebcd,
            cornsilk: 0xfff8dc, ivory: 0xfffff0, lavender: 0xe6e6fa, linen: 0xfaf0e6, mintcream: 0xf5fffa, mistyrose: 0xffe4e1,
            oldlace: 0xfdf5e6, seashell: 0xfff5ee, snow: 0xfffafa, floralwhite: 0xfffaf0, ghostwhite: 0xf8f8ff
        };
        const color = namedColors[cssColor.toLowerCase().split(' ')[0]];
        if (color !== undefined) return { hex: color, alpha: 1 };

        return { hex: 0xffffff, alpha: 1 };
    }

    async exportImage() {
        if (!this.app) return null;
        const canvas = this.app.renderer.canvas || this.app.renderer.view;
        return canvas.toDataURL();
    }

    purgeCache() {
        if (this.textureCache) {
            this.textureCache.forEach(texture => {
                try {
                    texture.destroy(true);
                } catch (e) {
                }
            });
            this.textureCache.clear();
        }
    }

    destroyDisplayObject(obj) {
        if (!obj || obj.destroyed) return;

        try {
            // Text textures in Pixi v8 are handled by systems. 
            // We should generally let the object destruction handle its textures 
            // unless we are sure about pooling.
            const isText = (obj.text !== undefined || obj.constructor.name === 'Text' || obj.constructor.name === 'HTMLText' || obj.label !== undefined);

            // In Pixi v8, destroy({ children: true }) is very recursive.
            // We only destroy textures for text nodes we created manually (not cached images).
            obj.destroy({
                children: true,
                texture: isText,
                baseTexture: isText
            });
        } catch (e) {
            // console.warn('[PixiRendererEngine] Error destroying object:', e);
        }
    }

    destroy() {
        this.purgeCache();
        if (this.app) {
            this.app.destroy(true);
            this.app = null;
        }
    }

    /**
     * High-speed position update
     * @param {PIXI.Container} container - The container returned by render()
     * @param {number} x 
     * @param {number} y 
     */
    updatePosition(container, x, y) {
        if (container && container.transform) {
            container.x = x;
            container.y = y;
        }
    }
}

// ==================== MODE 1: ORIGINAL CSS LAYOUT ENGINE ====================
// (All your original code below - keeping it intact)

class LayoutNode {
    constructor(props = {}, children = []) {
        this.props = props;
        this.children = Array.isArray(children) ? children : [];
        this.bounds = null;
        this.intrinsicSize = null;
        this.parent = null;

        this.children.forEach(child => {
            if (child) child.parent = this;
        });
    }

    measure(constraints) {
        throw new Error('measure() must be implemented by subclass');
    }

    layout(bounds) {
        throw new Error('layout() must be implemented by subclass');
    }

    render(engine) {
        throw new Error('render() must be implemented by subclass');
    }

    getContentBox(bounds, padding) {
        const p = parsePadding(padding);
        return {
            x: bounds.x + p.left,
            y: bounds.y + p.top,
            width: bounds.width - p.left - p.right,
            height: bounds.height - p.top - p.bottom
        };
    }

    renderBox(engine) {
        if (!this.bounds) return;

        const { backgroundColor, border, borderRadius = 0 } = this.props;

        if (backgroundColor) {
            engine.ctx.fillStyle = backgroundColor;
            if (borderRadius > 0) {
                this.roundRect(engine.ctx, this.bounds, borderRadius);
                engine.ctx.fill();
            } else {
                engine.ctx.fillRect(this.bounds.x, this.bounds.y, this.bounds.width, this.bounds.height);
            }
        }

        if (border) {
            const [width, style, color] = String(border).split(' ');
            engine.ctx.strokeStyle = color || '#000';
            engine.ctx.lineWidth = parseFloat(width) || 1;

            if (borderRadius > 0) {
                this.roundRect(engine.ctx, this.bounds, borderRadius);
                engine.ctx.stroke();
            } else {
                engine.ctx.strokeRect(this.bounds.x, this.bounds.y, this.bounds.width, this.bounds.height);
            }
        }
    }

    roundRect(ctx, bounds, radius) {
        ctx.beginPath();
        ctx.moveTo(bounds.x + radius, bounds.y);
        ctx.lineTo(bounds.x + bounds.width - radius, bounds.y);
        ctx.arcTo(bounds.x + bounds.width, bounds.y, bounds.x + bounds.width, bounds.y + radius, radius);
        ctx.lineTo(bounds.x + bounds.width, bounds.y + bounds.height - radius);
        ctx.arcTo(bounds.x + bounds.width, bounds.y + bounds.height, bounds.x + bounds.width - radius, bounds.y + bounds.height, radius);
        ctx.lineTo(bounds.x + radius, bounds.y + bounds.height);
        ctx.arcTo(bounds.x, bounds.y + bounds.height, bounds.x, bounds.y + bounds.height - radius, radius);
        ctx.lineTo(bounds.x, bounds.y + radius);
        ctx.arcTo(bounds.x, bounds.y, bounds.x + radius, bounds.y, radius);
        ctx.closePath();
    }
}

class FlexNode extends LayoutNode {
    // Full FlexNode implementation from CanvasEngine
    measure(constraints) {
        const {
            flexDirection = 'row',
            gap = 0,
            padding = 0
        } = this.props;

        const p = parsePadding(padding);
        const isRow = flexDirection === 'row' || flexDirection === 'row-reverse';

        // Measure all children
        const childConstraints = {
            maxWidth: constraints.maxWidth - p.left - p.right,
            maxHeight: constraints.maxHeight - p.top - p.bottom
        };

        const childSizes = this.children.map(child => {
            const size = child.measure(childConstraints);
            child.intrinsicSize = size;
            return size;
        });

        if (childSizes.length === 0) {
            return { width: p.left + p.right, height: p.top + p.bottom };
        }

        const totalGap = gap * (this.children.length - 1);

        if (isRow) {
            const width = childSizes.reduce((sum, s) => sum + s.width, 0) + totalGap + p.left + p.right;
            const height = Math.max(...childSizes.map(s => s.height)) + p.top + p.bottom;
            this.intrinsicSize = { width, height };
            return this.intrinsicSize;
        } else {
            const width = Math.max(...childSizes.map(s => s.width)) + p.left + p.right;
            const height = childSizes.reduce((sum, s) => sum + s.height, 0) + totalGap + p.top + p.bottom;
            this.intrinsicSize = { width, height };
            return this.intrinsicSize;
        }
    }

    layout(bounds) {
        this.bounds = bounds;

        if (this.children.length === 0) return;

        const {
            flexDirection = 'row',
            justifyContent = 'flex-start',
            alignItems = 'stretch',
            gap = 0,
            padding = 0
        } = this.props;

        const contentBox = this.getContentBox(bounds, padding);
        const isRow = flexDirection === 'row' || flexDirection === 'row-reverse';
        const mainAxis = isRow ? 'width' : 'height';
        const crossAxis = isRow ? 'height' : 'width';

        // Calculate flex item sizes
        const sizes = this.calculateFlexSizes(contentBox[mainAxis], mainAxis, gap);

        // Calculate main axis positions
        const positions = this.calculateMainAxisPositions(
            sizes,
            justifyContent,
            contentBox[mainAxis],
            gap
        );

        // Layout each child
        this.children.forEach((child, i) => {
            const mainSize = sizes[i];
            const crossSize = this.calculateCrossSize(child, alignItems, contentBox[crossAxis]);
            const crossPos = this.calculateCrossPosition(child, alignItems, contentBox[crossAxis], crossSize);

            let childBounds;
            if (isRow) {
                childBounds = {
                    x: contentBox.x + positions[i],
                    y: contentBox.y + crossPos,
                    width: mainSize,
                    height: crossSize
                };
            } else {
                childBounds = {
                    x: contentBox.x + crossPos,
                    y: contentBox.y + positions[i],
                    width: crossSize,
                    height: mainSize
                };
            }

            child.layout(childBounds);
        });
    }

    calculateFlexSizes(availableSpace, mainAxis, gap) {
        const totalGap = gap * (this.children.length - 1);
        let remainingSpace = availableSpace - totalGap;

        // Step 1: Calculate base sizes (flex-basis or intrinsic)
        const baseSizes = this.children.map(child => {
            const flexBasis = child.props.flexBasis;
            if (flexBasis && flexBasis !== 'auto') {
                return parseSize(flexBasis, availableSpace);
            }
            return child.intrinsicSize[mainAxis];
        });

        const totalBaseSize = baseSizes.reduce((sum, size) => sum + size, 0);
        remainingSpace -= totalBaseSize;

        // Step 2: Grow or shrink
        const sizes = [...baseSizes];

        if (remainingSpace > 0) {
            // GROW
            const totalGrow = this.children.reduce((sum, child) =>
                sum + (parseFloat(child.props.flexGrow) || 0), 0
            );

            if (totalGrow > 0) {
                this.children.forEach((child, i) => {
                    const flexGrow = parseFloat(child.props.flexGrow) || 0;
                    sizes[i] += (remainingSpace * flexGrow / totalGrow);
                });
            }
        } else if (remainingSpace < 0) {
            // SHRINK
            const totalShrink = this.children.reduce((sum, child) =>
                sum + (parseFloat(child.props.flexShrink) || 1), 0
            );

            if (totalShrink > 0) {
                this.children.forEach((child, i) => {
                    const flexShrink = parseFloat(child.props.flexShrink) || 1;
                    const shrinkAmount = Math.abs(remainingSpace) * flexShrink / totalShrink;
                    sizes[i] = Math.max(0, sizes[i] - shrinkAmount);
                });
            }
        }

        return sizes;
    }

    calculateMainAxisPositions(sizes, justifyContent, availableSpace, gap) {
        const positions = [];
        const totalSize = sizes.reduce((sum, s) => sum + s, 0);
        const totalGap = gap * (sizes.length - 1);
        const freeSpace = availableSpace - totalSize - totalGap;

        let currentPos = 0;

        switch (justifyContent) {
            case 'flex-start':
                currentPos = 0;
                break;
            case 'flex-end':
                currentPos = freeSpace;
                break;
            case 'center':
                currentPos = freeSpace / 2;
                break;
            case 'space-between':
                currentPos = 0;
                break;
            case 'space-around':
                currentPos = freeSpace / (sizes.length * 2);
                break;
            case 'space-evenly':
                currentPos = freeSpace / (sizes.length + 1);
                break;
        }

        sizes.forEach((size, i) => {
            positions.push(currentPos);
            currentPos += size;

            if (i < sizes.length - 1) {
                if (justifyContent === 'space-between' && sizes.length > 1) {
                    currentPos += gap + freeSpace / (sizes.length - 1);
                } else if (justifyContent === 'space-around') {
                    currentPos += gap + freeSpace / sizes.length;
                } else if (justifyContent === 'space-evenly') {
                    currentPos += gap + freeSpace / (sizes.length + 1);
                } else {
                    currentPos += gap;
                }
            }
        });

        return positions;
    }

    calculateCrossSize(child, alignItems, availableCrossSize) {
        const alignSelf = child.props.alignSelf || alignItems;

        if (alignSelf === 'stretch' && !child.props.height && !child.props.width) {
            return availableCrossSize;
        }

        const crossAxis = (this.props.flexDirection === 'row' || this.props.flexDirection === 'row-reverse')
            ? 'height' : 'width';

        return child.intrinsicSize[crossAxis];
    }

    calculateCrossPosition(child, alignItems, availableCrossSize, crossSize) {
        const alignSelf = child.props.alignSelf || alignItems;

        switch (alignSelf) {
            case 'flex-start':
            case 'stretch':
                return 0;
            case 'flex-end':
                return availableCrossSize - crossSize;
            case 'center':
                return (availableCrossSize - crossSize) / 2;
            default:
                return 0;
        }
    }

    render(engine) {
        this.renderBox(engine);
        this.children.forEach(child => child.render(engine));
    }
}

class GridNode extends LayoutNode {
    measure(constraints) {
        const {
            gridTemplateColumns = ['1fr'],
            gridTemplateRows = ['auto'],
            gap = 0,
            columnGap = gap,
            rowGap = gap,
            padding = 0
        } = this.props;

        const p = parsePadding(padding);

        // For auto-sized grids, we need to measure children
        const childConstraints = {
            maxWidth: constraints.maxWidth - p.left - p.right,
            maxHeight: constraints.maxHeight - p.top - p.bottom
        };

        this.children.forEach(child => {
            child.intrinsicSize = child.measure(childConstraints);
        });

        // Estimate size (will be resolved in layout)
        const colCount = gridTemplateColumns.length;
        const rowCount = gridTemplateRows.length;

        const estimatedWidth = constraints.maxWidth ||
            (colCount * 100 + parseSize(columnGap) * (colCount - 1) + p.left + p.right);
        const estimatedHeight = constraints.maxHeight ||
            (rowCount * 50 + parseSize(rowGap) * (rowCount - 1) + p.top + p.bottom);

        this.intrinsicSize = { width: estimatedWidth, height: estimatedHeight };
        return this.intrinsicSize;
    }

    layout(bounds) {
        this.bounds = bounds;

        if (this.children.length === 0) return;

        const {
            gridTemplateColumns = ['1fr'],
            gridTemplateRows = ['auto'],
            gap = 0,
            columnGap = gap,
            rowGap = gap,
            padding = 0
        } = this.props;

        const contentBox = this.getContentBox(bounds, padding);

        // Resolve grid tracks
        const colSizes = this.resolveGridTracks(
            gridTemplateColumns,
            contentBox.width,
            parseSize(columnGap),
            'width'
        );

        const rowSizes = this.resolveGridTracks(
            gridTemplateRows,
            contentBox.height,
            parseSize(rowGap),
            'height'
        );

        // Calculate grid line positions
        const colPositions = this.calculateGridLinePositions(colSizes, parseSize(columnGap));
        const rowPositions = this.calculateGridLinePositions(rowSizes, parseSize(rowGap));

        // Layout each child
        this.children.forEach((child, i) => {
            const placement = this.getGridPlacement(child, i, gridTemplateColumns.length);

            const childBounds = {
                x: contentBox.x + colPositions[placement.colStart],
                y: contentBox.y + rowPositions[placement.rowStart],
                width: colPositions[placement.colEnd] - colPositions[placement.colStart],
                height: rowPositions[placement.rowEnd] - rowPositions[placement.rowStart]
            };

            child.layout(childBounds);
        });
    }

    resolveGridTracks(tracks, availableSpace, gap, axis) {
        const sizes = [];
        let usedSpace = 0;
        const totalGap = gap * (tracks.length - 1);

        // Step 1: Calculate fixed and auto tracks
        const frTracks = [];

        tracks.forEach((track, i) => {
            if (String(track).endsWith('fr')) {
                frTracks.push({ index: i, value: parseFloat(track) });
                sizes[i] = 0;
            } else if (track === 'auto') {
                // Calculate auto size based on content
                const autoSize = this.calculateAutoTrackSize(i, axis);
                sizes[i] = autoSize;
                usedSpace += autoSize;
            } else {
                // Fixed size
                const size = parseSize(track, availableSpace);
                sizes[i] = size;
                usedSpace += size;
            }
        });

        // Step 2: Distribute remaining space to fr tracks
        const remaining = availableSpace - usedSpace - totalGap;
        const totalFr = frTracks.reduce((sum, t) => sum + t.value, 0);

        if (totalFr > 0 && remaining > 0) {
            const frUnit = remaining / totalFr;
            frTracks.forEach(({ index, value }) => {
                sizes[index] = frUnit * value;
            });
        }

        return sizes;
    }

    calculateAutoTrackSize(trackIndex, axis) {
        // Find all children in this track and get max size
        const { gridTemplateColumns = ['1fr'] } = this.props;
        const colCount = gridTemplateColumns.length;

        let maxSize = 0;

        this.children.forEach((child, i) => {
            const placement = this.getGridPlacement(child, i, colCount);
            const isInTrack = axis === 'width'
                ? (placement.colStart === trackIndex)
                : (placement.rowStart === trackIndex);

            if (isInTrack && child.intrinsicSize) {
                maxSize = Math.max(maxSize, child.intrinsicSize[axis]);
            }
        });

        return maxSize || 50; // Default size
    }

    calculateGridLinePositions(sizes, gap) {
        const positions = [0];
        let current = 0;

        sizes.forEach((size, i) => {
            current += size;
            positions.push(current);
            if (i < sizes.length - 1) {
                current += gap;
            }
        });

        return positions;
    }

    getGridPlacement(child, index, colCount) {
        // Check for explicit grid-area or grid-column/row
        if (child.props.gridArea) {
            return this.parseGridArea(child.props.gridArea);
        }

        if (child.props.gridColumn || child.props.gridRow) {
            return {
                colStart: this.parseGridLine(child.props.gridColumn, true) - 1,
                colEnd: this.parseGridLine(child.props.gridColumn, false),
                rowStart: this.parseGridLine(child.props.gridRow, true) - 1,
                rowEnd: this.parseGridLine(child.props.gridRow, false)
            };
        }

        // Auto-placement
        const row = Math.floor(index / colCount);
        const col = index % colCount;

        return {
            colStart: col,
            colEnd: col + 1,
            rowStart: row,
            rowEnd: row + 1
        };
    }

    parseGridArea(area) {
        // Format: "rowStart / colStart / rowEnd / colEnd"
        // or "row / col" (spans 1)
        const parts = String(area).split('/').map(s => s.trim());

        if (parts.length === 4) {
            return {
                rowStart: parseInt(parts[0]) - 1,
                colStart: parseInt(parts[1]) - 1,
                rowEnd: parseInt(parts[2]),
                colEnd: parseInt(parts[3])
            };
        } else if (parts.length === 2) {
            return {
                rowStart: parseInt(parts[0]) - 1,
                colStart: parseInt(parts[1]) - 1,
                rowEnd: parseInt(parts[0]),
                colEnd: parseInt(parts[1])
            };
        }

        return { colStart: 0, colEnd: 1, rowStart: 0, rowEnd: 1 };
    }

    parseGridLine(value, isStart) {
        if (!value) return isStart ? 1 : 2;

        const parts = String(value).split('/').map(s => s.trim());
        return parseInt(isStart ? parts[0] : (parts[1] || parts[0])) || (isStart ? 1 : 2);
    }

    render(engine) {
        this.renderBox(engine);

        // Debug: Draw grid lines
        if (engine.debug) {
            this.drawGridLines(engine);
        }

        this.children.forEach(child => child.render(engine));
    }

    drawGridLines(engine) {
        // Not implemented yet - would draw grid visualization
    }
}
class TextNode extends LayoutNode { constructor(content, props = {}) { super(props, []); this.content = content; } measure(constraints) { const { font = '16px Arial', maxWidth = constraints.maxWidth, lineHeight } = this.props; const canvas = document.createElement('canvas'); const ctx = canvas.getContext('2d'); ctx.font = font; const fontSize = parseInt(font) || 16; const lh = lineHeight || fontSize * 1.2; if (maxWidth === Infinity || !maxWidth) { const metrics = ctx.measureText(this.content); this.intrinsicSize = { width: metrics.width, height: lh }; } else { const lines = this.wrapText(ctx, this.content, maxWidth); this.intrinsicSize = { width: maxWidth, height: lines.length * lh }; } return this.intrinsicSize; } wrapText(ctx, text, maxWidth) { const words = text.split(' '); const lines = []; let currentLine = ''; words.forEach(word => { const testLine = currentLine ? `${currentLine} ${word}` : word; const metrics = ctx.measureText(testLine); if (metrics.width > maxWidth && currentLine) { lines.push(currentLine); currentLine = word; } else { currentLine = testLine; } }); if (currentLine) lines.push(currentLine); return lines; } layout(bounds) { this.bounds = bounds; } render(engine) { if (!this.bounds) return; const { font = '16px Arial', color = '#000000', textAlign = 'left', lineHeight } = this.props; const ctx = engine.ctx; ctx.font = font; ctx.fillStyle = color; ctx.textBaseline = 'top'; const fontSize = parseInt(font) || 16; const lh = lineHeight || fontSize * 1.2; const lines = this.wrapText(ctx, this.content, this.bounds.width); lines.forEach((line, i) => { let x = this.bounds.x; const y = this.bounds.y + (i * lh); if (textAlign === 'center') { const metrics = ctx.measureText(line); x = this.bounds.x + (this.bounds.width - metrics.width) / 2; } else if (textAlign === 'right') { const metrics = ctx.measureText(line); x = this.bounds.x + this.bounds.width - metrics.width; } ctx.fillText(line, x, y); }); } }
class BlockNode extends LayoutNode {
    measure(constraints) {
        const { width, height, padding = 0, margin = 0 } = this.props;
        const p = parsePadding(padding);
        const m = parseMargin(margin);

        // If explicit size provided
        if (width && height) {
            return {
                width: parseSize(width, constraints.maxWidth) + m.left + m.right,
                height: parseSize(height, constraints.maxHeight) + m.top + m.bottom
            };
        }

        // Otherwise measure children
        const childConstraints = {
            maxWidth: width ? parseSize(width, constraints.maxWidth) - p.left - p.right :
                constraints.maxWidth - p.left - p.right - m.left - m.right,
            maxHeight: height ? parseSize(height, constraints.maxHeight) - p.top - p.bottom :
                constraints.maxHeight - p.top - p.bottom - m.top - m.bottom
        };

        if (this.children.length === 0) {
            return {
                width: (width ? parseSize(width, constraints.maxWidth) : 0) + p.left + p.right + m.left + m.right,
                height: (height ? parseSize(height, constraints.maxHeight) : 0) + p.top + p.bottom + m.top + m.bottom
            };
        }

        const childSizes = this.children.map(child => {
            const size = child.measure(childConstraints);
            child.intrinsicSize = size;
            return size;
        });

        const contentWidth = Math.max(...childSizes.map(s => s.width));
        const contentHeight = childSizes.reduce((sum, s) => sum + s.height, 0);

        this.intrinsicSize = {
            width: (width ? parseSize(width, constraints.maxWidth) : contentWidth) + p.left + p.right + m.left + m.right,
            height: (height ? parseSize(height, constraints.maxHeight) : contentHeight) + p.top + p.bottom + m.top + m.bottom
        };

        return this.intrinsicSize;
    }

    layout(bounds) {
        const { position = 'relative', top, left, padding = 0, margin = 0 } = this.props;
        const m = parseMargin(margin);

        // Apply margin
        this.bounds = {
            x: bounds.x + m.left,
            y: bounds.y + m.top,
            width: bounds.width - m.left - m.right,
            height: bounds.height - m.top - m.bottom
        };

        if (position === 'absolute') {
            // Position absolutely within parent
            const x = left !== undefined ? bounds.x + parseSize(left, bounds.width) : this.bounds.x;
            const y = top !== undefined ? bounds.y + parseSize(top, bounds.height) : this.bounds.y;

            this.bounds = { ...this.bounds, x, y };
        }

        // Layout children within content box
        const contentBox = this.getContentBox(this.bounds, padding);

        let currentY = contentBox.y;
        this.children.forEach(child => {
            const childHeight = child.intrinsicSize?.height || 0;
            child.layout({
                x: contentBox.x,
                y: currentY,
                width: contentBox.width,
                height: childHeight
            });
            currentY += childHeight;
        });
    }

    render(engine) {
        this.renderBox(engine);
        this.children.forEach(child => child.render(engine));
    }
}

class ImageNode extends LayoutNode {
    constructor(src, props = {}) {
        super(props, []);
        this.src = src;
        this.image = null;
        this.loaded = false;

        if (typeof src === 'string') {
            this.image = new Image();
            this.image.onload = () => { this.loaded = true; };
            this.image.src = src;
        } else if (src instanceof Image) {
            this.image = src;
            this.loaded = src.complete;
        }
    }

    measure(constraints) {
        const { width, height, objectFit = 'contain' } = this.props;

        if (width && height) {
            this.intrinsicSize = {
                width: parseSize(width, constraints.maxWidth),
                height: parseSize(height, constraints.maxHeight)
            };
        } else if (this.loaded && this.image) {
            const aspectRatio = this.image.width / this.image.height;

            if (width) {
                const w = parseSize(width, constraints.maxWidth);
                this.intrinsicSize = { width: w, height: w / aspectRatio };
            } else if (height) {
                const h = parseSize(height, constraints.maxHeight);
                this.intrinsicSize = { width: h * aspectRatio, height: h };
            } else {
                this.intrinsicSize = {
                    width: Math.min(this.image.width, constraints.maxWidth),
                    height: Math.min(this.image.height, constraints.maxHeight)
                };
            }
        } else {
            this.intrinsicSize = { width: 100, height: 100 };
        }

        return this.intrinsicSize;
    }

    layout(bounds) {
        this.bounds = bounds;
    }

    render(engine) {
        if (!this.loaded || !this.image || !this.bounds) return;

        const { objectFit = 'contain', borderRadius = 0 } = this.props;

        const ctx = engine.ctx;

        // Calculate image dimensions based on objectFit
        let sx = 0, sy = 0, sw = this.image.width, sh = this.image.height;
        let dx = this.bounds.x, dy = this.bounds.y, dw = this.bounds.width, dh = this.bounds.height;

        if (objectFit === 'cover') {
            const scale = Math.max(dw / sw, dh / sh);
            const scaledWidth = sw * scale;
            const scaledHeight = sh * scale;
            sx = (scaledWidth - dw) / (2 * scale);
            sy = (scaledHeight - dh) / (2 * scale);
            sw = dw / scale;
            sh = dh / scale;
        } else if (objectFit === 'contain') {
            const scale = Math.min(dw / sw, dh / sh);
            dw = sw * scale;
            dh = sh * scale;
            dx = this.bounds.x + (this.bounds.width - dw) / 2;
            dy = this.bounds.y + (this.bounds.height - dh) / 2;
        }

        // Clip if borderRadius
        if (borderRadius > 0) {
            ctx.save();
            this.roundRect(ctx, { x: dx, y: dy, width: dw, height: dh }, borderRadius);
            ctx.clip();
        }

        ctx.drawImage(this.image, sx, sy, sw, sh, dx, dy, dw, dh);

        if (borderRadius > 0) {
            ctx.restore();
        }
    }
}

class SpacerNode extends LayoutNode {
    constructor(size, props = {}) {
        super(props, []);
        this.size = size;
    }

    measure(constraints) {
        this.intrinsicSize = {
            width: parseSize(this.size, constraints.maxWidth),
            height: parseSize(this.size, constraints.maxHeight)
        };
        return this.intrinsicSize;
    }

    layout(bounds) {
        this.bounds = bounds;
    }

    render(engine) {
        // Spacers don't render anything
    }
}


class CanvasLayoutEngine {
    constructor(canvas, config = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.config = config;
        this.scale = config.scale || 1;
        this.debug = config.debug || false;

        // Cache for performance
        this.measureCache = new Map();
    }

    initialize(width, height) {
        this.canvas.width = width * this.scale;
        this.canvas.height = height * this.scale;
        this.ctx.scale(this.scale, this.scale);
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';

        // Clear canvas
        this.ctx.clearRect(0, 0, width, height);

        if (this.debug) {
            this.drawDebugGrid(width, height);
        }
    }

    renderLayoutTree(rootNode, bounds) {
        // Phase 1: Measure
        rootNode.layout(bounds);

        // Phase 3: Render
        rootNode.render(this);
    }

    drawDebugGrid(width, height) {
        this.ctx.strokeStyle = 'rgba(200, 200, 200, 0.3)';
        this.ctx.lineWidth = 0.5;

        for (let x = 0; x < width; x += 50) {
            this.ctx.beginPath();
            this.ctx.moveTo(x, 0);
            this.ctx.lineTo(x, height);
            this.ctx.stroke();
        }

        for (let y = 0; y < height; y += 50) {
            this.ctx.beginPath();
            this.ctx.moveTo(0, y);
            this.ctx.lineTo(width, y);
            this.ctx.stroke();
        }
    }

    toDataURL(type = 'image/png', quality = 1.0) {
        return this.canvas.toDataURL(type, quality);
    }

    toImage() {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = this.toDataURL();
        });
    }

    download(filename = 'layout') {
        const link = document.createElement('a');
        link.download = `${filename}.png`;
        link.href = this.toDataURL();
        link.click();
    }
}

// ==================== CONFIG PARSER ====================

function parseConfigToLayout(config, data) {
    const { display = 'block', children = [], ...props } = config;

    const childNodes = children.map(child => {
        if (typeof child === 'string') {
            return new TextNode(child, props);
        } else if (child.type === 'text') {
            return new TextNode(child.content, child.props || {});
        } else if (child.type === 'image') {
            return new ImageNode(child.src, child.props || {});
        } else if (child.type === 'spacer') {
            return new SpacerNode(child.size, child.props || {});
        } else {
            return parseConfigToLayout(child, data);
        }
    });

    // Create appropriate node based on display
    if (display === 'flex') {
        return new FlexNode(props, childNodes);
    } else if (display === 'grid') {
        return new GridNode(props, childNodes);
    } else {
        return new BlockNode(props, childNodes);
    }
}



// ==================== REACT COMPONENT: WEBGL STAGE ====================

const WebGLStage = forwardRef(({
    width = 595,
    height = 842,
    shapes = [],
    lines = [],
    sections = [],
    snapshot = null,
    onDragEnd = () => { },
    onSelect = () => { },
    selectedId = null,
    resolution = 3,
    background = 0xffffff,
    physicsEnabled = false,
    physicsManagerRef = null, // 🚀 Changed to Ref
    yOffset = 0,
    onHeaderContainerReady = null,
    onSkillsContainerReady = null,
    onDragStart = () => { },
    isMagneticEnabled = false, // 🚀 NEW: Magnetic Flow Toggle
    className = "",
    style = {},
    stageScale = 1
}, ref) => {
    const containerRef = useRef(null);
    const fallbackCanvasRef = useRef(null); // 🚀 NEW: Fallback Ref
    const pixiApp = useRef(null);
    const layers = useRef({ background: null, shapes: null, sections: null, lines: null });
    const sharedRenderer = useRef(null);
    const [initialized, setInitialized] = useState(false);
    const [useFallback, setUseFallback] = useState(false); // 🚀 NEW: Fallback state
    const isMobile = typeof window !== 'undefined' && window.innerWidth < 768;

    const physicsEnabledRef = useRef(physicsEnabled);
    const isMagneticEnabledRef = useRef(isMagneticEnabled); // 🚀 NEW
    const yOffsetRef = useRef(yOffset); // 🚀 NEW

    useEffect(() => {
        physicsEnabledRef.current = physicsEnabled;
        isMagneticEnabledRef.current = isMagneticEnabled;
        yOffsetRef.current = yOffset;
    }, [physicsEnabled, isMagneticEnabled, yOffset]);

    const dragSession = useRef({
        active: false,
        type: null,
        id: null,
        target: null,
        startX: 0,
        startY: 0,
        dragStartX: 0,
        dragStartY: 0,
        wasDragging: false,
        initialPositions: {} // 🚀 NEW: Captured at start of drag
    });

    // --- PIXI INITIALIZATION ---
    useEffect(() => {
        let isMounted = true;
        const startTime = performance.now();

        const initPixi = async () => {
            if (!containerRef.current || !isMounted) return;

            const PIXI_LIB = PIXI || window.PIXI;

            // Check if PIXI is available
            if (!PIXI_LIB) {
                console.error("[WebGLStage] PIXI not found, falling back to Canvas");
                setUseFallback(true);
                return;
            }

            const app = new PIXI_LIB.Application();

            try {
                // Calculate optimal resolution for mobile
                const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
                const mobileResolution = Math.max(pixelRatio, 2); // Ensure at least 2x on mobile for sharpness

                const initOptions = {
                    width: Math.max(1, width),
                    height: Math.max(1, height),
                    background,
                    resolution: isMobile ? Math.min(mobileResolution, 2) : resolution,
                    antialias: true,
                    roundPixels: true, // 🔧 Fix mobile export artifacts
                    preference: 'webgl',
                    autoDensity: true
                };

                try {
                    await app.init(initOptions);
                } catch (firstTryErr) {
                    console.warn("[WebGLStage] Primary init failed, retrying with safe settings...", firstTryErr);
                    // Fallback to minimal settings for old/low-power mobile devices
                    try {
                        await app.init({
                            ...initOptions,
                            resolution: 1,
                            antialias: false,
                            preference: 'canvas' // Try canvas preference in pixi if webgl fails
                        });
                    } catch (secondTryErr) {
                        console.error("[WebGLStage] PixiJS init completely failed:", secondTryErr);
                        setUseFallback(true); // 🚨 COMPLETE FAIL -> TRIGGER FALLBACK
                        return;
                    }
                }

                if (!isMounted) {
                    app.destroy(true, { children: true, texture: true });
                    return;
                }

                pixiApp.current = app;
                containerRef.current.innerHTML = '';
                containerRef.current.appendChild(app.canvas || app.view);

                // Initialize Layers
                layers.current.background = new PIXI_LIB.Container();
                layers.current.shapes = new PIXI_LIB.Container();
                layers.current.sections = new PIXI_LIB.Container();
                layers.current.sections.sortableChildren = true;
                layers.current.lines = new PIXI_LIB.Container();

                app.stage.addChild(layers.current.background);
                app.stage.addChild(layers.current.shapes);
                app.stage.addChild(layers.current.sections);
                app.stage.addChild(layers.current.lines);

                // Apply Stage Scaling
                if (stageScale !== 1) {
                    app.stage.scale.set(stageScale);
                }

                // ✂️ CLIPPING: Strictly mask the stage to page dimensions
                // Mask needs to be in logical coordinates if it's a child of stage? 
                // No, mask is usually applied in global space or local space of the object.
                // Here we want to mask the VIEWPORT size.
                const mask = new PIXI_LIB.Graphics();
                mask.rect(0, 0, width / stageScale, height / stageScale).fill(0xffffff);
                app.stage.mask = mask;
                app.stage.addChild(mask);

                // Setup Interaction
                app.stage.interactive = true;
                // Hit area should be the unscaled logical size to cover the whole content
                app.stage.hitArea = new PIXI_LIB.Rectangle(0, 0, width / stageScale, height / stageScale);

                bindEvents(app);

                // FIX: Ensure stage event mode is set for v7/v8 compatibility
                app.stage.eventMode = 'static';
                app.stage.hitArea = app.screen;

                const duration = performance.now() - startTime;
                console.log(`[WebGLStage] Init complete in ${duration.toFixed(2)}ms`);
                setInitialized(true);

            } catch (err) {
                console.error("[WebGLStage] Init failed:", err);
            }
        };

        const bindEvents = (app) => {
            app.stage.on('pointermove', (e) => {
                const session = dragSession.current;
                if (!session.active || !session.target || session.target.destroyed) return;

                const newPos = e.data.global;
                const deltaX = newPos.x - session.dragStartX;
                const deltaY = newPos.y - session.dragStartY;

                const targetX = session.startX + deltaX;
                const targetY = session.startY + deltaY;
                if (physicsEnabledRef.current && session.type === 'section' && physicsManagerRef?.current) {
                    // 🚀 Real-time Physics Pushing (Matter.js)
                    const manager = physicsManagerRef.current;
                    manager.updateDragging(session.id, targetX, targetY + yOffsetRef.current);

                    const positions = manager.getPositions();

                    layers.current.sections.children.forEach(c => {
                        if (c._id && positions[c._id]) {
                            c.x = positions[c._id].x;
                            c.y = positions[c._id].y - yOffsetRef.current;
                        }
                    });
                } else if (isMagneticEnabledRef.current && session.type === 'section') {
                    // 🚀 NEW: Magnetic Flow (Cascaded Vertical Shift)
                    // 1. Update the dragged element
                    session.target.x = targetX;
                    session.target.y = targetY;

                    // 2. Shift all sections below it that are in the same column
                    const deltaY = targetY - session.startY;
                    const draggedInitialY = session.startY;
                    const draggedInitialX = session.startX;
                    // We need a width for the dragged section to check overlap
                    const draggedWidth = session.width || session.target.getBounds?.().width || 575;

                    layers.current.sections.children.forEach(c => {
                        if (c._id && c._id !== session.id) {
                            const initialPos = session.initialPositions[c._id];
                            if (!initialPos) return;

                            // Condition 1: Section started BELOW the dragged one
                            // Condition 2: Section is in the SAME column (X overlap)
                            const isBelow = initialPos.y > draggedInitialY;

                            // Simple X overlap check
                            const sectionWidth = initialPos.width || c.getBounds?.().width || 575;
                            const hasXOverlap = (initialPos.x < draggedInitialX + draggedWidth) &&
                                (initialPos.x + sectionWidth > draggedInitialX);

                            if (isBelow && hasXOverlap) {
                                // 🎯 Refined: Snap to Column + Cascaded Shift
                                c.x = targetX; // Matches X alignment
                                c.y = initialPos.y + deltaY;
                            } else {
                                // 🎯 Restore initial relative positions if not in the flow
                                c.x = initialPos.x;
                                c.y = initialPos.y;
                            }
                        }
                    });
                } else {
                    session.target.x = targetX;
                    session.target.y = targetY;
                }
            });

            const endDrag = () => {
                const session = dragSession.current;
                if (!session.active) return;

                if (session.target && !session.target.destroyed) {
                    const finalX = Math.round(session.target.x);
                    const finalY = Math.round(session.target.y);

                    // Batch positions for all sections if physics was moving them
                    const allPositions = {};
                    if (session.type === 'section' && layers.current.sections) {
                        layers.current.sections.children.forEach(c => {
                            if (c._id) allPositions[c._id] = { x: Math.round(c.x), y: Math.round(c.y) };
                        });
                    }

                    onDragEnd(session.type, session.id, { x: finalX, y: finalY }, allPositions);
                }
                session.active = false;
                session.target = null;

                // 🛡️ Prevent immediate de-selection on touch release
                session.wasDragging = true;
                setTimeout(() => {
                    if (dragSession.current) dragSession.current.wasDragging = false;
                }, 150);
            };

            app.stage.on('pointerup', endDrag);
            app.stage.on('pointerupoutside', endDrag);
            app.stage.on('pointerdown', (e) => {
                if (dragSession.current.wasDragging) return;
                if (e.target === app.stage) onSelect(null, null);
            });
        };

        const handlePhysics = (dragged) => {
            // REMOVED LEGACY PHYSICS (Now fully replaced by PhysicsPushingManager + Matter.js)
        };

        initPixi();

        return () => {
            isMounted = false;
            setInitialized(false);
            if (pixiApp.current) {
                console.log('🧹 [WebGLStage] Cleanup');
                const app = pixiApp.current;
                try {
                    // Defend against Pixi v8 _cancelResize issue
                    if (app.renderer && !app.renderer._cancelResize) {
                        app.renderer._cancelResize = () => { };
                    }

                    app.ticker.stop();
                    // Explicitly destroy stages/layers first to avoid pool issues
                    if (app.stage) {
                        app.stage.removeChildren();
                    }
                    app.destroy(true, { children: true, texture: true });
                } catch (e) {
                    console.warn('[WebGLStage] App destroy warning:', e);
                }
                pixiApp.current = null;
            }
        };
    }, [width, height]); // Re-init on size change

    // --- RENDERING LOGIC ---
    useEffect(() => {
        const app = pixiApp.current;
        if (!app || !app.stage) return;

        const renderStartTime = performance.now();

        if (!sharedRenderer.current) {
            sharedRenderer.current = new PixiRendererEngine(null, { width, height, resolution });
        }

        let isCancelled = false;

        const render = async () => {
            if (isCancelled) return;

            // Surgical Cleanup
            const engine = sharedRenderer.current;
            Object.values(layers.current).forEach(layer => {
                if (!layer) return;
                [...layer.children].forEach(child => engine.destroyDisplayObject(child));
                layer.removeChildren();
            });

            if (isCancelled) return;

            // 1. Background
            const bg = new PIXI.Graphics();
            bg.rect(0, 0, width, height).fill({ color: background, alpha: 1 });
            layers.current.background.addChild(bg);

            // 2. Shapes
            shapes.forEach(shape => {
                const g = new PIXI.Graphics();
                const color = engine.parseColor(shape.color);

                if (shape.type === 'circle') g.circle(shape.width / 2, shape.height / 2, shape.width / 2);
                else g.rect(0, 0, shape.width, shape.height);

                g.fill({ color: color.hex, alpha: color.alpha });
                g.x = shape.x; g.y = shape.y - yOffset;
                g._id = shape.id;
                g.eventMode = 'static';
                g.cursor = 'pointer';

                g.on('pointerdown', (e) => {
                    onSelect('shape', shape.id);
                    const pos = e.data.global;
                    dragSession.current = { active: true, type: 'shape', id: shape.id, target: g, startX: g.x, startY: g.y, dragStartX: pos.x, dragStartY: pos.y };
                });

                layers.current.shapes.addChild(g);
            });

            // 3. Sections (Hybrid: Single Snapshot or Multi-Section Snapshots)
            const renderSection = async (id, pos, snapshotData, isSelected) => {
                const sectionContainer = new PIXI.Container();
                sectionContainer.x = pos.x;
                sectionContainer.y = pos.y - yOffset;
                sectionContainer._id = id;
                sectionContainer.eventMode = 'static'; // Use modern PIXI event mode
                sectionContainer.cursor = 'move';
                sectionContainer.zIndex = isSelected ? 100 : 0;

                if (id === 'header' && onHeaderContainerReady) onHeaderContainerReady(sectionContainer);
                if (id === 'skills' && onSkillsContainerReady) onSkillsContainerReady(sectionContainer);

                // Selection Border / Hover Effect
                // MOVED: Border creation is now handled dynamically or initially hidden
                const borderInset = 5;
                const border = new PIXI.Graphics();
                border.name = 'selectionBorder'; // Tag for easy finding
                border.rect(-borderInset, -borderInset, snapshotData.width + borderInset * 2, snapshotData.height + borderInset * 2);
                border.stroke({ color: 0x3b82f6, width: 2, alpha: 0.8 });
                border.visible = isSelected; // Initial state
                sectionContainer.addChild(border);

                sectionContainer._width = snapshotData.width; // 🚀 Cache explicit width

                sectionContainer.on('pointerover', () => {
                    if (selectedId !== id) border.visible = true;
                });
                sectionContainer.on('pointerout', () => {
                    if (selectedId !== id) border.visible = false;
                });

                sectionContainer.on('pointerdown', (e) => {
                    e.stopPropagation();
                    // Track position immediately for drag
                    const globalPos = e.data.global;
                    onSelect('section', id);

                    dragSession.current = {
                        active: true,
                        type: 'section',
                        id: id,
                        target: sectionContainer,
                        startX: sectionContainer.x,
                        startY: sectionContainer.y,
                        dragStartX: globalPos.x,
                        dragStartY: globalPos.y,
                        width: snapshotData.width, // 🚀 Capture explicit width
                        initialPositions: {}
                    };

                    // 🚀 Capture all current positions for followers
                    if (layers.current.sections) {
                        layers.current.sections.children.forEach(c => {
                            if (c._id) {
                                dragSession.current.initialPositions[c._id] = {
                                    x: c.x,
                                    y: c.y,
                                    width: c._width || c.width // Capture width for others too
                                };
                            }
                        });
                    }

                    if (onDragStart) onDragStart('section', id); // 🚀 Trigger callback
                });

                layers.current.sections.addChild(sectionContainer);
                await engine.render(snapshotData, { targetContainer: sectionContainer });
            };

            if (snapshot && snapshot.nodes) {
                // Single Page Mode (ResumeEditorv3)
                const sortedNodes = [...snapshot.nodes].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
                for (const node of sortedNodes) {
                    const displayObj = await engine.renderNode(node);
                    if (displayObj) layers.current.sections.addChild(displayObj);
                }
            } else if (sections && sections.length > 0) {
                // Multi-Section Mode (b3.jsx)
                for (const [sectionId, pos] of sections) {
                    const sectionSnapshot = snapshot?.sectionSnapshots?.[sectionId] || snapshot?.[sectionId];
                    if (sectionSnapshot) {
                        const secStart = performance.now();
                        await renderSection(sectionId, pos, sectionSnapshot, selectedId === sectionId);
                        const secDuration = performance.now() - secStart;
                        console.log(`  └─ GPU Render [${sectionId.padEnd(12)}] : ${secDuration.toFixed(2)}ms`);
                    }
                }
            }

            // 4. Lines
            lines.forEach(line => {
                const g = new PIXI.Graphics();
                const color = engine.parseColor(line.color);
                const thickness = line.thickness || 1;
                g.moveTo(line.x1, line.y1 - yOffset).lineTo(line.x2, line.y2 - yOffset).stroke({ color: color.hex, width: thickness, alpha: color.alpha });
                g.interactive = true;
                g.hitArea = new PIXI.Rectangle(Math.min(line.x1, line.x2) - 5, Math.min(line.y1, line.y2) - yOffset - 5, Math.abs(line.x2 - line.x1) + 10, Math.abs(line.y2 - line.y1) + 10);
                g.on('pointerdown', () => onSelect('line', line.id));
                if (isCancelled) return;
                layers.current.lines.addChild(g);
            });

            const renderDuration = performance.now() - renderStartTime;
            const nodeCount = snapshot?.nodes?.length || Object.values(snapshot || {}).reduce((acc, s) => acc + (s?.nodes?.length || 0), 0);
            if (!isCancelled) {
                console.log(`[WebGLStage] Render cycle: ${renderDuration.toFixed(2)}ms (Nodes: ${nodeCount}, Sections: ${sections?.length || 0})`);
            }
        };

        render();

        return () => {
            isCancelled = true;
        };
    }, [initialized, shapes, lines, sections, snapshot, background, physicsEnabled, resolution, yOffset]); // REMOVED selectedId

    // --- SELECTION UPDATE EFFECT (Lightweight) ---
    useEffect(() => {
        if (!initialized) return;

        // Update Shapes
        if (layers.current.shapes) {
            layers.current.shapes.children.forEach(g => {
                // If we had a visual indicator for shapes, update it here
                // Currently shapes don't show a border on select in the original code, 
                // but we can add logic if needed. 
            });
        }

        // Update Sections
        if (layers.current.sections) {
            layers.current.sections.children.forEach(container => {
                const isSelected = container._id === selectedId;

                // Find or create border
                let border = container.children.find(c => c.name === 'selectionBorder');

                if (isSelected) {
                    if (!border) {
                        const borderInset = 5;
                        border = new PIXI.Graphics();
                        border.name = 'selectionBorder';
                        // We need the size. 
                        // Note: getBounds() might be expensive or local bounds might be 0 if empty.
                        // But we passed snapshotData before. 
                        // Best way relies on the fact the container usually has children.
                        // For now, we'll try to use the container's calculated bounds.
                        const bounds = container.getLocalBounds();
                        border.rect(bounds.x - borderInset, bounds.y - borderInset, bounds.width + borderInset * 2, bounds.height + borderInset * 2);
                        border.stroke({ color: 0x3b82f6, width: 2, alpha: 0.8 });
                        container.addChild(border);
                    }
                    border.visible = true;
                    container.zIndex = 100; // Bring to front
                } else {
                    if (border) border.visible = false;
                    container.zIndex = 0; // Reset zIndex
                }
            });
            // Re-sort to apply zIndex changes
            layers.current.sections.sortChildren();
        }

        // Update Lines
        if (layers.current.lines) {
            // Similar logic for lines if needed
        }

    }, [selectedId, initialized]);

    // --- FALLBACK CANVAS RENDERER ---
    useEffect(() => {
        if (useFallback && snapshot && fallbackCanvasRef.current) {
            // Rehydrate a temporary engine to use its valid render logic
            const engine = new GeometrySnapshot();
            engine.nodes = snapshot.nodes || [];
            engine.rootWidth = snapshot.width || width;
            engine.rootHeight = snapshot.height || height;

            // Use existing render logic
            try {
                engine.renderToCanvas(fallbackCanvasRef.current, resolution);
                console.log("[WebGLStage] 🎨 Fallback Canvas Rendered");
            } catch (e) {
                console.error("[WebGLStage] Fallback render failed:", e);
            }
        }
    }, [useFallback, snapshot, width, height, resolution]);

    useImperativeHandle(ref, () => ({
        app: pixiApp.current,
        exportImage: () => sharedRenderer.current ? sharedRenderer.current.exportImage() : null
    }));

    return (
        <div
            ref={containerRef}
            className={`webgl-stage-container ${className}`}
            style={{
                width: '100%', height: '100%',
                display: 'flex', justifyContent: 'center', alignItems: 'center',
                overflow: 'hidden', backgroundColor: '#525659',
                touchAction: 'none', // Critical for mobile dragging
                ...style
            }}
        >
            {useFallback && (
                <canvas
                    ref={fallbackCanvasRef}
                    style={{
                        maxWidth: '100%',
                        maxHeight: '100%',
                        boxShadow: '0 10px 30px rgba(0,0,0,0.2)'
                    }}
                />
            )}
            {useFallback && !snapshot && (
                <div style={{ color: '#aaa', fontFamily: 'sans-serif' }}>
                    Generating Preview...
                </div>
            )}
        </div>
    );
});

// ==================== HOOK: WEBGL SNAPSHOT ====================

const useWebGLSnapshot = () => {
    const [snapshot, setSnapshot] = useState(null);
    const [isCapturing, setIsCapturing] = useState(false);
    const engineRef = useRef(new GeometrySnapshot());

    const capture = useCallback(async (element, options = {}) => {
        if (!element) return null;
        const startTime = performance.now();
        setIsCapturing(true);

        try {
            const data = await engineRef.current.capture(element, options);
            setSnapshot(data);
            const duration = performance.now() - startTime;
            console.log(`[useWebGLSnapshot] Capture complete in ${duration.toFixed(2)}ms`);
            setIsCapturing(false);
            return data;
        } catch (err) {
            console.error("[useWebGLSnapshot] Capture failed:", err);
            setIsCapturing(false);
            return null;
        }
    }, []);

    return { snapshot, capture, isCapturing };
};

// ==================== HYBRID RENDERING ORCHESTRATOR ====================

class HybridRenderer {
    constructor(options = {}) {
        this.mode = options.mode || 'css'; // 'css' | 'geometry' | 'pixi'
        this.container = options.container;
        this.canvas = null;
        this.engine = null;
        this.pixiRenderer = null;
        this.geometrySnapshot = null;
    }

    /**
     * MODE 1: CSS Layout Engine (Manual Layout Building)
     */
    async renderWithCSSEngine(layoutTree, bounds) {
        if (!this.canvas) {
            this.canvas = document.createElement('canvas');
            this.container.appendChild(this.canvas);
        }

        this.engine = new CanvasLayoutEngine(this.canvas, { scale: 2 });
        this.engine.initialize(bounds.width, bounds.height);
        this.engine.renderLayoutTree(layoutTree, bounds);

        return this.canvas;
    }

    /**
     * MODE 2: Geometry Snapshot (DOM Capture)
     */
    async renderWithGeometrySnapshot(domElement, renderMode = 'canvas') {
        this.geometrySnapshot = new GeometrySnapshot();
        const snapshot = this.geometrySnapshot.capture(domElement);

        if (renderMode === 'canvas') {
            if (!this.canvas) {
                this.canvas = document.createElement('canvas');
                this.container.appendChild(this.canvas);
            }

            this.geometrySnapshot.renderToCanvas(this.canvas);
            return this.canvas;
        } else if (renderMode === 'pixi') {
            return this.renderSnapshotWithPixi(snapshot);
        }

        return snapshot;
    }

    /**
     * MODE 3: PixiJS Renderer (GPU Accelerated)
     */
    async renderWithPixi(geometrySnapshot, config = {}) {
        if (!this.pixiRenderer) {
            this.pixiRenderer = new PixiRendererEngine(this.container, {
                width: geometrySnapshot.width,
                height: geometrySnapshot.height
            });
            await this.pixiRenderer.initialize();
        }

        await this.pixiRenderer.render(geometrySnapshot, {
            shapes: config.shapes,
            lines: config.lines
        });
        return this.pixiRenderer;
    }

    async renderSnapshotWithPixi(snapshot, config = {}) {
        return this.renderWithPixi(snapshot, config);
    }

    async exportImage() {
        if (this.pixiRenderer) {
            return await this.pixiRenderer.exportImage();
        } else if (this.canvas) {
            return this.canvas.toDataURL();
        }
        return null;
    }

    destroy() {
        if (this.pixiRenderer) {
            this.pixiRenderer.destroy();
        }
        if (this.canvas && this.canvas.parentElement) {
            this.canvas.parentElement.removeChild(this.canvas);
        }
    }
}

class WebEngine {
    constructor(element, options = {}) {
        this.element = element;
        this.options = options;
        this.snapshotData = null;
        this.renderer = null;

        // Initialize workers if requested
        if (options.useWorkers) {
            this.styleWorker = getStyleWorker();
            this.gradientWorker = getGradientWorker();
        }

        this.geometrySnapshot = new GeometrySnapshot({
            styleWorker: this.styleWorker,
            gradientWorker: this.gradientWorker,
            useWorkers: !!options.useWorkers
        });
    }

    async snapshot() {
        if (!this.element) return null;
        this.snapshotData = await this.geometrySnapshot.capture(this.element);
        return this.snapshotData;
    }

    async renderToWebGL(container) {
        if (!container && !this.renderer) {
            console.error('[WebEngine] renderToWebGL called without a valid container.');
            return null;
        }

        if (!this.snapshotData) await this.snapshot();

        if (!this.renderer) {
            this.renderer = new PixiRendererEngine(container, this.options.rendererOptions || {});
            const success = await this.renderer.initialize();
            if (!success) {
                this.renderer = null; // Reset so we can try again
                return null;
            }
        }

        return await this.renderer.render(this.snapshotData);
    }

    async update() {
        await this.snapshot();
        if (this.renderer) {
            await this.renderer.render(this.snapshotData);
        }
    }

    destroy() {
        if (this.renderer) this.renderer.destroy();
    }
}

export {
    CanvasLayoutEngine,
    LayoutNode,
    FlexNode,
    GridNode,
    BlockNode,
    TextNode,
    ImageNode,
    SpacerNode,
    parseConfigToLayout,
    GeometrySnapshot,
    PixiRendererEngine,
    HybridRenderer,
    WebGLStage,
    useWebGLSnapshot,
    WebEngine
};

