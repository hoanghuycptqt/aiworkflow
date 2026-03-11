/**
 * Telegram AI Conversation Handler
 * 
 * Dual provider: Gemini (recommended) or OpenRouter (fallback).
 * Supports function calling for workflow management.
 * 
 * Features:
 * - Persistent chat memory (DB-backed, survives server restarts)
 * - Search completed jobs and resend their media
 * - Create/run jobs from photos sent via Telegram
 */

import { GoogleGenAI } from '@google/genai';
import { prisma } from '../index.js';
import { runJobBatch, cancelBatch } from './job-runner.js';
import { downloadTelegramPhoto, bot, getVideoDimensions } from './telegram-bot.js';
import { existsSync } from 'fs';

// ─── Transient State (per-chat, non-persistent) ──────────
// Only UI state that doesn't need to survive restarts
const chatState = new Map();
const MAX_HISTORY = 30;

function getChatState(chatId) {
    if (!chatState.has(chatId)) {
        chatState.set(chatId, {
            pendingPhotos: [],
            pendingWorkflowId: null,
            awaitingConfirm: null,
            awaitingWorkflowSelect: null,
        });
    }
    return chatState.get(chatId);
}

// ─── Persistent Memory ──────────────────────────────────
async function loadChatHistory(chatId) {
    const messages = await prisma.telegramChatMessage.findMany({
        where: { chatId },
        orderBy: { createdAt: 'desc' },
        take: MAX_HISTORY,
        select: { role: true, content: true },
    });
    // Reverse to chronological order
    return messages.reverse();
}

async function saveMessage(chatId, role, content) {
    await prisma.telegramChatMessage.create({
        data: { chatId, role, content },
    });
}

// ─── Function Definitions ────────────────────────────────
const functionDeclarations = [
    {
        name: 'list_workflows',
        description: 'Get list of all workflows owned by the user. Call this when user asks about their workflows.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'list_jobs',
        description: 'Get list of all jobs for a specific workflow.',
        parameters: {
            type: 'object',
            properties: {
                workflowId: { type: 'string', description: 'The workflow ID' },
            },
            required: ['workflowId'],
        },
    },
    {
        name: 'create_job',
        description: 'Create a new job for a workflow. The user should have already sent photos as input. Call this after the user provides images.',
        parameters: {
            type: 'object',
            properties: {
                workflowId: { type: 'string', description: 'The workflow ID to create job for' },
                jobName: { type: 'string', description: 'Name for the job, e.g. "Job 1"' },
            },
            required: ['workflowId'],
        },
    },
    {
        name: 'run_job',
        description: 'Run a specific job or all jobs for a workflow.',
        parameters: {
            type: 'object',
            properties: {
                workflowId: { type: 'string', description: 'The workflow ID' },
                jobIds: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Array of job IDs to run. If empty, run all jobs.',
                },
            },
            required: ['workflowId'],
        },
    },
    {
        name: 'get_status',
        description: 'Get current running batch status for a workflow.',
        parameters: {
            type: 'object',
            properties: {
                workflowId: { type: 'string', description: 'The workflow ID' },
            },
            required: ['workflowId'],
        },
    },
    {
        name: 'stop_batch',
        description: 'Stop/cancel a running batch.',
        parameters: {
            type: 'object',
            properties: {
                batchId: { type: 'string', description: 'The batch ID to cancel' },
            },
            required: ['batchId'],
        },
    },
    {
        name: 'get_history',
        description: 'Get recent execution history for a workflow.',
        parameters: {
            type: 'object',
            properties: {
                workflowId: { type: 'string', description: 'The workflow ID' },
            },
            required: ['workflowId'],
        },
    },
    {
        name: 'search_completed_jobs',
        description: 'Search for completed job executions with their output media. Use when user asks to find old/past results, wants to see previous outputs, or asks about jobs they ran before. Returns a list of matching executions with IDs that can be used with resend_job_media.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Optional search query — job name, workflow name, or keyword. Leave empty to get recent completed jobs.' },
                limit: { type: 'integer', description: 'Max results to return (default 5, max 10)' },
            },
        },
    },
    {
        name: 'resend_job_media',
        description: 'Resend all output media (images/videos) from a specific completed job execution to the current Telegram chat. Use after search_completed_jobs to send the actual files.',
        parameters: {
            type: 'object',
            properties: {
                executionId: { type: 'string', description: 'The workflow execution ID to resend media from' },
            },
            required: ['executionId'],
        },
    },
];

