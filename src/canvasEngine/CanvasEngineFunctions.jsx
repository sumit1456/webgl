/**
 * CanvasEngineFunctions.jsx
 * Safe versions of resume layout and rendering functions
 */

import {
  CanvasLayoutEngine,
  FlexNode,
  GridNode,
  TextNode,
  BlockNode,
  SpacerNode,
  GeometrySnapshot
} from "./CanvasEngine.jsx";

// ==================== UTILITIES ====================

export function parseSize(value, fallback = 0) {
  if (!value) return fallback;
  if (typeof value === 'number') return value;
  const parsed = parseInt(value);
  return isNaN(parsed) ? fallback : parsed;
}

// Helper to safely extract string from various data types
export function extractText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.filter(Boolean).join('\n');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

// Helper to convert array of items to text nodes
export function arrayToTextNodes(items = [], style = {}) {
  if (!Array.isArray(items)) return [];
  return items.filter(Boolean).map(item =>
    new TextNode(extractText(item), style)
  );
}

// Helper to safely get nested property
export function getSafe(obj, path, defaultValue = '') {
  if (!obj) return defaultValue;
  const keys = path.split('.');
  let result = obj;
  for (const key of keys) {
    if (result && typeof result === 'object' && key in result) {
      result = result[key];
    } else {
      return defaultValue;
    }
  }
  return result;
}

// ==================== CONFIG TO LAYOUT ====================

export function configToLayout(config = {}, children = []) {
  const {
    display = 'block',
    flexDirection,
    justifyContent,
    alignItems,
    gap,
    padding,
    margin,
    backgroundColor,
    width,
    height,
    gridTemplateColumns,
    gridTemplateRows,
    columnGap,
    rowGap,
    ...otherProps
  } = config;

  const props = {
    ...otherProps,
    padding: parseSize(padding),
    margin: parseSize(margin),
    backgroundColor,
    width,
    height
  };

  if (display === 'flex') {
    return new FlexNode({
      ...props,
      flexDirection,
      justifyContent,
      alignItems,
      gap: parseSize(gap)
    }, children);
  }

  if (display === 'grid') {
    return new GridNode({
      ...props,
      gridTemplateColumns,
      gridTemplateRows,
      gap: parseSize(gap),
      columnGap: parseSize(columnGap),
      rowGap: parseSize(rowGap)
    }, children);
  }

  return new BlockNode(props, children);
}

// ==================== HEADER LAYOUT ====================

export function buildHeaderLayout(resumeData = {}, config = {}) {
  const data = resumeData.resumeDetails || {};
  const {
    mainLayout = {},
    nameSection = {},
    contactLayout = {},
    nameStyle = {},
    titleStyle = {},
    contactItemStyle = {},
    contactOrder = [],
    showTitle = true,
    showContact = true
  } = config;

  // Safe name section
  const nameChildren = [];
  if (data.name) {
    nameChildren.push(new TextNode(data.name, {
      font: `${nameStyle.fontWeight || 'bold'} ${nameStyle.fontSize || 14}px Arial`,
      color: nameStyle.color || '#000',
      textAlign: 'center'
    }));
  }

  if (showTitle && data.title) {
    nameChildren.push(new TextNode(data.title, {
      font: `${titleStyle.fontWeight || 'normal'} ${titleStyle.fontSize || 12}px Arial`,
      color: titleStyle.color || '#666',
      textAlign: 'center'
    }));
  }

  const nameSectionNode = new FlexNode({
    flexDirection: nameSection.flexDirection || 'column',
    justifyContent: nameSection.justifyContent || 'center',
    alignItems: nameSection.alignItems || 'center',
    gap: parseSize(nameSection.gap || 4)
  }, nameChildren);

  // Safe contact section
  const contactChildren = [];
  if (showContact && data.contact) {
    contactOrder.forEach(type => {
      const value = data.contact[type];
      if (value) {
        contactChildren.push(new TextNode(value, {
          font: `${contactItemStyle.fontSize || 10}px Arial`,
          color: contactItemStyle.color || '#000'
        }));
      }
    });
  }

  const contactSectionNode = new FlexNode({
    flexDirection: contactLayout.flexDirection || 'row',
    alignItems: contactLayout.alignItems || 'center',
    gap: parseSize(contactLayout.gap || 4)
  }, contactChildren);

  // Main layout
  return new FlexNode({
    flexDirection: mainLayout.flexDirection || 'column',
    gap: parseSize(mainLayout.gap || 8),
    padding: parseSize(config.container?.padding || 0)
  }, [nameSectionNode, contactSectionNode]);
}

// ==================== RENDER FUNCTION ====================

export function renderHeaderWithLayoutEngine(resumeData, config) {
  const canvas = document.createElement('canvas');
  const engine = new CanvasLayoutEngine(canvas, { scale: 6 });

  const width = parseSize(config.container?.width, 500);
  const height = 200;

  engine.initialize(width, height);

  const layout = buildHeaderLayout(resumeData, config);
  engine.renderLayoutTree(layout, { x: 0, y: 0, width, height });

  return engine.toImage();
}

