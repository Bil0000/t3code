import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const setClientSettings = vi.hoisted(() => vi.fn());
const getClientSettings = vi.hoisted(() => vi.fn());

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings,
      setClientSettings,
    },
  }),
}));

import {
  __persistClientSettingsPatchForTests,
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  mergeEnvironmentSettings,
  resolveEnvironmentIdentificationMode,
} from "./useSettings";

beforeEach(() => {
  setClientSettings.mockReset();
  getClientSettings.mockReset().mockResolvedValue(null);
  __resetClientSettingsPersistenceForTests();
});

describe("client settings persistence", () => {
  it("writes settings snapshots in request order", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    let finishFirst: () => void = () => undefined;
    let markFirstStarted: () => void = () => undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    setClientSettings
      .mockImplementationOnce(() => {
        markFirstStarted();
        return new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      })
      .mockResolvedValueOnce(undefined);

    const firstSettings = { ...DEFAULT_CLIENT_SETTINGS, windowCaptureFlash: false };
    const secondSettings = { ...firstSettings, windowCapturePlaySound: false };
    const first = __persistClientSettingsPatchForTests({ windowCaptureFlash: false });
    const second = __persistClientSettingsPatchForTests({ windowCapturePlaySound: false });

    await firstStarted;
    expect(setClientSettings).toHaveBeenCalledTimes(1);
    finishFirst();
    await Promise.all([first, second]);

    expect(setClientSettings).toHaveBeenNthCalledWith(1, firstSettings);
    expect(setClientSettings).toHaveBeenNthCalledWith(2, secondSettings);
  });

  it("hydrates stored settings before applying a patch", async () => {
    let finishHydration: (settings: typeof DEFAULT_CLIENT_SETTINGS) => void = () => undefined;
    getClientSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishHydration = resolve;
      }),
    );
    const storedSettings = { ...DEFAULT_CLIENT_SETTINGS, windowCapturePlaySound: false };

    const write = __persistClientSettingsPatchForTests({ windowCaptureFlash: false });
    await Promise.resolve();
    expect(setClientSettings).not.toHaveBeenCalled();
    finishHydration(storedSettings);
    await write;

    expect(setClientSettings).toHaveBeenCalledWith({
      ...storedSettings,
      windowCaptureFlash: false,
    });
  });
});

describe("resolveEnvironmentIdentificationMode", () => {
  it("keeps identification hidden until client settings hydrate", () => {
    expect(resolveEnvironmentIdentificationMode({ mode: "artwork", settingsHydrated: false })).toBe(
      "none",
    );
    expect(resolveEnvironmentIdentificationMode({ mode: "pill", settingsHydrated: true })).toBe(
      "pill",
    );
  });

  it("uses a pill instead of artwork with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("pill");
  });

  it("respects none with a palette theme", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "none",
        settingsHydrated: true,
        paletteThemeActive: true,
      }),
    ).toBe("none");
  });

  it("keeps artwork when the palette theme opts into it", () => {
    expect(
      resolveEnvironmentIdentificationMode({
        mode: "artwork",
        settingsHydrated: true,
        paletteThemeActive: true,
        paletteThemeAllowsArtwork: true,
      }),
    ).toBe("artwork");
  });
});

describe("mergeEnvironmentSettings", () => {
  it("combines the selected environment's server settings with client preferences", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        [ProviderInstanceId.make("codex_remote")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
    };
    const clientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      favorites: [
        {
          provider: ProviderInstanceId.make("codex_remote"),
          model: "gpt-5.4",
        },
      ],
    };

    const settings = mergeEnvironmentSettings(serverSettings, clientSettings);

    expect(settings.providerInstances).toBe(serverSettings.providerInstances);
    expect(settings.favorites).toBe(clientSettings.favorites);
  });

  it("keeps server settlement settings when legacy client data contains retired keys", () => {
    const serverSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      sidebarAutoSettleAfterDays: 14,
      sidebarAutoSettleOnMerge: false,
    };
    const legacyClientSettings = {
      ...DEFAULT_CLIENT_SETTINGS,
      sidebarAutoSettleAfterDays: 1,
      sidebarAutoSettleOnMerge: true,
    };

    const settings = mergeEnvironmentSettings(serverSettings, legacyClientSettings);

    expect(settings.sidebarAutoSettleAfterDays).toBe(14);
    expect(settings.sidebarAutoSettleOnMerge).toBe(false);
  });
});
