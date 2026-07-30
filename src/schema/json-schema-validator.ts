type JsonSchema = Record<string, unknown>;

export interface JsonSchemaIssue {
    readonly path: string;
    readonly keyword: string;
    readonly expected: string;
}

export interface JsonSchemaItemRejection {
    readonly collection: string;
    readonly itemIndex: number;
    readonly issues: JsonSchemaIssue[];
    readonly sourceRefs: string[];
}

export type ItemizedJsonSchemaResult =
    | { valid: true; value: unknown; rejections: JsonSchemaItemRejection[] }
    | { valid: false; errors: string[]; issues: JsonSchemaIssue[] };

const MAX_DEPTH = 24;
const MAX_ISSUES = 32;
const ANNOTATION_KEYWORDS = new Set(['$id', '$schema', 'title', 'description', 'default', 'examples']);
const VALIDATION_KEYWORDS = new Set([
    'type', 'enum', 'const',
    'properties', 'required', 'additionalProperties',
    'items', 'minItems', 'maxItems', 'uniqueItems',
    'minLength', 'maxLength', 'pattern',
    'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
]);

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const equalJson = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);

function formatIssue(issue: JsonSchemaIssue): string {
    return `${issue.path}: ${issue.keyword} expected ${issue.expected}`;
}

function pushIssue(issues: JsonSchemaIssue[], issue: JsonSchemaIssue): void {
    if (issues.length < MAX_ISSUES) issues.push(issue);
}

export function preflightJsonSchema(schema: object): { valid: true } | { valid: false; errors: string[]; issues: JsonSchemaIssue[] } {
    const issues: JsonSchemaIssue[] = [];
    const visit = (current: JsonSchema, path: string, depth: number): void => {
        if (depth > MAX_DEPTH) {
            pushIssue(issues, { path, keyword: 'depth', expected: `at most ${MAX_DEPTH}` });
            return;
        }
        for (const keyword of Object.keys(current)) {
            if (!ANNOTATION_KEYWORDS.has(keyword) && !VALIDATION_KEYWORDS.has(keyword)) {
                pushIssue(issues, { path, keyword, expected: 'a supported SS-Helper JSON Schema keyword' });
            }
        }
        const declaredType = current.type;
        const types = Array.isArray(declaredType) ? declaredType : declaredType === undefined ? [] : [declaredType];
        const allowedTypes = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
        if (types.some((type) => typeof type !== 'string' || !allowedTypes.has(type))) {
            pushIssue(issues, { path, keyword: 'type', expected: 'object|array|string|number|integer|boolean|null' });
        }
        if (current.properties !== undefined && !isObject(current.properties)) {
            pushIssue(issues, { path, keyword: 'properties', expected: 'an object of schemas' });
        } else if (isObject(current.properties)) {
            for (const [key, child] of Object.entries(current.properties)) {
                if (!isObject(child)) pushIssue(issues, { path: `${path}.${key}`, keyword: 'schema', expected: 'an object' });
                else visit(child, `${path}.${key}`, depth + 1);
            }
        }
        if (current.items !== undefined) {
            if (!isObject(current.items)) pushIssue(issues, { path, keyword: 'items', expected: 'a single schema object' });
            else visit(current.items, `${path}[]`, depth + 1);
        }
        if (current.required !== undefined && (!Array.isArray(current.required) || !current.required.every((key) => typeof key === 'string'))) {
            pushIssue(issues, { path, keyword: 'required', expected: 'an array of property names' });
        }
        if (current.additionalProperties !== undefined && current.additionalProperties !== false) {
            pushIssue(issues, { path, keyword: 'additionalProperties', expected: 'false' });
        }
        if (current.pattern !== undefined) {
            if (typeof current.pattern !== 'string') pushIssue(issues, { path, keyword: 'pattern', expected: 'a regular expression string' });
            else {
                try { new RegExp(current.pattern, 'u'); } catch { pushIssue(issues, { path, keyword: 'pattern', expected: 'a valid regular expression' }); }
            }
        }
    };
    visit(schema as JsonSchema, '$', 0);
    return issues.length ? { valid: false, errors: issues.map(formatIssue), issues } : { valid: true };
}

