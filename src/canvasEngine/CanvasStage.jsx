import React, { useEffect, useRef, useState } from 'react';
import { fabric } from 'fabric';
import { CanvasLayoutEngine } from './CanvasEngine';

/**
 * CanvasStage
 * A high-fidelity fallback stage using CanvasEngine and Fabric.js
 * Supports multiple sections, shapes, and lines.
 */
const CanvasStage = ({
    width = 595,
    height = 842,
    sections = [],
    shapes = [],
    lines = [],
    snapshot = {}, // Mapping ID -> Snapshot object
    scale = 1,
    yOffset = 0,
    onDragEnd = () => { },
    className = "",
    style = {}
}) => {
    const canvasRef = useRef(null);
    const fabricRef = useRef(null);
    const [isRendering, setIsRendering] = useState(false);
    const renderCache = useRef(new Map());
    const renderInProgress = useRef(0); // Cancellation counter

    useEffect(() => {
        if (!canvasRef.current) return;

        fabricRef.current = new fabric.Canvas(canvasRef.current, {
            width: width * scale,
            height: height * scale,
            backgroundColor: '#ffffff',
            selection: true,
            renderOnAddRemove: true
        });

        fabricRef.current.on('object:modified', (e) => {
            const obj = e.target;
            if (obj && obj.data && obj.data.type === 'section') {
                const id = obj.data.id;
                const newPos = {
                    x: obj.left / scale,
                    y: (obj.top / scale) + yOffset
                };
                onDragEnd('section', id, newPos);
            }
        });

        return () => {
            fabricRef.current?.dispose();
            renderCache.current.clear();
        };
    }, []);

    useEffect(() => {
        if (!fabricRef.current) return;

        const currentRenderId = ++renderInProgress.current;

        const renderAll = async () => {
            setIsRendering(true);
            const canvas = fabricRef.current;

            // Wait for next tick if canvas size needs update (usually not needed here)
            canvas.setWidth(width * scale);
            canvas.setHeight(height * scale);
            canvas.clear();
            canvas.setBackgroundColor('#ffffff', canvas.renderAll.bind(canvas));

            try {
                // 1. Render Background Shapes
                for (const shape of shapes) {
                    if (currentRenderId !== renderInProgress.current) return;

                    // Adjust for Page yOffset
                    const adjustedY = shape.y - yOffset;
                    if (adjustedY + shape.height < 0 || adjustedY > height) continue;

                    const rect = new fabric.Rect({
                        left: shape.x * scale,
                        top: adjustedY * scale,
                        width: shape.width * scale,
                        height: shape.height * scale,
                        fill: shape.fill || '#000',
                        opacity: shape.opacity || 1,
                        selectable: false,
                        evented: false
                    });
                    canvas.add(rect);
                }

                // 2. Render Lines
                for (const line of lines) {
                    if (currentRenderId !== renderInProgress.current) return;

                    const adjustedY1 = line.y1 - yOffset;
                    const adjustedY2 = line.y2 - yOffset;

                    // Basic clipping check
                    if (Math.max(adjustedY1, adjustedY2) < 0 || Math.min(adjustedY1, adjustedY2) > height) continue;

                    const fabricLine = new fabric.Line([
                        line.x1 * scale, adjustedY1 * scale,
                        line.x2 * scale, adjustedY2 * scale
                    ], {
                        stroke: line.color || '#000',
                        strokeWidth: (line.thickness || 1) * scale,
                        selectable: false,
                        evented: false
                    });
                    canvas.add(fabricLine);
                }

                // 3. Render Sections (Images)
                console.log(`[CanvasStage] #${currentRenderId} Rendering ${sections.length} sections`);
                for (const sectionInfo of sections) {
                    if (currentRenderId !== renderInProgress.current) return;

                    let id, x, y;
                    if (Array.isArray(sectionInfo)) {
                        [id, { x, y }] = sectionInfo;
                    } else {
                        ({ id, x, y } = sectionInfo);
                    }

                    const sectionSnapshot = snapshot[id];

                    if (!sectionSnapshot || !sectionSnapshot.nodes) {
                        console.warn(`[CanvasStage] #${currentRenderId} No snapshot for section ${id}`);
                        continue;
                    }

                    const adjustedY = y - yOffset;
                    if (adjustedY + sectionSnapshot.height < 0 || adjustedY > height) continue;

                    let imgData;
                    const cacheKey = `${id}-${sectionSnapshot.nodes.length}-${sectionSnapshot.width}x${sectionSnapshot.height}`;

                    if (renderCache.current.has(cacheKey)) {
                        imgData = renderCache.current.get(cacheKey);
                    } else {
                        const tempCanvas = document.createElement('canvas');
                        tempCanvas.width = sectionSnapshot.width || 100;
                        tempCanvas.height = sectionSnapshot.height || 100;

                        const engine = new CanvasLayoutEngine(tempCanvas, { scale: 1 });
                        engine.renderSnapshot(sectionSnapshot);

                        imgData = tempCanvas.toDataURL('image/png');
                        renderCache.current.set(cacheKey, imgData);
                    }

                    await new Promise((resolve) => {
                        fabric.Image.fromURL(imgData, (img) => {
                            if (currentRenderId !== renderInProgress.current) {
                                resolve();
                                return;
                            }

                            img.set({
                                left: x * scale,
                                top: adjustedY * scale,
                                scaleX: scale,
                                scaleY: scale,
                                selectable: true,
                                hasControls: false,
                                data: { id, type: 'section' }
                            });
                            canvas.add(img);
                            resolve();
                        });
                    });
                }

                // 4. Add Watermark
                const watermark = new fabric.Text('High-Fidelity Canvas Mode', {
                    left: 10,
                    top: (height - 20) * scale,
                    fontSize: 10,
                    fill: '#3b82f6',
                    selectable: false,
                    opacity: 0.3
                });
                canvas.add(watermark);

                if (currentRenderId === renderInProgress.current) {
                    canvas.renderAll();
                    console.log(`[CanvasStage] renderAll #${currentRenderId} complete`);
                }
            } catch (err) {
                console.error(`[CanvasStage] renderAll #${currentRenderId} error:`, err);
            } finally {
                if (currentRenderId === renderInProgress.current) {
                    setIsRendering(false);
                }
            }
        };

        const timer = setTimeout(renderAll, 10); // Small debounce
        return () => {
            clearTimeout(timer);
            // By incrementing renderInProgress outside, we effectively cancel previous renders
        };
    }, [sections, shapes, lines, snapshot, scale, yOffset, width, height]);

    return (
        <div className={`canvas-stage-container ${className}`} style={{ ...style, position: 'relative' }}>
            <canvas ref={canvasRef} />
            {isRendering && (
                <div style={{
                    position: 'absolute',
                    top: 0, left: 0, right: 0, bottom: 0,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(255,255,255,0.3)',
                    zIndex: 10,
                    pointerEvents: 'none'
                }}>
                    <div style={{ fontSize: '10px', color: '#10b981', background: 'white', padding: '4px 8px', borderRadius: '4px', boxShadow: '0 2px 4px rgba(0,0,0,0.1)' }}>
                        Updating...
                    </div>
                </div>
            )}
        </div>
    );
};

export default CanvasStage;
