type JsonSchema = Record<string, unknown>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

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
        if (Array.isArray(current.enum) && !current.enum.some((item) => JSON.stringify(item) === JSON.stringify(candidate))) errors.push(`${path}: value is not in enum`);
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
