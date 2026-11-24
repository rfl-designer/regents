/** Relógio injetável: todo caminho testado lê a hora daqui, nunca de `new Date()`. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