// ─── Function Executor ───────────────────────────────────
async function executeFunction(name, args, userId, chatId) {
    switch (name) {
        case 'list_workflows': {
            const workflows = await prisma.workflow.findMany({
                where: { userId },
                select: { id: true, name: true, description: true, createdAt: true },
                orderBy: { updatedAt: 'desc' },
            });
            return workflows.length > 0
                ? workflows.map((w, i) => `${i + 1}. **${w.name}** (ID: \`${w.id}\`)`).join('\n')
                : 'Bạn chưa có workflow nào. Hãy tạo workflow trên Web UI trước.';
        }

        case 'list_jobs': {
            const jobs = await prisma.job.findMany({
                where: { workflowId: args.workflowId },
                orderBy: { order: 'asc' },
            });
            if (jobs.length === 0) return 'Workflow này chưa có job nào.';
            return jobs.map((j, i) => {
                const input = j.inputData ? JSON.parse(j.inputData) : {};
                const fileCount = input.filePaths?.length || 0;
                return `${i + 1}. **${j.name}** — ${fileCount} ảnh input (ID: \`${j.id}\`)`;
            }).join('\n');
        }

        case 'create_job': {
            const state = getChatState(chatId);
            if (state.pendingPhotos.length === 0) {
                state.pendingWorkflowId = args.workflowId;
                return 'NEEDS_PHOTOS';
            }

            const maxOrder = await prisma.job.aggregate({
                where: { workflowId: args.workflowId },
                _max: { order: true },
            });
            const nextOrder = (maxOrder._max.order ?? -1) + 1;
            const jobName = args.jobName || `Job ${nextOrder + 1}`;

            const inputData = {
                filePaths: state.pendingPhotos.map(p => p.fileUrl),
            };

            const job = await prisma.job.create({
                data: {
                    workflowId: args.workflowId,
                    name: jobName,
                    order: nextOrder,
                    inputData: JSON.stringify(inputData),
                },
            });

            const photoCount = state.pendingPhotos.length;
            state.pendingPhotos = [];
            state.pendingWorkflowId = null;

            return `✅ Đã tạo job **${jobName}** với ${photoCount} ảnh input.\nJob ID: \`${job.id}\``;
        }

        case 'run_job': {
            let jobIds = args.jobIds || [];
            if (jobIds.length === 0) {
                const jobs = await prisma.job.findMany({
                    where: { workflowId: args.workflowId },
                    select: { id: true },
                });
                jobIds = jobs.map(j => j.id);
            }
            if (jobIds.length === 0) return 'Không có job nào để chạy.';

            const result = await runJobBatch(args.workflowId, jobIds, userId, 'parallel', 3);
            return `⚡ Đang chạy ${jobIds.length} job(s).\nBatch ID: \`${result.batchId}\``;
        }

        case 'get_status': {
            const batches = await prisma.jobBatch.findMany({
                where: { workflowId: args.workflowId, status: { in: ['running', 'pending'] } },
                include: {
                    executions: {
                        select: { id: true, status: true, instanceIndex: true, jobId: true },
                    },
                },
                orderBy: { startedAt: 'desc' },
                take: 1,
            });

            if (batches.length === 0) return 'Không có batch nào đang chạy.';

            const batch = batches[0];
            const lines = [`📊 **Batch** \`${batch.id}\` — ${batch.status}`];
            for (const exec of batch.executions) {
                const icon = exec.status === 'completed' ? '✅'
                    : exec.status === 'running' ? '🔄'
                        : exec.status === 'failed' ? '❌' : '⏳';
                lines.push(`  ${icon} Execution ${exec.instanceIndex + 1} — ${exec.status}`);
            }
            return lines.join('\n');
        }

        case 'stop_batch': {
            await cancelBatch(args.batchId);
            return `⏹ Đã dừng batch \`${args.batchId}\`.`;
        }

        case 'get_history': {
            const executions = await prisma.workflowExecution.findMany({
                where: { workflowId: args.workflowId },
                orderBy: { startedAt: 'desc' },
                take: 10,
                select: {
                    id: true, status: true, startedAt: true, completedAt: true,
                    jobId: true, instanceIndex: true,
                },
            });

            if (executions.length === 0) return 'Chưa có lịch sử execution nào.';

            return executions.map((e, i) => {
                const icon = e.status === 'completed' ? '✅'
                    : e.status === 'failed' ? '❌'
                        : e.status === 'running' ? '🔄' : '⏳';
                const time = e.startedAt ? new Date(e.startedAt).toLocaleString('vi-VN') : '-';
                return `${i + 1}. ${icon} ${e.status} — ${time}`;
            }).join('\n');
        }

        case 'search_completed_jobs': {
            const limit = Math.min(args.limit || 5, 10);
            const query = args.query?.trim() || '';

            // Build where clause — completed executions for this user's workflows
            const userWorkflows = await prisma.workflow.findMany({
                where: { userId },
                select: { id: true, name: true },
            });
            const wfIds = userWorkflows.map(w => w.id);
            const wfNameMap = Object.fromEntries(userWorkflows.map(w => [w.id, w.name]));

            if (wfIds.length === 0) return 'Bạn chưa có workflow nào.';

            const executions = await prisma.workflowExecution.findMany({
                where: {
                    workflowId: { in: wfIds },
                    status: 'completed',
                },
                orderBy: { completedAt: 'desc' },
                take: 50, // fetch more, then filter by query
                include: {
                    nodeExecutions: { select: { outputData: true, nodeType: true } },
                },
            });

            // Get job names for these executions
            const jobIds = executions.map(e => e.jobId).filter(Boolean);
            const jobs = jobIds.length > 0
                ? await prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, name: true } })
                : [];
            const jobNameMap = Object.fromEntries(jobs.map(j => [j.id, j.name]));

            // Filter by query if provided
            let filtered = executions;
            if (query) {
                const q = query.toLowerCase();
                filtered = executions.filter(e => {
                    const wfName = wfNameMap[e.workflowId] || '';
                    const jobName = e.jobId ? (jobNameMap[e.jobId] || '') : '';
                    return wfName.toLowerCase().includes(q) || jobName.toLowerCase().includes(q);
                });
            }

            filtered = filtered.slice(0, limit);

            if (filtered.length === 0) {
                return query
                    ? `Không tìm thấy job hoàn thành nào khớp "${query}".`
                    : 'Chưa có job nào hoàn thành.';
            }

            // Count media files per execution
            const outputNodeTypes = ['google-flow-image', 'google-flow-video'];
            return filtered.map((e, i) => {
                const wfName = wfNameMap[e.workflowId] || 'Unknown';
                const jobName = e.jobId ? (jobNameMap[e.jobId] || '-') : '-';
                const time = e.completedAt ? new Date(e.completedAt).toLocaleString('vi-VN') : '-';

                let mediaCount = 0;
                for (const ne of e.nodeExecutions) {
                    if (!outputNodeTypes.includes(ne.nodeType)) continue;
                    try {
                        const data = typeof ne.outputData === 'string' ? JSON.parse(ne.outputData) : ne.outputData;
                        if (data?.imagePath) mediaCount++;
                        if (data?.videoPath) mediaCount++;
                        for (const k of ['allImages', 'savedImages']) {
                            if (Array.isArray(data?.[k])) mediaCount += data[k].length;
                        }
                    } catch { /* skip */ }
                }

                return `${i + 1}. 📦 **${jobName}** (WF: ${wfName})\n   ⏰ ${time} | 📸 ${mediaCount} media\n   ID: \`${e.id}\``;
            }).join('\n\n');
        }

        case 'resend_job_media': {
            const execution = await prisma.workflowExecution.findUnique({
                where: { id: args.executionId },
                include: {
                    nodeExecutions: { select: { outputData: true, nodeType: true } },
                    workflow: { select: { userId: true } },
                },
            });

            if (!execution) return '❌ Không tìm thấy execution với ID này.';
            if (execution.workflow.userId !== userId) return '❌ Bạn không có quyền truy cập execution này.';

            // Extract media files (same logic as job-runner.js)
            const outputNodeTypes = ['google-flow-image', 'google-flow-video'];
            const mediaFiles = [];

            for (const ne of execution.nodeExecutions) {
                if (!outputNodeTypes.includes(ne.nodeType)) continue;
                let data;
                try { data = typeof ne.outputData === 'string' ? JSON.parse(ne.outputData) : ne.outputData; } catch { continue; }
                if (!data) continue;

                // Images: prefer array over single to avoid duplicates
                let foundImageArray = false;
                for (const arrKey of ['allImages', 'savedImages']) {
                    if (Array.isArray(data[arrKey]) && data[arrKey].length > 0) {
                        foundImageArray = true;
                        for (const item of data[arrKey]) {
                            if (item.imagePath) mediaFiles.push({ type: 'image', path: item.imagePath });
                        }
                    }
                }
                if (!foundImageArray && data.imagePath) {
                    mediaFiles.push({ type: 'image', path: data.imagePath });
                }
                if (data.videoPath) mediaFiles.push({ type: 'video', path: data.videoPath });
            }

            if (mediaFiles.length === 0) {
                return '📭 Execution này không có media output nào.';
            }

            // Send media files directly to the chat
            let sent = 0;
            for (const media of mediaFiles) {
                if (!existsSync(media.path)) continue;
                try {
                    if (media.type === 'video') {
                        const dims = await getVideoDimensions(media.path);
                        await bot.telegram.sendVideo(chatId, { source: media.path }, {
                            supports_streaming: true,
                            ...(dims && { width: dims.width, height: dims.height }),
                        });
                    } else {
                        await bot.telegram.sendPhoto(chatId, { source: media.path });
                    }
                    sent++;
                } catch (err) {
                    console.warn(`[Telegram AI] Failed to send media: ${err.message}`);
                }
            }

            return `✅ Đã gửi ${sent}/${mediaFiles.length} media files.`;
        }

        default:
            return `Unknown function: ${name}`;
    }
}

