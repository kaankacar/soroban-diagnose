import { describe, expect, it } from "vitest";
import {
  camelToSnakeUpper,
  hostErrorId,
  hostErrorRaw,
  opResultCode,
  txResultCodeId,
  txResultCodeName,
} from "../src/xdrnames.js";

describe("canonical code naming", () => {
  it("converts tx result codes to the XDR spelling", () => {
    expect(txResultCodeName("txFailed")).toBe("txFAILED");
    expect(txResultCodeName("txBadSeq")).toBe("txBAD_SEQ");
    expect(txResultCodeName("txFeeBumpInnerFailed")).toBe("txFEE_BUMP_INNER_FAILED");
    expect(txResultCodeName("txSorobanInvalid")).toBe("txSOROBAN_INVALID");
    expect(txResultCodeName("txBadMinSeqAgeOrGap")).toBe("txBAD_MIN_SEQ_AGE_OR_GAP");
  });

  it("derives namespaced tx ids", () => {
    expect(txResultCodeId("txBadSeq")).toBe("tx.bad_seq");
    expect(txResultCodeId("txInsufficientFee")).toBe("tx.insufficient_fee");
  });

  it("derives op codes and ids from op type + code", () => {
    expect(opResultCode("invokeHostFunction", "invokeHostFunctionTrapped")).toEqual({
      name: "INVOKE_HOST_FUNCTION_TRAPPED",
      id: "op.invoke_host_function.trapped",
    });
    expect(opResultCode("payment", "paymentUnderfunded")).toEqual({
      name: "PAYMENT_UNDERFUNDED",
      id: "op.payment.underfunded",
    });
    expect(opResultCode("invokeHostFunction", "invokeHostFunctionInsufficientRefundableFee").id).toBe(
      "op.invoke_host_function.insufficient_refundable_fee",
    );
  });

  it("formats host errors in both spellings", () => {
    expect(hostErrorRaw("Budget", "ExceededLimit")).toBe("Error(Budget, ExceededLimit)");
    expect(hostErrorId("WasmVm", "InvalidAction")).toBe("soroban.host.wasm_vm.invalid_action");
  });

  it("handles acronym runs", () => {
    expect(camelToSnakeUpper("ledgerReadByte")).toBe("LEDGER_READ_BYTE");
    expect(camelToSnakeUpper("maxRWKeyByte")).toBe("MAX_RW_KEY_BYTE");
  });
});
