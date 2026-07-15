import { z } from 'zod';
import type { ZodIssue, ZodType } from 'zod';

/**
 * 校验返回结果结构
 */
export interface ValidationResult<T = any> {
    valid: boolean;
    data?: T;
    errors: string[];
}

/**
 * 使用 Zod 强类型校验大模型返回的 JSON 对象
 * @param data 解析后的原始对象
 * @param schema Zod Schema 定义
 */
export function validateZodSchema<T>(data: any, schema: ZodType<T>): ValidationResult<T> {
    const result = schema.safeParse(data);

    if (result.success) {
        return { valid: true, data: result.data, errors: [] };
    } else {
        const errors = result.error.issues.map(
            (err: ZodIssue) => `字段 "${err.path.join('.')}" 校验失败: ${err.message}`
        );
        return { valid: false, errors };
    }
}

/**
 * 尝试从 LLM 混沌输出中提取最纯净的 JSON
 * 对于部分附带反思过程 `<think>` 或者包裹在 \`\`\`json 里面的格式，进行强力清洗
 */
export function parseJsonOutput(raw: string | object): { ok: boolean; data: any; error?: string } {
    if (raw && typeof raw === 'object') {
        return { ok: true, data: raw };
    }
    if (!raw || typeof raw !== 'string') {
        return { ok: false, data: null, error: '返回内容为空或格式非字符串' };
    }

    let cleanStr = raw.trim();
    let lastError = '';

    // 1. 尝试去除 DeepSeek / Claude 等喜欢附带的 <think> 标签内容
    cleanStr = cleanStr.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // 2. 尝试直接解析
    try {
        return { ok: true, data: JSON.parse(cleanStr) };
    } catch (error) {
        lastError = (error as Error).message;
        // 继续尝试提取代码块中的 JSON
    }

    // 3. 尝试提取 ```json ... ``` 或 ``` ... ``` 块
    const jsonBlockMatch = cleanStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonBlockMatch) {
        try {
            return { ok: true, data: JSON.parse(jsonBlockMatch[1].trim()) };
        } catch (e) {
            lastError = `代码块中的 JSON 解析失败: ${(e as Error).message}`;
        }
    }

    const extractBalancedJsonCandidate = (value: string): string | null => {
        const start = value.search(/[\[{]/);
        if (start < 0) return null;

        const stack: string[] = [];
        let inString = false;
        let escaped = false;

        for (let index = start; index < value.length; index += 1) {
            const ch = value[index];
            if (inString) {
                if (escaped) {
                    escaped = false;
                    continue;
                }
                if (ch === '\\') {
                    escaped = true;
                    continue;
                }
                if (ch === '"') {
                    inString = false;
                }
                continue;
            }

            if (ch === '"') {
                inString = true;
                continue;
            }

            if (ch === '{' || ch === '[') {
                stack.push(ch);
                continue;
            }

            if (ch === '}' || ch === ']') {
                if (stack.length === 0) {
                    return null;
                }
                const top = stack[stack.length - 1];
                const matched = (top === '{' && ch === '}') || (top === '[' && ch === ']');
                if (!matched) {
                    return null;
                }
                stack.pop();
                if (stack.length === 0) {
                    return value.slice(start, index + 1);
                }
            }
        }

        return null;
    };

    const balancedCandidate = extractBalancedJsonCandidate(cleanStr)
        || (jsonBlockMatch?.[1] ? extractBalancedJsonCandidate(jsonBlockMatch[1].trim()) : null);
    if (balancedCandidate) {
        try {
            return { ok: true, data: JSON.parse(balancedCandidate) };
        } catch (e) {
            lastError = `平衡括号提取 JSON 解析失败: ${(e as Error).message}`;
        }
    }

    // 4. 暴力搜索第一个 { 和最后一个 } 之间的内容
    const firstBrace = cleanStr.indexOf('{');
    const lastBrace = cleanStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        try {
            const manualExtract = cleanStr.substring(firstBrace, lastBrace + 1);
            return { ok: true, data: JSON.parse(manualExtract) };
        } catch (e) {
            lastError = `暴力括号提取 JSON 解析失败: ${(e as Error).message}`;
        }
    }

    if (/[\[{]/.test(cleanStr)) {
        return {
            ok: false,
            data: null,
            error: lastError || '疑似输出截断或 JSON 未闭合，无法提取完整结构',
        };
    }

    return { ok: false, data: null, error: lastError || '无法从 LLM 输出中识别到有效的 JSON' };
}

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asArray<T>(value: T | T[] | undefined | null): T[] {
    if (Array.isArray(value)) return value;
    if (value == null) return [];
    return [value];
}

function normalizeConfidence(value: unknown): number {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        return Math.max(0, Math.min(1, numeric));
    }
    return 0.7;
}

function normalizeSummaryLevel(value: unknown): 'message' | 'scene' | 'arc' {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'message' || normalized === 'msg' || normalized === 'turn') return 'message';
    if (normalized === 'arc' || normalized === 'chapter' || normalized === 'story') return 'arc';
    return 'scene';
}

