/** API key -> account. Keys come from API_KEYS="key:account,key2:account2". Unknown/missing => "anonymous". */
const keys = new Map<string, string>(
  (process.env.API_KEYS ?? "dev-buyer:buyer,dev-vendor:vendor")
    .split(",")
    .map((p) => p.split(":") as [string, string])
    .filter((p) => p.length === 2),
);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function ownerFrom(ctx: any): string {
  const header = ctx?.req?.header?.("x-api-key") ?? ctx?.req?.header?.("authorization")?.replace(/^Bearer /i, "");
  return (header && keys.get(header)) || "anonymous";
}
