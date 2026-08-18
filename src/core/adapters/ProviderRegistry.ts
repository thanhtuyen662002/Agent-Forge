import { ProviderAdapter } from './ProviderAdapter';

export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  /**
   * Register a provider adapter by its unique, stable ID.
   * Throws an error if an adapter with the same ID is already registered.
   */
  public register(adapter: ProviderAdapter): void {
    if (!adapter || !adapter.id) {
      throw new Error('Cannot register provider adapter without a valid ID.');
    }

    if (this.adapters.has(adapter.id)) {
      throw new Error(`Duplicate provider registration for ID: "${adapter.id}". Each provider ID must be unique.`);
    }

    this.adapters.set(adapter.id, adapter);
  }

  /**
   * Retrieve an adapter by its ID without throwing if not found.
   */
  public get(id: string): ProviderAdapter | undefined {
    return this.adapters.get(id);
  }

  /**
   * Resolve an adapter by its ID, throwing an explicit error if missing.
   * Never silently substitutes another adapter.
   */
  public resolve(id: string): ProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) {
      throw new Error(`Provider adapter "${id}" is not registered.`);
    }
    return adapter;
  }

  /**
   * Enumerate all registered adapters.
   */
  public getAll(): ProviderAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Check whether a provider adapter is registered.
   */
  public has(id: string): boolean {
    return this.adapters.has(id);
  }

  /**
   * Unregister an adapter by its ID.
   */
  public unregister(id: string): boolean {
    return this.adapters.delete(id);
  }

  /**
   * Clear all registered adapters.
   */
  public clear(): void {
    this.adapters.clear();
  }

  /**
   * Count of registered adapters.
   */
  public get size(): number {
    return this.adapters.size;
  }
}
