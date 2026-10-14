/**
 * MMD metadata parsing utility.
 * Extracted from prompts/l15.ts — pure data parsing, not a prompt.
 */
export function parseMmdMeta(filename, mmdPath, content) {
    const meta = {
        filename,
        path: mmdPath,
        taskGoal: "",
        createdTime: null,
        updatedTime: null,
        doneCount: 0,
        doingCount: 0,
        todoCount: 0,
        nodeSummaries: [],
    };
    const metaMatch = content.match(/^%%\{\s*(.*?)\s*\}%%/);
    if (metaMatch) {
        try {
            const p = JSON.parse(`{${metaMatch[1]}}`);
            meta.taskGoal = p.taskGoal || "";
            meta.createdTime = p.createdTime || null;
            meta.updatedTime = p.updatedTime || null;
        }
        catch {
            /* ignore */
        }
    }
    meta.doneCount = (content.match(/status:\s*done/gi) || []).length;
    meta.doingCount = (content.match(/status:\s*doing/gi) || []).length;
    meta.todoCount = (content.match(/status:\s*todo/gi) || []).length;
    const nodeRe = /(\d{3}-N\d+)\["([^"]*?)"\]/g;
    let m;
    while ((m = nodeRe.exec(content)) !== null) {
        const nodeText = m[2];
        const summaryMatch = nodeText.match(/summary:\s*(.+?)(?:<br\/>|$)/i);
        const statusMatch = nodeText.match(/status:\s*(\w+)/i);
        if (summaryMatch) {
            meta.nodeSummaries.push({
                nodeId: m[1],
                status: statusMatch ? statusMatch[1] : "unknown",
                summary: summaryMatch[1].trim().slice(0, 100),
            });
        }
    }
    if (meta.nodeSummaries.length > 2) {
        meta.nodeSummaries = meta.nodeSummaries.slice(-2);
    }
    return meta;
}
