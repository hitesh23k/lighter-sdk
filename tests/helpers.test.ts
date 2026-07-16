import { describe, it, expect } from "vitest";
import LighterHelper from "../src/helpers";
import LighterConstant from "../src/constants";

describe("LighterHelper fixed-point", () => {
    it("scales decimals to integers with floor of extra precision", () => {
        expect(LighterHelper.scaleToInt("1.5", 3)).toBe(1500n);
        expect(LighterHelper.scaleToInt("0.123456", 3)).toBe(123n); // floors extra precision
        expect(LighterHelper.scaleToInt("10", 0)).toBe(10n);
        expect(LighterHelper.scaleToInt("-2.25", 2)).toBe(-225n);
        expect(LighterHelper.scaleToInt(2.5, 4)).toBe(25000n);
    });

    it("toBaseAmount and toPriceInt use the market decimals", () => {
        expect(LighterHelper.toBaseAmount("0.5", 6)).toBe(500000n);
        expect(LighterHelper.toPriceInt("2500.75", 2)).toBe(250075n);
    });

    it("floorToStep snaps down to the nearest step multiple", () => {
        expect(LighterHelper.floorToStep(1050n, 100n)).toBe(1000n);
        expect(LighterHelper.floorToStep(1000n, 100n)).toBe(1000n);
        expect(LighterHelper.floorToStep(999n, 0n)).toBe(999n); // no-op when step <= 0
    });

    it("fromScaledInt round-trips a scaled integer to a trimmed decimal string", () => {
        expect(LighterHelper.fromScaledInt(1500n, 3)).toBe("1.5");
        expect(LighterHelper.fromScaledInt(250075n, 2)).toBe("2500.75");
        expect(LighterHelper.fromScaledInt(10n, 0)).toBe("10");
        expect(LighterHelper.fromScaledInt(-225n, 2)).toBe("-2.25");
    });

    it("builds URLs with query strings, normalizing slashes and dropping empties", () => {
        expect(LighterHelper.buildUrl("https://x.ai/", "/api/v1/account", { by: "index", value: 7 })).toBe(
            "https://x.ai/api/v1/account?by=index&value=7",
        );
        expect(LighterHelper.buildUrl("https://x.ai", "api/v1/status")).toBe("https://x.ai/api/v1/status");
        expect(LighterHelper.buildUrl("https://x.ai", "/e", { a: 1, b: undefined, c: null, d: "" })).toBe(
            "https://x.ai/e?a=1",
        );
    });
});

describe("LighterHelper.leverageToMarginFraction", () => {
    const SCALE = LighterConstant.MARGIN_FRACTION_SCALE; // 10000

    it("maps leverage to fraction = SCALE / leverage", () => {
        expect(LighterHelper.leverageToMarginFraction(20)).toBe(SCALE / 20); // 500 -> 20x
        expect(LighterHelper.leverageToMarginFraction(1)).toBe(SCALE); // 1x
        expect(LighterHelper.leverageToMarginFraction(10)).toBe(1000);
    });

    it("clamps below the market min fraction (leverage cap) and above 1x", () => {
        // min fraction 800 caps leverage at 12.5x; asking 50x clamps up to 800.
        expect(LighterHelper.leverageToMarginFraction(50, 800)).toBe(800);
        // Sub-1x leverage cannot exceed SCALE.
        expect(LighterHelper.leverageToMarginFraction(0.5)).toBe(SCALE);
    });
});
