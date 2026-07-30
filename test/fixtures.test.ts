/**
 * Fixture replay tests: every recorded real failure is diagnosed fully
 * offline (ReplayTransport, zero network) and must
 *   1. validate against the frozen envelope JSON Schema,
 *   2. reproduce its ground-truth label (error id, top cause, resolution),
 *   3. NOT fire the explicitly-forbidden wrong rules (negative assertions),
 *   4. stay under the token budget in compact form.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import Ajv from "ajv/dist/2020.js";
import { diagnose } from "../src/index.js";
import { ReplayTransport, type RecordedCall } from "../src/rpc.js";
import { compactEnvelope } from "../src/render/compact.js";
import { estimateTokens } from "../src/render/tokens.js";
import type { DiagnoseInput, Envelope } from "../src/types.js";

const FIXTURE_DIR = join(__dirname, "..", "fixtures");
const SCHEMA = JSON.parse(
  readFileSync(join(__dirname, "..", "schema", "envelope.schema.json"), "utf8"),
);

interface Fixture {
  name: string;
  description: string;
  network: string;
  input: DiagnoseInput;
  expected: {
    error_id: string;
    top_cause: string;
    contract_error_name: string | null;
    confirmed: boolean;
    must_not_fire: string[];
  } | null;
  recorded: RecordedCall[];
}

const ajv = new Ajv({ allErrors: true, strict: true });
const validate = ajv.compile(SCHEMA);

const fixtures: Fixture[] = readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf8")));

async function replay(fixture: Fixture): Promise<Envelope> {
  return diagnose(fixture.input, {
    network: fixture.network,
    transport: new ReplayTransport(fixture.recorded),
  });
}

describe.each(fixtures.map((f) => [f.name, f] as const))("fixture %s", (_name, fixture) => {
  it("diagnoses offline, matches its label, and validates against the schema", async () => {
    const envelope = await replay(fixture);

    // 1. Schema validation (full and compact views)
    const ok = validate(JSON.parse(JSON.stringify(envelope)));
    expect(validate.errors ?? []).toEqual([]);
    expect(ok).toBe(true);
    const compactOk = validate(JSON.parse(JSON.stringify(compactEnvelope(envelope))));
    expect(compactOk).toBe(true);

    // 2. Ground-truth label
    if (fixture.expected) {
      expect(envelope.error.id).toBe(fixture.expected.error_id);
      expect(envelope.diagnoses[0]?.cause_id).toBe(fixture.expected.top_cause);
      expect(envelope.diagnoses[0]?.confirmed).toBe(fixture.expected.confirmed);
      if (fixture.expected.contract_error_name) {
        expect(envelope.error.contract_error?.name).toBe(fixture.expected.contract_error_name);
      }

      // 3. Negative assertions: the wrong rule must not fire at all.
      const fired = envelope.diagnoses.map((d) => d.cause_id);
      for (const forbidden of fixture.expected.must_not_fire) {
        expect(fired).not.toContain(forbidden);
      }

      // High-risk guarantee (spec 3.4): no unconfirmed hypothesis may outrank
      // or tie the confirmed ground-truth cause above the 0.5 guess ceiling.
      const top = envelope.diagnoses[0]!;
      for (const d of envelope.diagnoses.slice(1)) {
        if (!d.confirmed) expect(d.confidence).toBeLessThanOrEqual(0.5);
        expect(d.confidence).toBeLessThanOrEqual(top.confidence);
      }
    } else {
      // Wild fixtures: must extract an error identity and never crash.
      expect(envelope.error.id).toBeTruthy();
    }

    // 4. Token budget: compact JSON stays under ~1500 tokens.
    const compactJson = JSON.stringify(compactEnvelope(envelope));
    expect(estimateTokens(compactJson)).toBeLessThanOrEqual(1500);
  });

  it("is fully deterministic across replays", async () => {
    const a = await replay(fixture);
    const b = await replay(fixture);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("corpus shape", () => {
  it("has at least 20 fixtures spanning at least 6 distinct root causes", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(20);
    const causes = new Set(fixtures.filter((f) => f.expected).map((f) => f.expected!.top_cause));
    expect(causes.size).toBeGreaterThanOrEqual(6);
  });
});