// ─── System Prompt ───────────────────────────────────────
const SYSTEM_PROMPT = `You are the AI assistant for Video Creator Workflow — a platform for bulk AI content production.
You help users manage workflows, create jobs, run them, and track progress via Telegram.

You have persistent memory — you remember ALL past conversations with this user across sessions.

Capabilities:
- List user's workflows
- List jobs in a workflow
- Create new jobs (user sends photos as input)
- Run jobs (trigger batch execution)
- Check execution status
- Stop running batches
- View execution history
- **Search completed jobs** — find past jobs by name or keyword
- **Resend job media** — send images/videos from completed jobs back to the chat

Important rules:
- When user wants to create a job, first ask which workflow (use list_workflows if needed), then ask for photos.
- When user sends photos, store them and ask if they want to create a job with those photos.
- When user asks about past results, old jobs, or wants to see previous outputs, use search_completed_jobs first, then offer to resend media with resend_job_media.
- Respond in the same language as the user (Vietnamese or English).
- Be concise but helpful.
- Use emojis to make responses friendly.
- When showing IDs, format them in monospace.
- If a function returns 'NEEDS_PHOTOS', tell the user to send their input photos.`;

// ─── Gemini Provider ─────────────────────────────────────
async function callGemini(messages) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not configured');

    const ai = new GoogleGenAI({ apiKey });

    // Read model from admin settings (DB), fallback to default
    let selectedModel = 'gemini-3-flash-preview';
    try {
        const setting = await prisma.systemSetting.findUnique({ where: { key: 'telegram_ai_model' } });
        if (setting?.value) selectedModel = setting.value;
    } catch { /* use default */ }

    // Build history for chat (all messages except the last one)
    const history = messages.slice(0, -1)
        .map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }],
        }))
        // Gemini requires history to start with 'user' — drop leading 'model' messages
        .reduce((acc, msg) => {
            if (acc.length === 0 && msg.role === 'model') return acc;
            return [...acc, msg];
        }, []);

    const chat = ai.chats.create({
        model: selectedModel,
        history,
        config: {
            tools: [{ functionDeclarations }],
            systemInstruction: SYSTEM_PROMPT,
        },
    });

    const lastMessage = messages[messages.length - 1];
    const response = await chat.sendMessage({ message: lastMessage.content });

    const functionCalls = [];
    const textParts = [];

    // New SDK: response.candidates[0].content.parts for function calls
    const candidate = response.candidates?.[0];
    if (!candidate) return { text: 'Xin lỗi, tôi không thể trả lời lúc này.', functionCalls: [] };

    for (const part of candidate.content?.parts || []) {
        if (part.functionCall) {
            functionCalls.push({
                name: part.functionCall.name,
                arguments: part.functionCall.args || {},
            });
        }
        if (part.text) {
            textParts.push(part.text);
        }
    }

    return { text: textParts.join(''), functionCalls };
}

