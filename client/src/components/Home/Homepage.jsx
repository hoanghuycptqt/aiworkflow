import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import Icon from '../../services/icons.jsx';
import Logo, { Wordmark } from '../../services/Logo.jsx';

const FEATURES = [
    {
        icon: 'workflow',
        title: 'Visual Workflow Builder',
        desc: 'Drag-and-drop nodes on an infinite canvas. Wire them into a DAG and the engine will topologically sort and run them for you — no code required.',
    },
    {
        icon: 'sparkles',
        title: 'Multi-Provider AI Out of the Box',
        desc: 'Google Gemini for text, Google Flow / Veo for image and video, ChatGPT, OpenRouter, and growing. Bring your own API keys.',
    },
    {
        icon: 'clapperboard',
        title: 'Built for Bulk Video Production',
        desc: 'Parameterize a workflow once, then run it across hundreds of inputs as a batch — parallel or sequential, with live progress.',
    },
    {
        icon: 'zap',
        title: 'Real-Time Execution',
        desc: 'Every node update streams over Socket.IO so you watch progress, errors, and intermediate outputs as they happen.',
    },
    {
        icon: 'bot',
        title: 'Telegram Bot Built In',
        desc: 'Trigger workflows and receive results straight from Telegram. Perfect for kicking off long-running jobs on the go.',
    },
    {
        icon: 'shield-check',
        title: 'Your Keys, Your Data',
        desc: 'Credentials are stored encrypted and used only to call providers on your behalf. We never train on your prompts or files.',
    },
];

const NODES = [
    { icon: 'brain', label: 'AI Text (Gemini, ChatGPT, OpenRouter)', color: 'var(--node-chatgpt)' },
    { icon: 'palette', label: 'Google Flow Image', color: 'var(--node-flow-image)' },
    { icon: 'clapperboard', label: 'Google Flow Video (Veo)', color: 'var(--node-flow-video)' },
    { icon: 'upload', label: 'File Upload', color: 'var(--node-file)' },
    { icon: 'download', label: 'File Download', color: 'var(--node-file)' },
    { icon: 'file-edit', label: 'Text Template', color: 'var(--node-utility)' },
    { icon: 'scissors', label: 'Text Extractor', color: 'var(--node-utility)' },
    { icon: 'timer', label: 'Delay', color: 'var(--node-utility)' },
];

const STEPS = [
    {
        n: '01',
        title: 'Design',
        desc: 'Open the canvas and drop nodes for the providers and utilities you need. Connect them with edges — the platform handles execution order automatically.',
    },
    {
        n: '02',
        title: 'Configure',
        desc: 'Add your provider credentials once on the Credentials page. Reference upstream outputs in any field with simple {{nodeId.field}} templates.',
    },
    {
        n: '03',
        title: 'Run at Scale',
        desc: 'Run a single execution to test, or create a Job Batch to run the same workflow across hundreds of parameter sets in parallel.',
    },
];

// Data transparency — what each sign-in method gives us, and what we use it for.
// This section exists explicitly to satisfy Google OAuth homepage verification:
// "Explain with transparency the purpose for which your app requests user data".
const DATA_USAGE = [
    {
        scope: 'Email address',
        purpose: 'Used as your unique account identifier and to send transactional email such as the verification link and security notices.',
    },
    {
        scope: 'Name',
        purpose: 'Displayed in the THHFlow interface (sidebar, profile) so you and any teammates can identify your account.',
    },
    {
        scope: 'Profile picture',
        purpose: 'Shown as your avatar inside the application. Never shared with third parties.',
    },
];

