import React, { useEffect, useRef, useState, useCallback } from 'react';
import { WebEngine } from './legacy-version-engine/engine/WebEngine';

const EngineCard = ({ id, title, subtitle, children, useWorker, triggerSync, liveUpdate = false }) => {
    const sourceRef = useRef(null);
    const canvasRef = useRef(null);
    const [engine, setEngine] = useState(null);
    const [status, setStatus] = useState('Standby');

    useEffect(() => {
        if (!sourceRef.current || !canvasRef.current) return;

        let activeEngine = null;
        let mounted = true;

        const initEngine = async () => {
            setStatus('Initializing...');

            const webEngine = new WebEngine(sourceRef.current, {
                useWorkers: true,
                rendererOptions: {
                    width: sourceRef.current.offsetWidth || 700,
                    height: sourceRef.current.offsetHeight || 400,
                    backgroundColor: 0xfbfeff,
                    resolution: window.devicePixelRatio || 2,
                    useWorker: useWorker,
                }
            });

            if (!mounted) {
                webEngine.destroy();
                return;
            }

            activeEngine = webEngine;

            await new Promise(r => setTimeout(r, 300));
            if (!mounted) return;

            await webEngine.snapshot();
            if (!mounted) return;

            await webEngine.renderToWebGL(canvasRef.current);
            if (!mounted) return;

            setStatus('Ready');
            setEngine(webEngine);
        };

        initEngine();

        return () => {
            mounted = false;
            if (activeEngine) activeEngine.destroy();
            setEngine(null);
        };
    }, [useWorker]);

    useEffect(() => {
        if ((triggerSync || liveUpdate) && engine) {
            let mounted = true;
            const sync = async () => {
                if (!mounted) return;
                // setStatus('Syncing...');
                await engine.update();
                // setStatus('Ready');
                if (liveUpdate && mounted) {
                    requestAnimationFrame(sync);
                }
            };

            if (liveUpdate) {
                requestAnimationFrame(sync);
            } else {
                sync();
            }

            return () => { mounted = false; };
        }
    }, [triggerSync, engine, liveUpdate]);

    return (
        <div style={{ display: 'flex', gap: 30, marginBottom: 60, width: '100%', minHeight: 400 }}>
            {/* Source */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div style={{ marginBottom: 15, fontSize: 12, color: '#94a3b8', fontWeight: 600, textTransform: 'uppercase', display: 'flex', justifyContent: 'space-between' }}>
                    <span>DOM: {title}</span>
                    <span style={{ color: '#4ade80' }}>{status}</span>
                </div>
                <div ref={sourceRef} style={{ background: 'white', borderRadius: 20, padding: 30, color: '#1e293b', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.05)', position: 'relative', overflow: 'hidden' }}>
                    {children}
                </div>
            </div>

            {/* GPU */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div style={{ marginBottom: 15, fontSize: 12, color: '#475569', fontWeight: 600, textTransform: 'uppercase' }}>
                    GPU RENDER (SNAPSHOT)
                </div>
                <div ref={canvasRef} style={{ flex: 1, borderRadius: 20, border: '2px solid #334155', background: '#1e293b', overflow: 'hidden' }}>
                </div>
            </div>
        </div>
    );
};

const PolishedResume = () => {
    return (
        <div style={{ fontFamily: '"Inter", sans-serif', color: '#1e293b' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', borderBottom: '2px solid #e2e8f0', paddingBottom: 20, marginBottom: 20 }}>
                <div>
                    <h1 style={{ fontSize: 32, fontWeight: 900, margin: 0, letterSpacing: '-0.025em', background: 'linear-gradient(to right, #2563eb, #7c3aed)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
                        ALEX RIVERA
                    </h1>
                    <p style={{ fontSize: 16, fontWeight: 600, color: '#64748b', margin: '4px 0 0 0' }}>Senior Full-Stack Developer</p>
                </div>
                <div style={{ textAlign: 'right', fontSize: 13, color: '#64748b' }}>
                    <p style={{ margin: 0 }}>alex.rivera@example.com</p>
                    <p style={{ margin: '2px 0 0 0' }}>San Francisco, CA</p>
                </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 30 }}>
                <div>
                    <h3 style={{ fontSize: 14, fontWeight: 800, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Experience</h3>
                    <div style={{ marginBottom: 20 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <h4 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>TechFlow Systems</h4>
                            <span style={{ fontSize: 12, color: '#94a3b8' }}>2021 — Present</span>
                        </div>
                        <p style={{ fontSize: 13, fontStyle: 'italic', margin: '2px 0 8px 0', color: '#64748b' }}>Lead Engineer</p>
                        <ul style={{ fontSize: 13, color: '#475569', paddingLeft: 18, margin: 0 }}>
                            <li style={{ marginBottom: 4 }}>Architected high-performance WebGL rendering engine for data visualization.</li>
                            <li style={{ marginBottom: 4 }}>Reduced initial load time by 45% through aggressive code splitting and worker-offloading.</li>
                        </ul>
                    </div>

                    <div style={{ marginBottom: 20 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                            <h4 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>CloudScale Inc</h4>
                            <span style={{ fontSize: 12, color: '#94a3b8' }}>2018 — 2021</span>
                        </div>
                        <p style={{ fontSize: 13, fontStyle: 'italic', margin: '2px 0 8px 0', color: '#64748b' }}>Senior Developer</p>
                        <ul style={{ fontSize: 13, color: '#475569', paddingLeft: 18, margin: 0 }}>
                            <li>Led the migration of legacy monolith to microservices architecture.</li>
                        </ul>
                    </div>
                </div>

                <div>
                    <h3 style={{ fontSize: 14, fontWeight: 800, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Skills</h3>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
                        {['React', 'WebGL', 'TypeScript', 'PixiJS', 'Node.js', 'PostgreSQL', 'Docker'].map(skill => (
                            <span key={skill} style={{ padding: '4px 10px', background: '#f1f5f9', borderRadius: 6, fontSize: 11, fontWeight: 600, color: '#475569' }}>
                                {skill}
                            </span>
                        ))}
                    </div>

                    <h3 style={{ fontSize: 14, fontWeight: 800, color: '#2563eb', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 12 }}>Education</h3>
                    <p style={{ fontSize: 13, fontWeight: 700, margin: 0 }}>BS Computer Science</p>
                    <p style={{ fontSize: 12, color: '#64748b', margin: '2px 0 0 0' }}>Stanford University</p>
                </div>
            </div>
        </div>
    );
};


const Demo = () => {
    const [useWorker, setUseWorker] = useState(false);
    const [syncCount, setSyncCount] = useState(0);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100%', background: '#0f172a', color: 'white', fontFamily: 'Inter, system-ui, sans-serif' }}>
            {/* TOP BAR */}
            <div style={{ padding: '15px 30px', background: '#1e293b', borderBottom: '1px solid #334155', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 15 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 8, background: 'linear-gradient(135deg, #6366f1, #a855f7)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20 }}>🛸</div>
                    <h1 style={{ fontSize: 18, margin: 0, fontWeight: 700 }}>WebGL Layout Engine - Pro Demo</h1>
                </div>
                <div style={{ display: 'flex', gap: 20, alignItems: 'center' }}>
                    <label style={{ fontSize: 14, display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                        <input type="checkbox" checked={useWorker} onChange={e => setUseWorker(e.target.checked)} />
                        Parallel Workers
                    </label>
                    <button
                        onClick={() => setSyncCount(c => c + 1)}
                        style={{ padding: '8px 20px', borderRadius: 8, border: 'none', background: '#6366f1', color: 'white', fontWeight: 600, cursor: 'pointer' }}
                    >
                        Sync Global
                    </button>
                </div>
            </div>

            {/* MAIN CONTENT AREA */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '40px 60px' }}>
                <div style={{ maxWidth: 1400, margin: '0 auto' }}>

                    {/* TEST 1: POLISHED RESUME */}
                    <EngineCard
                        id="resume-snapshot"
                        title="Polished Resume Snapshot"
                        subtitle="Complex CSS, gradients, and typography capture"
                        useWorker={useWorker}
                        triggerSync={syncCount}
                    >
                        <PolishedResume />
                    </EngineCard>


                </div>
            </div>
        </div>
    );
};

export default Demo;