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
                borderColor: raw.borderTopColor || raw.borderColor,
                borderStyle: raw.borderTopStyle || raw.borderStyle,
                borderRadius: raw.borderRadius.includes('%') ? raw.borderRadius : (parseFloat(raw.borderRadius) || 0),
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
                wordBreak: raw.wordBreak
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