function normalizePatchOp(value: unknown): 'add' | 'replace' | 'remove' | null {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'add' || normalized === 'insert' || normalized === 'create') return 'add';
    if (normalized === 'replace' || normalized === 'set' || normalized === 'update') return 'replace';
    if (normalized === 'remove' || normalized === 'delete') return 'remove';
    return null;
}

function normalizeTemplateFieldInput(item: unknown, fallbackKey?: string): Record<string, any> | null {
    if (typeof item === 'string') {
        const key = item.trim();
        if (!key) return null;
        return {
            key,
            label: key,
            tier: 'extension',
        };
    }
    if (!isRecord(item)) return null;
    const key = String(item.key ?? item.name ?? fallbackKey ?? '').trim();
    if (!key) return null;
    const label = String(item.label ?? item.title ?? key).trim() || key;
    const tierRaw = String(item.tier ?? 'extension').trim().toLowerCase();
    const tier = tierRaw === 'core' ? 'core' : 'extension';
    return {
        key,
        label,
        tier,
        ...(item.description ? { description: String(item.description) } : {}),
        ...(item.fillSpec ? { fillSpec: String(item.fillSpec) } : {}),
        ...(item.isPrimaryKey === true ? { isPrimaryKey: true } : {}),
    };
}

function normalizeTemplateTableInput(item: unknown): Record<string, any> | null {
    if (!isRecord(item)) return null;
    const key = String(item.key ?? item.name ?? '').trim();
    if (!key) return null;
    const label = String(item.label ?? item.title ?? key).trim() || key;
    const primaryKeyField = String(item.primaryKeyField ?? item.primaryKey ?? 'id').trim() || 'id';
    const rawFields = Array.isArray(item.fields) ? item.fields : [];
    const fields = rawFields
        .map((field: unknown): Record<string, any> | null => normalizeTemplateFieldInput(field))
        .filter((field: Record<string, any> | null): field is Record<string, any> => field != null);

    if (!fields.some((field: Record<string, any>) => field.key === primaryKeyField)) {
        fields.unshift({
            key: primaryKeyField,
            label: primaryKeyField,
            tier: 'core',
            isPrimaryKey: true,
        });
    }

    return {
        key,
        label,
        primaryKeyField,
        isBase: item.isBase === true,
        fields,
        ...(item.description ? { description: String(item.description) } : {}),
    };
}

function normalizeTemplateFactTypeInput(item: unknown): Record<string, any> | null {
    if (!isRecord(item)) return null;
    const type = String(item.type || '').trim();
    const pathPattern = String(item.pathPattern || '').trim();
    if (!type || !pathPattern) return null;
    const slots = asArray(item.slots).map((slot: unknown) => String(slot || '').trim()).filter(Boolean);
    return {
        type,
        pathPattern,
        slots,
        ...(item.defaultInjection ? { defaultInjection: String(item.defaultInjection) } : {}),
    };
}

