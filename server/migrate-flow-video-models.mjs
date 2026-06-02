#!/usr/bin/env node
/**
 * One-off migration: remap retired Google Flow video model keys on saved workflows.
 *
 *   veo3_fast_low | veo3_fast | veo3_lite  ->  veo3_lite_low
 *   veo3                                   ->  veo3_quality
 *   veo3_lite_low                          ->  (unchanged)
 *
 * Scans Workflow.nodesData for nodes with data.type === 'google-flow-video' and
 * rewrites data.config.model. The connector ALSO aliases these keys at runtime
 * (resolveModelAlias in connectors/google-flow/connector.js), so this migration is
 * NON-load-bearing — old stored keys keep working even if you never run it. Its only
 * job is to normalise stored values so the builder dropdown shows the right option.
 *
 * Dry-run by default. Pass --apply to write.
 *
 * Run (from the server/ directory):
 *   cp prisma/dev.db prisma/dev.db.bak-$(date +%s)     # back up FIRST
 *   node migrate-flow-video-models.mjs                 # dry-run (no writes)
 *   node migrate-flow-video-models.mjs --apply         # write changes
 *
 * On the VPS the DB is /opt/vcw/app/server/prisma/dev.db (DATABASE_URL=file:./dev.db).
 * Because the runtime alias covers old keys, deploy the code first, then run this at leisure.
 */
import { PrismaClient } from '@prisma/client';

// A plain `new PrismaClient()` does NOT auto-load .env (only the Prisma CLI does).
// Default to the server's SQLite path (Prisma resolves it relative to prisma/schema.prisma)
// when DATABASE_URL is not already present in the environment.
process.env.DATABASE_URL ||= 'file:./dev.db';

const APPLY = process.argv.includes('--apply');

const MODEL_REMAP = {
    veo3_fast_low: 'veo3_lite_low',
    veo3_fast: 'veo3_lite_low',
    veo3: 'veo3_quality',
    veo3_lite: 'veo3_lite_low',
    // veo3_lite_low: unchanged (not listed)
};

const prisma = new PrismaClient();

async function main() {
    // Surface the resolved target so the operator can eyeball it before --apply
    // (matters if a stray DATABASE_URL is exported in the shell).
    console.log(`[migrate] DATABASE_URL=${process.env.DATABASE_URL}`);
    const workflows = await prisma.workflow.findMany({ select: { id: true, name: true, nodesData: true } });
    console.log(`[migrate] ${workflows.length} workflow(s) found. Mode: ${APPLY ? 'APPLY (writing)' : 'DRY-RUN (no writes)'}`);

    let changedWorkflows = 0;
    let changedNodes = 0;

    for (const wf of workflows) {
        let nodes;
        try {
            nodes = JSON.parse(wf.nodesData || '[]');
        } catch (e) {
            console.warn(`[migrate] SKIP workflow ${wf.id} ("${wf.name}") — nodesData is not valid JSON: ${e.message}`);
            continue;
        }
        if (!Array.isArray(nodes)) continue;

        let wfChanged = false;
        for (const node of nodes) {
            // Connector key lives at node.data.type (node.type is the React Flow visual type).
            if (node?.data?.type !== 'google-flow-video') continue;
            const cfg = node.data.config;
            if (!cfg || typeof cfg.model !== 'string') continue; // no model => runtime default veo3_lite_low
            const next = MODEL_REMAP[cfg.model];
            if (next && next !== cfg.model) {
                console.log(`  workflow ${wf.id} ("${wf.name}") node ${node.id}: ${cfg.model} -> ${next}`);
                cfg.model = next;
                wfChanged = true;
                changedNodes++;
            }
        }

        if (wfChanged) {
            changedWorkflows++;
            if (APPLY) {
                await prisma.workflow.update({
                    where: { id: wf.id },
                    data: { nodesData: JSON.stringify(nodes) },
                });
            }
        }
    }

    // Informational only: Job.inputData holds { filePaths, variables } — there is no
    // model-override path there. Warn (don't auto-migrate) if a stale key appears anyway.
    const jobs = await prisma.job.findMany({ select: { id: true, name: true, inputData: true } });
    let jobHits = 0;
    for (const job of jobs) {
        if (!job.inputData) continue;
        for (const oldKey of Object.keys(MODEL_REMAP)) {
            if (job.inputData.includes(`"${oldKey}"`)) {
                console.warn(`[migrate] NOTE: Job ${job.id} ("${job.name}") inputData mentions "${oldKey}" — review manually (not auto-migrated).`);
                jobHits++;
                break;
            }
        }
    }

    console.log(`[migrate] ${changedNodes} node(s) across ${changedWorkflows} workflow(s) ${APPLY ? 'updated' : 'would change'}.`);
    if (jobHits) console.log(`[migrate] ${jobHits} job(s) reference an old key in inputData — review manually.`);
    if (!APPLY && changedNodes) console.log('[migrate] Re-run with --apply to write these changes.');
}

main()
    .catch((e) => { console.error('[migrate] FAILED:', e); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
