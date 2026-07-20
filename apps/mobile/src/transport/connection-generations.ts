/**
 * Coordinates asynchronous connection attempts without coupling lifecycle
 * checks to React state. Generations are monotonic per host; disposal is final.
 */
export class ConnectionGenerations {
  private readonly generations = new Map<string, number>();
  private isDisposed = false;

  get disposed(): boolean {
    return this.isDisposed;
  }

  begin(hostId: string): number {
    const generation = (this.generations.get(hostId) ?? 0) + 1;
    this.generations.set(hostId, generation);
    return generation;
  }

  invalidate(hostId: string): void {
    this.generations.set(hostId, (this.generations.get(hostId) ?? 0) + 1);
  }

  isCurrent(hostId: string, generation: number): boolean {
    return !this.isDisposed && this.generations.get(hostId) === generation;
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const hostId of this.generations.keys()) this.invalidate(hostId);
  }
}
