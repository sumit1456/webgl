# WebGL Renderer Engine

## What is this?
This is a high-performance engine designed to render your resume layouts instantly and with crystal-clear quality. Unlike older methods that take a "screenshot" of your page (which can be slow and blurry html2canvas or html to image), this engine rebuilds your design from scratch using your computer's graphics card (GPU).

## Why is it better?
- **It's Fast**: It renders complex designs in milliseconds.
- **It's Sharp**: Text and shapes stay crisp at any zoom level, they don't get pixelated.
- **It's Accurate**: It perfectly handles advanced styles like gradients, shadows, and rounded corners.

## How does it work? (The Simple Version)
Think of it as a two-step process involving a "Scanner" and an "Artist".

### Step 1: The Scanner (Geometry Snapshot)
First, the engine looks at your HTML page. Instead of taking a photo, it creates a **blueprint**.
- It measures exactly where every box, image, and piece of text is.
- It notes down all the styles: "This box is blue," "This text is bold," "This image has rounded corners."
- This process is super lightweight and happens in the blink of an eye.

### Step 2: The Artist (PixiJS Renderer)
Next, it hands this blueprint to the **PixiJS Renderer**.
- This renderer uses **WebGL**, which is the same technology used for video games in the browser.
- It takes the blueprint and "draws" everything onto a single canvas.
- Because it uses the GPU, it can draw thousands of items instantly without slowing down your computer.

## Key Features
- **3 Rendering Modes**:
  1. **CSS Layout**: The standard way web pages are built (good for editing).
  2. **Geometry Snapshot**: The "Scanner" mode that captures the layout.
  3. **PixiJS Renderer**: The "Artist" mode that draws the final high-quality result.

- **Smart Features**:
  - **Gradients**: Beautiful smooth color transitions.
  - **Clipping**: content stays neatly inside boxes (like images inside circles).
  - **Shadows**: Realistic drop shadows that look great.
