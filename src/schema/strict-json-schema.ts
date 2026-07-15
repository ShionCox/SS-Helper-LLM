/**
 * 功能：定义严格 schema 自动填充模式。
 */
export type StrictSchemaAutofillMode = 'default' | 'off' | 'force';

/**
 * 功能：定义严格 schema 不兼容时的处理策略。
 */
export type StrictSchemaOnIncompatible = 'downgrade' | 'error';

/**
 * 功能：定义请求级 schema 兼容控制项。
 */
export interface SchemaCompatOptions {
    strictAutofill?: StrictSchemaAutofillMode;
    onIncompatible?: StrictSchemaOnIncompatible;
}

/**
 * 功能：描述严格 schema 兼容性检查的诊断结果。
 */
export interface StrictSchemaCompatibilityDiagnostic {
    compatible: boolean;
    path?: string;
    reason?: string;
}

/**
 * 功能：定义严格 schema 处理结果。
 */
export interface StrictSchemaProcessingResult {
    schema: object | undefined;
    originalCompatible: boolean;
    autofillApplied: boolean;
    providerCompatible: boolean;
    originalDiagnostic: StrictSchemaCompatibilityDiagnostic;
    providerDiagnostic: StrictSchemaCompatibilityDiagnostic;
}

/**
 * 功能：判断 schema 是否兼容 OpenAI/Gemini 严格 json_schema。
 * @param schema 待检查的 schema。
 * @returns 兼容时返回 true，否则返回 false。
 */
export function isStrictJsonSchemaCompatible(schema: unknown): boolean {
    return inspectStrictJsonSchemaCompatibility(schema).compatible;
}

/**
 * 功能：检查 schema 在严格 json_schema 模式下的首个不兼容点。
 * @param schema 待检查的 schema。
 * @returns 兼容诊断结果。
 */
export function inspectStrictJsonSchemaCompatibility(schema: unknown): StrictSchemaCompatibilityDiagnostic {
    const diagnostic = checkStrictJsonSchemaNode(schema, '$', 0);
    return diagnostic || { compatible: true };
}

/**
 * 功能：将普通 JSON Schema 规整成更兼容严格 json_schema 的版本。
 * @param schema 原始 schema。
 * @returns 规整后的 schema；无法处理时返回原值的安全副本。
 */
export function sanitizeStrictJsonSchemaForProvider(schema: unknown): object | undefined {
    if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
        return undefined;
    }
    const cloned = deepCloneSchema(schema as object);
    sanitizeStrictJsonSchemaNode(cloned, 0);
    return cloned;
}

/**
 * 功能：按请求级选项处理 provider 专用 schema。
 * @param schema 原始 schema。
 * @param options 兼容选项。
 * @returns 处理结果。
 */
export function processProviderStrictJsonSchema(
    schema: object | undefined,
    options?: SchemaCompatOptions,
): StrictSchemaProcessingResult {
    const originalDiagnostic = inspectStrictJsonSchemaCompatibility(schema);
    const originalCompatible = originalDiagnostic.compatible;
    const strictAutofill = options?.strictAutofill ?? 'default';

    if (!schema) {
        return {
            schema: undefined,
            originalCompatible,
            autofillApplied: false,
            providerCompatible: false,
            originalDiagnostic,
            providerDiagnostic: {
                compatible: false,
                path: '$',
                reason: 'schema_missing',
            },
        };
    }

    if (strictAutofill === 'off') {
        return {
            schema,
            originalCompatible,
            autofillApplied: false,
            providerCompatible: originalCompatible,
            originalDiagnostic,
            providerDiagnostic: originalDiagnostic,
        };
    }

    if (strictAutofill === 'default' && originalCompatible) {
        return {
            schema,
            originalCompatible,
            autofillApplied: false,
            providerCompatible: true,
            originalDiagnostic,
            providerDiagnostic: originalDiagnostic,
        };
    }

    const sanitized = sanitizeStrictJsonSchemaForProvider(schema);
    const providerDiagnostic = inspectStrictJsonSchemaCompatibility(sanitized);
    return {
        schema: sanitized ?? schema,
        originalCompatible,
        autofillApplied: true,
        providerCompatible: providerDiagnostic.compatible,
        originalDiagnostic,
        providerDiagnostic,
    };
}

