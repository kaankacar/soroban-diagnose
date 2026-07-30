import { xdr } from "@stellar/stellar-sdk";

async function call(url: string, method: string, params: unknown): Promise<any> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as any;
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

for (const [name, url] of [
  ["testnet", "https://soroban-testnet.stellar.org"],
  ["mainnet", "https://mainnet.sorobanrpc.com"],
] as const) {
  const key = xdr.LedgerKey.configSetting(
    new xdr.LedgerKeyConfigSetting({ configSettingId: xdr.ConfigSettingId.configSettingStateArchival() }),
  ).toXDR("base64");
  const res = await call(url, "getLedgerEntries", { keys: [key] });
  const entry = res.entries?.[0];
  if (!entry) {
    console.log(name, "no state archival config found");
    continue;
  }
  const cs = xdr.LedgerEntryData.fromXDR(entry.xdr, "base64").configSetting().stateArchivalSettings();
  console.log(name, {
    minPersistentTTL: cs.minPersistentTtl(),
    minTemporaryTTL: cs.minTemporaryTtl(),
    maxEntryTTL: cs.maxEntryTtl(),
    latest: res.latestLedger,
  });
}
