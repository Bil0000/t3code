import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { serverSupportsPullRequests } from "./environmentCapabilities";

function configWith(capabilities: ServerConfig["environment"]["capabilities"]): ServerConfig {
  return {
    environment: {
      environmentId: EnvironmentId.make("environment-1"),
      label: "Local",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.32",
      capabilities,
    },
  } as ServerConfig;
}

describe("serverSupportsPullRequests", () => {
  it("requires the environment to advertise support explicitly", () => {
    expect(serverSupportsPullRequests(null)).toBe(false);
    expect(serverSupportsPullRequests(configWith({ repositoryIdentity: true }))).toBe(false);
    expect(
      serverSupportsPullRequests(configWith({ repositoryIdentity: true, pullRequests: true })),
    ).toBe(true);
  });
});