/**
 * 功能：递归检查 schema 节点是否满足严格 json_schema 约束。
 * @param node 当前 schema 节点。
 * @param path 当前节点路径。
 * @param depth 当前递归深度。
 * @returns 找到首个不兼容点时返回诊断，否则返回 null。
 */
function checkStrictJsonSchemaNode(
    node: unknown,
    path: string,
    depth: number,
): StrictSchemaCompatibilityDiagnostic | null {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return null;
    }
    if (depth >= 20) {
        return null;
    }

    const record = node as Record<string, unknown>;
    const compositeKeys: Array<'anyOf' | 'oneOf' | 'allOf' | 'prefixItems'> = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
    for (const key of compositeKeys) {
        if (record[key] !== undefined) {
            return {
                compatible: false,
                path: `${path}.${key}`,
                reason: `unsupported_composite_keyword:${key}`,
            };
        }
    }

    if (record.type === 'object') {
        if (!('additionalProperties' in record) || record.additionalProperties !== false) {
            return {
                compatible: false,
                path,
                reason: 'object_additionalProperties_must_be_false',
            };
        }

        if (record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
            const properties = record.properties as Record<string, unknown>;
            const required = Array.isArray(record.required) ? record.required : null;
            if (!required) {
                return {
                    compatible: false,
                    path,
                    reason: 'object_required_must_include_all_properties',
                };
            }

            const requiredSet = new Set(required.map((item: unknown) => String(item ?? '').trim()).filter(Boolean));
            for (const key of Object.keys(properties)) {
                if (!requiredSet.has(key)) {
                    return {
                        compatible: false,
                        path: `${path}.properties.${key}`,
                        reason: `object_required_missing_property:${key}`,
                    };
                }
            }
        }
    }

    if (record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
        for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) {
            const childDiagnostic = checkStrictJsonSchemaNode(child, `${path}.properties.${key}`, depth + 1);
            if (childDiagnostic) {
                return childDiagnostic;
            }
        }
    }

    if (record.items !== undefined) {
        const itemsDiagnostic = checkStrictJsonSchemaNode(record.items, `${path}.items`, depth + 1);
        if (itemsDiagnostic) {
            return itemsDiagnostic;
        }
    }

    if (record.additionalProperties && typeof record.additionalProperties === 'object' && !Array.isArray(record.additionalProperties)) {
        return checkStrictJsonSchemaNode(record.additionalProperties, `${path}.additionalProperties`, depth + 1);
    }

    return null;
}

/**
 * 功能：递归规整 schema 节点。
 * @param node 当前 schema 节点。
 * @param depth 当前递归深度。
 */
function sanitizeStrictJsonSchemaNode(node: unknown, depth: number): void {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
        return;
    }
    if (depth >= 20) {
        return;
    }

    const record = node as Record<string, unknown>;
    if (record.type === 'object' && record.properties && typeof record.properties === 'object' && !Array.isArray(record.properties)) {
        const properties = record.properties as Record<string, unknown>;
        record.additionalProperties = false;
        record.required = Object.keys(properties);
        for (const child of Object.values(properties)) {
            sanitizeStrictJsonSchemaNode(child, depth + 1);
        }
    }

    if (record.items !== undefined) {
        sanitizeStrictJsonSchemaNode(record.items, depth + 1);
    }

    if (record.additionalProperties && typeof record.additionalProperties === 'object' && !Array.isArray(record.additionalProperties)) {
        sanitizeStrictJsonSchemaNode(record.additionalProperties, depth + 1);
    }
}

/**
 * 功能：深拷贝 schema 对象，避免修改调用方原始引用。
 * @param schema 原始 schema。
 * @returns 深拷贝后的 schema。
 */
function deepCloneSchema<T extends object>(schema: T): T {
    return JSON.parse(JSON.stringify(schema)) as T;
}
