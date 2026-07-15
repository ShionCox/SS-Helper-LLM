import { logger } from '../runtime/logger';

/**
 * Profile 配置层 —— 一套参数组合（温度、maxTokens、json 强制、重试等）
 * 用于 LLM Hub 的 consumer+task → provider+profile 路由
 */

export interface LLMProfile {
    id: string;
    name: string;
    temperature: number;
    maxTokens: number;
    jsonMode: boolean;
    retryCount: number;
    retryDelayMs: number;
    topP?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
}

/**
 * 预置 Profile 集合
 */
export const BUILTIN_PROFILES: Record<string, LLMProfile> = {
    /** 精确模式：低温度、强 JSON、适合数据抽取 */
    precise: {
        id: 'precise',
        name: '精确模式',
        temperature: 0.1,
        maxTokens: 2048,
        jsonMode: true,
        retryCount: 2,
        retryDelayMs: 1000,
    },
    /** 创意模式：中温度、适合叙事生成 */
    creative: {
        id: 'creative',
        name: '创意模式',
        temperature: 0.8,
        maxTokens: 4096,
        jsonMode: false,
        retryCount: 1,
        retryDelayMs: 500,
    },
    /** 平衡模式：适合通用任务 */
    balanced: {
        id: 'balanced',
        name: '平衡模式',
        temperature: 0.5,
        maxTokens: 2048,
        jsonMode: true,
        retryCount: 2,
        retryDelayMs: 800,
    },
    /** 经济模式：低 token、快速返回 */
    economy: {
        id: 'economy',
        name: '经济模式',
        temperature: 0.3,
        maxTokens: 1024,
        jsonMode: true,
        retryCount: 1,
        retryDelayMs: 500,
    },
};

/**
 * Profile 管理器
 */
export class ProfileManager {
    private profiles: Map<string, LLMProfile> = new Map();

    constructor() {
        // 注册内置 Profiles
        for (const [id, profile] of Object.entries(BUILTIN_PROFILES)) {
            this.profiles.set(id, profile);
        }
    }

    /** 注册自定义 Profile */
    register(profile: LLMProfile): void {
        this.profiles.set(profile.id, profile);
    }

    /** 获取 Profile */
    get(profileId: string): LLMProfile | undefined {
        return this.profiles.get(profileId);
    }

    /** 列出所有 Profile */
    list(): LLMProfile[] {
        return Array.from(this.profiles.values());
    }

    /** 删除自定义 Profile */
    remove(profileId: string): boolean {
        if (BUILTIN_PROFILES[profileId]) {
            logger.warn(`[ProfileManager] 无法删除内置 Profile: ${profileId}`);
            return false;
        }
        return this.profiles.delete(profileId);
    }
}
