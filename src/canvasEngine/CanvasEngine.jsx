/**
 * CSS Layout Engine for Canvas
 * A complete layout system supporting Flexbox, Grid, and positioning
 * 
 * Usage:
 * const engine = new CanvasLayoutEngine(canvas);
 * const layout = new FlexNode({ flexDirection: 'column' }, [
 *   new TextNode('Hello', { font: '24px Arial' })
 * ]);
 * engine.renderLayoutTree(layout, { x: 0, y: 0, width: 500, height: 300 });
 */

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

// ==================== GEOMETRY SNAPSHOT ENGINE ====================
// Captures DOM layout geometry (positions, styles) 
// Mirroring functionality from WebEngine.jsx for DOM -> Canvas conversion

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

  async capture(element, overrideOptions = {}) {
    if (!element) return null;

    this.captureStartTime = performance.now();
    const options = { ...this.options, ...overrideOptions };
    this.currentMode = options.mode;

    // Store original transform if needed
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

    // New: collect all nodes for deferred style processing
    this.pendingStyles = [];

    this.captureNode(element);

    // Restore transforms
    transforms.forEach(({ element, transform }) => {
      element.style.transform = transform;
    });

    // Resolve workers - Batch all pending styles
    if (this.options.useWorkers && this.styleWorker && this.pendingStyles.length > 0) {
      console.log(`[GeometrySnapshot] Processing ${this.pendingStyles.length} nodes with worker`);
      await this.dispatchAllStyles();
    } else if (this.pendingStyles.length > 0) {
      console.log(`[GeometrySnapshot] Processing ${this.pendingStyles.length} nodes locally`);
      this.pendingStyles.forEach(item => this.processStyleFromRaw(item.nodeData, item.raw));
    }

    if (this.gradientPromises.length > 0) {
      console.log(`[GeometrySnapshot] Resolving ${this.gradientPromises.length} gradients`);
      await Promise.all(this.gradientPromises);
    }

    return {
      nodes: this.nodes,
      width: this.rootWidth,
      height: this.rootHeight,
      stats: { nodeCount: this.nodes.length, captureTime: performance.now() - this.captureStartTime }
    };
  }

  captureNode(element, parentClip = null) {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return;
    if (this.processedNodes.has(element)) return;

    const rect = element.getBoundingClientRect();
    const x = rect.left - this.rootRect.left;
    const y = rect.top - this.rootRect.top;
    const width = rect.width;
    const height = rect.height;

    const computed = window.getComputedStyle(element);
    if (computed.display === 'none' || parseFloat(computed.opacity) === 0) return;

    const type = this.getNodeType(element, computed);

    // Calculate effective clip region
    let currentClip = parentClip;
    if (computed.overflow === 'hidden' || computed.overflow === 'auto') {
      const myClip = { x, y, width, height, radius: parseFloat(computed.borderRadius) || 0 };
      if (parentClip) {
        // Intersect parent clip and my clip
        const x1 = Math.max(parentClip.x, myClip.x);
        const y1 = Math.max(parentClip.y, myClip.y);
        const x2 = Math.min(parentClip.x + parentClip.width, myClip.x + myClip.width);
        const y2 = Math.min(parentClip.y + parentClip.height, myClip.y + myClip.height);

        if (x2 > x1 && y2 > y1) {
          currentClip = { x: x1, y: y1, width: x2 - x1, height: y2 - y1, radius: myClip.radius }; // Simplification: using newest radius
          // NOTE: Nested rounded clipping is hard; we prioritize the immediate clipper's radius or rectangle intersection
        } else {
          currentClip = { x: 0, y: 0, width: 0, height: 0, radius: 0 }; // Fully clipped
        }
      } else {
        currentClip = myClip;
      }
    }

    const nodeData = {
      type,
      x, y, width, height,
      styles: {},
      zIndex: parseInt(computed.zIndex) || 0,
      clip: parentClip // Store the clip region inherited from parent to apply to THIS node (Wait, parentClip clips ME, currentClip clips MY CHILDREN)
    };
    // FIX: The clip applied to `this` node is `parentClip`. 
    // The clip applied to `children` is `currentClip`.

    // Correction: If *I* have overflow:hidden, that shouldn't clip *ME* (except border-radius maybe?), it clips my CHILDREN.
    // However, if my parent had overflow:hidden, that clips ME.
    // So `nodeData.clip` should be `parentClip`.

    // Extract basic styles immediately, defer complex ones
    const styles = nodeData.styles;
    styles.opacity = parseFloat(computed.opacity) || 1;
    styles.zIndex = computed.zIndex !== 'auto' ? parseInt(computed.zIndex) : 0;
    styles.display = computed.display;

    if (computed.backgroundImage && computed.backgroundImage !== 'none') {
      if (this.gradientWorker && this.options.useWorkers) {
        this.gradientPromises.push(this.dispatchGradientTask(nodeData, computed.backgroundImage));
      } else {
        styles.gradient = this.parseGradient(computed.backgroundImage);
      }
    }

    const raw = this.extractRawStyles(element, computed);
    this.pendingStyles.push({ nodeData, raw });

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

    // Handle background text for boxes
    if (type === 'box') {
      const directTextNodes = Array.from(element.childNodes)
        .filter(n => n.nodeType === Node.TEXT_NODE && n.textContent.trim().length > 0);
      if (directTextNodes.length > 0) {
        nodeData.text = directTextNodes.map(n => n.textContent).join(' ').trim();
      }
    }

    this.nodes.push(nodeData);

    // Pass the calculated 'currentClip' (which includes my own overflow if hidden) to children
    if (type !== 'text') {
      for (const child of element.children) {
        this.captureNode(child, currentClip);
      }
    }
  }

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
    const isTextElement = ['SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'STRONG', 'EM', 'B', 'I', 'LABEL', 'A', 'LI'].includes(element.tagName);
    const hasLeafText = Array.from(element.children).every(child =>
      ['BR', 'WBR', 'SPAN', 'STRONG', 'EM', 'B', 'I'].includes(child.tagName)
    );

    if (isTextElement && textContent.length > 0 && hasLeafText) return 'text';

    return 'box';
  }

  // Removed extractStyles and processStyleLocally in favor of a clean deferral

  extractRawStyles(element, computed) {
    const raw = {
      backgroundColor: computed.backgroundColor,
      backgroundImage: computed.backgroundImage,
      borderTopWidth: computed.borderTopWidth,
      borderTopColor: computed.borderTopColor,
      borderTopStyle: computed.borderTopStyle,
      borderRadius: computed.borderRadius,
      color: computed.color,
      fontSize: computed.fontSize,
      fontFamily: computed.fontFamily,
      fontWeight: computed.fontWeight,
      fontStyle: computed.fontStyle,
      textAlign: computed.textAlign,
      paddingTop: computed.paddingTop,
      paddingRight: computed.paddingRight,
      paddingBottom: computed.paddingBottom,
      paddingLeft: computed.paddingLeft,
      boxShadow: computed.boxShadow,
      transform: computed.transform,
      lineHeight: computed.lineHeight,
      opacity: computed.opacity,
      // New properties for text rendering
      letterSpacing: computed.letterSpacing,
      whiteSpace: computed.whiteSpace,
      wordBreak: computed.wordBreak
    };

    if (raw.backgroundColor !== 'rgba(0, 0, 0, 0)' && raw.backgroundColor !== 'transparent') {
      // Only log if it has a background to avoid spam
      // console.log(`[GeometrySnapshot] Extracted raw styles:`, { bg: raw.backgroundColor });
    }

    return raw;
  }

  processStyleFromRaw(nodeData, raw) {
    Object.assign(nodeData.styles, {
      backgroundColor: raw.backgroundColor,
      backgroundImage: raw.backgroundImage,
      borderWidth: parseFloat(raw.borderTopWidth) || 0,
      borderColor: raw.borderTopColor,
      borderStyle: raw.borderTopStyle,
      borderRadius: raw.borderRadius.includes('%') ? raw.borderRadius : (parseFloat(raw.borderRadius) || 0),
      color: raw.color,
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

    // Only parse locally if NOT handled by worker (worker sets styles.gradient directly)
    if (!nodeData.styles.gradient && raw.backgroundImage && raw.backgroundImage !== 'none') {
      const gradient = this.parseGradient(raw.backgroundImage);
      if (gradient) nodeData.styles.gradient = gradient;
    }
  }

  dispatchAllStyles() {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).substr(2, 9);
      const rawStylesBatch = this.pendingStyles.map(p => p.raw);

      // console.log(`[GeometrySnapshot] Dispatching ALL ${rawStylesBatch.length} styles to worker (ID: ${id})`);

      const handler = (e) => {
        if (e.data.type === 'STYLES_PROCESSED' && e.data.id === id) {
          // console.log(`[GeometrySnapshot] Received processed styles from worker (ID: ${id})`);
          e.data.processedBatch.forEach((styles, i) => {
            Object.assign(this.pendingStyles[i].nodeData.styles, styles);
          });
          this.styleWorker.removeEventListener('message', handler);
          resolve();
        }
      };
      this.styleWorker.addEventListener('message', handler);
      this.styleWorker.postMessage({ type: 'PARSE_STYLES', id, data: { rawStylesBatch } });
    });
  }

  dispatchGradientTask(nodeData, bgImage) {
    return new Promise((resolve) => {
      const id = Math.random().toString(36).substr(2, 9);
      const handler = (e) => {
        if (e.data.type === 'GRADIENT_PARSED' && e.data.id === id) {
          nodeData.styles.gradient = e.data.gradient;
          this.gradientWorker.removeEventListener('message', handler);
          resolve();
        }
      };
      this.gradientWorker.addEventListener('message', handler);
      this.gradientWorker.postMessage({ type: 'PARSE_GRADIENT', id, data: { backgroundImage: bgImage } });
    });
  }

  parseGradient(bgImage) {
    if (!bgImage || bgImage === 'none') return null;

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
    let result = null;

    // Match linear or radial gradient
    const linearMatch = cleanBg.match(/linear-gradient\((.*)\)/s);
    const radialMatch = cleanBg.match(/radial-gradient\((.*)\)/s);

    if (linearMatch) {
      result = this.parseLinearGradient(linearMatch[1].trim());
    } else if (radialMatch) {
      result = this.parseRadialGradient(radialMatch[1].trim());
    }

    return result;
  }

  parseLinearGradient(content) {
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
}

