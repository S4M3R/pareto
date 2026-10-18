/** Money for text the model reads (views format their own). */
export const usd = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;
