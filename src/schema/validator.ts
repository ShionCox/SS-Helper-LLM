/** Strictly parses one JSON root object without cleaning, stitching, or fence extraction. */
export function parseJsonOutput(raw: string | object): { ok: boolean; data: any } {
    if (raw && typeof raw === 'object') {
        return Array.isArray(raw)
            ? { ok: false, data: null }
            : { ok: true, data: raw };
    }
    if (!raw || typeof raw !== 'string') {
        return { ok: false, data: null };
    }

    try {
        const parsed = JSON.parse(raw.trim());
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? { ok: true, data: parsed }
            : { ok: false, data: null };
    } catch {
        return { ok: false, data: null };
    }
}
