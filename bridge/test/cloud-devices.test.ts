import { describe, expect, it } from "vitest";
import { parseBoundDevices } from "../src/providers/bambu-cloud/api.ts";
import { DEVICE_ID } from "./synthetic-values.ts";

describe("parseBoundDevices", () => {
  it("maps a well-formed device", () => {
    const payload = {
      devices: [
        {
          dev_id: DEVICE_ID,
          name: "Workshop",
          dev_model_name: "A1",
          dev_product_name: "A1",
          online: true,
          print_status: "RUNNING",
        },
      ],
    };
    expect(parseBoundDevices(payload)).toEqual([
      {
        id: DEVICE_ID,
        name: "Workshop",
        model: "A1",
        online: true,
        printStatus: "RUNNING",
      },
    ]);
  });

  it("falls back to the product name when the model name is absent", () => {
    const payload = { devices: [{ dev_id: DEVICE_ID, dev_product_name: "A1 mini" }] };
    expect(parseBoundDevices(payload)[0]?.model).toBe("A1 mini");
  });

  it("drops a device with no usable identifier", () => {
    const payload = { devices: [{ name: "nameless" }, { dev_id: "" }, { dev_id: 7 }] };
    expect(parseBoundDevices(payload)).toEqual([]);
  });

  it("refuses to read a truthy string as online", () => {
    const payload = { devices: [{ dev_id: DEVICE_ID, online: "true" }] };
    expect(parseBoundDevices(payload)[0]?.online).toBeNull();
  });

  it("keeps a device whose optional fields are the wrong type", () => {
    const payload = {
      devices: [{ dev_id: DEVICE_ID, name: 42, print_status: [], online: 1 }],
    };
    expect(parseBoundDevices(payload)).toEqual([
      { id: DEVICE_ID, name: null, model: null, online: null, printStatus: null },
    ]);
  });

  it("never throws on a wrong shape", () => {
    expect(parseBoundDevices(null)).toEqual([]);
    expect(parseBoundDevices(undefined)).toEqual([]);
    expect(parseBoundDevices([])).toEqual([]);
    expect(parseBoundDevices({ devices: 3 })).toEqual([]);
    expect(parseBoundDevices({ devices: [null, 1, "x"] })).toEqual([]);
    expect(parseBoundDevices("nope")).toEqual([]);
  });
});