/**
 * Capture a DOM element and render it to a Canvas image
 */
export async function captureDOMToCanvas(element, options = {}) {
  if (!element) return null;

  const scale = options.scale || 4;
  const snapshotter = new GeometrySnapshot({
    mode: options.mode || 'performance',
    styleWorker: options.styleWorker,
    gradientWorker: options.gradientWorker
  });
  const snapshot = await snapshotter.capture(element);

  if (!snapshot) return null;

  const canvas = document.createElement('canvas');
  const engine = new CanvasLayoutEngine(canvas, { scale });

  const renderStart = performance.now();
  engine.renderSnapshot(snapshot);
  const renderTime = performance.now() - renderStart;

  const img = await engine.toImage();

  return {
    src: img.src,
    stats: {
      nodeCount: snapshot.stats.nodeCount,
      captureTime: snapshot.stats.captureTime,
      renderTime: renderTime
    }
  };
}

// ==================== ADVANCED EXAMPLES ====================

export function buildTwoColumnResume(resumeData = {}) {
  const details = resumeData.resumeDetails || {};
  const skills = resumeData.skills || [];
  const experiences = resumeData.experiences || [];

  return new FlexNode({
    flexDirection: 'row',
    gap: 0
  }, [
    new FlexNode({
      flexDirection: 'column',
      width: '240px',
      backgroundColor: '#1a1a1a',
      padding: 20,
      gap: 12
    }, [
      new TextNode('SKILLS', { font: 'bold 14px Arial', color: '#fff', textAlign: 'center' }),
      ...arrayToTextNodes(skills.slice(0, 6), { font: '11px Arial', color: '#ccc', lineHeight: 16 })
    ]),
    new FlexNode({
      flexDirection: 'column',
      flexGrow: 1,
      backgroundColor: '#fff',
      padding: 20,
      gap: 12
    }, [
      new TextNode('EXPERIENCE', { font: 'bold 14px Arial', color: '#000' }),
      ...experiences.slice(0, 2).map(exp => new FlexNode({ flexDirection: 'column', gap: 4, marginBottom: 12 }, [
        new TextNode(exp.position || '', { font: 'bold 12px Arial', color: '#000' }),
        new TextNode(`${exp.company || ''} • ${exp.duration || ''}`, { font: '10px Arial', color: '#666' }),
        ...arrayToTextNodes((exp.achievements || []).slice(0, 2), { font: '10px Arial', color: '#333', lineHeight: 14 })
      ]))
    ])
  ]);
}

export function buildSkillsGrid(skills = []) {
  const skillNodes = skills.map(skill => new BlockNode({
    backgroundColor: '#f0f0f0',
    padding: 8,
    borderRadius: 4
  }, [new TextNode(extractText(skill), { font: '11px Arial', color: '#333', textAlign: 'center' })]));

  return new GridNode({ gridTemplateColumns: ['1fr', '1fr', '1fr', '1fr'], gap: 12, padding: 12 }, skillNodes);
}

export function buildExperienceTimeline(experiences = []) {
  const experienceNodes = experiences.map(exp => {
    const achievements = exp.achievements || exp.description || [];
    const achievementList = Array.isArray(achievements) ? achievements : [achievements];

    return new FlexNode({
      flexDirection: 'row',
      gap: 12,
      marginBottom: 12
    }, [
      new BlockNode({ width: '120px', flexShrink: 0 }, [
        new TextNode(exp.duration || '', { font: 'bold 10px Arial', color: '#666' })
      ]),
      new FlexNode({ flexDirection: 'column', gap: 4, flexGrow: 1 }, [
        new TextNode(exp.position || '', { font: 'bold 12px Arial', color: '#000' }),
        new TextNode(exp.company || '', { font: '10px Arial', color: '#666' }),
        ...achievementList.slice(0, 3).map(item =>
          new TextNode(`• ${extractText(item)}`, { font: '11px Arial', color: '#333', lineHeight: 16 })
        )
      ])
    ]);
  });

  return new FlexNode({ flexDirection: 'column', padding: 12 }, experienceNodes);
}