// ==================== BASE LAYOUT NODE ====================

class LayoutNode {
  constructor(props = {}, children = []) {
    this.props = props;
    this.children = Array.isArray(children) ? children : [];
    this.bounds = null;
    this.intrinsicSize = null;
    this.parent = null;

    // Link children to parent
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

  // Helper to render background and borders
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

// ==================== FLEX LAYOUT NODE ====================

class FlexNode extends LayoutNode {
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

// ==================== GRID LAYOUT NODE ====================

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

// ==================== TEXT NODE ====================

class TextNode extends LayoutNode {
  constructor(content, props = {}) {
    super(props, []);
    this.content = content;
  }

  measure(constraints) {
    const {
      font = '16px Arial',
      maxWidth = constraints.maxWidth,
      lineHeight
    } = this.props;

    // Create temporary canvas for measurement if needed
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = font;

    const fontSize = parseInt(font) || 16;
    const lh = lineHeight || fontSize * 1.2;

    if (maxWidth === Infinity || !maxWidth) {
      // Single line
      const metrics = ctx.measureText(this.content);
      this.intrinsicSize = {
        width: metrics.width,
        height: lh
      };
    } else {
      // Wrapped text
      const lines = this.wrapText(ctx, this.content, maxWidth);
      this.intrinsicSize = {
        width: maxWidth,
        height: lines.length * lh
      };
    }

    return this.intrinsicSize;
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

  layout(bounds) {
    this.bounds = bounds;
  }

  render(engine) {
    if (!this.bounds) return;

    const {
      font = '16px Arial',
      color = '#000000',
      textAlign = 'left',
      lineHeight
    } = this.props;

    const ctx = engine.ctx;
    ctx.font = font;
    ctx.fillStyle = color;
    ctx.textBaseline = 'top';

    const fontSize = parseInt(font) || 16;
    const lh = lineHeight || fontSize * 1.2;

    const lines = this.wrapText(ctx, this.content, this.bounds.width);

    lines.forEach((line, i) => {
      let x = this.bounds.x;
      const y = this.bounds.y + (i * lh);

      if (textAlign === 'center') {
        const metrics = ctx.measureText(line);
        x = this.bounds.x + (this.bounds.width - metrics.width) / 2;
      } else if (textAlign === 'right') {
        const metrics = ctx.measureText(line);
        x = this.bounds.x + this.bounds.width - metrics.width;
      }

      ctx.fillText(line, x, y);
    });
  }
}

// ==================== BLOCK NODE ====================

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

// ==================== IMAGE NODE ====================

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

// ==================== SPACER NODE ====================

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

// ==================== CANVAS LAYOUT ENGINE ====================

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
    console.log('Phase 1: Measuring...');
    const intrinsicSize = rootNode.measure({
      maxWidth: bounds.width,
      maxHeight: bounds.height
    });
    console.log('Intrinsic size:', intrinsicSize);

    // Phase 2: Layout
    console.log('Phase 2: Layout...');
    rootNode.layout(bounds);

    // Phase 3: Render
    console.log('Phase 3: Rendering...');
    rootNode.render(this);

    console.log('✓ Render complete');
  }

  /**
   * Render a snapshot captured by GeometrySnapshot
   */
  renderSnapshot(snapshot) {
    if (!snapshot || !snapshot.nodes) {
      console.warn('[CanvasLayoutEngine] renderSnapshot called with empty snapshot');
      return;
    }

    console.log(`[CanvasLayoutEngine] Rendering dynamic snapshot:`, {
      nodes: snapshot.nodes.length,
      width: snapshot.width,
      height: snapshot.height,
      scale: this.scale
    });

    // Clear and scale
    this.initialize(snapshot.width, snapshot.height);

    // Sort by z-index
    const sortedNodes = [...snapshot.nodes].sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));

    for (const node of sortedNodes) {
      this.renderSnapshotNode(node);
    }
  }

