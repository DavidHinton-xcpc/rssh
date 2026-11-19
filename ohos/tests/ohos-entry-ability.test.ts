import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const sourcePath = fileURLToPath(new URL(
  "../app/common/runtime/src/main/ets/ability/RsshAbility.ets", import.meta.url,
));
const code = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness() {
  const applicationContext = { filesDir: "/isolated-test/base/files" };
  const context = { filesDir: "/isolated-test/base/haps/entry/files", getApplicationContext: () => applicationContext };
  const initContext = { basePath: context.filesDir, prefPath: context.filesDir, moduleName: "rssh_ohos", resourceManager: {}, preferredLocales: "zh" };
  const createInitContext = vi.fn((_moduleName: string) => ({ ...initContext }));
  class NativeAbility {
    context = context;
    createInitContext(moduleName: string) { return createInitContext(moduleName); }
    onCreate() {}
    onForeground() { lifecycleCalls.push("foreground"); }
    onBackground() { lifecycleCalls.push("background"); }
    onWindowStageCreate() {}
    onWindowStageDestroy() {}
    onDestroy() { lifecycleCalls.push("destroy"); return Promise.resolve(); }
  }
  const lifecycleCalls: string[] = [];
  const startBackgroundRunning = vi.fn().mockResolvedValue(undefined);
  const stopBackgroundRunning = vi.fn().mockResolvedValue(undefined);
  const onTaskCancel = vi.fn();
  const getWantAgent = vi.fn().mockResolvedValue({ id: "want-agent" });
  const logError = vi.fn();
  const logWarn = vi.fn();
  const logInfo = vi.fn();
  const modules: Record<string, unknown> = {
    "@ohos-rs/ability": {
      NativeAbility,
      LazyPlugin: class { constructor(public create: () => { id: string }) {} },
    },
    "@kit.BackgroundTasksKit": {
      BackgroundMode: { MULTI_DEVICE_CONNECTION: 6 },
      backgroundTaskManager: { startBackgroundRunning, stopBackgroundRunning, on: onTaskCancel, off: vi.fn() },
    },
    "@kit.AbilityKit": {
      common: {},
      WantAgent: class {},
      wantAgent: {
        getWantAgent,
        OperationType: { START_ABILITY: 1 },
        WantAgentFlags: { UPDATE_PRESENT_FLAG: 1 },
      },
    },
    "@kit.BasicServicesKit": { BusinessError: class {} },
  };
  for (const [pkg, cls, id] of [
    ["files", "FilesPlugin", "ohos.files"], ["url", "UrlPlugin", "ohos.url"],
    ["permission", "PermissionPlugin", "ohos.permission"], ["webview", "WebviewPlugin", "ohos.webview"],
    ["window", "WindowPlugin", "ohos.window"], ["app-control", "AppControlPlugin", "ohos.app-control"],
  ]) {
    modules[`@ohos-rs/ability-plugin-${pkg}`] = { [cls]: class { id = id; } };
  }
  modules["../plugins/FilesAccessPlugin"] = { FilesAccessPlugin: class { id = "rssh.files-access"; } };
  modules["../plugins/ClipboardPlugin"] = { ClipboardPlugin: class { id = "rssh.clipboard"; } };
  modules["../plugins/RuntimePlugin"] = { RuntimePlugin: class {
    id = "rssh.runtime";
    constructor(public systemBack = false) {}
  } };
  modules["../plugins/SerialPlugin"] = { SerialPlugin: class { id = "rssh.serial"; } };
  const pluginExports = {};
  const pluginSource = sourcePath.replace('RsshAbility.ets', 'RsshPlugins.ets');
  const pluginCode = ts.transpileModule(readFileSync(pluginSource, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(pluginCode, { exports: pluginExports, require: (name: string) => modules[name] });
  modules["./RsshPlugins"] = pluginExports;
  const exports = {} as { RsshAbility: new () => NativeAbility & {
    moduleName: string;
    bridgePlugins: { create: () => { id: string; systemBack?: boolean } }[];
    loadWindowStageContent(stage: {
      getMainWindow: () => Promise<{ setSpecificSystemBarEnabled: (name: string, enabled: boolean) => Promise<void> }>;
      loadContent: (path: string) => Promise<void>;
    }): Promise<void>;
  } };
  runInNewContext(code, { exports, require: (name: string) => {
    if (!(name in modules)) throw new Error(`Unexpected native dependency: ${name}`);
    return modules[name];
  }, console: { error: logError, warn: logWarn, info: logInfo } }, { filename: sourcePath });
  return { ability: new exports.RsshAbility(), NativeAbility, initContext, createInitContext, applicationContext, logError, logWarn, logInfo, lifecycleCalls, startBackgroundRunning, stopBackgroundRunning, getWantAgent, onTaskCancel };
}

describe("HarmonyOS framework host", () => {
  it("lets ArkWeb handle cutout insets without reserving a native top strip on phones and tablets", () => {
    const { module } = JSON.parse(readFileSync(new URL(
      "../app/products/phone/src/main/module.json5", import.meta.url,
    ), "utf8"));
    expect(module.deviceTypes).toEqual(["phone", "tablet"]);
    expect(module.metadata ?? []).not.toContainEqual({ name: "avoid_cutout", value: "true" });
    expect(module.abilities[0].backgroundModes).toEqual(["multiDeviceConnection"]);
    expect(module.requestPermissions).toContainEqual({ name: "ohos.permission.KEEP_BACKGROUND_RUNNING" });
  });

  it("does not restore a raw database without its device-bound master key", () => {
    const config = JSON.parse(readFileSync(new URL(
      "../app/common/runtime/src/main/resources/base/profile/backup_config.json", import.meta.url,
    ), "utf8"));
    expect(config.allowToBackupRestore).toBe(false);
  });

  it("preserves application filesDir while keeping the framework initialization metadata", () => {
    const h = harness();
    expect(h.ability.createInitContext("rssh_ohos")).toEqual({
      ...h.initContext, basePath: h.applicationContext.filesDir, prefPath: h.applicationContext.filesDir,
    });
    expect(h.createInitContext).toHaveBeenCalledExactlyOnceWith("rssh_ohos");
    expect(h.ability.context.filesDir).toBe("/isolated-test/base/haps/entry/files");
  });

  it("lets NativeAbility own creation, teardown and cancellation", () => {
    const h = harness();
    for (const name of ["onCreate", "onWindowStageCreate", "onWindowStageDestroy"] as const) {
      expect(h.ability[name]).toBe(h.NativeAbility.prototype[name]);
    }
  });

  it("requests and releases a data-transfer continuous task around background/foreground", async () => {
    const h = harness();
    h.ability.onBackground();
    await vi.waitFor(() => expect(h.startBackgroundRunning).toHaveBeenCalledTimes(1));
    expect(h.getWantAgent).toHaveBeenCalledWith(expect.objectContaining({
      wants: [{ bundleName: "com.rssh.app", moduleName: "entry", abilityName: "EntryAbility" }],
    }));
    expect(h.startBackgroundRunning).toHaveBeenCalledWith(
      expect.objectContaining({ filesDir: "/isolated-test/base/haps/entry/files" }),
      6,
      { id: "want-agent" },
    );

    h.ability.onForeground();
    await vi.waitFor(() => expect(h.stopBackgroundRunning).toHaveBeenCalledTimes(1));
    expect(h.stopBackgroundRunning).toHaveBeenCalledWith(
      expect.objectContaining({ filesDir: "/isolated-test/base/haps/entry/files" }),
    );
    expect(h.lifecycleCalls).toEqual(["background", "foreground"]);
  });

  it("does not fail lifecycle calls when the continuous task is rejected", async () => {
    const h = harness();
    h.startBackgroundRunning.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: 201, message: "denied" }));
    expect(() => h.ability.onBackground()).not.toThrow();
    await vi.waitFor(() => expect(h.logWarn).toHaveBeenCalled());
    expect(h.stopBackgroundRunning).not.toHaveBeenCalled();
  });

  it("requests a fresh task after the system cancels one behind the app's back", async () => {
    const h = harness();
    h.ability.onBackground();
    await vi.waitFor(() => expect(h.startBackgroundRunning).toHaveBeenCalledTimes(1));
    expect(h.onTaskCancel).toHaveBeenCalledExactlyOnceWith("continuousTaskCancel", expect.any(Function));

    const [, cancelCallback] = h.onTaskCancel.mock.calls[0];
    cancelCallback({ reason: 12 });

    h.ability.onForeground();
    await vi.waitFor(() => expect(h.lifecycleCalls).toEqual(["background", "foreground"]));
    expect(h.stopBackgroundRunning).not.toHaveBeenCalled();

    h.ability.onBackground();
    await vi.waitFor(() => expect(h.startBackgroundRunning).toHaveBeenCalledTimes(2));
  });

  it("does not double-register the cancel listener across repeated background entries", async () => {
    const h = harness();
    h.ability.onBackground();
    await vi.waitFor(() => expect(h.startBackgroundRunning).toHaveBeenCalledTimes(1));
    h.ability.onForeground();
    await vi.waitFor(() => expect(h.stopBackgroundRunning).toHaveBeenCalledTimes(1));
    h.ability.onBackground();
    await vi.waitFor(() => expect(h.startBackgroundRunning).toHaveBeenCalledTimes(2));
    expect(h.onTaskCancel).toHaveBeenCalledTimes(1);
  });

  it("hides only the mobile status bar before loading the page", async () => {
    const h = harness();
    let finishHiding!: () => void;
    const hidden = new Promise<void>(resolve => { finishHiding = resolve; });
    const mainWindow = { setSpecificSystemBarEnabled: vi.fn(() => hidden) };
    const stage = {
      getMainWindow: vi.fn().mockResolvedValue(mainWindow),
      loadContent: vi.fn().mockResolvedValue(undefined),
    };

    const loading = h.ability.loadWindowStageContent(stage);
    await vi.waitFor(() => {
      expect(mainWindow.setSpecificSystemBarEnabled).toHaveBeenCalledExactlyOnceWith("status", false);
    });
    expect(stage.loadContent).not.toHaveBeenCalled();

    finishHiding();
    await loading;
    expect(stage.loadContent).toHaveBeenCalledExactlyOnceWith("pages/Index");
    expect(h.logError).not.toHaveBeenCalled();
  });

  it("reports a status-bar failure without preventing the page from loading", async () => {
    const h = harness();
    const mainWindow = {
      setSpecificSystemBarEnabled: vi.fn().mockRejectedValue(new Error("window manager unavailable")),
    };
    const stage = {
      getMainWindow: vi.fn().mockResolvedValue(mainWindow),
      loadContent: vi.fn().mockResolvedValue(undefined),
    };

    await h.ability.loadWindowStageContent(stage);
    expect(h.logError).toHaveBeenCalledExactlyOnceWith(
      "[RsshAbility] Failed to hide mobile status bar: Error: window manager unavailable",
    );
    expect(stage.loadContent).toHaveBeenCalledExactlyOnceWith("pages/Index");
  });

  it("assembles framework capabilities and creates independent application plugin instances", () => {
    const h = harness();
    expect(h.ability.moduleName).toBe("rssh_ohos");
    expect(h.ability.bridgePlugins.map((factory) => factory.create().id).sort()).toEqual([
      "ohos.app-control", "ohos.files", "ohos.permission", "ohos.url", "ohos.webview", "ohos.window",
      "rssh.clipboard", "rssh.files-access", "rssh.runtime", "rssh.serial",
    ]);
    for (const factory of h.ability.bridgePlugins) expect(factory.create()).not.toBe(factory.create());
    expect(h.ability.bridgePlugins.map(factory => factory.create())
      .find(plugin => plugin.id === "rssh.runtime")?.systemBack).toBe(true);
  });
});
