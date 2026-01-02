/**
 * Gradient Processing Web Worker
 * Handles gradient parsing and texture generation in background thread
 */

// ==================== GRADIENT PARSING ====================

function parseGradient(bgImage) {
    if (!bgImage || bgImage === 'none') return null;

    // Match linear-gradient or radial-gradient
    const linearMatch = bgImage.match(/linear-gradient\((.*)\)/);
    const radialMatch = bgImage.match(/radial-gradient\((.*)\)/);

    if (linearMatch) {
        return parseLinearGradient(linearMatch[1]);
    } else if (radialMatch) {
        return parseRadialGradient(radialMatch[1]);
    }

    return null;
}

function parseLinearGradient(content) {
    // Split by commas that are not inside parentheses (to handle rgb/rgba)
    const parts = content.split(/,(?![^(]*\))/).map(s => s.trim());

    // First part might be angle or direction
    let angle = 180; // default to bottom
    let colorStartIdx = 0;

    const firstPart = parts[0];
    if (firstPart.includes('deg')) {
        angle = parseFloat(firstPart);
        colorStartIdx = 1;
    } else if (firstPart.startsWith('to ')) {
        // Convert direction to angle
        const direction = firstPart.replace('to ', '');
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
        angle = directionMap[direction] || 180;
        colorStartIdx = 1;
    }

    const stops = parseColorStops(parts, colorStartIdx);

    return {
        type: 'linear',
        angle,
        stops
    };
}

function parseRadialGradient(content) {
    const parts = content.split(/,(?![^(]*\))/).map(s => s.trim());

    // Simple radial gradient (center by default)
    const stops = parseColorStops(parts, 0);

    return {
        type: 'radial',
        stops
    };
}

function parseColorStops(parts, startIdx) {
    const stops = [];

    for (let i = startIdx; i < parts.length; i++) {
        const part = parts[i].trim();

        // Match color and optional position
        // Examples: "red", "red 0%", "rgba(255,0,0,1) 50%"
        const match = part.match(/^(.+?)\s*(\d+%)?$/);

        if (match) {
            const color = match[1].trim();
            const position = match[2] ? parseFloat(match[2]) / 100 : null;

            stops.push({
                color,
                position: position !== null ? position : (i - startIdx) / (parts.length - startIdx - 1)
            });
        }
    }

    return stops;
}

// ==================== TEXTURE GENERATION ====================

function generateGradientTexture(width, height, gradient) {
    try {
        // Use OffscreenCanvas for background thread rendering
        const canvas = new OffscreenCanvas(width, height);
        const ctx = canvas.getContext('2d');

        if (!ctx) {
            throw new Error('Failed to get OffscreenCanvas context');
        }

        let gradientObj;

        if (gradient.type === 'linear') {
            // Convert angle to x1,y1,x2,y2
            const angleRad = (gradient.angle - 90) * Math.PI / 180;
            const x1 = width / 2 - Math.cos(angleRad) * width / 2;
            const y1 = height / 2 - Math.sin(angleRad) * height / 2;
            const x2 = width / 2 + Math.cos(angleRad) * width / 2;
            const y2 = height / 2 + Math.sin(angleRad) * height / 2;

            gradientObj = ctx.createLinearGradient(x1, y1, x2, y2);
        } else if (gradient.type === 'radial') {
            const centerX = width / 2;
            const centerY = height / 2;
            const radius = Math.max(width, height) / 2;

            gradientObj = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
        }

        // Add color stops
        if (gradientObj && gradient.stops) {
            gradient.stops.forEach(stop => {
                gradientObj.addColorStop(stop.position, stop.color);
            });
        }

        // Fill canvas with gradient
        ctx.fillStyle = gradientObj;
        ctx.fillRect(0, 0, width, height);

        // Convert to ImageBitmap for efficient transfer
        return canvas.transferToImageBitmap();
    } catch (error) {
        console.error('Gradient texture generation failed:', error);
        return null;
    }
}

// ==================== MESSAGE HANDLING ====================

const pendingRequests = new Map();

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

            case 'GENERATE_TEXTURE': {
                const bitmap = generateGradientTexture(data.width, data.height, data.gradient);

                if (bitmap) {
                    self.postMessage({
                        type: 'TEXTURE_READY',
                        id,
                        bitmap
                    }, [bitmap]); // Transfer bitmap ownership
                } else {
                    self.postMessage({
                        type: 'TEXTURE_ERROR',
                        id,
                        error: 'Failed to generate texture'
                    });
                }
                break;
            }

            case 'PARSE_AND_GENERATE': {
                // Combined operation for efficiency
                const gradient = parseGradient(data.backgroundImage);

                if (gradient && data.width && data.height) {
                    const bitmap = generateGradientTexture(data.width, data.height, gradient);

                    if (bitmap) {
                        self.postMessage({
                            type: 'GRADIENT_AND_TEXTURE_READY',
                            id,
                            gradient,
                            bitmap
                        }, [bitmap]);
                    } else {
                        self.postMessage({
                            type: 'GRADIENT_PARSED',
                            id,
                            gradient
                        });
                    }
                } else {
                    self.postMessage({
                        type: 'GRADIENT_PARSED',
                        id,
                        gradient
                    });
                }
                break;
            }

            case 'PING': {
                // Health check
                self.postMessage({
                    type: 'PONG',
                    id
                });
                break;
            }

            default:
                console.warn('Unknown message type:', type);
        }
    } catch (error) {
        self.postMessage({
            type: 'ERROR',
            id,
            error: error.message
        });
    }
};

// Signal that worker is ready
self.postMessage({ type: 'READY' });