export function normalizeWorldTemplateInput(input: unknown): unknown {
    if (!isRecord(input)) {
        return input;
    }

    const normalizedTables: Record<string, any>[] = [];
    if (Array.isArray(input.tables)) {
        normalizedTables.push(
            ...input.tables
                .map((table: unknown): Record<string, any> | null => normalizeTemplateTableInput(table))
                .filter((table: Record<string, any> | null): table is Record<string, any> => table != null),
        );
    }

    if (normalizedTables.length === 0 && isRecord(input.entities)) {
        for (const [entityKey, entityValue] of Object.entries(input.entities)) {
            if (!isRecord(entityValue)) continue;
            const primaryKeyField = String(entityValue.primaryKey || entityValue.primaryKeyField || 'id').trim() || 'id';
            const rawFields = Array.isArray(entityValue.fields) ? entityValue.fields : [];
            const fields = rawFields
                .map((field: unknown): Record<string, any> | null => normalizeTemplateFieldInput(field))
                .filter((field: Record<string, any> | null): field is Record<string, any> => field != null);
            if (!fields.some((field: Record<string, any>) => field.key === primaryKeyField)) {
                fields.unshift({
                    key: primaryKeyField,
                    label: primaryKeyField,
                    tier: 'core',
                    isPrimaryKey: true,
                });
            }
            normalizedTables.push({
                key: entityKey,
                label: entityKey,
                primaryKeyField,
                isBase: false,
                fields,
            });
        }
    }

    const factTypes = asArray(input.factTypes)
        .map((item: unknown): Record<string, any> | null => normalizeTemplateFactTypeInput(item))
        .filter((item: Record<string, any> | null): item is Record<string, any> => item != null);

    return {
        ...input,
        worldType: ['fantasy', 'urban', 'custom'].includes(String(input.worldType || '').trim())
            ? input.worldType
            : 'custom',
        ...(normalizedTables.length > 0 ? { tables: normalizedTables } : {}),
        ...(factTypes.length > 0 ? { factTypes } : {}),
        extractPolicies: isRecord(input.extractPolicies) ? input.extractPolicies : {},
        injectionLayout: isRecord(input.injectionLayout) ? input.injectionLayout : {},
    };
}

function normalizeKeywords(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        const items = value.map((item: unknown) => String(item || '').trim()).filter(Boolean);
        return items.length > 0 ? items : undefined;
    }
    if (typeof value === 'string') {
        const items = value.split(/[，,、;；\n]/).map((item: string) => item.trim()).filter(Boolean);
        return items.length > 0 ? items : undefined;
    }
    return undefined;
}

function normalizeEntity(value: unknown, fallbackKind?: unknown, fallbackId?: unknown): { kind: string; id: string } | undefined {
    if (isRecord(value)) {
        const kind = String(value.kind || value.type || fallbackKind || '').trim();
        const id = String(value.id || value.entityId || value.name || fallbackId || '').trim();
        if (kind && id) {
            return { kind, id };
        }
    }

    const inferredId = String(fallbackId || value || '').trim();
    const inferredKind = String(fallbackKind || '').trim();
    if (inferredId && inferredKind) {
        return { kind: inferredKind, id: inferredId };
    }
    return undefined;
}

function normalizeFactProposalInput(item: unknown): Record<string, any> | null {
    if (typeof item === 'string') {
        const content = item.trim();
        if (!content) return null;
        return {
            type: 'observation',
            value: content,
        };
    }
    if (!isRecord(item)) return null;

    const type = String(item.type || item.factType || item.kind || item.category || '').trim();
    const value = item.value ?? item.fact ?? item.content ?? item.text ?? item.data ?? item.summary;
    if (!type || value === undefined) {
        return null;
    }

    const factKey = String(item.factKey || item.id || '').trim() || undefined;
    const path = String(item.path || item.statePath || item.key || '').trim() || undefined;
    const confidence = Number(item.confidence);
    const entity = normalizeEntity(item.entity, item.entityKind, item.entityId);

    return {
        ...(factKey ? { factKey } : {}),
        type,
        ...(entity ? { entity } : {}),
        ...(path ? { path } : {}),
        value,
        ...(Number.isFinite(confidence) ? { confidence: Math.max(0, Math.min(1, confidence)) } : {}),
    };
}

function normalizePatchProposalInput(item: unknown): Record<string, any> | null {
    if (!isRecord(item)) return null;
    const op = normalizePatchOp(item.op || item.operation || item.action || item.kind);
    const path = String(item.path || item.statePath || item.key || item.field || '').trim();
    const value = item.value ?? item.nextValue ?? item.data ?? item.content;
    if (!op || !path) {
        return null;
    }
    if (op !== 'remove' && value === undefined) {
        return null;
    }
    return op === 'remove'
        ? { op, path }
        : { op, path, value };
}

