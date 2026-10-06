import { validateJsonSchema } from './json-schema-validator';

function minimumValue(schema: object): unknown {
    const node = schema as Record<string, any>;
    if (Object.hasOwn(node, 'const')) return node.const;
    if (Array.isArray(node.enum) && node.enum.length > 0) return node.enum[0];
    if (node.type === 'object' || node.properties) {
        const required = new Set<string>(node.required ?? []);
        return Object.fromEntries(Object.entries(node.properties ?? {})
            .filter(([key]) => required.has(key))
            .map(([key, child]) => [key, minimumValue(child as object)]));
    }
    if (node.type === 'array') return Array.from({ length: Math.min(node.minItems ?? 0, 10) }, () => minimumValue(node.items ?? {}));
    if (node.type === 'string') return '';
    if (node.type === 'boolean') return false;
    if (node.type === 'number' || node.type === 'integer') return 0;
    return null;
}

export function buildStructuredOutputSystemInstruction(args: { schema?: object; name?: string }): string {
    const example = args.schema ? minimumValue(args.schema) : { ok: true };
    const exampleValid = !args.schema || validateJsonSchema(example, args.schema).valid;
    return [
        '只输出一个合法 json 对象，不要解释、前后缀或 Markdown 代码块。',
        args.name ? `输出目标名称：${args.name}` : '',
        args.schema ? `JSON Schema：\n${JSON.stringify(args.schema)}` : '',
        exampleValid ? `最小合法 JSON 格式示例：\n${JSON.stringify(example)}` : '',
        '示例只说明格式，不能用来补写未知事实。缺少证据时省略条目；可选字段可省略，禁止猜测必填业务值。',
        '输出前检查字段类型、必填字段和枚举；不得增加 Schema 未声明字段。',
    ].filter(Boolean).join('\n\n');
}
