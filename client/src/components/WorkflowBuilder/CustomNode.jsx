import { Handle, Position } from '@xyflow/react';
import { getNodeType } from '../../services/nodeTypes.js';
import Icon from '../../services/icons.jsx';

const SUBTYPE_FOR_TYPE = {
    'ai-text': 'TEXT',
    'google-flow-image': 'IMAGE',
    'google-flow-video': 'VIDEO',
    'chatgpt-note': 'NOTE',
    'file-upload': 'IN',
    'file-download': 'OUT',
    'text-template': 'TMPL',
    'text-extractor': 'EXTRACT',
    'delay': 'DELAY',
};

export default function CustomNode({ data, selected }) {
    const typeDef = getNodeType(data.type);
    const hasInputs = typeDef?.inputs !== 0;
    const hasOutputs = typeDef?.outputs !== 0;
    const subtype = SUBTYPE_FOR_TYPE[data.type] || '';
    const accent = data.color || 'var(--peach)';
    const promptPreview = data.config?.prompt
        || data.config?.template
        || data.config?.text
        || '';

    return (
        <div
            className={`custom-node ${selected ? 'selected' : ''}`}
            style={{ '--node-accent': accent }}
        >
            {hasInputs && (
                <Handle type="target" position={Position.Left} style={{ background: accent }} />
            )}

            <div className="custom-node-header">
                <span className="custom-node-icon" style={{ background: `color-mix(in srgb, ${accent} 24%, transparent)` }}>
                    <Icon name={data.icon} size={14} color="var(--ink)" />
                </span>
                <span className="custom-node-label">{data.label}</span>
                {subtype && <span className="custom-node-subtype">{subtype}</span>}
            </div>

            {promptPreview && (
                <div className="custom-node-body">
                    &ldquo;{promptPreview.length > 80 ? `${promptPreview.substring(0, 80)}…` : promptPreview}&rdquo;
                </div>
            )}

            <div className="custom-node-footer">
                <span>{data.type?.replace(/-/g, ' ') || ''}</span>
                <div className={`custom-node-status ${data.status || 'idle'}`} />
            </div>

            {hasOutputs && (
                <Handle type="source" position={Position.Right} style={{ background: accent }} />
            )}
        </div>
    );
}
