/**
 * Worker Manager
 * Manages Web Worker lifecycle and provides Promise-based API
 */

export class WorkerManager {
    constructor(workerPath, options = {}) {
        this.workerPath = workerPath;
        this.poolSize = options.poolSize || 1;
        this.workers = [];
        this.currentWorkerIndex = 0;
        this.pendingRequests = new Map();
        this.requestIdCounter = 0;
        this.isReady = false;
        this.readyPromise = null;
        this.fallbackMode = false;

        // Initialize workers
        this.initialize();
    }

    async initialize() {
        this.readyPromise = new Promise((resolve, reject) => {
            try {
                // Check if Web Workers are supported
                if (typeof Worker === 'undefined') {
                    console.warn('Web Workers not supported, using fallback mode');
                    this.fallbackMode = true;
                    resolve(false);
                    return;
                }

                // Check if OffscreenCanvas is supported
                if (typeof OffscreenCanvas === 'undefined') {
                    console.warn('OffscreenCanvas not supported, using fallback mode');
                    this.fallbackMode = true;
                    resolve(false);
                    return;
                }

                // Create worker pool
                for (let i = 0; i < this.poolSize; i++) {
                    try {
                        // Use classic workers for broader compatibility when serving from public/
                        const worker = new Worker(this.workerPath);

                        worker.onmessage = (e) => this.handleMessage(e, i);
                        worker.onerror = (error) => {
                            console.error(`Worker ${i} runtime error at ${this.workerPath}:`, error);
                            this.handleError(error, i);
                        };

                        this.workers.push({
                            worker,
                            busy: false,
                            ready: false
                        });
                    } catch (error) {
                        console.error(`Failed to create worker ${i} at ${this.workerPath}:`, error);
                        this.fallbackMode = true;
                        resolve(false);
                        return;
                    }
                }

                // Wait for all workers to be ready
                const readyTimeout = setTimeout(() => {
                    console.warn('Worker initialization timeout, using fallback mode');
                    this.fallbackMode = true;
                    resolve(false);
                }, 5000);

                // Listen for READY messages
                const checkReady = () => {
                    const allReady = this.workers.every(w => w.ready);
                    if (allReady) {
                        clearTimeout(readyTimeout);
                        this.isReady = true;
                        console.log(`✅ ${this.workers.length} worker(s) ready`);
                        resolve(true);
                    }
                };

                // Initial check
                setTimeout(checkReady, 100);

            } catch (error) {
                console.error('Worker initialization failed:', error);
                this.fallbackMode = true;
                reject(error);
            }
        });

        return this.readyPromise;
    }

    handleMessage(e, workerIndex) {
        const { type, id, ...data } = e.data;

        if (type === 'READY') {
            this.workers[workerIndex].ready = true;
            return;
        }

        if (type === 'PONG') {
            // Health check response
            return;
        }

        // Handle request response
        const request = this.pendingRequests.get(id);
        if (request) {
            this.pendingRequests.delete(id);

            // Mark worker as available
            this.workers[workerIndex].busy = false;

            if (type === 'ERROR' || type.includes('ERROR')) {
                request.reject(new Error(data.error || 'Worker error'));
            } else {
                request.resolve({ type, ...data });
            }
        }
    }

    handleError(error, workerIndex) {
        console.error(`Worker ${workerIndex} error:`, error);

        // Reject all pending requests for this worker
        this.pendingRequests.forEach((request, id) => {
            request.reject(error);
            this.pendingRequests.delete(id);
        });

        // Mark worker as not ready
        this.workers[workerIndex].ready = false;
        this.workers[workerIndex].busy = false;
    }

    getNextWorker() {
        // Round-robin worker selection
        const startIndex = this.currentWorkerIndex;

        do {
            const workerInfo = this.workers[this.currentWorkerIndex];
            this.currentWorkerIndex = (this.currentWorkerIndex + 1) % this.workers.length;

            if (workerInfo.ready && !workerInfo.busy) {
                return workerInfo;
            }
        } while (this.currentWorkerIndex !== startIndex);

        // If all workers are busy, return the next one anyway
        const workerInfo = this.workers[this.currentWorkerIndex];
        this.currentWorkerIndex = (this.currentWorkerIndex + 1) % this.workers.length;
        return workerInfo;
    }

    async execute(type, data, timeout = 10000) {
        // Wait for initialization
        if (!this.isReady && !this.fallbackMode) {
            await this.readyPromise;
        }

        // If in fallback mode, return null to trigger main thread fallback
        if (this.fallbackMode) {
            return null;
        }

        return new Promise((resolve, reject) => {
            const id = `req_${this.requestIdCounter++}`;

            // Get next available worker
            const workerInfo = this.getNextWorker();
            workerInfo.busy = true;

            // Store request
            this.pendingRequests.set(id, { resolve, reject });

            // Set timeout
            const timeoutId = setTimeout(() => {
                if (this.pendingRequests.has(id)) {
                    this.pendingRequests.delete(id);
                    workerInfo.busy = false;
                    reject(new Error('Worker request timeout'));
                }
            }, timeout);

            // Clear timeout on resolution
            const originalResolve = resolve;
            const originalReject = reject;

            this.pendingRequests.set(id, {
                resolve: (value) => {
                    clearTimeout(timeoutId);
                    originalResolve(value);
                },
                reject: (error) => {
                    clearTimeout(timeoutId);
                    originalReject(error);
                }
            });

            // Send message to worker
            try {
                workerInfo.worker.postMessage({ type, id, data });
            } catch (error) {
                clearTimeout(timeoutId);
                this.pendingRequests.delete(id);
                workerInfo.busy = false;
                reject(error);
            }
        });
    }

    async ping() {
        try {
            await this.execute('PING', {}, 1000);
            return true;
        } catch {
            return false;
        }
    }

    terminate() {
        this.workers.forEach(({ worker }) => {
            worker.terminate();
        });
        this.workers = [];
        this.pendingRequests.clear();
        this.isReady = false;
    }

    getStats() {
        return {
            totalWorkers: this.workers.length,
            readyWorkers: this.workers.filter(w => w.ready).length,
            busyWorkers: this.workers.filter(w => w.busy).length,
            pendingRequests: this.pendingRequests.size,
            fallbackMode: this.fallbackMode
        };
    }
}

// Singleton instance for gradient worker
let gradientWorkerInstance = null;

export function getGradientWorker() {
    if (!gradientWorkerInstance) {
        gradientWorkerInstance = new WorkerManager('/workers/gradientWorker.js', {
            poolSize: 2 // Use 2 workers for parallel processing
        });
    }
    return gradientWorkerInstance;
}

export function terminateGradientWorker() {
    if (gradientWorkerInstance) {
        gradientWorkerInstance.terminate();
        gradientWorkerInstance = null;
    }
}

// Singleton instance for style worker
let styleWorkerInstance = null;

export function getStyleWorker() {
    if (!styleWorkerInstance) {
        styleWorkerInstance = new WorkerManager('/workers/styleWorker.js', {
            poolSize: 2
        });
    }
    return styleWorkerInstance;
}

export function terminateStyleWorker() {
    if (styleWorkerInstance) {
        styleWorkerInstance.terminate();
        styleWorkerInstance = null;
    }
}
