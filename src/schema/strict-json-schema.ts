/**
 * 功能：描述严格 schema 兼容性检查的诊断结果。
 */
export interface StrictSchemaCompatibilityDiagnostic {
    compatible: boolean;
    path?: string;
    reason?: string;
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

