export interface ConsumerDescriptor {
    pluginId: string;
    displayName: string;
    version?: string;
    capabilities?: readonly string[];
}

export class ConsumerDiscovery {
    private readonly consumers = new Map<string, ConsumerDescriptor>();

    update(descriptor: ConsumerDescriptor): void { this.consumers.set(descriptor.pluginId, descriptor); }
    remove(pluginId: string): void { this.consumers.delete(pluginId); }
    list(): ConsumerDescriptor[] { return [...this.consumers.values()]; }
}
