export function buildJsonExampleFromSchema(schema?: object, depth = 0): unknown {
    if (!schema || typeof schema !== 'object' || depth >= 4) {
        return {};
    }

    const node = schema as Record<string, any>;
    const type = String(node.type || '').trim();

    if (type === 'object' || node.properties) {
        const properties = node.properties && typeof node.properties === 'object'
            ? node.properties as Record<string, any>
            : {};
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(properties)) {
            out[key] = buildJsonExampleFromSchema(value as object, depth + 1);
        }
        return out;
    }

    if (type === 'array') {
        const itemExample = buildJsonExampleFromSchema(node.items as object | undefined, depth + 1);
        return Array.isArray(itemExample) ? itemExample : [itemExample];
    }

    if (Array.isArray(node.enum) && node.enum.length > 0) {
        return node.enum[0];
    }

    if (type === 'string') return '';
    if (type === 'number' || type === 'integer') return 0;
    if (type === 'boolean') return false;
    if (type === 'null') return null;

    return '';
}

function summarizeSchemaConstraints(schema?: object, depth = 0, path = 'root'): string[] {
    if (!schema || typeof schema !== 'object' || depth >= 4) {
        return [];
    }

    const node = schema as Record<string, any>;
    const type = Array.isArray(node.type)
        ? node.type.join(' | ')
        : String(node.type || (node.properties ? 'object' : node.items ? 'array' : 'unknown'));
    const lines: string[] = [];

    if (path === 'root') {
        lines.push(`- 根节点类型：${type}`);
        if (node.additionalProperties === false) {
            lines.push('- 根节点禁止输出未声明字段（additionalProperties=false）。');
        }
    }

    const properties = node.properties && typeof node.properties === 'object'
        ? node.properties as Record<string, any>
        : null;
    const required = Array.isArray(node.required) ? node.required.map((item: unknown) => String(item)) : [];

    if (properties) {
        if (required.length > 0) {
            lines.push(`${path === 'root' ? '-' : `- ${path}：`}必填字段：${required.join('、')}`);
        }
        if (node.additionalProperties === false && path !== 'root') {
            lines.push(`- ${path} 禁止输出未声明字段（additionalProperties=false）。`);
        }
        for (const [key, value] of Object.entries(properties)) {
            const child = value as Record<string, any>;
            const childType = Array.isArray(child.type)
                ? child.type.join(' | ')
                : String(child.type || (child.properties ? 'object' : child.items ? 'array' : 'unknown'));
            const childPath = path === 'root' ? key : `${path}.${key}`;
            const enumHint = Array.isArray(child.enum) && child.enum.length > 0
                ? `；枚举值=${child.enum.join(' / ')}`
                : '';
            const itemType = child.items && typeof child.items === 'object'
                ? Array.isArray(child.items.type)
                    ? child.items.type.join(' | ')
                    : String(child.items.type || (child.items.properties ? 'object' : 'unknown'))
                : '';
            const arrayHint = childType === 'array' && itemType
                ? `；数组元素类型=${itemType}`
                : '';
            lines.push(`- ${childPath}：类型=${childType}${arrayHint}${enumHint}`);
            lines.push(...summarizeSchemaConstraints(child, depth + 1, childPath));
        }
    } else if (type === 'array' && node.items && typeof node.items === 'object') {
        const itemType = Array.isArray(node.items.type)
            ? node.items.type.join(' | ')
            : String(node.items.type || (node.items.properties ? 'object' : 'unknown'));
        lines.push(`- ${path}：数组元素类型=${itemType}`);
        lines.push(...summarizeSchemaConstraints(node.items as object, depth + 1, `${path}[]`));
    }

    return lines;
}

function buildMinimumValueFromSchema(schema?: object, depth = 0): unknown {
    if (!schema || typeof schema !== 'object' || depth >= 4) {
        return null;
    }

    const node = schema as Record<string, any>;
    const type = String(node.type || '').trim();

    if (type === 'object' || node.properties) {
        const properties = node.properties && typeof node.properties === 'object'
            ? node.properties as Record<string, any>
            : {};
        const required = Array.isArray(node.required) ? new Set(node.required.map((item: unknown) => String(item))) : null;
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(properties)) {
            if (!required || required.has(key)) {
                out[key] = buildMinimumValueFromSchema(value as object, depth + 1);
            }
        }
        return out;
    }

    if (type === 'array') {
        return [];
    }

    if (Array.isArray(node.enum) && node.enum.length > 0) {
        return node.enum[0];
    }

    if (type === 'string') return '';
    if (type === 'number' || type === 'integer') return 0;
    if (type === 'boolean') return false;
    if (type === 'null') return null;

    return null;
}

