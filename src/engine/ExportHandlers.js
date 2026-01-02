/**
 * WebGL Engine Export Handlers
 * 
 * This file contains standalone logic for exporting the WebGL stage
 * to various formats (PNG, PDF, JS).
 */

import { jsPDF } from "jspdf";

/**
 * Export the WebGL Stage as a PNG image
 */
export const exportToPNG = async (webGLStageRef, filename = 'preview.png') => {
    const app = webGLStageRef.current?.app;
    if (!app) {
        console.error("❌ WebGL App not found");
        return;
    }

    try {
        const canvas = await app.renderer.extract.canvas(app.stage);
        const uri = canvas.toDataURL('image/png', 1.0);

        const link = document.createElement('a');
        link.download = filename;
        link.href = uri;
        link.click();
        console.log(`✅ PNG downloaded: ${filename}`);
    } catch (err) {
        console.error('Failed to download PNG:', err);
    }
};

/**
 * Export the WebGL Stage(s) as a Multi-page PDF
 */
export const exportToPDF = async (options = {}) => {
    const {
        stageRef1,
        stageRef2,
        showPage2,
        filename = 'preview.pdf'
    } = options;

    const app1 = stageRef1.current?.app;
    if (!app1) {
        console.error("❌ WebGL App not found for Page 1");
        return;
    }

    try {
        console.log('📄 Starting PDF Generation...');
        const pdf = new jsPDF('p', 'pt', 'a4');
        const width = pdf.internal.pageSize.getWidth();
        const height = pdf.internal.pageSize.getHeight();

        // Page 1
        const canvas1 = await app1.renderer.extract.canvas(app1.stage);
        const imgData1 = canvas1.toDataURL('image/png', 1.0);
        pdf.addImage(imgData1, 'PNG', 0, 0, width, height);

        // Page 2
        if (showPage2) {
            const app2 = stageRef2.current?.app;
            if (app2) {
                const canvas2 = await app2.renderer.extract.canvas(app2.stage);
                const imgData2 = canvas2.toDataURL('image/png', 1.0);
                pdf.addPage();
                pdf.addImage(imgData2, 'PNG', 0, 0, width, height);
            }
        }

        pdf.save(filename);
        console.log(`✅ PDF downloaded: ${filename}`);
    } catch (err) {
        console.error('Failed to download PDF:', err);
    }
};

/**
 * Export the Engine Geometry Snapshot as a JS Module
 */
export const exportToJS = (options = {}) => {
    const {
        snapshots,
        positions,
        lines,
        shapes,
        styleConfig,
        showPage2,
        metadata = {},
        filename = 'snapshot.js'
    } = options;

    try {
        const data = {
            snapshots,
            positions,
            lines,
            shapes,
            styleConfig,
            showPage2,
            metadata: {
                exportedAt: new Date().toISOString(),
                ...metadata
            }
        };

        const fileContent = `/**
 * WebGL Engine Snapshot Export
 * Generated: ${new Date().toLocaleString()}
 */
export const engineSnapshotData = ${JSON.stringify(data, null, 2)};
`;

        const blob = new Blob([fileContent], { type: 'application/javascript' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 100);

        console.log(`✅ Snapshot exported: ${filename}`);
    } catch (err) {
        console.error('Failed to export JS snapshot:', err);
    }
};
