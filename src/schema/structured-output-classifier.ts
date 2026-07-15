function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function uniqueStrings(items: unknown): string[] {
    if (!Array.isArray(items)) return [];
    const seen = new Set<string>();
    const output: string[] = [];
    for (const item of items) {
        const text = String(item || '').trim();
        if (!text || seen.has(text)) continue;
        seen.add(text);
        output.push(text);
    }
    return output;
}

type CategoryBucket = 'nations' | 'regions' | 'cities' | 'locations' | 'factions' | 'entities' | null;

const NATION_PATTERNS = [
    /王国|帝国|联邦|共和国|公国|王朝|皇朝|汗国|政体|国$/,
];

const REGION_PATTERNS = [
    /(^|[^城])区$/,
    /边境|行省|州|郡|大陆|高地|群岛|荒原|平原|沙漠|海岸|山脉|流域/,
];

const CITY_PATTERNS = [
    /城$|都$|都市|主城|镇$|村$|聚落|港口城|港城/,
];

const LOCATION_PATTERNS = [
    /酒馆|神殿|广场|之井|哭泣之井|遗迹|房间|据点|学院|基地|空间站|森林|峡谷|大厅|议会厅|总部|市场|工业园|庄园区|庄园|神庙|塔$|之塔|宫|馆$/,
];

const FACTION_PATTERNS = [
    /议会|帮|公会|联盟|教团|军团|家族|协会|公司|组织|结社|骑士团|商会|学派/,
];

function matchesAny(text: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern: RegExp) => pattern.test(text));
}

function detectBucket(text: string): CategoryBucket {
    if (!text) return null;

    if (matchesAny(text, FACTION_PATTERNS)) return 'factions';
    if (matchesAny(text, NATION_PATTERNS)) return 'nations';
    if (matchesAny(text, LOCATION_PATTERNS)) return 'locations';
    if (matchesAny(text, CITY_PATTERNS)) return 'cities';
    if (matchesAny(text, REGION_PATTERNS)) return 'regions';
    return 'entities';
}

function hasKnownBuckets(value: Record<string, unknown>): boolean {
    return ['nations', 'regions', 'cities', 'locations', 'factions', 'entities'].some((key: string) => key in value);
}

export function normalizeStructuredCategoryBuckets(input: unknown): unknown {
    if (!isRecord(input) || !hasKnownBuckets(input)) {
        return input;
    }

    const buckets: Record<Exclude<CategoryBucket, null>, string[]> = {
        nations: uniqueStrings(input.nations),
        regions: uniqueStrings(input.regions),
        cities: uniqueStrings(input.cities),
        locations: uniqueStrings(input.locations),
        factions: uniqueStrings(input.factions),
        entities: uniqueStrings(input.entities),
    };

    const collected = new Map<string, CategoryBucket>();
    const orderedEntries: Array<{ value: string; originalBucket: CategoryBucket }> = [];

    (Object.keys(buckets) as Array<Exclude<CategoryBucket, null>>).forEach((bucket) => {
        for (const value of buckets[bucket]) {
            orderedEntries.push({ value, originalBucket: bucket });
        }
    });

    const nextBuckets: Record<Exclude<CategoryBucket, null>, string[]> = {
        nations: [],
        regions: [],
        cities: [],
        locations: [],
        factions: [],
        entities: [],
    };

    for (const entry of orderedEntries) {
        if (collected.has(entry.value)) continue;
        const detected = detectBucket(entry.value) || entry.originalBucket;
        const target = detected || entry.originalBucket;
        if (!target) continue;
        nextBuckets[target].push(entry.value);
        collected.set(entry.value, target);
    }

    return {
        ...input,
        nations: nextBuckets.nations,
        regions: nextBuckets.regions,
        cities: nextBuckets.cities,
        locations: nextBuckets.locations,
        factions: nextBuckets.factions,
        entities: nextBuckets.entities.filter((item: string) => !nextBuckets.factions.includes(item)),
    };
}