function collectSchemaFieldRules(schema?: object, depth = 0, path = ''): string[] {
    if (!schema || typeof schema !== 'object' || depth >= 4) {
        return [];
    }

    const node = schema as Record<string, any>;
    const properties = node.properties && typeof node.properties === 'object'
        ? node.properties as Record<string, any>
        : null;

    if (!properties) {
        return [];
    }

    const required = Array.isArray(node.required) ? new Set(node.required.map((item: unknown) => String(item))) : new Set<string>();
    const lines: string[] = [];

    for (const [key, value] of Object.entries(properties)) {
        const child = value as Record<string, any>;
        const childType = Array.isArray(child.type)
            ? child.type.join(' | ')
            : String(child.type || (child.properties ? 'object' : child.items ? 'array' : 'unknown'));
        const childPath = path ? `${path}.${key}` : key;
        const desc = typeof child.description === 'string' && child.description.trim()
            ? `：${child.description.trim()}`
            : '';
        const enumHint = Array.isArray(child.enum) && child.enum.length > 0
            ? `；可选值=${child.enum.join(' / ')}`
            : '';
        const requiredHint = required.has(key) ? '必填' : '可选';
        lines.push(`- ${childPath}（${requiredHint}，${childType}）${desc}${enumHint}`);
        lines.push(...collectSchemaFieldRules(child, depth + 1, childPath));
    }

    return lines;
}

export function buildStructuredOutputSystemInstruction(args: {
    schema?: object;
    schemaName?: string;
}): string {
    const schemaProperties = args.schema && typeof args.schema === 'object' && 'properties' in (args.schema as Record<string, unknown>)
        ? (((args.schema as Record<string, unknown>).properties || {}) as Record<string, unknown>)
        : {};
    const hasWorldBuckets = ['nations', 'regions', 'cities', 'locations', 'factions', 'entities'].every(
        (key: string) => key in schemaProperties,
    );
    const schemaText = args.schema ? JSON.stringify(args.schema, null, 2) : '';
    const minimumJson = args.schema
        ? JSON.stringify(buildMinimumValueFromSchema(args.schema), null, 2)
        : '{\n  "ok": true\n}';
    const exampleJson = args.schema
        ? JSON.stringify(buildJsonExampleFromSchema(args.schema), null, 2)
        : '{\n  "ok": true\n}';
    const fieldRules = args.schema ? collectSchemaFieldRules(args.schema).join('\n') : '';
    const constraintSummary = args.schema ? summarizeSchemaConstraints(args.schema).join('\n') : '';

    return [
        '你必须只输出一个合法 json 对象，不要输出额外解释、前后缀、Markdown 代码块或自然语言说明。',
        args.schemaName ? `输出目标名称：${args.schemaName}` : '',
        schemaText
            ? `请严格参考以下 JSON Schema / 结构定义：\n${schemaText}`
            : '若未提供完整 schema，也必须返回可被 JSON.parse 解析的 json 对象。',
        constraintSummary ? `关键约束摘要：\n${constraintSummary}` : '',
        fieldRules ? `字段规则摘要：\n${fieldRules}` : '',
        hasWorldBuckets
            ? [
                '归类补充规则：nation > region > city > location，命中多个类别时只放入最合适的一个字段。',
                'factions 只放组织、派系、公会、教团、军团、家族势力；如果某条已进入 factions，就不要再放入 entities。',
                'cities 只放城市、都城、主城、镇、村、聚落；酒馆、广场、神殿、总部、市场、工业园、议会厅等具体地点必须放入 locations。',
                '不要在 nations / regions / cities / locations / factions / entities 之间重复放置同一条内容。',
            ].join('\n')
            : '',
        `最小合法 json 模板（字段缺失时至少满足这个结构；不要缺字段，不要新增 schema 未声明字段）：\n${minimumJson}`,
        `请参考以下 json 输出样例（字段名和类型必须匹配 schema）：\n${exampleJson}`,
        '如果输入信息不足，请返回空字符串、空数组、false、0 或 null 等与字段类型匹配的占位值，不要编造。',
        '最终输出前请自行检查：1）所有必填字段都存在；2）字段类型正确；3）没有 schema 未声明的新字段；4）输出必须能被 JSON.parse 直接解析。',
    ].filter(Boolean).join('\n\n');
}
