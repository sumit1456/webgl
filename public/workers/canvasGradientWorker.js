/**
 * Canvas Gradient Processing Web Worker
 * Handles gradient parsing for CanvasEngine (Fixed Radial Gradients)
 */

// ==================== GRADIENT PARSING ====================

function parseGradient(bgImage) {
    if (!bgImage || bgImage === 'none') return null;

    // Match linear-gradient or radial-gradient
    const linearMatch = bgImage.match(/linear-gradient\((.*)\)/s);
    const radialMatch = bgImage.match(/radial-gradient\((.*)\)/s);

    if (linearMatch) {
        return parseLinearGradient(linearMatch[1].trim());
    } else if (radialMatch) {
        return parseRadialGradient(radialMatch[1].trim());
    }

    return null;
}

function parseLinearGradient(content) {
    // Robust splitting handling nested parenthesis if any
    const parts = splitByComma(content);

    // First part might be angle or direction
    let angle = 180; // default to bottom
    let colorStartIdx = 0;

    const firstPart = parts[0];
    if (firstPart.includes('deg')) {
        angle = parseFloat(firstPart);
        colorStartIdx = 1;
    } else if (firstPart.startsWith('to ')) {
        const direction = firstPart.replace('to ', '').trim();
        const directionMap = {
            'top': 0,
            'right': 90,
            'bottom': 180,
            'left': 270,
            'top right': 45,
            'bottom right': 135,
            'bottom left': 225,
            'top left': 315
        };
        angle = directionMap[direction] !== undefined ? directionMap[direction] : 180;
        colorStartIdx = 1;
    }

    const stops = parseColorStops(parts, colorStartIdx);

    return { type: 'linear', angle, stops };
}

function parseRadialGradient(content) {
    const parts = splitByComma(content);

    // Check for shape/size/position arguments in the first part
    // e.g. "circle", "circle at center", "closest-side at 50% 50%"
    let startIdx = 0;
    const firstPart = parts[0].trim();

    const isColor = /^(#|rgb|hsl|[a-zA-Z]+$)/.test(firstPart) && !firstPart.includes(' at ') && !firstPart.includes('circle') && !firstPart.includes('ellipse');

    // If the first part explicitly mentions shape keywords or position 'at', it's not a color stop
    if (firstPart.includes('circle') || firstPart.includes('ellipse') || firstPart.includes(' at ') || firstPart.includes('closest-side') || firstPart.includes('farthest-side')) {
        startIdx = 1;
    }

    // Also handling complex multi-keyword vs color detection is tricky.
    // Simpler check: if it parses as a valid color, assumes it's a stop.
    // However, 'red' is a color. 'circle' is not.

    const stops = parseColorStops(parts, startIdx);

    return { type: 'radial', stops };
}

function parseColorStops(parts, startIdx) {
    const stops = [];
    for (let i = startIdx; i < parts.length; i++) {
        const part = parts[i].trim();
        // Match color and optional position
        const match = part.match(/^(.+?)\s*(\d+%)?$/);

        if (match) {
            const color = match[1].trim();
            // Filter out obvious non-colors that might sneak in
            if (['circle', 'ellipse', 'at'].includes(color)) continue;

            const position = match[2] ? parseFloat(match[2]) / 100 : null;
            stops.push({
                color,
                position: position !== null ? position : (i - startIdx) / (Math.max(parts.length - startIdx - 1, 1))
            });
        }
    }
    return stops;
}

// Helper to safely split by comma ignoring nested parens
function splitByComma(str) {
    const parts = [];
    let depth = 0;
    let lastIdx = 0;
    for (let i = 0; i < str.length; i++) {
        if (str[i] === '(') depth++;
        else if (str[i] === ')') depth--;
        else if (str[i] === ',' && depth === 0) {
            parts.push(str.substring(lastIdx, i).trim());
            lastIdx = i + 1;
        }
    }
    parts.push(str.substring(lastIdx).trim());
    return parts.filter(p => p);
}


// ==================== MESSAGE HANDLING ====================

self.onmessage = async (e) => {
    const { type, id, data } = e.data;

    try {
        switch (type) {
            case 'PARSE_GRADIENT': {
                const gradient = parseGradient(data.backgroundImage);
                self.postMessage({
                    type: 'GRADIENT_PARSED',
                    id,
                    gradient
                });
                break;
            }
            case 'PING': {
                self.postMessage({ type: 'PONG', id });
                break;
            }
        }
    } catch (error) {
        self.postMessage({ type: 'ERROR', id, error: error.message });
    }
};

self.postMessage({ type: 'READY' });
