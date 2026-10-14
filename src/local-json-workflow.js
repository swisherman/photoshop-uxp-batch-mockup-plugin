// Local T-shirt workflow. Uses UXP entries and never calls production APIs.
module.exports = async function runLocalJsonWorkflow(steps, deps) {
    const { fs, core, openTemplate, applyDesign, applyMockup, exportPng,
        exportGroups, getFolders, childFolder, updateFolders } = deps;
    if (!Array.isArray(steps) || !steps.length) throw new Error('Load a PSD workflow JSON first.');
    const ordered = [...steps].sort((a, b) => Number(a.WorkflowStep) - Number(b.WorkflowStep));
    if (Number(ordered[0].WorkflowStep) !== 10 ||
        ordered.filter(s => Number(s.WorkflowStep) === 10).length !== 1 ||
        ordered.some(s => s.ProductType !== 'tshirt' || !s.FilePathName || ![10, 20].includes(Number(s.WorkflowStep)))) {
        throw new Error('Local mode requires one tshirt Step 10, followed by optional Step 20 templates.');
    }
    const jsonFile = await fs.getFileForOpening({ types: ['json'] });
    if (!jsonFile) throw new Error('No artwork records JSON selected.');
    const items = JSON.parse((await jsonFile.read()).replace(/^\uFEFF/, ''));
    if (!Array.isArray(items) || !items.length) throw new Error('Artwork JSON must contain a nonempty array.');
    const { inputTokenKey, outputTokenKey } = getFolders();
    const input = await deps.rememberFolder(inputTokenKey, 'Select demo input folder');
    const output = await deps.rememberFolder(outputTokenKey, 'Select demo output folder');
    if (!input?.isFolder || !output?.isFolder) throw new Error('Input and output folders are required.');
    updateFolders(input, output);
    const simpleName = name => typeof name === 'string' && name.trim() && !/[\\/:]/.test(name) && !['.', '..'].includes(name);
    const prepared = [];
    const seen = new Set();
    for (const item of items) {
        if (!simpleName(item.FolderName) || !simpleName(item.Filename) ||
            !/\.png$/i.test(item.Filename) || typeof item.Phrase !== 'string' || !item.Phrase.trim()) {
            throw new Error('Each record requires Phrase, FolderName and a PNG Filename (simple names).');
        }
        if (seen.has(item.FolderName.toLowerCase())) throw new Error('Each demo record needs a distinct FolderName.');
        seen.add(item.FolderName.toLowerCase());
        const folder = await input.getEntry(item.FolderName);
        const file = await folder.getEntry(item.Filename);
        if (!file.isFile) throw new Error('Artwork file not found: ' + item.Filename);
        prepared.push({ item, file });
    }
    let completed = 0;
    for (const { item, file } of prepared) {
        const out = await childFolder(output, item.FolderName);
        const baseName = item.Filename.replace(/\.png$/i, '');
        for (const step of ordered) {
            const template = await openTemplate(step);
            let working;
            try {
                const artwork = Number(step.WorkflowStep) === 20 ? await out.getEntry(baseName + '.png') : file;
                await core.executeAsModal(async () => {
                    working = await template.duplicate();
                    if (Number(step.WorkflowStep) === 10) {
                        await applyDesign(working, item.Phrase, artwork);
                        await exportPng(working, out, baseName + '.png');
                    } else {
                        await applyMockup(working, artwork);
                        await exportGroups(working, out, baseName);
                    }
                }, { commandName: 'Local demo: ' + item.Phrase });
            } finally {
                await core.executeAsModal(async () => {
                    try { if (working) await working.closeWithoutSaving(); }
                    finally { await template.closeWithoutSaving(); }
                }, { commandName: 'Close local demo documents' });
            }
        }
        completed++;
    }
    return { processed: completed, failed: 0 };
};
