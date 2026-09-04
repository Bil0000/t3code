import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { readClientSettings, writeClientSettings } = vi.hoisted(() => ({
  readClientSettings: vi.fn(),
  writeClientSettings: vi.fn(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getClientSettings: readClientSettings,
      setClientSettings: writeClientSettings,
    },
  }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
  getClientSettings,
  mergeEnvironmentSettings,
  persistClientSettingsPatch,
  persistClientSettingsUpdate,
  resolveEnvironmentIdentificationMode,
} from "./useSettings";

beforeEach(() => {
  readClientSettings.mockReset().mockResolvedValue(null);
  writeClientSettings.mockReset().mockResolvedValue(undefined);
  __resetClientSettingsPersistenceForTests();
});

describe("persistClientSettingsPatch", () => {
  it("waits for settings writes in request order", async () => {
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    let finishFirst!: () => void;
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    writeClientSettings.mockImplementationOnce(() => {
      markFirstStarted();
      return new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
    });

    const firstSettings = { ...DEFAULT_CLIENT_SETTINGS, snapShotFlash: false };
    const secondSettings = { ...firstSettings, snapShotPlaySound: false };
    const first = persistClientSettingsPatch({ snapShotFlash: false });
    await firstStarted;
    const second = persistClientSettingsPatch({ snapShotPlaySound: false });

    expect(writeClientSettings).toHaveBeenCalledTimes(1);
    expect(getClientSettings()).toEqual(secondSettings);
    finishFirst();
    await Promise.all([first, second]);

    expect(writeClientSettings).toHaveBeenNthCalledWith(1, firstSettings);
    expect(writeClientSettings).toHaveBeenNthCalledWith(2, secondSettings);
  });

  it("hydrates stored settings before applying a patch", async () => {
    let finishHydration!: (settings: typeof DEFAULT_CLIENT_SETTINGS) => void;
    readClientSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishHydration = resolve;
      }),
    );
    const storedSettings = { ...DEFAULT_CLIENT_SETTINGS, snapShotPlaySound: false };

    const write = persistClientSettingsPatch({ snapShotFlash: false });
    expect(writeClientSettings).not.toHaveBeenCalled();
    finishHydration(storedSettings);
    await write;

    expect(writeClientSettings).toHaveBeenCalledWith({
      ...storedSettings,
      snapShotFlash: false,
    });
  });
});

describe("persistClientSettingsUpdate", () => {
  it("publishes the update only after persistence succeeds", async () => {
    let finishPersistence!: () => void;
    const persistence = new Promise<void>((resolve) => {
      finishPersistence = resolve;
    });
    const setClientSettings = vi.fn(() => persistence);
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    const pending = persistClientSettingsUpdate(
      (current) => ({
        ...current,
        timestampFormat: "12-hour",
      }),
      setClientSettings,
    );

    expect(getClientSettings().timestampFormat).toBe(DEFAULT_CLIENT_SETTINGS.timestampFormat);
    finishPersistence();
    await expect(pending).resolves.toMatchObject({ timestampFormat: "12-hour" });
    expect(getClientSettings().timestampFormat).toBe("12-hour");
  });

  it("keeps the current snapshot and propagates persistence failure", async () => {
    const failure = new Error("disk full");
    const setClientSettings = vi.fn().mockRejectedValue(failure);
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    await expect(
      persistClientSettingsUpdate(
        (current) => ({ ...current, timestampFormat: "12-hour" }),
        setClientSettings,
      ),
    ).rejects.toBe(failure);
    expect(getClientSettings()).toBe(DEFAULT_CLIENT_SETTINGS);
  });

  it("preserves an optimistic write made while an awaited update persists", async () => {
    let finishFirstPersistence!: () => void;
    let durableSettings = DEFAULT_CLIENT_SETTINGS;
    const firstPersistence = new Promise<void>((resolve) => {
      finishFirstPersistence = resolve;
    });
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockImplementationOnce((settings) =>
        firstPersistence.then(() => {
          durableSettings = settings;
        }),
      )
      .mockImplementation(async (settings) => {
        durableSettings = settings;
      });
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    const importedProfile = { id: "profile-import", name: "Imported", kind: "persistent" as const };

    const pending = persistClientSettingsUpdate(
      (current) => ({
        ...current,
        browserProfiles: [...current.browserProfiles, importedProfile],
      }),
      persist,
    );
    await Promise.resolve();
    const patch = persistClientSettingsPatch({ wordWrap: false }, persist);
    finishFirstPersistence();
    await Promise.all([pending, patch]);

    expect(persist).toHaveBeenCalledTimes(3);
    expect(persist.mock.calls[1]?.[0]).toMatchObject({
      wordWrap: false,
    });
    expect(persist.mock.calls[1]?.[0].browserProfiles).toContainEqual(importedProfile);
    expect(durableSettings.wordWrap).toBe(false);
    expect(durableSettings.browserProfiles).toContainEqual(importedProfile);
    expect(getClientSettings().wordWrap).toBe(false);
    expect(getClientSettings().browserProfiles).toContainEqual(importedProfile);
  });

  it("orders an awaited update after an older optimistic write", async () => {
    let finishOldWrite!: () => void;
    let durableSettings = DEFAULT_CLIENT_SETTINGS;
    const oldWrite = new Promise<void>((resolve) => {
      finishOldWrite = resolve;
    });
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockImplementationOnce((settings) =>
        oldWrite.then(() => {
          durableSettings = settings;
        }),
      )
      .mockImplementation(async (settings) => {
        durableSettings = settings;
      });
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    void persistClientSettingsPatch({ wordWrap: false }, persist);
    const importedProfile = { id: "profile-import", name: "Imported", kind: "persistent" as const };
    const registration = persistClientSettingsUpdate(
      (current) => ({
        ...current,
        browserProfiles: [...current.browserProfiles, importedProfile],
      }),
      persist,
    );
    await Promise.resolve();
    expect(persist).toHaveBeenCalledTimes(1);

    finishOldWrite();
    await registration;

    expect(persist).toHaveBeenCalledTimes(2);
    expect(durableSettings.wordWrap).toBe(false);
    expect(durableSettings.browserProfiles).toContainEqual(importedProfile);
  });

  it("continues the queue after a rejected write", async () => {
    const failure = new Error("disk full");
    const persist = vi
      .fn<(settings: typeof DEFAULT_CLIENT_SETTINGS) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue(undefined);
    __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);

    await expect(
      persistClientSettingsUpdate(
        (current) => ({ ...current, timestampFormat: "12-hour" }),
        persist,
      ),
    ).rejects.toBe(failure);
    await expect(
      persistClientSettingsUpdate((current) => ({ ...current, wordWrap: false }), persist),
    ).resolves.toMatchObject({ wordWrap: false });
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
