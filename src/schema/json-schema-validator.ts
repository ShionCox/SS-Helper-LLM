type JsonSchema = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export interface JsonSchemaEnumRepair {
    path: string;
    from: string;
    to: string;
    reason: 'case_normalized';
}

/**
 * Normalizes only unambiguous string-enum deviations before strict validation.
 *
 * - Case-only deviations are restored to the schema's canonical spelling.
 * The input is never mutated. Other enum failures remain visible to the normal
 * validator and can enter the caller's repair/retry flow.
 */
export function normalizeJsonSchemaEnumFallbacks(
    value: unknown,
    schema: object,
): { data: unknown; repairs: JsonSchemaEnumRepair[] } {
    const repairs: JsonSchemaEnumRepair[] = [];

    const visit = (candidate: unknown, current: JsonSchema, path: string, depth: number): unknown => {
        if (depth > 24) return candidate;

        if (typeof candidate === 'string' && Array.isArray(current.enum)) {
            const stringOptions = current.enum.filter((item): item is string => typeof item === 'string');
            if (!stringOptions.includes(candidate)) {
                const normalizedCandidate = candidate.trim().toLowerCase();
                const caseMatch = stringOptions.find((item) => item.toLowerCase() === normalizedCandidate);
                if (caseMatch !== undefined) {
                    repairs.push({ path, from: candidate, to: caseMatch, reason: 'case_normalized' });
                    return caseMatch;
                }
            }
            return candidate;
        }

        if (isObject(candidate)) {
            const properties = isObject(current.properties) ? current.properties : {};
            let changed = false;
            const output: Record<string, unknown> = { ...candidate };
            for (const [key, childSchema] of Object.entries(properties)) {
                if (!(key in candidate) || !isObject(childSchema)) continue;
                const next = visit(candidate[key], childSchema, `${path}.${key}`, depth + 1);
                if (next !== candidate[key]) {
                    output[key] = next;
                    changed = true;
                }
            }
            return changed ? output : candidate;
        }

        if (Array.isArray(candidate) && isObject(current.items)) {
            let changed = false;
            const output = candidate.map((item, index) => {
                const next = visit(item, current.items as JsonSchema, `${path}[${index}]`, depth + 1);
                if (next !== item) changed = true;
                return next;
            });
            return changed ? output : candidate;
        }

        return candidate;
    };

    return { data: visit(value, schema as JsonSchema, '$', 0), repairs };
}

export function validateJsonSchema(value: unknown, schema: object): { valid: true } | { valid: false; errors: string[] } {
    const errors: string[] = [];
    const visit = (candidate: unknown, current: JsonSchema, path: string, depth: number): void => {
        if (depth > 24 || errors.length >= 32) return;
        const declaredType = current.type;
        const types = Array.isArray(declaredType) ? declaredType : declaredType === undefined ? [] : [declaredType];
        const matches = (type: unknown): boolean => type === 'object' ? isObject(candidate)
            : type === 'array' ? Array.isArray(candidate)
                : type === 'string' ? typeof candidate === 'string'
                    : type === 'number' ? typeof candidate === 'number' && Number.isFinite(candidate)
                        : type === 'integer' ? Number.isInteger(candidate)
                            : type === 'boolean' ? typeof candidate === 'boolean'
                                : type === 'null' ? candidate === null : true;
        if (types.length > 0 && !types.some(matches)) {
            errors.push(`${path}: expected ${types.join('|')}`);
            return;
        }
        if (Array.isArray(current.enum) && !current.enum.some((item) => JSON.stringify(item) === JSON.stringify(candidate))) {
            const allowed = current.enum.map((item) => JSON.stringify(item)).join('|');
            errors.push(`${path}: value is not in enum (allowed: ${allowed})`);
        }
        if (isObject(candidate)) {
            const properties = isObject(current.properties) ? current.properties : {};
            const required = Array.isArray(current.required) ? current.required.map(String) : [];
            for (const key of required) if (!(key in candidate)) errors.push(`${path}.${key}: required`);
            if (current.additionalProperties === false) for (const key of Object.keys(candidate)) if (!(key in properties)) errors.push(`${path}.${key}: additional property is not allowed`);
            for (const [key, childSchema] of Object.entries(properties)) if (key in candidate && isObject(childSchema)) visit(candidate[key], childSchema, `${path}.${key}`, depth + 1);
        }
        if (Array.isArray(candidate) && isObject(current.items)) candidate.forEach((item, index) => visit(item, current.items as JsonSchema, `${path}[${index}]`, depth + 1));
        if (typeof candidate === 'string') {
            if (typeof current.minLength === 'number' && candidate.length < current.minLength) errors.push(`${path}: shorter than minLength`);
            if (typeof current.maxLength === 'number' && candidate.length > current.maxLength) errors.push(`${path}: longer than maxLength`);
        }
    };
    visit(value, schema as JsonSchema, '$', 0);
    return errors.length > 0 ? { valid: false, errors } : { valid: true };
}
