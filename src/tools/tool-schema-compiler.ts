import { createSSHelperError, type LlmToolDefinition, type PlainData, type ProviderToolDialect } from '@ss-helper/sdk';
import { validateJsonSchema } from '../schema/json-schema-validator';

export const SS_HELPER_TOOL_SCHEMA_PROFILE = 'ss_helper_tool_v0' as const;

const ALLOWED_TYPES = new Set(['object', 'string', 'number', 'integer', 'boolean', 'array']);
const ALLOWED_KEYS = new Set([
    'type', 'properties', 'required', 'enum', 'items', 'minimum', 'maximum',
    'minLength', 'maxLength', 'minItems', 'maxItems', 'additionalProperties', 'description',
]);

const schemaFailure = (path: string, keyword: string, expected: string): never => {
    throw createSSHelperError('LLM_TOOL_SCHEMA_UNSUPPORTED', {
        stage: 'llm.tools.schema.compile',
        path,
        keyword,
        expected,
    });
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inspectSchema(value: unknown, path: string, depth: number): void {
    if (!isRecord(value)) schemaFailure(path, 'type', 'a JSON Schema object');
    const schema = value as Record<string, unknown>;
    if (depth > 8) schemaFailure(path, 'depth', 'at most 8 nested schema levels');
    for (const key of Object.keys(schema)) {
        if (!ALLOWED_KEYS.has(key)) schemaFailure(`${path}.${key}`, key, 'a keyword allowed by ss_helper_tool_v0');
    }
    if (!ALLOWED_TYPES.has(String(schema.type))) schemaFailure(`${path}.type`, 'enum', 'object|string|number|integer|boolean|array');
    if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) schemaFailure(`${path}.enum`, 'minItems', 'a non-empty enum');
    for (const key of ['minimum', 'maximum', 'minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
        if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || Number(schema[key]) < 0)) schemaFailure(`${path}.${key}`, key, 'a finite non-negative number');
    }
    if (schema.type === 'object') {
        if (!isRecord(schema.properties)) schemaFailure(`${path}.properties`, 'type', 'an object property map');
        if (schema.additionalProperties !== false) schemaFailure(`${path}.additionalProperties`, 'const', 'false');
        if (!Array.isArray(schema.required) || !schema.required.every((item: unknown) => typeof item === 'string')) schemaFailure(`${path}.required`, 'type', 'an array of property names');
        const properties = schema.properties as Record<string, unknown>;
        const propertyNames = Object.keys(properties);
        for (const required of schema.required as string[]) {
            if (!propertyNames.includes(required)) schemaFailure(`${path}.required`, 'required', `a declared property name (${required})`);
        }
        for (const [key, child] of Object.entries(properties)) inspectSchema(child, `${path}.properties.${key}`, depth + 1);
    }
    if (schema.type === 'array') {
        if (schema.items === undefined) schemaFailure(`${path}.items`, 'required', 'an item schema');
        inspectSchema(schema.items, `${path}.items`, depth + 1);
    }
}

function clonePlain<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export class ToolSchemaCompiler {
    compile(definitions: readonly LlmToolDefinition[], _dialect: ProviderToolDialect): readonly LlmToolDefinition[] {
        if (definitions.length === 0) schemaFailure('$.tools', 'minItems', 'at least one tool definition');
        const names = new Set<string>();
        return Object.freeze(definitions.map((definition, index) => {
            if (!/^[A-Za-z0-9_.-]{1,96}$/u.test(definition.name)) schemaFailure(`$.tools[${index}].name`, 'pattern', 'a stable tool name');
            if (names.has(definition.name)) schemaFailure(`$.tools[${index}].name`, 'uniqueItems', 'a unique tool name');
            names.add(definition.name);
            inspectSchema(definition.parameters, `$.tools[${index}].parameters`, 0);
            return Object.freeze({ ...definition, parameters: clonePlain(definition.parameters), strict: definition.strict !== false });
        }));
    }

    validateArguments(definition: LlmToolDefinition, value: PlainData): void {
        const result = validateJsonSchema(value, definition.parameters as object);
        if (result.valid) return;
        const issue = result.issues[0];
        throw createSSHelperError('LLM_TOOL_CALL_INVALID', {
            stage: 'llm.tools.arguments.validate',
            path: issue?.path ?? '$',
            keyword: issue?.keyword ?? 'schema',
            expected: issue?.expected ?? 'arguments matching the tool schema',
        });
    }
}
