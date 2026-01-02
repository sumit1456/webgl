/**
 * Style Processing Worker
 * Handles complex style parsing and normalization in a background thread
 */

// Simple color parser to avoid importing large libs
function parseColor(cssColor) {
    if (!cssColor || cssColor === 'transparent') return { hex: 0xffffff, alpha: 0 };

    // 1. Hex
    if (cssColor.startsWith('#')) {
        const hex = cssColor.slice(1);
        if (hex.length === 3) {
            const fullHex = hex.split('').map(c => c + c).join('');
            return { hex: parseInt(fullHex, 16), alpha: 1 };
        }
        if (hex.length === 8) {
            return { hex: parseInt(hex.slice(0, 6), 16), alpha: parseInt(hex.slice(6, 8), 16) / 255 };
        }
        return { hex: parseInt(hex, 16), alpha: 1 };
    }

    // 2. RGB/RGBA
    if (cssColor.startsWith('rgb')) {
        const values = cssColor.match(/[\d.]+/g);
        if (values) {
            const r = parseInt(values[0]);
            const g = parseInt(values[1]);
            const b = parseInt(values[2]);
            const a = values[3] !== undefined ? parseFloat(values[3]) : 1;
            return { hex: (r << 16) | (g << 8) | b, alpha: a };
        }
    }

    // 3. Named Colors
    const namedColors = {
        white: 0xffffff, black: 0x000000, red: 0xff0000, green: 0x008000, blue: 0x0000ff,
        yellow: 0xffff00, orange: 0xffa500, gray: 0x808080, grey: 0x808080, purple: 0x800080,
        pink: 0xffc0cb, transparent: 0xffffff
    };
    const c = namedColors[cssColor.toLowerCase()];
    if (c !== undefined) return { hex: c, alpha: cssColor.toLowerCase() === 'transparent' ? 0 : 1 };

    return { hex: 0xcccccc, alpha: 1 };
}

function parseGradient(bgImage) {
    if (!bgImage || bgImage === 'none') return null;

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
    const linearMatch = cleanBg.match(/linear-gradient\((.*)\)/s);
    const radialMatch = cleanBg.match(/radial-gradient\((.*)\)/s);

    if (linearMatch) return parseLinearGradient(linearMatch[1].trim());
    if (radialMatch) return parseRadialGradient(radialMatch[1].trim());
    return null;
}

function parseLinearGradient(content) {
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

    let angle = 180;
    let startIdx = 0;

    if (parts[0].includes('deg')) {
        angle = parseFloat(parts[0]) || 180;
        startIdx = 1;
    } else if (parts[0].includes('to ')) {
        const dir = parts[0].toLowerCase();
        if (dir.includes('bottom')) angle = 180;
        if (dir.includes('top')) angle = 0;
        if (dir.includes('right')) angle = 90;
        if (dir.includes('left')) angle = 270;
        startIdx = 1;
    }

    return { type: 'linear', angle, stops: parseColorStops(parts, startIdx) };
}

function parseRadialGradient(content) {
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

    return { type: 'radial', stops: parseColorStops(parts, 0) };
}

function parseColorStops(parts, startIdx) {
    const stops = [];
    for (let i = startIdx; i < parts.length; i++) {
        const part = parts[i];
        const colorMatch = part.match(/(rgba?\(.*?\)|#[0-9a-fA-F]+|[a-zA-Z]+)/);
        if (colorMatch) {
            const colorData = parseColor(colorMatch[0]);
            let offset = null;
            const offsetMatch = part.replace(colorMatch[0], '').trim().match(/(\d+)%/);
            if (offsetMatch) offset = parseFloat(offsetMatch[1]) / 100;
            else offset = (i - startIdx) / (parts.length - startIdx - 1);
            stops.push({ color: colorData.hex, alpha: colorData.alpha, offset });
        }
    }
    return stops;
}

self.onmessage = function (e) {
    const { type, id, data } = e.data;

    if (type === 'PARSE_STYLES') {
        const { rawStylesBatch } = data;
        console.log(`[Worker] Processing style batch ${id} with ${rawStylesBatch.length} items`);
        const processedBatch = rawStylesBatch.map(raw => {
            return {
                backgroundColor: raw.backgroundColor,
                backgroundImage: raw.backgroundImage,
                borderWidth: parseFloat(raw.borderTopWidth) || 0,
                borderRightWidth: parseFloat(raw.borderRightWidth) || 0,
                borderBottomWidth: parseFloat(raw.borderBottomWidth) || 0,
                borderLeftWidth: parseFloat(raw.borderLeftWidth) || 0,
                borderColor: raw.borderTopColor || raw.borderColor,
                borderRightColor: raw.borderRightColor,
                borderBottomColor: raw.borderBottomColor,
                borderLeftColor: raw.borderLeftColor,
                borderStyle: raw.borderTopStyle || raw.borderStyle,
                borderRadius: raw.borderRadius,
                color: raw.color,
                fontSize: parseFloat(raw.fontSize) || 12,
                fontFamily: raw.fontFamily,
                fontWeight: raw.fontWeight,
                fontStyle: raw.fontStyle,
                textAlign: raw.textAlign,
                justifyContent: raw.justifyContent,
                alignItems: raw.alignItems,
                lineHeight: parseFloat(raw.lineHeight) || parseFloat(raw.fontSize) * 1.2,
                letterSpacing: parseFloat(raw.letterSpacing) || 0,
                padding: {
                    top: parseFloat(raw.paddingTop) || 0,
                    right: parseFloat(raw.paddingRight) || 0,
                    bottom: parseFloat(raw.paddingBottom) || 0,
                    left: parseFloat(raw.paddingLeft) || 0
                },
                opacity: parseFloat(raw.opacity) || 1,
                boxShadow: raw.boxShadow !== 'none' ? raw.boxShadow : null,
                transform: raw.transform !== 'none' ? raw.transform : null,
                zIndex: raw.zIndex !== 'auto' ? parseInt(raw.zIndex) : 0,
                overflow: raw.overflow,
                visibility: raw.visibility,
                whiteSpace: raw.whiteSpace,
                wordBreak: raw.wordBreak,
                gradient: raw.backgroundImage && raw.backgroundImage !== 'none' ? parseGradient(raw.backgroundImage) : null
            };
        });

        console.log(`[Worker] Finished style batch ${id}`);
        self.postMessage({
            type: 'STYLES_PROCESSED',
            id,
            processedBatch
        });
    }

    if (type === 'PING') {
        self.postMessage({ type: 'PONG', id });
    }
};

self.postMessage({ type: 'READY' });