function normalizeSummaryProposalInput(item: unknown): Record<string, any> | null {
    if (typeof item === 'string') {
        const content = item.trim();
        if (!content) return null;
        return {
            level: 'scene',
            content,
        };
    }
    if (!isRecord(item)) return null;

    const content = String(item.content ?? item.summary ?? item.text ?? item.value ?? item.description ?? '').trim();
    if (!content) {
        return null;
    }

    const title = String(item.title || item.label || '').trim() || undefined;
    const keywords = normalizeKeywords(item.keywords || item.tags);

    return {
        level: normalizeSummaryLevel(item.level || item.scope || item.kind),
        ...(title ? { title } : {}),
        content,
        ...(keywords ? { keywords } : {}),
    };
}

function hasProposalPayloadShape(value: unknown): boolean {
    if (!isRecord(value)) return false;
    return ['facts', 'patches', 'summaries', 'notes', 'schemaChanges', 'entityResolutions'].some((key: string) => key in value);
}

function unwrapProposalSource(value: unknown): Record<string, any> | null {
    if (!isRecord(value)) return null;
    if (isRecord(value.proposal) || hasProposalPayloadShape(value)) {
        return value;
    }
    if (isRecord(value.data) && (isRecord(value.data.proposal) || hasProposalPayloadShape(value.data))) {
        return value.data;
    }
    if (isRecord(value.result) && (isRecord(value.result.proposal) || hasProposalPayloadShape(value.result))) {
        return value.result;
    }
    return value;
}

export function normalizeProposalEnvelopeInput(input: unknown): unknown {
    const source = unwrapProposalSource(input);
    if (!source) {
        return input;
    }

    const proposalSource = isRecord(source.proposal)
        ? source.proposal
        : hasProposalPayloadShape(source)
            ? source
            : null;
    if (!proposalSource) {
        return input;
    }

    const facts = asArray(proposalSource.facts).map(normalizeFactProposalInput).filter((item): item is Record<string, any> => item != null);
    const patches = asArray(proposalSource.patches).map(normalizePatchProposalInput).filter((item): item is Record<string, any> => item != null);
    const summaries = asArray(proposalSource.summaries).map(normalizeSummaryProposalInput).filter((item): item is Record<string, any> => item != null);
    const notes = typeof proposalSource.notes === 'string' ? proposalSource.notes.trim() || undefined : undefined;
    const schemaChanges = Array.isArray(proposalSource.schemaChanges) ? proposalSource.schemaChanges : undefined;
    const entityResolutions = Array.isArray(proposalSource.entityResolutions) ? proposalSource.entityResolutions : undefined;

    return {
        ok: typeof source.ok === 'boolean' ? source.ok : true,
        proposal: {
            ...(facts.length > 0 ? { facts } : {}),
            ...(patches.length > 0 ? { patches } : {}),
            ...(summaries.length > 0 ? { summaries } : {}),
            ...(notes ? { notes } : {}),
            ...(schemaChanges ? { schemaChanges } : {}),
            ...(entityResolutions ? { entityResolutions } : {}),
        },
        confidence: normalizeConfidence(source.confidence),
    };
}

// ==========================================
// 具体业务 Schema 定义 (由 Zod 驱动)
// ==========================================

export const TemplateEntitySchema = z.object({
    primaryKey: z.string().describe('该实体数据表的主键名称'),
    fields: z.array(z.string()).describe('允许提取的属性列表(字符串数组)'),
    indexes: z.array(z.string()).optional().describe('可选：建索引加快搜索的字段名'),
});

export const TemplateTableFieldSchema = z.object({
    key: z.string().describe('字段 key'),
    label: z.string().describe('字段标签'),
    tier: z.enum(['core', 'extension']).describe('字段层级'),
    description: z.string().optional().describe('字段说明'),
    fillSpec: z.string().optional().describe('填充规范'),
    isPrimaryKey: z.boolean().optional().describe('是否主键字段'),
});

export const TemplateTableSchema = z.object({
    key: z.string().describe('表 key'),
    label: z.string().describe('表标签'),
    isBase: z.boolean().optional().describe('是否基础表'),
    primaryKeyField: z.string().describe('主键字段'),
    fields: z.array(TemplateTableFieldSchema).describe('表字段'),
    description: z.string().optional().describe('表说明'),
});

