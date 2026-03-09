import { Handle, Position } from '@xyflow/react';
import { getNodeType } from '../../services/nodeTypes.js';

export default function CustomNode({ data, selected }) {
    const typeDef = getNodeType(data.type);
    const hasInputs = typeDef?.inputs !== 0;
    const hasOutputs = typeDef?.outputs !== 0;

    return (
        <div className={`custom-node ${selected ? 'selected' : ''}`} style={{ borderTopColor: data.color }}>
            {hasInputs && (
                <Handle type="target" position={Position.Left} style={{ background: data.color || '#818cf8' }} />
            )}

            <div className="custom-node-header" style={{ borderBottomColor: `${data.color}20` }}>
                <span className="custom-node-icon">{data.icon}</span>
                <span className="custom-node-label">{data.label}</span>
                {data.status && (
                    <div className={`custom-node-status ${data.status}`} />
                )}
            </div>

            {data.config?.prompt && (
                <div className="custom-node-body">
                    {data.config.prompt.substring(0, 50)}
                    {data.config.prompt.length > 50 ? '...' : ''}
                </div>
            )}

            {hasOutputs && (
                <Handle type="source" position={Position.Right} style={{ background: data.color || '#818cf8' }} />
            )}
        </div>
    );
}
