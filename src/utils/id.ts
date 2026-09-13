export function newId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}