  renderSnapshotNode(node) {
    const { x, y, width, height, type, styles, text, src } = node;
    const ctx = this.ctx;

    // Granular debug for ALL nodes
    const hasBg = styles.backgroundColor && styles.backgroundColor !== 'transparent' && styles.backgroundColor !== 'rgba(0, 0, 0, 0)';
    this.renderNode(this.ctx, node);
  }
  renderNode(ctx, node) {
    const { x, y, width, height, styles, type, text, src } = node;

    ctx.save();

    // 0. CLIP (Parent Overflow)
    if (node.clip) {
      ctx.beginPath();
      if (node.clip.radius > 0) {
        this.roundRect(ctx, node.clip, node.clip.radius);
      } else {
        ctx.rect(node.clip.x, node.clip.y, node.clip.width, node.clip.height);
      }
      ctx.clip();
    }

    // Handle transform (matrix from computed style)
    if (styles.transform && styles.transform !== 'none') {
      const matrixMatch = styles.transform.match(/matrix\(([^)]+)\)/);
      if (matrixMatch) {
        // CSS matrix: matrix(a, b, c, d, tx, ty)
        const [a, b, c, d, tx, ty] = matrixMatch[1].split(',').map(v => parseFloat(v));

        // Canvas transform: context.transform(a, b, c, d, e, f)
        // Note: CSS transform origin is usually center, but here we might need adjustment.
        // However, since we capture absolute positions (x,y) from getBoundingClientRect, 
        // the transform might already be "baked in" to the rect for position, 
        // BUT rotation needs to be applied locally.
        // Actually, GeometrySnapshot removes transform from element to get untransformed rect, 
        // then restores it. So 'x, y' are UNTRANSFORMED positions relative to root.
        // We need to translate to center, rotate, translate back? 
        // Standard CSS matrix applies to the element origin (50% 50% usually).

        // Simplified approach: Apply matrix at the element's position
        // We need to move origin to x,y, apply matrix, move back?
        // No, CSS matrix includes translation (tx, ty). 
        // But our X/Y are already derived relative to root.

        // Let's rely on the raw styles.transform which is what we captured.
        // For a robust implementation we ideally need transform-origin.
        // For now, let's just apply it relative to the element's top-left or try to mimic standard flow.

        // If we apply transform, we affect x/y. 
        // Let's assume the matrix applies to local coordinate system at 0,0 
        // but we are drawing at x,y.

        // Safe bet for now: Translate to x,y, apply rotation components of matrix, Draw at 0,0.
        // But matrix has translation too.

        // Let's just try standard matrix application.
        // The previous working code was:
        // ctx.transform(a, b, c, d, tx, ty); 
        // But that applies to the whole context.

        // Correct way for isolated element:
        // 1. Translate to center of element
        // 2. Apply transform
        // 3. Translate back

        // Wait, the 'matrix' from computed style is the *accumulated* matrix if we aren't careful, 
        // but we captured it from the specific element.

        // Re-adding the previous simple logic:
        ctx.translate(x + width / 2, y + height / 2);
        ctx.transform(a, b, c, d, 0, 0); // Ignore tx/ty for now as we have absolute x/y
        ctx.translate(-(x + width / 2), -(y + height / 2));
      }
    }

