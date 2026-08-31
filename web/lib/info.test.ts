import { expect, test } from "vitest";
import { parseMarketVolumes } from "./info";

test("parseMarketVolumes keeps HIP-4 24h notional volumes and rejects malformed rows", () => {
  expect(
    parseMarketVolumes([
      { universe: [] },
      [
        { coin: "#100", dayNtlVlm: "12.5" },
        { coin: "#101", dayNtlVlm: "7.25" },
        { coin: "BTC", dayNtlVlm: "999" },
        { coin: "#102", dayNtlVlm: "not-a-number" },
        { coin: "#103", dayNtlVlm: "-1" },
      ],
    ]),
  ).toEqual({ "#100": 12.5, "#101": 7.25 });
});