// ─── OpenRouter Provider ─────────────────────────────────
async function callOpenRouter(messages) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error('OPENROUTER_API_KEY not configured');

    const tools = functionDeclarations.map(f => ({
        type: 'function',
        function: {
            name: f.name,
            description: f.description,
            parameters: f.parameters,
        },
    }));

    const formattedMessages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...messages,
    ];

    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': 'https://vcw.local',
        },
        body: JSON.stringify({
            model: 'google/gemini-2.0-flash-exp:free',
            messages: formattedMessages,
            tools,
            tool_choice: 'auto',
        }),
    });

    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`OpenRouter API error: ${res.status} ${errorText}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) return { text: 'Xin lỗi, tôi không thể trả lời lúc này.', functionCalls: [] };

    const functionCalls = [];
    if (choice.message?.tool_calls) {
        for (const tc of choice.message.tool_calls) {
            functionCalls.push({
                name: tc.function.name,
                arguments: typeof tc.function.arguments === 'string'
                    ? JSON.parse(tc.function.arguments)
                    : tc.function.arguments,
            });
        }
    }

    return { text: choice.message?.content || '', functionCalls };
}

// ─── Unified AI Call ─────────────────────────────────────
async function callAI(messages) {
    const provider = process.env.TELEGRAM_AI_PROVIDER || 'gemini';
    if (provider === 'openrouter') {
        return callOpenRouter(messages);
    }
    return callGemini(messages);
}

// ─── Quick Create + Run Helper ───────────────────────────
async function quickCreateAndRun(ctx, state, workflowId, userId, chatId) {
    const photoCount = state.pendingPhotos.length;

    const maxOrder = await prisma.job.aggregate({
        where: { workflowId },
        _max: { order: true },
    });
    const nextOrder = (maxOrder._max.order ?? -1) + 1;
    const jobName = `Job ${nextOrder + 1}`;

    const inputData = {
        filePaths: state.pendingPhotos.map(p => p.fileUrl),
    };
    const job = await prisma.job.create({
        data: {
            workflowId,
            name: jobName,
            order: nextOrder,
            inputData: JSON.stringify(inputData),
        },
    });

    // Clear pending state
    state.pendingPhotos = [];
    state.pendingWorkflowId = null;
    state.awaitingConfirm = null;
    state.awaitingWorkflowSelect = null;

    // Run immediately
    const result = await runJobBatch(workflowId, [job.id], userId, 'parallel', 3);

    await ctx.reply(
        `✅ Đã tạo **${jobName}** với ${photoCount} ảnh\n` +
        `⚡ Đang chạy... Batch ID: \`${result.batchId}\`\n\n` +
        `Tôi sẽ gửi kết quả khi hoàn thành!`,
        { parse_mode: 'Markdown' }
    ).catch(() => ctx.reply(`✅ Đã tạo ${jobName} với ${photoCount} ảnh. Đang chạy...`));
}