    // 0. GLOBAL OPACITY
    if (styles.opacity !== undefined) {
      ctx.globalAlpha = styles.opacity;
    }

    // 1. SHADOW
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


    // 2. BACKGROUND & GRADIENT
    if (styles.backgroundColor && styles.backgroundColor !== 'transparent' && styles.backgroundColor !== 'rgba(0, 0, 0, 0)') {
      ctx.fillStyle = styles.backgroundColor;
      if (radius > 0) {
        this.roundRect(ctx, { x, y, width, height }, radius);
        ctx.fill();
        ctx.shadowColor = 'transparent'; // clear after fill
      } else {
        ctx.fillRect(x, y, width, height);
        ctx.shadowColor = 'transparent';
      }
    }

    // Gradient Handling
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
        try {
          if (stop.color && stop.color !== 'circle' && stop.color !== 'ellipse' && !stop.color.includes(' at ')) {
            gradient.addColorStop(stop.position, stop.color);
          }
        } catch (e) {
          console.warn('[CanvasLayoutEngine] Invalid gradient stop:', stop, e);
        }
      });

      ctx.fillStyle = gradient;
      if (radius > 0) {
        this.roundRect(ctx, { x, y, width, height }, radius);
        ctx.fill();
      } else {
        ctx.fillRect(x, y, width, height);
      }
      ctx.shadowColor = 'transparent';
    }


    // 3. BORDER (Dashed/Dotted Support)
    if (styles.borderWidth > 0 && styles.borderStyle !== 'none') {
      const bColor = styles.borderColor || '#000';
      ctx.strokeStyle = bColor;
      ctx.lineWidth = styles.borderWidth;

      if (styles.borderStyle === 'dashed') {
        ctx.setLineDash([styles.borderWidth * 3, styles.borderWidth * 2]);
      } else if (styles.borderStyle === 'dotted') {
        ctx.setLineDash([styles.borderWidth, styles.borderWidth]);
      } else {
        ctx.setLineDash([]);
      }

      if (radius > 0) {
        this.roundRect(ctx, { x, y, width, height }, radius);
        ctx.stroke();
      } else {
        ctx.strokeRect(x, y, width, height);
      }
      ctx.setLineDash([]); // Reset
    }

    // 4. IMAGE
    if (type === 'image' && src) {
      const img = new Image();
      img.src = src;
      if (img.complete && img.width > 0) {
        if (radius > 0) {
          ctx.save();
          this.roundRect(ctx, { x, y, width, height }, radius);
          ctx.clip();
          ctx.drawImage(img, x, y, width, height);
          ctx.restore();
        } else {
          ctx.drawImage(img, x, y, width, height);
        }
      }
    }

    // 5. TEXT
    if (type === 'text' && text) {
      this.renderText(ctx, node);
    }

    ctx.restore();
  }

  renderText(ctx, node) {
    const { x, y, width, height, text, styles } = node;
    const fontSize = styles.fontSize || 12;
    const fontFamily = styles.fontFamily || 'Arial';
    const fontWeight = styles.fontWeight || 'normal';
    const fontStyle = styles.fontStyle || 'normal';

    ctx.font = `${fontStyle} ${fontWeight} ${fontSize}px ${fontFamily}`;
    ctx.fillStyle = styles.color || '#000';
    ctx.textBaseline = 'top';

    // Alignment
    const align = styles.textAlign || 'left';
    const lineHeight = styles.lineHeight || fontSize * 1.2;
    const padding = styles.padding || { left: 0, top: 0, right: 0 };

    const words = text.split(' ');
    let line = '';
    let lineY = y + (padding.top || 0);

    const maxWidth = width - ((padding.left || 0) + (padding.right || 0));
    const startX = x + (padding.left || 0);

    for (let n = 0; n < words.length; n++) {
      const testLine = line + words[n] + ' ';
      const metrics = ctx.measureText(testLine);

      if (metrics.width > maxWidth && n > 0) {
        this.fillTextLine(ctx, line, startX, lineY, maxWidth, align);
        line = words[n] + ' ';
        lineY += lineHeight;
      }
      else {
        line = testLine;
      }
    }
    this.fillTextLine(ctx, line, startX, lineY, maxWidth, align);
  }

  fillTextLine(ctx, text, x, y, maxWidth, align) {
    if (align === 'center') {
      const metrics = ctx.measureText(text);
      ctx.fillText(text, x + (maxWidth - metrics.width) / 2, y);
    } else if (align === 'right') {
      const metrics = ctx.measureText(text);
      ctx.fillText(text, x + maxWidth - metrics.width, y);
    } else {
      ctx.fillText(text, x, y);
    }
  }

  roundRect(ctx, bounds, radius) {
    const { x, y, width: w, height: h } = bounds;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.arcTo(x + w, y, x + w, y + radius, radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
    ctx.lineTo(x + radius, y + h);
    ctx.arcTo(x, y + h, x, y + h - radius, radius);
    ctx.lineTo(x, y + radius);
    ctx.arcTo(x, y, x + radius, y, radius);
    ctx.closePath();
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

/**
 * Parse CSS-like config to Layout Nodes
 */
function parseConfigToLayout(config, data) {
  const { display = 'block', children = [], ...props } = config;

  // Parse children
  const childNodes = children.map(child => {
    if (typeof child === 'string') {
      // Text content
      return new TextNode(child, props);
    } else if (child.type === 'text') {
      // Explicit text node
      return new TextNode(child.content, child.props || {});
    } else if (child.type === 'image') {
      // Image node
      return new ImageNode(child.src, child.props || {});
    } else if (child.type === 'spacer') {
      // Spacer node
      return new SpacerNode(child.size, child.props || {});
    } else {
      // Nested layout
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

// ==================== EXPORT ====================

export {
  CanvasLayoutEngine,
  LayoutNode,
  FlexNode,
  GridNode,
  BlockNode,
  TextNode,
  ImageNode,
  SpacerNode,
  GeometrySnapshot,
  parseConfigToLayout
};

// ==================== USAGE EXAMPLES ====================

/*

// Example 1: Simple Flex Layout
const canvas = document.createElement('canvas');
const engine = new CanvasLayoutEngine(canvas, { scale: 2 });
engine.initialize(500, 300);

const layout = new FlexNode({
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 16,
  padding: 20,
  backgroundColor: '#f5f5f5'
}, [
  new TextNode('Hello World', {
    font: 'bold 32px Arial',
    color: '#333'
  }),
  new TextNode('This is a flex layout', {
    font: '16px Arial',
    color: '#666'
  })
]);

engine.renderLayoutTree(layout, { x: 0, y: 0, width: 500, height: 300 });
document.body.appendChild(canvas);


// Example 2: Grid Layout
const gridLayout = new GridNode({
  gridTemplateColumns: ['1fr', '2fr', '1fr'],
  gridTemplateRows: ['auto', '1fr', 'auto'],
  gap: 16,
  padding: 20,
  backgroundColor: '#ffffff'
}, [
  new TextNode('Header', {
    font: 'bold 24px Arial',
    gridArea: '1 / 1 / 1 / 4',
    backgroundColor: '#007bff',
    color: '#fff',
    padding: 10
  }),
  new TextNode('Sidebar', {
    font: '14px Arial',
    backgroundColor: '#e9ecef'
  }),
  new TextNode('Main Content', {
    font: '16px Arial'
  }),
  new TextNode('Right Sidebar', {
    font: '14px Arial',
    backgroundColor: '#e9ecef'
  }),
  new TextNode('Footer', {
    font: '12px Arial',
    gridArea: '3 / 1 / 3 / 4',
    backgroundColor: '#6c757d',
    color: '#fff',
    padding: 10
  })
]);


// Example 3: Complex Nested Layout (Resume Header)
const resumeHeader = new FlexNode({
  flexDirection: 'column',
  gap: 8,
  padding: 40,
  backgroundColor: '#ffffff'
}, [
  // Name section with centered layout
  new FlexNode({
    flexDirection: 'column',
    alignItems: 'center',
    gap: 4
  }, [
    new TextNode('John Doe', {
      font: 'bold 32px Arial',
      color: '#000'
    }),
    new TextNode('Senior Software Engineer', {
      font: '16px Arial',
      color: '#c53a3a'
    })
  ]),
  
  // Contact section
  new FlexNode({
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 20,
    marginTop: 16
  }, [
    new TextNode('email@example.com', {
      font: '12px Arial',
      color: '#666'
    }),
    new TextNode('(555) 123-4567', {
      font: '12px Arial',
      color: '#666'
    }),
    new TextNode('linkedin.com/in/johndoe', {
      font: '12px Arial',
      color: '#666'
    })
  ])
]);


// Example 4: Using Config Parser
const config = {
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  padding: 20,
  children: [
    {
      type: 'text',
      content: 'Title',
      props: {
        font: 'bold 24px Arial'
      }
    },
    {
      display: 'grid',
      gridTemplateColumns: ['1fr', '1fr'],
      gap: 12,
      children: [
        { type: 'text', content: 'Item 1' },
        { type: 'text', content: 'Item 2' },
        { type: 'text', content: 'Item 3' },
        { type: 'text', content: 'Item 4' }
      ]
    }
  ]
};

const layoutFromConfig = parseConfigToLayout(config, {});
engine.renderLayoutTree(layoutFromConfig, { x: 0, y: 0, width: 500, height: 400 });


// Example 5: Flex Properties (grow, shrink, basis)
const flexProps = new FlexNode({
  flexDirection: 'row',
  gap: 10,
  padding: 20,
  height: 200
}, [
  new BlockNode({
    backgroundColor: '#ff6b6b',
    flexBasis: 100,
    flexGrow: 0,
    flexShrink: 0
  }),
  new BlockNode({
    backgroundColor: '#4ecdc4',
    flexGrow: 2  // Takes twice as much space as the next one
  }),
  new BlockNode({
    backgroundColor: '#45b7d1',
    flexGrow: 1
  })
]);


// Example 6: Alignment Examples
const alignmentDemo = new FlexNode({
  flexDirection: 'column',
  gap: 20,
  padding: 20
}, [
  // justify-content examples
  new FlexNode({
    flexDirection: 'row',
    justifyContent: 'space-between',
    height: 50,
    backgroundColor: '#f0f0f0'
  }, [
    new TextNode('A'),
    new TextNode('B'),
    new TextNode('C')
  ]),
  
  new FlexNode({
    flexDirection: 'row',
    justifyContent: 'center',
    height: 50,
    backgroundColor: '#f0f0f0'
  }, [
    new TextNode('Centered')
  ]),
  
  new FlexNode({
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    height: 50,
    backgroundColor: '#f0f0f0'
  }, [
    new TextNode('1'),
    new TextNode('2'),
    new TextNode('3'),
    new TextNode('4')
  ])
]);

*/