export function validateJsonSchema(value: unknown, schema: object): { valid: true } | { valid: false; errors: string[]; issues: JsonSchemaIssue[] } {
    const preflight = preflightJsonSchema(schema);
    if (!preflight.valid) return preflight;

    const issues: JsonSchemaIssue[] = [];
    const visit = (candidate: unknown, current: JsonSchema, path: string, depth: number): void => {
        if (depth > MAX_DEPTH || issues.length >= MAX_ISSUES) return;
        const declaredType = current.type;
        const types = Array.isArray(declaredType) ? declaredType : declaredType === undefined ? [] : [declaredType];
        const matches = (type: unknown): boolean => type === 'object' ? isObject(candidate)
            : type === 'array' ? Array.isArray(candidate)
                : type === 'string' ? typeof candidate === 'string'
                    : type === 'number' ? typeof candidate === 'number' && Number.isFinite(candidate)
                        : type === 'integer' ? Number.isInteger(candidate)
                            : type === 'boolean' ? typeof candidate === 'boolean'
                                : type === 'null' ? candidate === null : false;
        if (types.length > 0 && !types.some(matches)) {
            pushIssue(issues, { path, keyword: 'type', expected: types.join('|') });
            return;
        }
        if (Array.isArray(current.enum) && !current.enum.some((item) => equalJson(item, candidate))) {
            pushIssue(issues, { path, keyword: 'enum', expected: current.enum.map((item) => JSON.stringify(item)).join('|') });
        }
        if (Object.hasOwn(current, 'const') && !equalJson(current.const, candidate)) {
            pushIssue(issues, { path, keyword: 'const', expected: JSON.stringify(current.const) });
        }
        if (isObject(candidate)) {
            const properties = isObject(current.properties) ? current.properties : {};
            const required = Array.isArray(current.required) ? current.required as string[] : [];
            for (const key of required) {
                if (!(key in candidate)) pushIssue(issues, { path: `${path}.${key}`, keyword: 'required', expected: 'property to be present' });
            }
            if (current.additionalProperties === false) {
                for (const key of Object.keys(candidate)) {
                    if (!(key in properties)) pushIssue(issues, { path: `${path}.${key}`, keyword: 'additionalProperties', expected: 'property to be absent' });
                }
            }
            for (const [key, childSchema] of Object.entries(properties)) {
                if (key in candidate && isObject(childSchema)) visit(candidate[key], childSchema, `${path}.${key}`, depth + 1);
            }
        }
        if (Array.isArray(candidate)) {
            if (typeof current.minItems === 'number' && candidate.length < current.minItems) pushIssue(issues, { path, keyword: 'minItems', expected: String(current.minItems) });
            if (typeof current.maxItems === 'number' && candidate.length > current.maxItems) pushIssue(issues, { path, keyword: 'maxItems', expected: String(current.maxItems) });
            if (current.uniqueItems === true) {
                const serialized = candidate.map((item) => JSON.stringify(item));
                if (new Set(serialized).size !== serialized.length) pushIssue(issues, { path, keyword: 'uniqueItems', expected: 'all items to be distinct' });
            }
            if (isObject(current.items)) candidate.forEach((item, index) => visit(item, current.items as JsonSchema, `${path}[${index}]`, depth + 1));
        }
        if (typeof candidate === 'string') {
            if (typeof current.minLength === 'number' && Array.from(candidate).length < current.minLength) pushIssue(issues, { path, keyword: 'minLength', expected: String(current.minLength) });
            if (typeof current.maxLength === 'number' && Array.from(candidate).length > current.maxLength) pushIssue(issues, { path, keyword: 'maxLength', expected: String(current.maxLength) });
            if (typeof current.pattern === 'string' && !new RegExp(current.pattern, 'u').test(candidate)) pushIssue(issues, { path, keyword: 'pattern', expected: current.pattern });
        }
        if (typeof candidate === 'number' && Number.isFinite(candidate)) {
            if (typeof current.minimum === 'number' && candidate < current.minimum) pushIssue(issues, { path, keyword: 'minimum', expected: String(current.minimum) });
            if (typeof current.maximum === 'number' && candidate > current.maximum) pushIssue(issues, { path, keyword: 'maximum', expected: String(current.maximum) });
            if (typeof current.exclusiveMinimum === 'number' && candidate <= current.exclusiveMinimum) pushIssue(issues, { path, keyword: 'exclusiveMinimum', expected: String(current.exclusiveMinimum) });
            if (typeof current.exclusiveMaximum === 'number' && candidate >= current.exclusiveMaximum) pushIssue(issues, { path, keyword: 'exclusiveMaximum', expected: String(current.exclusiveMaximum) });
            if (typeof current.multipleOf === 'number' && current.multipleOf > 0 && Math.abs(candidate / current.multipleOf - Math.round(candidate / current.multipleOf)) > Number.EPSILON) {
                pushIssue(issues, { path, keyword: 'multipleOf', expected: String(current.multipleOf) });
            }
        }
    };
    visit(value, schema as JsonSchema, '$', 0);
    return issues.length ? { valid: false, errors: issues.map(formatIssue), issues } : { valid: true };
}