// ─── Handle Text Message ─────────────────────────────────
export async function handleMessage(ctx) {
    const chatId = String(ctx.chat.id);
    const userId = ctx.userId;
    const text = ctx.message.text.trim();

    const state = getChatState(chatId);

    // ── State: Awaiting confirm (1 workflow) ──────────────
    if (state.awaitingConfirm) {
        const yes = /^(ok|yes|y|có|co|ừ|uh|u|đồng ý|dong y|chạy|chay|run|confirm|1|👍)$/i.test(text);
        if (yes) {
            await ctx.sendChatAction('typing');
            await quickCreateAndRun(ctx, state, state.awaitingConfirm.workflowId, userId, chatId);
            return;
        }
        state.awaitingConfirm = null;
        state.pendingPhotos = [];
        await ctx.reply('❌ Đã huỷ. Gửi ảnh mới khi bạn muốn tạo job.');
        return;
    }

    // ── State: Awaiting workflow selection (multiple) ─────
    if (state.awaitingWorkflowSelect) {
        const num = parseInt(text);
        const workflows = state.awaitingWorkflowSelect;
        if (num >= 1 && num <= workflows.length) {
            const selected = workflows[num - 1];
            await ctx.sendChatAction('typing');
            await quickCreateAndRun(ctx, state, selected.id, userId, chatId);
            return;
        }
        await ctx.reply(`⚠️ Vui lòng nhập số từ 1 đến ${workflows.length}.`);
        return;
    }

    // ── Normal AI conversation ────────────────────────────
    // Save user message to DB
    await saveMessage(chatId, 'user', text);

    // Load full conversation history from DB
    const history = await loadChatHistory(chatId);

    // Show typing
    await ctx.sendChatAction('typing');

    // Call AI with full persistent history
    let response = await callAI(history);

    // Handle function calls (may chain multiple)
    let iterations = 0;
    while (response.functionCalls.length > 0 && iterations < 5) {
        iterations++;
        const results = [];

        for (const fc of response.functionCalls) {
            console.log(`[Telegram AI] Calling function: ${fc.name}`, fc.arguments);
            const result = await executeFunction(fc.name, fc.arguments, userId, chatId);
            results.push({ name: fc.name, result });
        }

        // Add function context to history for this turn (not persisted)
        const resultText = results.map(r => `[Function ${r.name} result]: ${r.result}`).join('\n');
        history.push({ role: 'assistant', content: response.text || '(calling functions...)' });
        history.push({ role: 'user', content: resultText });

        await ctx.sendChatAction('typing');
        response = await callAI(history);
    }

    // Save & send final response
    const replyText = response.text || 'Tôi đã thực hiện yêu cầu của bạn.';
    await saveMessage(chatId, 'assistant', replyText);

    // Split long messages (Telegram limit: 4096 chars)
    if (replyText.length > 4000) {
        const chunks = replyText.match(/.{1,4000}/gs) || [replyText];
        for (const chunk of chunks) {
            await ctx.reply(chunk, { parse_mode: 'Markdown' }).catch(() =>
                ctx.reply(chunk)
            );
        }
    } else {
        await ctx.reply(replyText, { parse_mode: 'Markdown' }).catch(() =>
            ctx.reply(replyText)
        );
    }
}

