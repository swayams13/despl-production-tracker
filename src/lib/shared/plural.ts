/** "1 item", "2 items". Pass `many` for an irregular plural. */
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