function schemaEnum(schema: unknown): readonly unknown[] {
    return isObject(schema) && Array.isArray(schema.enum) ? schema.enum : [];
}

function safeSourceRefs(item: Record<string, unknown>, itemSchema: JsonSchema): string[] {
    const properties = isObject(itemSchema.properties) ? itemSchema.properties : {};
    const accepted = new Set<string>();
    const sourceRefSchema = properties.sourceRef;
    if (typeof item.sourceRef === 'string' && schemaEnum(sourceRefSchema).some(value => value === item.sourceRef)) {
        accepted.add(item.sourceRef);
    }
    const sourceRefsSchema = properties.sourceRefs;
    const sourceRefsItemSchema = isObject(sourceRefsSchema) ? sourceRefsSchema.items : undefined;
    if (Array.isArray(item.sourceRefs)) {
        for (const value of item.sourceRefs) {
            if (typeof value === 'string' && schemaEnum(sourceRefsItemSchema).some(candidate => candidate === value)) accepted.add(value);
        }
    }
    return [...accepted];
}

/**
 * Validates a fixed object envelope while allowing explicitly named top-level
 * array items to fail independently. Invalid values are never repaired: they
 * are omitted from the returned clone and described by safe path/schema data.
 */
export function validateJsonSchemaItemized(
    value: unknown,
    schema: object,
    collections: readonly string[],
): ItemizedJsonSchemaResult {
    const full = validateJsonSchema(value, schema);
    if (full.valid) return { valid: true, value, rejections: [] };
    if (!isObject(value) || !isObject(schema)) return full;
    const properties = isObject(schema.properties) ? schema.properties : {};
    const allowedCollections = new Set(collections);
    const itemIssuePattern = /^\$\.([A-Za-z0-9_-]+)\[(\d+)\](?:\.|$)/u;
    const envelopeIssues = full.issues.filter(issue => {
        const match = itemIssuePattern.exec(issue.path);
        return !match || !allowedCollections.has(match[1]!);
    });
    if (envelopeIssues.length > 0) {
        return { valid: false, errors: envelopeIssues.map(formatIssue), issues: envelopeIssues };
    }

    const output: Record<string, unknown> = { ...value };
    const rejections: JsonSchemaItemRejection[] = [];
    for (const collection of collections) {
        const collectionValue = value[collection];
        const collectionSchema = properties[collection];
        if (!Array.isArray(collectionValue) || !isObject(collectionSchema) || !isObject(collectionSchema.items)) {
            const issue = { path: `$.${collection}`, keyword: 'itemized', expected: 'an array with an item schema' };
            return { valid: false, errors: [formatIssue(issue)], issues: [issue] };
        }
        const accepted: unknown[] = [];
        collectionValue.forEach((item, itemIndex) => {
            const validation = validateJsonSchema(item, collectionSchema.items as object);
            if (validation.valid) {
                accepted.push(item);
                return;
            }
            const issues = validation.issues.map(issue => ({
                ...issue,
                path: issue.path === '$'
                    ? `$.${collection}[${itemIndex}]`
                    : `$.${collection}[${itemIndex}]${issue.path.slice(1)}`,
            }));
            rejections.push({
                collection,
                itemIndex,
                issues,
                sourceRefs: isObject(item) ? safeSourceRefs(item, collectionSchema.items as JsonSchema) : [],
            });
        });
        output[collection] = accepted;
    }
    return rejections.length > 0
        ? { valid: true, value: output, rejections }
        : { valid: false, errors: full.errors, issues: full.issues };
}
