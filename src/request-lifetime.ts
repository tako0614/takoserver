/** Request-scoped runtime lifetime; never serialized into a Host operation. */
export interface RequestLifetime {
  readonly waitUntil: (work: Promise<void>) => void;
}