export function buildCompleteResume(resumeData = {}) {
  const details = resumeData.resumeDetails || {};
  const { name = '', title = '', summary = '' } = details;
  const contact = details.contact || {};
  const { email = '', phone = '', location = '' } = contact;
  const skills = resumeData.skills || [];
  const educationList = resumeData.educationList || [];
  const experiences = resumeData.experiences || [];
  const projects = resumeData.projects || [];
  const certifications = resumeData.certifications || [];

  return new FlexNode({ flexDirection: 'column', width: '595px', backgroundColor: '#fff' }, [
    new FlexNode({ flexDirection: 'column', alignItems: 'center', gap: 8, padding: 20, backgroundColor: '#f8f9fa' }, [
      new TextNode(name, { font: 'bold 32px Arial', color: '#000' }),
      new TextNode(title, { font: '16px Arial', color: '#c53a3a' }),
      new FlexNode({ flexDirection: 'row', gap: 8, marginTop: 8 }, [
        email ? new TextNode(email, { font: '10px Arial', color: '#666' }) : null,
        phone ? new TextNode(phone, { font: '10px Arial', color: '#666' }) : null,
        location ? new TextNode(location, { font: '10px Arial', color: '#666' }) : null
      ].filter(Boolean))
    ]),
    summary ? new BlockNode({ padding: 12, borderBottom: '1px solid #e0e0e0' }, [
      new TextNode('PROFESSIONAL SUMMARY', { font: 'bold 14px Arial', color: '#000', marginBottom: 8 }),
      new TextNode(summary, { font: '11px Arial', color: '#333', lineHeight: 16 })
    ]) : null,
    new FlexNode({ flexDirection: 'row', gap: 16, padding: 20 }, [
      new FlexNode({ flexDirection: 'column', width: '200px', gap: 12 }, [
        buildSkillsSection(skills),
        buildEducationSection(educationList),
        buildCertificationsSection(certifications)
      ].filter(Boolean)),
      new FlexNode({ flexDirection: 'column', flexGrow: 1, gap: 12 }, [
        buildExperienceSection(experiences),
        buildProjectsSection(projects)
      ].filter(Boolean))
    ])
  ].filter(Boolean));
}

export function buildSkillsSection(skills = []) {
  if (!skills || skills.length === 0) return null;

  return new FlexNode({ flexDirection: 'column', gap: 4 }, [
    new TextNode('SKILLS', { font: 'bold 12px Arial', color: '#000', marginBottom: 4 }),
    ...arrayToTextNodes(skills, { font: '10px Arial', color: '#333', lineHeight: 14 })
  ]);
}

export function buildEducationSection(educationList = []) {
  if (!Array.isArray(educationList) || educationList.length === 0) return null;

  // Handle both single object and array
  const eduArray = Array.isArray(educationList) ? educationList : [educationList];

  return new FlexNode({ flexDirection: 'column', gap: 8 }, [
    new TextNode('EDUCATION', { font: 'bold 12px Arial', color: '#000', marginBottom: 4 }),
    ...eduArray.map(education => {
      const { degree = '', institution = '', year = '', gpa = '', location = '' } = education;
      return new FlexNode({ flexDirection: 'column', gap: 2, marginBottom: 8 }, [
        new TextNode(degree, { font: 'bold 11px Arial', color: '#000' }),
        new TextNode(institution, { font: '10px Arial', color: '#666' }),
        new TextNode(`${year}${gpa ? ` • GPA: ${gpa}` : ''}`, { font: '9px Arial', color: '#999' })
      ]);
    })
  ]);
}

export function buildExperienceSection(experiences = []) {
  if (!experiences || experiences.length === 0) return null;

  return new FlexNode({ flexDirection: 'column', gap: 12 }, [
    new TextNode('EXPERIENCE', { font: 'bold 12px Arial', color: '#000', marginBottom: 4 }),
    ...experiences.map(exp => {
      const { position = '', company = '', duration = '', achievements = [], description = '', location = '' } = exp;
      const items = achievements.length ? achievements : description ? (Array.isArray(description) ? description : [description]) : [];
      return new FlexNode({ flexDirection: 'column', gap: 4, marginBottom: 8 }, [
        new TextNode(position, { font: 'bold 12px Arial', color: '#000' }),
        new TextNode(`${company} • ${duration}`, { font: '10px Arial', color: '#666' }),
        ...items.map(a => new TextNode(`• ${extractText(a)}`, { font: '10px Arial', color: '#333', lineHeight: 14 }))
      ]);
    })
  ]);
}

export function buildProjectsSection(projects = []) {
  if (!projects || projects.length === 0) return null;

  return new FlexNode({ flexDirection: 'column', gap: 12 }, [
    new TextNode('PROJECTS', { font: 'bold 12px Arial', color: '#000', marginBottom: 4 }),
    ...projects.map(proj => {
      const { name = '', description = [], technologies = '', duration = '' } = proj;
      const descArray = Array.isArray(description) ? description : [description];

      return new FlexNode({ flexDirection: 'column', gap: 4, marginBottom: 8 }, [
        new TextNode(`${name}${duration ? ` (${duration})` : ''}`, { font: 'bold 11px Arial', color: '#000' }),
        ...descArray.filter(Boolean).map(d =>
          new TextNode(`• ${extractText(d)}`, { font: '10px Arial', color: '#333', lineHeight: 14 })
        ),
        technologies ? new TextNode(`Tech: ${technologies}`, { font: 'italic 9px Arial', color: '#666' }) : null
      ].filter(Boolean));
    })
  ]);
}

export function buildCertificationsSection(certifications = []) {
  if (!certifications || certifications.length === 0) return null;

  return new FlexNode({ flexDirection: 'column', gap: 4 }, [
    new TextNode('CERTIFICATIONS', { font: 'bold 12px Arial', color: '#000', marginBottom: 4 }),
    ...arrayToTextNodes(certifications, { font: '10px Arial', color: '#333', lineHeight: 14 })
  ]);
}

// ==================== EXPORTS ====================