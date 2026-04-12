import type { FixyAdapter } from './adapter.js';

export class AdapterRegistry {
  private readonly adapters = new Map<string, FixyAdapter>();

  register(adapter: FixyAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new Error(`Adapter already registered: ${adapter.id}`);
    }
    this.adapters.set(adapter.id, adapter);
  }

  unregister(id: string): void {
    this.adapters.delete(id);
  }

  require(id: string): FixyAdapter {
    const adapter = this.adapters.get(id);
    if (adapter === undefined) {
      throw new Error(`Unknown adapter: ${id}`);
    }
    return adapter;
  }

  get(id: string): FixyAdapter | undefined {
    return this.adapters.get(id);
  }

  list(): FixyAdapter[] {
    return Array.from(this.adapters.values());
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  clear(): void {
    this.adapters.clear();
  }
}
