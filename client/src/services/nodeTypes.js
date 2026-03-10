/**
 * Node type definitions for the workflow builder
 */

/**
 * Models available per credential provider — used by AI Text node
 * for dynamic model selection based on selected credential.
 */
export const PROVIDER_MODELS = {
    openrouter: [
        'nvidia/nemotron-nano-12b-v2-vl:free',
        'mistralai/mistral-small-3.1-24b-instruct:free',
        'google/gemma-3-27b-it:free',
        'google/gemma-3-12b-it:free',
        'nvidia/nemotron-nano-9b-v2:free',
        'qwen/qwen3-4b:free',
        'meta-llama/llama-3.2-3b-instruct:free',
    ],
    gemini: [
        'gemini-2.5-flash',
        'gemini-3-pro-preview',
    ],
};

export const NODE_TYPES = {
    'file-upload': {
        type: 'file-upload',
        label: 'File Upload',
        icon: '📤',
        category: 'utility',
        color: '#6366f1',
        description: 'Upload and provide files as input',
        configSchema: {
            filePath: { type: 'file', label: 'Upload Files', description: 'Browse to upload images or drag & drop multiple files', accept: 'image/*' },
        },
        inputs: 0,
        outputs: 1,
    },
    'ai-text': {
        type: 'ai-text',
        label: 'AI Text',
        icon: '🔀',
        category: 'ai',
        color: '#4285f4',
        description: 'AI text generation & image analysis (supports OpenRouter & Google Gemini)',
        configSchema: {
            prompt: { type: 'textarea', label: 'Prompt', required: true, description: 'Use {{nodeId.field}} for dynamic values' },
            systemInstruction: { type: 'textarea', label: 'System Instruction', description: 'Custom instructions (like Custom GPT). Applied to every request.' },
            model: {
                type: 'select', label: 'Model',
                options: [],  // populated dynamically based on credential provider
                default: '',
                dynamic: true,  // flag for NodeConfigPanel to handle dynamically
            },
            temperature: { type: 'number', label: 'Temperature', default: 0.7, min: 0, max: 2 },
            includeImage: { type: 'boolean', label: 'Include Image from Previous Node', default: false },
            credentialId: { type: 'credential', label: 'Credential', provider: ['openrouter', 'gemini'], required: true },
        },
        inputs: 1,
        outputs: 1,
    },
    'google-flow-image': {
        type: 'google-flow-image',
        label: 'Flow — Image',
        icon: '🎨',
        category: 'ai',
        color: '#f59e0b',
        description: 'Generate images with Google Flow (uses uploaded image as reference)',
        configSchema: {
            prompt: { type: 'textarea', label: 'Image Prompt', required: true, description: 'Use {{nodeId.imagePrompt}} for Text Extractor output' },
            model: {
                type: 'select', label: 'Model',
                options: [
                    { label: 'Nano Banana 2', value: 'banana2' },
                    { label: 'Nano Banana Pro', value: 'banana_pro' },
                ],
                default: 'banana2',
            },
            aspectRatio: { type: 'select', label: 'Aspect Ratio', options: ['9:16', '1:1', '16:9', '4:3', '3:4'], default: '9:16' },
            count: { type: 'number', label: 'Number of Images', default: 1, min: 1, max: 4, description: '1–4 images per generation' },
            useReferenceImage: { type: 'boolean', label: 'Use Reference Image from Upload', default: true, description: 'Sends uploaded image from File Upload as reference' },
            resolution: {
                type: 'select', label: 'Resolution',
                options: [
                    { label: '1K (Original)', value: '1k' },
                    { label: '2K (Upscaled)', value: '2k' },
                    { label: '4K (Upscaled)', value: '4k' },
                ],
                default: '1k',
            },
            projectId: { type: 'text', label: 'Project ID', required: true, description: 'Your Google Flow project UUID (from network requests URL)' },
            credentialId: { type: 'credential', label: 'Credential', provider: 'google-flow', required: true },
        },
        inputs: 1,
        outputs: 1,
    },
    'google-flow-video': {
        type: 'google-flow-video',
        label: 'Flow — Video',
        icon: '🎬',
        category: 'ai',
        color: '#ef4444',
        description: 'Generate videos with Google Flow (auto-uses Flow Image output as start frame)',
        configSchema: {
            prompt: { type: 'textarea', label: 'Video Prompt', required: true, description: 'Use {{nodeId.videoPrompt}} for Text Extractor output' },
            model: {
                type: 'select', label: 'Model',
                options: [
                    { label: 'Veo 3.1 Fast (Low Priority)', value: 'veo3_fast_low' },
                    { label: 'Veo 3.1 - Fast', value: 'veo3_fast' },
                    { label: 'Veo 3.1 - Quality', value: 'veo3' },
                ],
                default: 'veo3_fast_low',
            },
            aspectRatio: {
                type: 'select', label: 'Aspect Ratio',
                options: [
                    { label: 'Portrait (9:16)', value: '9:16' },
                    { label: 'Landscape (16:9)', value: '16:9' },
                    { label: 'Square (1:1)', value: '1:1' },
                ],
                default: '9:16',
            },
            useStartFrame: { type: 'boolean', label: 'Use Start Frame from Upstream Image', description: 'Use generated image from Flow Image as video start frame', default: true },
            resolution: {
                type: 'select', label: 'Resolution',
                options: [
                    { label: '720p (Original)', value: '720p' },
                    { label: '1080p (Upscaled)', value: '1080p' },
                ],
                default: '720p',
            },
            projectId: { type: 'text', label: 'Project ID', required: true, description: 'Your Google Flow project UUID' },
            credentialId: { type: 'credential', label: 'Credential', provider: 'google-flow', required: true },
        },
        inputs: 1,
        outputs: 1,
    },
    'chatgpt-note': {
        type: 'chatgpt-note',
        label: 'ChatGPT Note',
        icon: '💬',
        category: 'ai',
        color: '#10a37f',
        description: 'Send messages to ChatGPT via direct API (supports Custom GPTs & image input)',
        configSchema: {
            prompt: { type: 'textarea', label: 'Prompt', required: true, description: 'Use {{nodeId.field}} for dynamic values' },
            model: {
                type: 'select', label: 'Model',
                options: [
                    { label: 'GPT-5.3', value: 'gpt-5-3' },
                    { label: 'GPT-4o', value: 'gpt-4o' },
                    { label: 'o3', value: 'o3' },
                    { label: 'o4-mini', value: 'o4-mini' },
                    { label: 'GPT-4o Mini', value: 'gpt-4o-mini' },
                ],
                default: 'gpt-5-3',
            },
            customGptId: { type: 'text', label: 'Custom GPT ID', description: 'ID from Custom GPT URL (g-xxxxx). Leave empty for default ChatGPT.' },
            includeImage: { type: 'boolean', label: 'Include Image from Previous Node', default: false, description: 'Attach image from upstream node (File Upload / Flow Image)' },
            credentialId: { type: 'credential', label: 'Credential', provider: 'chatgpt', required: true },
        },
        inputs: 1,
        outputs: 1,
    },
    'file-download': {
        type: 'file-download',
        label: 'File Download',
        icon: '📥',
        category: 'utility',
        color: '#8b5cf6',
        description: 'Download and save output files',
        configSchema: {
            outputDir: { type: 'text', label: 'Output Directory', default: 'output' },
            fileName: { type: 'text', label: 'Custom File Name' },
        },
        inputs: 1,
        outputs: 0,
    },
    'text-template': {
        type: 'text-template',
        label: 'Text Template',
        icon: '📝',
        category: 'utility',
        color: '#06b6d4',
        description: 'Create text using templates',
        configSchema: {
            template: { type: 'textarea', label: 'Template', required: true, description: 'Use {{nodeId.field}} for variables' },
            outputField: { type: 'text', label: 'Output Field', default: 'text' },
        },
        inputs: 1,
        outputs: 1,
    },
    'delay': {
        type: 'delay',
        label: 'Delay',
        icon: '⏱️',
        category: 'utility',
        color: '#64748b',
        description: 'Wait before continuing',
        configSchema: {
            seconds: { type: 'number', label: 'Seconds', default: 5, min: 1, max: 3600 },
        },
        inputs: 1,
        outputs: 1,
    },
    'text-extractor': {
        type: 'text-extractor',
        label: 'Text Extractor',
        icon: '✂️',
        category: 'utility',
        color: '#f472b6',
        description: 'Extract Image & Video prompts from AI output',
        configSchema: {
            marker1: { type: 'text', label: 'Marker 1 (→ imagePrompt)', default: 'IMAGE PROMPT', description: 'Output field: {{nodeId.imagePrompt}}' },
            marker2: { type: 'text', label: 'Marker 2 (→ videoPrompt)', default: 'VIDEO PROMPT', description: 'Output field: {{nodeId.videoPrompt}}' },
        },
        inputs: 1,
        outputs: 1,
    },
};

export const NODE_CATEGORIES = [
    { id: 'ai', label: 'AI Services', icon: '🧠' },
    { id: 'utility', label: 'Utilities', icon: '🔧' },
];

export function getNodeType(type) {
    return NODE_TYPES[type] || null;
}
