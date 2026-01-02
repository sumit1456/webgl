/**
 * WebGL Engine with Web Worker Support
 * Export enhanced engine components with gradient worker integration
 */

import { GeometrySnapshot as BaseGeometrySnapshot, PixiRenderer, HybridRenderer } from './WebglEngine3.jsx';
import { getGradientWorker, terminateGradientWorker, getStyleWorker, terminateStyleWorker } from '../../workers/workerManager.js';

// Initialize workers
let gradientWorkerInstance = null;
let styleWorkerInstance = null;

export async function initializeWorkers() {
    const promises = [];

    if (!gradientWorkerInstance) {
        gradientWorkerInstance = getGradientWorker();
        promises.push(gradientWorkerInstance.initialize());
    }

    if (!styleWorkerInstance) {
        styleWorkerInstance = getStyleWorker();
        promises.push(styleWorkerInstance.initialize());
    }

    await Promise.all(promises);
    console.log('✅ Web Workers (Gradient & Style) initialized');

    return { gradientWorkerInstance, styleWorkerInstance };
}

export function getWorkerStats() {
    return {
        gradient: gradientWorkerInstance?.getStats(),
        style: styleWorkerInstance?.getStats()
    };
}

export function cleanupWorkers() {
    if (gradientWorkerInstance) {
        terminateGradientWorker();
        gradientWorkerInstance = null;
    }
    if (styleWorkerInstance) {
        terminateStyleWorker();
        styleWorkerInstance = null;
    }
}

// Enhanced GeometrySnapshot with worker support
export class GeometrySnapshotWithWorkers extends BaseGeometrySnapshot {
    constructor(options = {}) {
        super({
            ...options,
            gradientWorker: gradientWorkerInstance,
            styleWorker: styleWorkerInstance,
            useWorkers: true
        });
    }
}

// Re-export other components
export { PixiRenderer, HybridRenderer };

// Export original for fallback
export { GeometrySnapshot } from './WebglEngine3.jsx';
