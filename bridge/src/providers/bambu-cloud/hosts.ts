/**
 * Bambu Cloud regional hosts.
 *
 * Bambu publishes no general public consumer Cloud API contract. Every host and
 * endpoint in this directory is reverse-engineered from OpenBambuAPI and
 * ha-bambulab, so treat all of it as volatile and keep it isolated behind the
 * cloud provider.
 */

export type Region = "global" | "china";

export interface CloudHosts {
  api: string;
  mqtt: string;
}

/** Cloud MQTT listens on the standard MQTT-over-TLS port. */
export const CLOUD_MQTT_PORT = 8883;

const GLOBAL: CloudHosts = {
  api: "https://api.bambulab.com",
  mqtt: "us.mqtt.bambulab.com",
};

const CHINA: CloudHosts = {
  api: "https://api.bambulab.cn",
  mqtt: "cn.mqtt.bambulab.com",
};

/** Ordered for presentation in the setup CLI. */
export const REGIONS: readonly { id: Region; label: string; api: string }[] = [
  { id: "global", label: "Global (bambulab.com)", api: GLOBAL.api },
  { id: "china", label: "China (bambulab.cn)", api: CHINA.api },
];

export function hostsFor(region: Region): CloudHosts {
  return region === "china" ? { ...CHINA } : { ...GLOBAL };
}

export function isRegion(value: string): value is Region {
  return value === "global" || value === "china";
}
