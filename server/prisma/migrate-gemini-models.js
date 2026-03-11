/**
 * Migration: Update deprecated Gemini model names in Workflow nodesData
 * 
 * Replaces 'gemini-2.5-flash' → 'gemini-3-flash-preview' in all saved workflows.
 * 
 * Run: node server/prisma/migrate-gemini-models.js
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
    const workflows = await prisma.workflow.findMany({
        select: { id: true, name: true, nodesData: true },
    });

    let updated = 0;

    for (const wf of workflows) {
        if (wf.nodesData.includes('gemini-2.5-flash')) {
            const newNodesData = wf.nodesData.replaceAll('gemini-2.5-flash', 'gemini-3-flash-preview');
            await prisma.workflow.update({
                where: { id: wf.id },
                data: { nodesData: newNodesData },
            });
            updated++;
            console.log(`✅ Updated workflow "${wf.name}" (${wf.id})`);
        }
    }

    if (updated === 0) {
        console.log('ℹ️  No workflows needed updating.');
    } else {
        console.log(`\n🎉 Done! Updated ${updated} workflow(s).`);
    }
}

main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