export default function Homepage() {
    const [theme, setTheme] = useState(
        () => document.documentElement.getAttribute('data-theme') || 'dark'
    );

    function toggleTheme() {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.classList.add('theme-transitioning');
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('theme', next);
        setTheme(next);
        setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 350);
    }

    useEffect(() => {
        document.documentElement.classList.add('public-page');
        window.scrollTo(0, 0);
        return () => document.documentElement.classList.remove('public-page');
    }, []);

    return (
        <div className="home-page">
            {/* Navbar */}
            <header className="home-nav">
                <Link to="/" className="home-brand">
                    <Logo chip size={30} />
                    <Wordmark size={22} />
                </Link>
                <nav className="home-nav-links">
                    <a href="#features">Features</a>
                    <a href="#nodes">Connectors</a>
                    <a href="#how">How it works</a>
                    <a href="#data-usage">Data &amp; Privacy</a>
                    <Link to="/privacy">Privacy</Link>
                    <Link to="/terms">Terms</Link>
                </nav>
                <div className="home-nav-actions">
                    <button
                        className="home-theme-toggle"
                        onClick={toggleTheme}
                        title={theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
                    >
                        <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
                    </button>
                    <Link to="/auth" className="btn btn-secondary home-nav-signin">Sign In</Link>
                    <Link to="/auth" className="btn btn-primary">Get Started</Link>
                </div>
            </header>

            {/* Hero — brand identity + functional one-liner */}
            <section className="home-hero">
                <div className="home-hero-glow" aria-hidden="true" />
                <div className="home-hero-inner">
                    <span className="home-badge">
                        <Icon name="sparkles" size={14} /> AI Workflow Automation
                    </span>
                    <h1 className="home-hero-title">
                        THHFlow — build, automate, and scale{' '}
                        <span className="home-gradient-text">AI video workflows</span>
                    </h1>
                    <p className="home-hero-sub">
                        THHFlow is a visual workflow automation platform for AI-driven bulk video
                        production. Wire together Google Flow (Veo), Gemini, ChatGPT, and OpenRouter
                        nodes on a drag-and-drop canvas, then run your pipeline across hundreds of
                        inputs in parallel. Owned and operated at thhflow.com.
                    </p>
                    <div className="home-hero-cta">
                        <Link to="/auth" className="btn btn-primary home-cta-primary">
                            <Icon name="zap" size={16} /> Start Free
                        </Link>
                        <a href="#how" className="btn btn-secondary home-cta-secondary">
                            See how it works <Icon name="chevron-right" size={16} />
                        </a>
                    </div>
                    <div className="home-hero-meta">
                        <span><Icon name="check-circle" size={14} /> No credit card required</span>
                        <span><Icon name="check-circle" size={14} /> Bring your own API keys</span>
                        <span><Icon name="check-circle" size={14} /> Read our <Link to="/privacy">Privacy Policy</Link></span>
                    </div>
                </div>
            </section>

            {/* What THHFlow does — explicit functional description */}
            <section className="home-section" id="features">
                <div className="home-section-head">
                    <h2>What THHFlow does</h2>
                    <p>
                        THHFlow is a self-hosted workflow engine. You build directed acyclic graphs of
                        nodes — each node calls an AI provider or performs a utility step — and the
                        platform runs them in order, streams their outputs back to you in real time,
                        and stores the resulting files so you can chain them downstream. Below is
                        everything the platform gives you.
                    </p>
                </div>
                <div className="home-features">
                    {FEATURES.map((f) => (
                        <div className="home-feature-card" key={f.title}>
                            <div className="home-feature-icon">
                                <Icon name={f.icon} size={22} />
                            </div>
                            <h3>{f.title}</h3>
                            <p>{f.desc}</p>
                        </div>
                    ))}
                </div>
            </section>

            {/* Nodes / connectors */}
            <section className="home-section home-section-alt" id="nodes">
                <div className="home-section-head">
                    <h2>Connectors and utility nodes</h2>
                    <p>Drop in the building blocks you need. Add more via custom connectors.</p>
                </div>
                <div className="home-nodes">
                    {NODES.map((n) => (
                        <div className="home-node-chip" key={n.label}>
                            <span className="home-node-dot" style={{ background: n.color }}>
                                <Icon name={n.icon} size={16} />
                            </span>
                            {n.label}
                        </div>
                    ))}
                </div>
            </section>

            {/* How it works */}
            <section className="home-section" id="how">
                <div className="home-section-head">
                    <h2>From idea to batch run in three steps</h2>
                    <p>No code, no infra. Just connect nodes and press play.</p>
                </div>
                <div className="home-steps">
                    {STEPS.map((s) => (
                        <div className="home-step" key={s.n}>
                            <span className="home-step-num">{s.n}</span>
                            <h3>{s.title}</h3>
                            <p>{s.desc}</p>
                        </div>
                    ))}
                </div>
            </section>

            {/* Data usage — Google OAuth transparency.
                This section directly addresses the OAuth homepage verification requirement
                to explain why THHFlow requests user data. */}
            <section className="home-section home-section-alt" id="data-usage">
                <div className="home-section-head">
                    <h2>Why THHFlow asks for your data</h2>
                    <p>
                        Full transparency on what we request, why we need it, and what we will never do
                        with it. For the complete legal text see our{' '}
                        <Link to="/privacy">Privacy Policy</Link>.
                    </p>
                </div>

                <div className="home-data-card">
                    <div className="home-data-card-head">
                        <span className="home-data-badge">
                            <Icon name="key" size={14} /> Sign in with Google
                        </span>
                        <p>
                            When you choose <strong>&quot;Sign in with Google&quot;</strong>, THHFlow uses
                            Google Identity Services to receive a verified identity token. We request
                            only the standard <code>openid</code>, <code>email</code>, and{' '}
                            <code>profile</code> scopes — the minimum needed to create your account.
                        </p>
                    </div>

                    <table className="home-data-table">
                        <thead>
                            <tr>
                                <th>Data we receive</th>
                                <th>How we use it</th>
                            </tr>
                        </thead>
                        <tbody>
                            {DATA_USAGE.map((row) => (
                                <tr key={row.scope}>
                                    <td><strong>{row.scope}</strong></td>
                                    <td>{row.purpose}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>

                    <div className="home-data-bullets">
                        <h4>What THHFlow will <em>never</em> do</h4>
                        <ul>
                            <li>Access your Gmail, Google Drive, Calendar, Contacts, or any other Google service. We do not request those scopes.</li>
                            <li>Post anything to your Google account.</li>
                            <li>Sell, rent, or share your personal information with any third party.</li>
                            <li>Use the content of your prompts, files, or outputs to train any machine-learning model.</li>
                        </ul>
                    </div>

                    <div className="home-data-bullets">
                        <h4>Your controls</h4>
                        <ul>
                            <li>Sign in with email and password instead — Google sign-in is optional.</li>
                            <li>Revoke THHFlow&apos;s access at any time from your{' '}
                                <a href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">
                                    Google Account permissions page
                                </a>.
                            </li>
                            <li>Delete your THHFlow account and all associated data by emailing{' '}
                                <a href="mailto:hoanghuycptqt@gmail.com">hoanghuycptqt@gmail.com</a>.
                            </li>
                        </ul>
                    </div>
                </div>
            </section>

            {/* MCP callout */}
            <section className="home-section">
                <div className="home-mcp">
                    <div className="home-mcp-icon">
                        <Icon name="cpu" size={28} />
                    </div>
                    <div className="home-mcp-body">
                        <h2>Also available as an MCP server</h2>
                        <p>
                            THHFlow ships with a Model Context Protocol server that exposes Google Flow
                            image and video generation as tools to Claude, Antigravity, and any other
                            MCP-compatible client. Stay in your favorite assistant — let THHFlow handle
                            the render queue.
                        </p>
                    </div>
                </div>
            </section>

            {/* Final CTA */}
            <section className="home-final-cta">
                <h2>Ready to build your first workflow?</h2>
                <p>
                    Sign up free and start running AI pipelines in minutes. By creating an account you
                    agree to our <Link to="/terms">Terms of Service</Link> and{' '}
                    <Link to="/privacy">Privacy Policy</Link>.
                </p>
                <Link to="/auth" className="btn btn-primary home-cta-primary">
                    <Icon name="zap" size={16} /> Create your account
                </Link>
            </section>

            {/* Footer */}
            <footer className="home-footer">
                <div className="home-footer-cols">
                    <div className="home-footer-brand">
                        <Link to="/" className="home-brand">
                            <Logo chip size={30} />
                            <Wordmark size={22} />
                        </Link>
                        <p>
                            AI workflow automation for bulk video production. Operated at thhflow.com
                            by Truong Hoang Huy.
                        </p>
                    </div>
                    <div className="home-footer-col">
                        <h4>Product</h4>
                        <a href="#features">Features</a>
                        <a href="#nodes">Connectors</a>
                        <a href="#how">How it works</a>
                    </div>
                    <div className="home-footer-col">
                        <h4>Account</h4>
                        <Link to="/auth">Sign In</Link>
                        <Link to="/auth">Sign Up</Link>
                    </div>
                    <div className="home-footer-col">
                        <h4>Legal &amp; Privacy</h4>
                        <Link to="/privacy">Privacy Policy</Link>
                        <Link to="/terms">Terms of Service</Link>
                        <a href="#data-usage">Data &amp; Google Sign-In</a>
                    </div>
                    <div className="home-footer-col">
                        <h4>Contact</h4>
                        <a href="mailto:hoanghuycptqt@gmail.com">hoanghuycptqt@gmail.com</a>
                        <a href="https://thhflow.com">thhflow.com</a>
                    </div>
                </div>
                <div className="home-footer-bottom">
                    <span>&copy; {new Date().getFullYear()} THHFlow. All rights reserved.</span>
                </div>
            </footer>
        </div>
    );
}