export const TemplateFactTypeSchema = z.object({
    type: z.string().describe('事实类型的名称 (例如 user_profile, relationship)'),
    pathPattern: z.string().describe('向统一状态树(StateManager)写值时的路径规则，可以使用 :id 等占位'),
    slots: z.array(z.string()).describe('该类型能够拥有的具体栏位名'),
    defaultInjection: z.string().optional().describe('默认往哪块区域注入（如 WORLD_STATE')
});

export const WorldTemplateSchema = z.object({
    templateId: z.string().describe('模板的唯一业务哈希。如果没法给就用 uuid'),
    name: z.string().describe('所提取这套字典模板的名字'),
    worldType: z.enum(['fantasy', 'urban', 'custom']).describe('世界风格定位，预置选择或 custom'),
    entities: z.record(z.string(), TemplateEntitySchema).optional().describe('旧版实体字典（兼容字段）'),
    tables: z.array(TemplateTableSchema).optional().describe('聊天级多表模板定义'),
    factTypes: z.array(TemplateFactTypeSchema).optional().describe('基于实体的进一步状态树类型映射，大模型可选返回'),
    extractPolicies: z.record(z.string(), z.any()).describe('针对这个世界推荐的记忆提取抽取参数配置'),
    injectionLayout: z.record(z.string(), z.any()).describe('推荐该世界下的 Token 分区占用（可选）'),
}).superRefine((
    value: { tables?: unknown[]; entities?: Record<string, unknown> },
    ctx: { addIssue: (issue: { code: string; path: string[]; message: string }) => void },
) => {
    const hasTables = Array.isArray(value.tables) && value.tables.length > 0;
    const hasEntities = value.entities && Object.keys(value.entities).length > 0;
    if (!hasTables && !hasEntities) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tables'],
            message: '模板必须包含 tables 或 entities 之一',
        });
    }
});

// ==========================================
// AI 提议制 (Proposal) Schema 定义
// 用于 memory.extract, world.update, memory.summarize 等统一返回
// ==========================================

export const FactProposalSchema = z.object({
    factKey: z.string().optional().describe('事实对应的唯一主键 (更新时使用)'),
    type: z.string().describe('事实类型，必须符合 world_template 限定'),
    entity: z.object({ kind: z.string(), id: z.string() }).optional().describe('关联的具体实体标示'),
    path: z.string().optional().describe('如果这属于对象树的层级结构，描述其访问路径'),
    value: z.any().describe('具体事实的对象体或者文本值'),
    confidence: z.number().min(0).max(1).optional().describe('大模型对这该条提取的置信度 (0-1.0)')
});

export const PatchProposalSchema = z.object({
    op: z.enum(['add', 'replace', 'remove']).describe('操作模式(类似 json-patch)'),
    path: z.string().describe('操作状态树节点位置'),
    value: z.any().optional().describe('操作具体覆值 (remove 时为空)')
});

export const SummaryProposalSchema = z.object({
    level: z.enum(['message', 'scene', 'arc']).describe('摘要归档层级。短线推荐归档为 message 或 scene'),
    title: z.string().optional().describe('给摘要起的名字'),
    content: z.string().describe('摘要总结文本本体'),
    keywords: z.array(z.string()).optional().describe('提炼相关关键词组')
});

export const ProposalEnvelopeSchema = z.object({
    ok: z.boolean().describe('由于内部要求返回强 Json，如果发生拒绝则设置为 false'),
    proposal: z.object({
        facts: z.array(FactProposalSchema).optional().describe('事实写入的提议 (一般在 memory.extract 发生)'),
        patches: z.array(PatchProposalSchema).optional().describe('状态变量更改提议 (一般在 world.update 发生)'),
        summaries: z.array(SummaryProposalSchema).optional().describe('事件摘要化提议 (一般在 memory.summarize 发生)'),
        notes: z.string().optional().describe('随附说明，用于 AI 反思或者提示')
    }).describe('提交供 memory consumer 四道闸门审批的提议内容'),
    confidence: z.number().min(0).max(1).describe('大模型对整体此提议判断的把握程度 (0~1)')
});
