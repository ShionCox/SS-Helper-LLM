import type {
    AdaptiveMaxTokensConfig,
    GlobalMaxTokensControl,
    RunTaskArgs,
    TaskAssignment,
} from '../schema/types';

export type MaxTokensSource =
    | 'global_manual'
    | 'task_manual'
    | 'task_registered'
    | 'adaptive'
    | 'request_budget'
    | 'consumer_budget'
    | 'profile'
    | 'default';

export interface ResolvedMaxTokensResult {
    value: number;
    source: MaxTokensSource;
    detail?: Record<string, unknown>;
}

function toPositiveInt(value: unknown): number | undefined {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
    return Math.max(1, Math.round(numeric));
}

function safeJsonLength(value: unknown): number {
    if (value == null) return 0;
    if (typeof value === 'string') return value.length;
    try {
        return JSON.stringify(value).length;
    } catch {
        return String(value).length;
    }
}

function collectMessageChars(input: unknown): { messageChars: number; messageCount: number } {
    const messages = Array.isArray((input as { messages?: unknown[] } | undefined)?.messages)
        ? ((input as { messages?: Array<{ role?: string; content?: unknown }> }).messages || [])
        : [];

    let messageChars = 0;
    for (const message of messages) {
        if (!message || typeof message !== 'object') continue;
        const content = (message as { content?: unknown }).content;
        if (typeof content === 'string') {
            messageChars += content.length;
            continue;
        }
        messageChars += safeJsonLength(content);
    }

    return { messageChars, messageCount: messages.length };
}

function estimateAdaptiveMaxTokens(args: RunTaskArgs, config?: AdaptiveMaxTokensConfig): ResolvedMaxTokensResult {
    const min = toPositiveInt(config?.min) ?? 800;
    const max = toPositiveInt(config?.max) ?? 4096;
    const charDivisor = toPositiveInt(config?.charDivisor) ?? 6;
    const schemaCharDivisor = toPositiveInt(config?.schemaCharDivisor) ?? 12;
    const messageBonus = toPositiveInt(config?.messageBonus) ?? 48;

    const { messageChars, messageCount } = collectMessageChars(args.input);
    const inputChars = safeJsonLength(args.input);
    const schemaChars = safeJsonLength(args.schema);

    let base = args.schema ? 960 : 720;
    if (args.taskKey === 'world.template.build') {
        base = 1400;
    } else if (args.taskKey === 'memory.extract' || args.taskKey === 'world.update' || args.taskKey === 'memory.summarize') {
        base = 1100;
    }

    const estimate = base
        + Math.ceil(inputChars / charDivisor)
        + Math.ceil(schemaChars / schemaCharDivisor)
        + (messageCount * messageBonus)
        + Math.ceil(messageChars / Math.max(4, charDivisor * 2));

    const value = Math.min(max, Math.max(min, estimate));
    return {
        value,
        source: 'adaptive',
        detail: {
            mode: 'adaptive',
            min,
            max,
            base,
            inputChars,
            schemaChars,
            messageChars,
            messageCount,
            charDivisor,
            schemaCharDivisor,
            messageBonus,
            estimate,
        },
    };
}

export function resolveMaxTokens(args: RunTaskArgs, options: {
    globalControl?: GlobalMaxTokensControl;
    taskAssignment?: TaskAssignment;
    taskRegisteredMaxTokens?: number;
    consumerBudgetMaxTokens?: number;
    profileMaxTokens?: number;
}): ResolvedMaxTokensResult {
    const globalControl = options.globalControl;
    const taskAssignment = options.taskAssignment;

    const globalManual = globalControl?.mode === 'manual'
        ? toPositiveInt(globalControl.manualValue)
        : undefined;
    if (globalManual) {
        return {
            value: globalManual,
            source: 'global_manual',
            detail: { mode: 'manual' },
        };
    }

    const taskManual = toPositiveInt(taskAssignment?.maxTokens);
    if (taskManual) {
        return {
            value: taskManual,
            source: 'task_manual',
            detail: {
                pluginId: taskAssignment?.pluginId,
                taskKey: taskAssignment?.taskKey,
            },
        };
    }

    const taskRegistered = toPositiveInt(options.taskRegisteredMaxTokens);
    if (taskRegistered) {
        return {
            value: taskRegistered,
            source: 'task_registered',
        };
    }

    if (globalControl?.mode === 'adaptive') {
        return estimateAdaptiveMaxTokens(args, globalControl.adaptive);
    }

    const consumerBudget = toPositiveInt(options.consumerBudgetMaxTokens);
    if (consumerBudget) {
        return {
            value: consumerBudget,
            source: 'consumer_budget',
        };
    }

    const profile = toPositiveInt(options.profileMaxTokens);
    if (profile) {
        return {
            value: profile,
            source: 'profile',
        };
    }

    return {
        value: 2048,
        source: 'default',
    };
}