// ─── Handle Photo Message ────────────────────────────────
export async function handlePhoto(ctx) {
    const chatId = String(ctx.chat.id);
    const userId = ctx.userId;
    const state = getChatState(chatId);

    const photos = ctx.message.photo;
    const bestPhoto = photos[photos.length - 1];

    await ctx.sendChatAction('typing');

    const saved = await downloadTelegramPhoto(ctx, bestPhoto.file_id);
    state.pendingPhotos.push(saved);

    if (ctx.message.media_group_id) {
        if (state._mediaGroupId === ctx.message.media_group_id) {
            clearTimeout(state._mediaGroupTimer);
        }
        state._mediaGroupId = ctx.message.media_group_id;
        state._mediaGroupTimer = setTimeout(() => {
            processPhotoFlow(ctx, state, userId, chatId);
            state._mediaGroupId = null;
        }, 1500);
        return;
    }

    await processPhotoFlow(ctx, state, userId, chatId);
}

// ─── Process Photo Flow ──────────────────────────────────
async function processPhotoFlow(ctx, state, userId, chatId) {
    const count = state.pendingPhotos.length;

    const workflows = await prisma.workflow.findMany({
        where: { userId },
        select: { id: true, name: true },
        orderBy: { updatedAt: 'desc' },
    });

    if (workflows.length === 0) {
        state.pendingPhotos = [];
        await ctx.reply('❌ Bạn chưa có workflow nào. Hãy tạo workflow trên Web UI trước.');
        return;
    }

    if (workflows.length === 1) {
        const wf = workflows[0];
        state.awaitingConfirm = { workflowId: wf.id, workflowName: wf.name };
        await ctx.reply(
            `📸 Đã nhận ${count} ảnh!\n\n` +
            `🔧 Workflow: **${wf.name}**\n` +
            `📦 Sẽ tạo job với ${count} ảnh và chạy ngay.\n\n` +
            `✅ Gõ **ok** để xác nhận, hoặc gửi thêm ảnh.`,
            { parse_mode: 'Markdown' }
        ).catch(() => ctx.reply(`📸 Đã nhận ${count} ảnh! Workflow: ${wf.name}. Gõ "ok" để chạy.`));
    } else {
        state.awaitingWorkflowSelect = workflows;
        const list = workflows.map((w, i) => `${i + 1}. **${w.name}**`).join('\n');
        await ctx.reply(
            `📸 Đã nhận ${count} ảnh!\n\n` +
            `Chọn workflow bằng số:\n${list}\n\n` +
            `Sẽ tạo job và chạy ngay sau khi chọn.`,
            { parse_mode: 'Markdown' }
        ).catch(() => ctx.reply(`📸 Đã nhận ${count} ảnh! Chọn workflow:\n${workflows.map((w, i) => `${i + 1}. ${w.name}`).join('\n')}`));
    }
}
